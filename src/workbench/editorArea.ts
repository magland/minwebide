import { $, append, clearNode } from 'vs/base/browser/dom';
import { VSBuffer } from 'vs/base/common/buffer';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, DisposableStore, IDisposable } from 'vs/base/common/lifecycle';
import { basename } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import * as monaco from '../editor/monaco';
import type { WorkspaceFileSystem } from '../fs/fileSystem';

interface OpenFileEntry {
	readonly uri: URI;
	readonly model: monaco.editor.ITextModel;
	readonly listeners: DisposableStore;
	savedVersionId: number;
	dirty: boolean;
	viewState: monaco.editor.ICodeEditorViewState | null;
}

/**
 * The editor area: a tab bar plus a single Monaco editor that swaps models,
 * reading and saving file contents through VS Code's FileService.
 */
export class EditorArea extends Disposable {
	readonly element: HTMLElement;
	readonly editor: monaco.editor.IStandaloneCodeEditor;

	private readonly tabsEl: HTMLElement;
	private readonly editorContainerEl: HTMLElement;
	private readonly watermarkEl: HTMLElement;

	private readonly openFiles = new Map<string, OpenFileEntry>();
	private activeKey: string | undefined;
	private width = 0;
	private height = 0;

	private readonly _onDidChangeActiveFile = this._register(new Emitter<URI | undefined>());
	readonly onDidChangeActiveFile: Event<URI | undefined> = this._onDidChangeActiveFile.event;

	constructor(private readonly fs: WorkspaceFileSystem, theme: string) {
		super();

		this.element = $('.mw-editor-area');
		this.tabsEl = append(this.element, $('.mw-tabs'));
		this.editorContainerEl = append(this.element, $('.mw-editor-container'));
		this.watermarkEl = append(this.editorContainerEl, $('.mw-watermark'));
		append(this.watermarkEl, $('span.codicon.codicon-files'));
		append(this.watermarkEl, $('span', undefined, 'Open a file from the Explorer to get started'));

		const editorHost = append(this.editorContainerEl, $('div'));
		editorHost.style.position = 'absolute';
		editorHost.style.inset = '0';

		this.editor = this._register(monaco.editor.create(editorHost, {
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

		this.updateEditorVisibility();
	}

	get activeUri(): URI | undefined {
		return this.activeKey ? this.openFiles.get(this.activeKey)?.uri : undefined;
	}

	async openFile(uri: URI, options?: { revealRange?: monaco.IRange }): Promise<void> {
		const key = uri.toString();
		let entry = this.openFiles.get(key);
		if (!entry) {
			const content = await this.fs.fileService.readFile(uri);
			const text = content.value.toString();
			const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, undefined, uri);
			const listeners = new DisposableStore();
			entry = {
				uri,
				model,
				listeners,
				savedVersionId: model.getAlternativeVersionId(),
				dirty: false,
				viewState: null,
			};
			listeners.add(model.onDidChangeContent(() => {
				const dirty = entry!.model.getAlternativeVersionId() !== entry!.savedVersionId;
				if (dirty !== entry!.dirty) {
					entry!.dirty = dirty;
					this.renderTabs();
				}
			}));
			this.openFiles.set(key, entry);
		}
		this.setActive(key);
		if (options?.revealRange) {
			this.editor.revealRangeInCenter(options.revealRange);
			this.editor.setSelection(options.revealRange);
		}
		this.editor.focus();
	}

	closeFile(uri: URI): void {
		const key = uri.toString();
		const entry = this.openFiles.get(key);
		if (!entry) {
			return;
		}
		if (entry.dirty && !confirm(`Discard unsaved changes to ${basename(uri)}?`)) {
			return;
		}
		if (this.activeKey === key) {
			this.editor.setModel(null);
			this.activeKey = undefined;
		}
		entry.listeners.dispose();
		entry.model.dispose();
		this.openFiles.delete(key);
		if (!this.activeKey) {
			const next = [...this.openFiles.keys()].pop();
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

	async saveActive(): Promise<void> {
		if (!this.activeKey) {
			return;
		}
		const entry = this.openFiles.get(this.activeKey);
		if (!entry) {
			return;
		}
		await this.fs.fileService.writeFile(entry.uri, VSBuffer.fromString(entry.model.getValue()));
		entry.savedVersionId = entry.model.getAlternativeVersionId();
		entry.dirty = false;
		this.renderTabs();
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		const tabsHeight = this.tabsEl.offsetHeight;
		this.editor.layout({ width, height: Math.max(0, height - tabsHeight) });
	}

	private setActive(key: string): void {
		if (this.activeKey === key) {
			return;
		}
		// stash view state of the outgoing file
		if (this.activeKey) {
			const prev = this.openFiles.get(this.activeKey);
			if (prev) {
				prev.viewState = this.editor.saveViewState();
			}
		}
		const entry = this.openFiles.get(key);
		if (!entry) {
			return;
		}
		this.activeKey = key;
		this.editor.setModel(entry.model);
		if (entry.viewState) {
			this.editor.restoreViewState(entry.viewState);
		}
		this.updateEditorVisibility();
		this.renderTabs();
		this._onDidChangeActiveFile.fire(entry.uri);
	}

	private updateEditorVisibility(): void {
		const hasFile = this.openFiles.size > 0 && !!this.activeKey;
		this.watermarkEl.style.display = hasFile ? 'none' : '';
		if (this.width && this.height) {
			this.layout(this.width, this.height);
		}
	}

	private renderTabs(): void {
		clearNode(this.tabsEl);
		for (const [key, entry] of this.openFiles) {
			const tab = append(this.tabsEl, $('.mw-tab'));
			tab.classList.toggle('active', key === this.activeKey);
			tab.classList.toggle('dirty', entry.dirty);
			tab.title = entry.uri.path;
			const label = append(tab, $('span.mw-tab-label'));
			label.textContent = basename(entry.uri);
			const close = append(tab, $('.mw-tab-close'));
			const closeIcon = append(close, $('span.codicon'));
			closeIcon.classList.add(entry.dirty ? 'codicon-circle-filled' : 'codicon-close');
			tab.addEventListener('click', (e) => {
				if (!(e.target instanceof Node) || !close.contains(e.target)) {
					this.setActive(key);
				}
			});
			close.addEventListener('click', () => this.closeFile(entry.uri));
		}
	}

	override dispose(): void {
		for (const entry of this.openFiles.values()) {
			entry.listeners.dispose();
			entry.model.dispose();
		}
		this.openFiles.clear();
		super.dispose();
	}
}
