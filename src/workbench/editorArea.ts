import { $, append, clearNode } from 'vs/base/browser/dom';
import { Delayer } from 'vs/base/common/async';
import { VSBuffer } from 'vs/base/common/buffer';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { basename, isEqualOrParent } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import * as monaco from '../editor/monaco';
import type { WorkspaceFileSystem } from '../fs/fileSystem';
import { CustomEditorDocument, CustomEditorPane, CustomEditorRegistry } from './customEditors';
import { FileRunner, RunnerRegistry } from './runners';

/** A text model shared by every editor (text or custom) opened for a file. */
interface ModelRecord {
	readonly model: monaco.editor.ITextModel;
	readonly listeners: DisposableStore;
	savedVersionId: number;
	dirty: boolean;
}

interface OpenEntry {
	readonly uri: URI;
	readonly key: string;
	readonly kind: 'text' | 'custom';
	readonly viewType?: string;
	readonly pane?: CustomEditorPane;
	readonly paneListeners?: DisposableStore;
	paneDirty: boolean;
	/** Whether this entry works against the shared text model. */
	usesModel: boolean;
	viewState: monaco.editor.ICodeEditorViewState | null;
}

export interface OpenFileOptions {
	readonly revealRange?: monaco.IRange;
	/** Open with a specific custom editor viewType, or 'text' to force the text editor. */
	readonly openWith?: string;
	/** Keep focus where it is instead of focusing the opened editor. */
	readonly preserveFocus?: boolean;
}

/**
 * The editor area: a tab bar plus an editor host that shows either the shared
 * Monaco editor (swapping models) or an app-registered custom editor pane.
 * File contents flow through VS Code's FileService.
 */
export class EditorArea extends Disposable {
	readonly element: HTMLElement;
	readonly editor: monaco.editor.IStandaloneCodeEditor;

	private readonly tabsEl: HTMLElement;
	private readonly tabsListEl: HTMLElement;
	private readonly tabsActionsEl: HTMLElement;
	private readonly editorContainerEl: HTMLElement;
	private readonly editorHostEl: HTMLElement;
	private readonly watermarkEl: HTMLElement;

	private readonly models = new Map<string, ModelRecord>();
	private readonly entries = new Map<string, OpenEntry>();
	private activeKey: string | undefined;
	private width = 0;
	private height = 0;

	private readonly _onDidChangeActiveFile = this._register(new Emitter<URI | undefined>());
	readonly onDidChangeActiveFile: Event<URI | undefined> = this._onDidChangeActiveFile.event;

	constructor(
		private readonly fs: WorkspaceFileSystem,
		theme: string,
		private readonly customEditors: CustomEditorRegistry,
		private readonly runners: RunnerRegistry,
		private readonly runFile: (runner: FileRunner, uri: URI) => void,
		private readonly isRunnerRunning: (runner: FileRunner) => boolean,
	) {
		super();

		this.element = $('.mw-editor-area');
		this.tabsEl = append(this.element, $('.mw-tabs'));
		this.tabsListEl = append(this.tabsEl, $('.mw-tabs-list'));
		this.tabsActionsEl = append(this.tabsEl, $('.mw-tabs-actions'));
		this.editorContainerEl = append(this.element, $('.mw-editor-container'));
		this.watermarkEl = append(this.editorContainerEl, $('.mw-watermark'));
		append(this.watermarkEl, $('span.codicon.codicon-files'));
		append(this.watermarkEl, $('span', undefined, 'Open a file from the Explorer to get started'));

		this.editorHostEl = append(this.editorContainerEl, $('.mw-editor-host'));

		this.editor = this._register(monaco.editor.create(this.editorHostEl, {
			model: null,
			theme,
			automaticLayout: false,
			fixedOverflowWidgets: true,
			minimap: { enabled: true },
		}));

		this.editor.addAction({
			id: 'minwebide.saveFile',
			label: 'File: Save',
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
			run: () => this.saveActive(),
		});

		// follow external changes (other tabs, imports, runners): non-dirty
		// models reload from disk, VS Code style
		const reloadDelayer = this._register(new Delayer<void>(150));
		this._register(this.fs.fileService.onDidFilesChange(() => {
			reloadDelayer.trigger(() => this.reloadFromDisk(false));
		}));

		this.updateEditorVisibility();
	}

	get activeUri(): URI | undefined {
		return this.activeKey ? this.entries.get(this.activeKey)?.uri : undefined;
	}

	async openFile(uri: URI, options?: OpenFileOptions): Promise<void> {
		const key = uri.toString();
		const requested = options?.openWith;
		const existing = this.entries.get(key);

		let targetViewType: string | undefined; // undefined → text editor
		if (requested) {
			targetViewType = requested === 'text' ? undefined : requested;
		} else if (existing) {
			targetViewType = existing.viewType;
		} else {
			targetViewType = this.customEditors.getDefaultForResource(uri)?.viewType;
		}

		let entry = existing;
		if (!entry || entry.viewType !== targetViewType) {
			if (entry) {
				this.disposeEntry(entry, { releaseModel: false });
				this.entries.delete(key);
				if (this.activeKey === key) {
					this.activeKey = undefined;
				}
			}
			entry = targetViewType
				? await this.createCustomEntry(uri, key, targetViewType)
				: await this.createTextEntry(uri, key);
			this.entries.set(key, entry);
		}

		this.setActive(key);
		if (options?.revealRange && entry.kind === 'text') {
			this.editor.revealRangeInCenter(options.revealRange);
			this.editor.setSelection(options.revealRange);
		}
		if (!options?.preserveFocus) {
			this.focusActive();
		}
	}

	closeFile(uri: URI): void {
		const key = uri.toString();
		const entry = this.entries.get(key);
		if (!entry) {
			return;
		}
		if (this.isDirty(entry) && !confirm(`Discard unsaved changes to ${basename(uri)}?`)) {
			return;
		}
		this.forceClose(key);
	}

	/** Close any open tabs for a deleted file or folder, without prompting. */
	handleDelete(uri: URI): void {
		for (const entry of [...this.entries.values()]) {
			if (isEqualOrParent(entry.uri, uri)) {
				this.forceClose(entry.key);
			}
		}
	}

	/**
	 * Point open tabs at a moved file or folder: reopen affected entries at
	 * their new URI, carrying over unsaved edits and the active tab.
	 */
	async handleMove(from: URI, to: URI): Promise<void> {
		const moved = [...this.entries.values()].filter(entry => isEqualOrParent(entry.uri, from));
		if (moved.length === 0) {
			return;
		}
		const activeKey = this.activeKey;
		let newActiveUri: URI | undefined;
		for (const entry of moved) {
			const newUri = to.with({ path: to.path + entry.uri.path.substring(from.path.length) });
			const record = entry.usesModel ? this.models.get(entry.key) : undefined;
			const dirtyText = record?.dirty ? record.model.getValue() : undefined;
			const viewType = entry.viewType;
			if (entry.key === activeKey) {
				newActiveUri = newUri;
			}
			this.forceClose(entry.key);
			await this.openFile(newUri, viewType ? { openWith: viewType } : undefined);
			if (dirtyText !== undefined) {
				monaco.editor.getModel(newUri)?.setValue(dirtyText);
			}
		}
		if (newActiveUri) {
			this.setActive(newActiveUri.toString());
		}
	}

	private forceClose(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) {
			return;
		}
		if (this.activeKey === key) {
			this.editor.setModel(null);
			this.activeKey = undefined;
		}
		this.disposeEntry(entry, { releaseModel: true });
		this.entries.delete(key);

		if (!this.activeKey) {
			const next = [...this.entries.keys()].pop();
			if (next) {
				this.setActive(next);
			} else {
				this.updateEditorVisibility();
				this.renderTabs();
				this._onDidChangeActiveFile.fire(undefined);
			}
		} else {
			this.renderTabs();
		}
	}

	/**
	 * Reloads open editors from disk. Without `force`, only non-dirty text
	 * models follow the disk (unsaved edits win, VS Code style). With `force`
	 * (an explicit revert, e.g. after re-importing a repo), unsaved edits are
	 * discarded too and editors whose files are gone get closed. `paths`
	 * limits the reload to those workspace paths (a per-file revert), leaving
	 * every other editor — dirty or not — untouched.
	 */
	async reloadFromDisk(force = false, paths?: readonly string[]): Promise<void> {
		const only = paths ? new Set(paths) : undefined;
		if (force) {
			for (const entry of [...this.entries.values()]) {
				if (only && !only.has(entry.uri.path)) {
					continue;
				}
				if (!await this.fs.fileService.exists(entry.uri)) {
					this.forceClose(entry.key);
				}
			}
		}
		for (const [key, record] of [...this.models]) {
			if (!this.models.has(key) || (record.dirty && !force)) {
				continue;
			}
			if (only && !only.has(record.model.uri.path)) {
				continue;
			}
			let text: string | undefined;
			try {
				text = (await this.fs.fileService.readFile(record.model.uri)).value.toString();
			} catch {
				continue; // gone from disk (possibly transiently, mid-import); keep the buffer
			}
			if (text !== record.model.getValue()) {
				// an edit (not setValue) keeps the undo stack intact
				record.model.pushEditOperations([], [{ range: record.model.getFullModelRange(), text }], () => null);
			}
			record.savedVersionId = record.model.getAlternativeVersionId();
			record.dirty = false;
		}
		this.renderTabs();
	}

	async saveActive(): Promise<void> {
		const entry = this.activeKey ? this.entries.get(this.activeKey) : undefined;
		if (!entry) {
			return;
		}
		if (entry.pane?.save) {
			await entry.pane.save();
			entry.paneDirty = false;
		} else if (entry.usesModel) {
			const record = this.models.get(entry.key);
			if (record) {
				await this.fs.fileService.writeFile(entry.uri, VSBuffer.fromString(record.model.getValue()));
				record.savedVersionId = record.model.getAlternativeVersionId();
				record.dirty = false;
			}
		}
		this.renderTabs();
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		const tabsHeight = this.tabsEl.offsetHeight;
		const contentHeight = Math.max(0, height - tabsHeight);
		const entry = this.activeKey ? this.entries.get(this.activeKey) : undefined;
		if (entry?.kind === 'custom') {
			entry.pane?.layout?.(width, contentHeight);
		} else {
			this.editor.layout({ width, height: contentHeight });
		}
	}

	// ---- entry construction ----

	private async acquireModel(uri: URI, key: string): Promise<ModelRecord> {
		let record = this.models.get(key);
		if (record) {
			return record;
		}
		const content = await this.fs.fileService.readFile(uri);
		const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content.value.toString(), undefined, uri);
		const listeners = new DisposableStore();
		const created: ModelRecord = { model, listeners, savedVersionId: model.getAlternativeVersionId(), dirty: false };
		listeners.add(model.onDidChangeContent(() => {
			const dirty = model.getAlternativeVersionId() !== created.savedVersionId;
			if (dirty !== created.dirty) {
				created.dirty = dirty;
				this.renderTabs();
			}
		}));
		this.models.set(key, created);
		return created;
	}

	private async createTextEntry(uri: URI, key: string): Promise<OpenEntry> {
		await this.acquireModel(uri, key);
		return { uri, key, kind: 'text', paneDirty: false, usesModel: true, viewState: null };
	}

	private async createCustomEntry(uri: URI, key: string, viewType: string): Promise<OpenEntry> {
		const provider = this.customEditors.get(viewType);
		if (!provider) {
			throw new Error(`Unknown custom editor: ${viewType}`);
		}
		const entry: OpenEntry & { usesModel: boolean } = {
			uri,
			key,
			kind: 'custom',
			viewType,
			pane: undefined as unknown as CustomEditorPane,
			paneListeners: new DisposableStore(),
			paneDirty: false,
			usesModel: false,
			viewState: null,
		};
		const document: CustomEditorDocument = {
			uri,
			getTextModel: async () => {
				const record = await this.acquireModel(uri, key);
				entry.usesModel = true;
				return record.model;
			},
			readBytes: async () => {
				const content = await this.fs.fileService.readFile(uri);
				return content.value.buffer;
			},
		};
		const pane = await provider.resolveCustomEditor(document);
		(entry as { pane: CustomEditorPane }).pane = pane;
		if (pane.onDidChangeDirty) {
			entry.paneListeners!.add(pane.onDidChangeDirty((dirty) => {
				entry.paneDirty = dirty;
				this.renderTabs();
			}));
		}
		pane.element.classList.add('mw-custom-editor');
		this.editorContainerEl.appendChild(pane.element);
		return entry;
	}

	private disposeEntry(entry: OpenEntry, options: { releaseModel: boolean }): void {
		entry.paneListeners?.dispose();
		entry.pane?.dispose?.();
		entry.pane?.element.remove();
		if (options.releaseModel) {
			const record = this.models.get(entry.key);
			if (record) {
				record.listeners.dispose();
				record.model.dispose();
				this.models.delete(entry.key);
			}
		}
	}

	// ---- activation & rendering ----

	private isDirty(entry: OpenEntry): boolean {
		if (entry.paneDirty) {
			return true;
		}
		return entry.usesModel ? (this.models.get(entry.key)?.dirty ?? false) : false;
	}

	private setActive(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) {
			return;
		}
		if (this.activeKey && this.activeKey !== key) {
			const prev = this.entries.get(this.activeKey);
			if (prev?.kind === 'text') {
				prev.viewState = this.editor.saveViewState();
			}
		}
		this.activeKey = key;

		// show the right surface
		for (const other of this.entries.values()) {
			if (other.pane) {
				other.pane.element.style.display = other === entry ? '' : 'none';
			}
		}
		if (entry.kind === 'text') {
			this.editorHostEl.style.display = '';
			const record = this.models.get(key);
			this.editor.setModel(record?.model ?? null);
			if (entry.viewState) {
				this.editor.restoreViewState(entry.viewState);
			}
		} else {
			this.editorHostEl.style.display = 'none';
			this.editor.setModel(null);
		}

		this.updateEditorVisibility();
		this.renderTabs();
		this.layout(this.width, this.height);
		this._onDidChangeActiveFile.fire(entry.uri);
	}

	private focusActive(): void {
		const entry = this.activeKey ? this.entries.get(this.activeKey) : undefined;
		if (entry?.kind === 'custom') {
			entry.pane?.focus?.();
		} else {
			this.editor.focus();
		}
	}

	private updateEditorVisibility(): void {
		const entry = this.activeKey ? this.entries.get(this.activeKey) : undefined;
		this.watermarkEl.style.display = entry ? 'none' : '';
		if (!entry) {
			this.editorHostEl.style.display = 'none';
		}
	}

	private renderTabs(): void {
		clearNode(this.tabsListEl);
		for (const [key, entry] of this.entries) {
			const dirty = this.isDirty(entry);
			const tab = append(this.tabsListEl, $('.mw-tab'));
			tab.classList.toggle('active', key === this.activeKey);
			tab.classList.toggle('dirty', dirty);
			const provider = entry.viewType ? this.customEditors.get(entry.viewType) : undefined;
			tab.title = provider ? `${entry.uri.path} (${provider.displayName})` : entry.uri.path;
			const label = append(tab, $('span.mw-tab-label'));
			label.textContent = basename(entry.uri);
			const close = append(tab, $('.mw-tab-close'));
			const closeIcon = append(close, $('span.codicon'));
			closeIcon.classList.add(dirty ? 'codicon-circle-filled' : 'codicon-close');
			tab.addEventListener('click', (e) => {
				if (!(e.target instanceof Node) || !close.contains(e.target)) {
					this.setActive(key);
					this.focusActive();
				}
			});
			close.addEventListener('click', () => this.closeFile(entry.uri));
		}
		this.renderTabActions();
	}

	/** "Open with" affordances for the active file, like VS Code's editor title actions. */
	private renderTabActions(): void {
		clearNode(this.tabsActionsEl);
		const entry = this.activeKey ? this.entries.get(this.activeKey) : undefined;
		if (!entry) {
			return;
		}
		const addAction = (icon: string, title: string, run: () => void) => {
			const button = append(this.tabsActionsEl, $('.mw-tab-action'));
			button.title = title;
			append(button, $(`span.codicon.codicon-${icon}`));
			button.addEventListener('click', run);
		};
		for (const runner of this.runners.getForResource(entry.uri)) {
			if (this.isRunnerRunning(runner) && runner.stop) {
				addAction('debug-stop', `Stop ${runner.displayName}`, () => runner.stop!(entry.uri));
			} else {
				addAction('play', runner.displayName, () => this.runFile(runner, entry.uri));
			}
		}
		if (entry.kind === 'custom') {
			addAction('go-to-file', 'Reopen as Text Editor', () => this.openFile(entry.uri, { openWith: 'text' }));
		}
		for (const provider of this.customEditors.getForResource(entry.uri)) {
			if (provider.viewType !== entry.viewType) {
				addAction('open-preview', `Open with ${provider.displayName}`, () => this.openFile(entry.uri, { openWith: provider.viewType }));
			}
		}
	}

	/** Re-render tab actions (e.g. after a runner or custom editor was registered). */
	refreshActions(): void {
		this.renderTabActions();
	}

	override dispose(): void {
		for (const entry of this.entries.values()) {
			this.disposeEntry(entry, { releaseModel: true });
		}
		this.entries.clear();
		super.dispose();
	}
}
