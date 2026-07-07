import { $, addDisposableListener, addStandardDisposableListener, append, EventType, isActiveElement } from 'vs/base/browser/dom';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { IContextViewProvider } from 'vs/base/browser/ui/contextview/contextview';
import { InputBox, MessageType } from 'vs/base/browser/ui/inputbox/inputBox';
import { IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { AsyncDataTree } from 'vs/base/browser/ui/tree/asyncDataTree';
import { IAsyncDataSource, ITreeContextMenuEvent, ITreeNode, ITreeRenderer } from 'vs/base/browser/ui/tree/tree';
import { Action, IAction, Separator } from 'vs/base/common/actions';
import { Delayer, timeout } from 'vs/base/common/async';
import { VSBuffer } from 'vs/base/common/buffer';
import { onUnexpectedError } from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { createSingleCallFunction } from 'vs/base/common/functional';
import { KeyCodeChord, ResolvedKeybinding } from 'vs/base/common/keybindings';
import { KeyCode } from 'vs/base/common/keyCodes';
import { Disposable, DisposableStore, dispose, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { OS } from 'vs/base/common/platform';
import { dirname, joinPath, relativePath } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { IFileStat } from 'vs/platform/files/common/files';
import { USLayoutResolvedKeybinding } from 'vs/platform/keybinding/common/usLayoutResolvedKeybinding';
import { defaultInputBoxStyles, defaultListStyles } from 'vs/platform/theme/browser/defaultStyles';
import type { WorkspaceFileSystem } from '../fs/fileSystem';
import type { WorkbenchServices } from './services';

interface FileTemplate {
	readonly row: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly elementDisposables: DisposableStore;
}

const TEMPLATE_ID = 'mw-file';

/** State for an in-progress inline rename or create, VS Code's IEditableData. */
interface EditableData {
	readonly initialValue: string;
	validationMessage(value: string): string | null;
	onFinish(value: string, success: boolean): void | Promise<void>;
}

interface IExplorerEditController {
	readonly contextViewProvider: IContextViewProvider;
	getEditableData(stat: IFileStat): EditableData | undefined;
}

function keybindingFor(keyCode: KeyCode): ResolvedKeybinding {
	return new USLayoutResolvedKeybinding([new KeyCodeChord(false, false, false, false, keyCode)], OS);
}

const EXPLORER_KEYBINDINGS = new Map<string, ResolvedKeybinding>([
	['minwebide.explorer.rename', keybindingFor(KeyCode.F2)],
	['minwebide.explorer.delete', keybindingFor(KeyCode.Delete)],
]);

/** VS Code's explorer file name validation, trimmed to what this fs supports. */
function validateFileName(value: string, options: { siblings: ReadonlySet<string>; currentName?: string; allowPathSegments: boolean }): string | null {
	if (!value || !value.trim()) {
		return 'A file or folder name must be provided.';
	}
	if (!options.allowPathSegments && value.includes('/')) {
		return `The name **${value}** is not valid as a file or folder name. Please choose a different name.`;
	}
	if (value.startsWith('/') || value.endsWith('/')) {
		return 'A file or folder name cannot start or end with a slash.';
	}
	for (const segment of value.split('/')) {
		if (!segment.trim() || segment === '.' || segment === '..') {
			return `The name **${segment}** is not valid as a file or folder name. Please choose a different name.`;
		}
	}
	const firstSegment = value.split('/')[0];
	if (!value.includes('/') && firstSegment !== options.currentName && options.siblings.has(firstSegment)) {
		return `A file or folder **${firstSegment}** already exists at this location. Please choose a different name.`;
	}
	return null;
}

class FileDelegate implements IListVirtualDelegate<IFileStat> {
	getHeight(): number {
		return 22;
	}
	getTemplateId(): string {
		return TEMPLATE_ID;
	}
}

class FileRenderer implements ITreeRenderer<IFileStat, void, FileTemplate> {
	readonly templateId = TEMPLATE_ID;

	constructor(private readonly controller: IExplorerEditController) { }

	renderTemplate(container: HTMLElement): FileTemplate {
		const row = append(container, $('.mw-explorer-item'));
		const icon = append(row, $('span.codicon'));
		const label = append(row, $('span.mw-explorer-item-label'));
		return { row, icon, label, elementDisposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<IFileStat, void>, _index: number, template: FileTemplate): void {
		const stat = node.element;
		template.icon.classList.remove('codicon-file', 'codicon-folder');
		template.icon.classList.add(stat.isDirectory ? 'codicon-folder' : 'codicon-file');

		const editable = this.controller.getEditableData(stat);
		if (editable) {
			template.label.style.display = 'none';
			template.elementDisposables.add(this.renderInputBox(template.row, stat, editable));
		} else {
			template.label.style.display = '';
			template.label.textContent = stat.name;
		}
	}

	/** An inline name editor in the tree row, mirroring VS Code's explorer. */
	private renderInputBox(container: HTMLElement, stat: IFileStat, editable: EditableData): IDisposable {
		const inputContainer = append(container, $('.mw-explorer-item-input'));
		const inputBox = new InputBox(inputContainer, this.controller.contextViewProvider, {
			validationOptions: {
				validation: (value) => {
					const message = editable.validationMessage(value);
					return message ? { content: message, formatContent: true, type: MessageType.ERROR } : null;
				},
			},
			ariaLabel: 'Type file name. Press Enter to confirm or Escape to cancel.',
			inputBoxStyles: defaultInputBoxStyles,
		});

		const value = editable.initialValue;
		inputBox.value = value;
		inputBox.focus();
		const lastDot = value.lastIndexOf('.');
		inputBox.select({ start: 0, end: lastDot > 0 && !stat.isDirectory ? lastDot : value.length });

		const done = createSingleCallFunction((success: boolean, finishEditing: boolean) => {
			const finalValue = inputBox.value;
			dispose(toDispose);
			inputContainer.remove();
			if (finishEditing) {
				editable.onFinish(finalValue, success);
			}
		});

		const toDispose = [
			inputBox,
			addStandardDisposableListener(inputBox.inputElement, EventType.KEY_DOWN, (e: IKeyboardEvent) => {
				// keep the tree's own keyboard handling (navigation, F2/Delete,
				// type-ahead) away from the edit
				e.stopPropagation();
				if (e.equals(KeyCode.Enter)) {
					if (!inputBox.validate()) {
						done(true, true);
					}
				} else if (e.equals(KeyCode.Escape)) {
					done(false, true);
				}
			}),
			addStandardDisposableListener(inputBox.inputElement, EventType.KEY_UP, (e: IKeyboardEvent) => {
				e.stopPropagation();
			}),
			addDisposableListener(inputBox.inputElement, EventType.BLUR, async () => {
				await timeout(0);
				if (!isActiveElement(inputBox.inputElement)) {
					done(inputBox.isInputValid(), true);
				}
			}),
		];
		return toDisposable(() => done(false, false));
	}

	disposeElement(_element: ITreeNode<IFileStat, void>, _index: number, template: FileTemplate): void {
		template.elementDisposables.clear();
	}

	disposeTemplate(template: FileTemplate): void {
		template.elementDisposables.dispose();
	}
}

class FileDataSource implements IAsyncDataSource<IFileStat, IFileStat> {
	constructor(
		private readonly fs: WorkspaceFileSystem,
		private readonly getCreatePlaceholder: (parentKey: string) => IFileStat | undefined,
		private readonly onChildren: (parentKey: string, children: IFileStat[]) => void,
	) { }

	hasChildren(element: IFileStat): boolean {
		return element.isDirectory;
	}

	async getChildren(element: IFileStat): Promise<IFileStat[]> {
		const stat = await this.fs.fileService.resolve(element.resource);
		const children = [...(stat.children ?? [])];
		const placeholder = this.getCreatePlaceholder(element.resource.toString());
		if (placeholder) {
			children.push(placeholder);
		}
		children.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) {
				return a.isDirectory ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});
		this.onChildren(element.resource.toString(), children);
		return children;
	}
}

/**
 * The Explorer view: VS Code's AsyncDataTree over the workspace file system,
 * with VS Code-style file management (context menu, inline rename/create,
 * delete with confirmation, F2/Delete keybindings).
 */
export class ExplorerView extends Disposable {
	readonly element: HTMLElement;

	private readonly tree: AsyncDataTree<IFileStat, IFileStat>;
	private readonly refreshDelayer = this._register(new Delayer<void>(150));
	private rootStat: IFileStat | undefined;

	private editable: { key: string; data: EditableData } | undefined;
	private pendingCreate: { parentKey: string; placeholder: IFileStat } | undefined;
	/** Last children handed to the tree, per parent, to look up fresh elements by resource. */
	private readonly lastChildren = new Map<string, IFileStat[]>();

	private readonly _onDidOpenFile = this._register(new Emitter<{ uri: URI; focusEditor: boolean }>());
	/**
	 * Like VS Code, opening by clicking in the tree keeps focus in the tree
	 * (focusEditor false); a freshly created file focuses the editor.
	 */
	readonly onDidOpenFile: Event<{ uri: URI; focusEditor: boolean }> = this._onDidOpenFile.event;

	private readonly _onDidMove = this._register(new Emitter<{ from: URI; to: URI }>());
	readonly onDidMove: Event<{ from: URI; to: URI }> = this._onDidMove.event;

	private readonly _onDidDelete = this._register(new Emitter<URI>());
	readonly onDidDelete: Event<URI> = this._onDidDelete.event;

	constructor(
		private readonly fs: WorkspaceFileSystem,
		private readonly services: WorkbenchServices,
	) {
		super();

		this.element = $('.mw-sidebar-pane.mw-explorer');

		const controller: IExplorerEditController = {
			contextViewProvider: services.contextViewService,
			getEditableData: (stat) => this.editable?.key === stat.resource.toString() ? this.editable.data : undefined,
		};

		this.tree = this._register(new AsyncDataTree<IFileStat, IFileStat>(
			'minwebide.explorer',
			this.element,
			new FileDelegate(),
			[new FileRenderer(controller)],
			new FileDataSource(
				fs,
				(parentKey) => this.pendingCreate?.parentKey === parentKey ? this.pendingCreate.placeholder : undefined,
				(parentKey, children) => this.lastChildren.set(parentKey, children),
			),
			{
				identityProvider: { getId: (stat: IFileStat) => stat.resource.toString() },
				accessibilityProvider: {
					getAriaLabel: (stat: IFileStat) => stat.name,
					getWidgetAriaLabel: () => 'Files Explorer',
				},
				expandOnlyOnTwistieClick: false,
			},
		));
		this.tree.style(defaultListStyles);

		this._register(this.tree.onDidChangeSelection((e) => {
			const stat = e.elements[0];
			if (stat && !stat.isDirectory && this.pendingCreate?.placeholder !== stat) {
				this._onDidOpenFile.fire({ uri: stat.resource, focusEditor: false });
			}
		}));

		// like VS Code: single click previews keeping focus in the tree,
		// double click (or Enter) hands focus to the editor
		this._register(this.tree.onMouseDblClick((e) => {
			if (e.element && !e.element.isDirectory && this.pendingCreate?.placeholder !== e.element) {
				this._onDidOpenFile.fire({ uri: e.element.resource, focusEditor: true });
			}
		}));

		this._register(this.tree.onContextMenu((e) => this.onContextMenu(e)));

		this._register(addStandardDisposableListener(this.tree.getHTMLElement(), EventType.KEY_DOWN, (e: IKeyboardEvent) => {
			if (this.editable) {
				return;
			}
			const stat = this.tree.getFocus()[0];
			if (!stat) {
				return;
			}
			if (e.equals(KeyCode.F2)) {
				e.preventDefault();
				e.stopPropagation();
				this.startRename(stat);
			} else if (e.equals(KeyCode.Delete)) {
				e.preventDefault();
				e.stopPropagation();
				this.deleteStat(stat);
			} else if (e.equals(KeyCode.Enter) && !stat.isDirectory) {
				this._onDidOpenFile.fire({ uri: stat.resource, focusEditor: true });
			}
		}));

		// refresh when anything in the workspace changes (also across windows,
		// via the provider's BroadcastChannel-based watching); hold off while an
		// inline edit is in progress so the input box isn't re-rendered away
		this._register(fs.fileService.onDidFilesChange(() => {
			if (this.editable) {
				return;
			}
			this.refreshDelayer.trigger(() => this.refresh());
		}));
	}

	async setRoot(): Promise<void> {
		this.rootStat = await this.fs.fileService.resolve(this.fs.root);
		await this.tree.setInput(this.rootStat);
	}

	async refresh(): Promise<void> {
		if (this.rootStat) {
			await this.tree.updateChildren(this.rootStat);
		}
	}

	layout(height: number, width: number): void {
		this.tree.layout(height, width);
	}

	// ---- file operations ----

	private onContextMenu(e: ITreeContextMenuEvent<IFileStat>): void {
		e.browserEvent.preventDefault();
		e.browserEvent.stopPropagation();
		if (!this.rootStat || (e.element && this.editable?.key === e.element.resource.toString())) {
			return;
		}
		const stat = e.element;
		if (stat) {
			this.tree.setFocus([stat]);
		}

		const targetFolder = !stat ? this.rootStat : stat.isDirectory ? stat : this.parentOf(stat);
		// the menu's action runner reports errors to a notification service this
		// workbench doesn't render, so surface them on the console instead
		const actions: IAction[] = [
			new Action('minwebide.explorer.newFile', 'New File...', undefined, true, () => this.startCreate(targetFolder, 'file').catch(onUnexpectedError)),
			new Action('minwebide.explorer.newFolder', 'New Folder...', undefined, true, () => this.startCreate(targetFolder, 'folder').catch(onUnexpectedError)),
		];
		if (stat) {
			actions.push(
				new Separator(),
				new Action('minwebide.explorer.copyPath', 'Copy Path', undefined, true, () => navigator.clipboard.writeText(stat.resource.path)),
				new Action('minwebide.explorer.copyRelativePath', 'Copy Relative Path', undefined, true,
					() => navigator.clipboard.writeText(relativePath(this.fs.root, stat.resource) ?? stat.resource.path)),
				new Separator(),
				new Action('minwebide.explorer.rename', 'Rename...', undefined, true, () => this.startRename(stat).catch(onUnexpectedError)),
				new Action('minwebide.explorer.delete', 'Delete', undefined, true, () => this.deleteStat(stat).catch(onUnexpectedError)),
			);
		}

		this.services.contextMenuService.showContextMenu({
			getAnchor: () => e.anchor,
			getActions: () => actions,
			getKeyBinding: (action) => EXPLORER_KEYBINDINGS.get(action.id),
		});
	}

	private parentOf(stat: IFileStat): IFileStat {
		// getParentElement yields null for top-level elements: the tree input
		// itself is not an element
		return (this.tree.getParentElement(stat) as IFileStat | null) ?? this.rootStat!;
	}

	private async siblingNames(parent: URI): Promise<Set<string>> {
		const stat = await this.fs.fileService.resolve(parent);
		return new Set((stat.children ?? []).map(c => c.name));
	}

	private focusResource(parentKey: string, resource: URI): void {
		const match = this.lastChildren.get(parentKey)?.find(c => c.resource.toString() === resource.toString());
		if (match) {
			this.tree.reveal(match);
			this.tree.setFocus([match]);
		}
	}

	async startRename(stat: IFileStat): Promise<void> {
		if (this.editable || !this.rootStat) {
			return;
		}
		const parentResource = dirname(stat.resource);
		const parentKey = parentResource.toString();
		const siblings = await this.siblingNames(parentResource);
		this.editable = {
			key: stat.resource.toString(),
			data: {
				initialValue: stat.name,
				validationMessage: (value) => validateFileName(value, { siblings, currentName: stat.name, allowPathSegments: false }),
				onFinish: async (value, success) => {
					this.editable = undefined;
					if (!success || !value || value === stat.name) {
						this.tree.rerender(stat);
						this.tree.domFocus();
						return;
					}
					const target = joinPath(parentResource, value);
					try {
						await this.fs.fileService.move(stat.resource, target);
						this._onDidMove.fire({ from: stat.resource, to: target });
					} catch (error) {
						await this.services.error(`Unable to rename '${stat.name}'.`, String(error));
					}
					await this.refresh();
					this.focusResource(parentKey, target);
					this.tree.domFocus();
				},
			},
		};
		this.tree.rerender(stat);
	}

	async startCreate(parent: IFileStat, kind: 'file' | 'folder'): Promise<void> {
		if (this.editable || !this.rootStat) {
			return;
		}
		const isDirectory = kind === 'folder';
		if (parent !== this.rootStat) {
			await this.tree.expand(parent);
		}
		const parentKey = parent.resource.toString();
		const siblings = await this.siblingNames(parent.resource);
		const placeholder: IFileStat = {
			resource: joinPath(parent.resource, '__minwebide-new__').with({ query: 'minwebide-new' }),
			name: '',
			isFile: !isDirectory,
			isDirectory,
			isSymbolicLink: false,
			children: undefined,
		};
		this.pendingCreate = { parentKey, placeholder };
		this.editable = {
			key: placeholder.resource.toString(),
			data: {
				initialValue: '',
				validationMessage: (value) => validateFileName(value, { siblings, allowPathSegments: true }),
				onFinish: async (value, success) => {
					this.editable = undefined;
					this.pendingCreate = undefined;
					if (!success || !value) {
						await this.tree.updateChildren(parent);
						this.tree.domFocus();
						return;
					}
					// like VS Code, slashes in the name create intermediate folders
					const target = joinPath(parent.resource, ...value.split('/').filter(s => s.length));
					try {
						if (isDirectory) {
							await this.fs.fileService.createFolder(target);
						} else {
							await this.fs.fileService.createFolder(dirname(target));
							await this.fs.fileService.createFile(target, VSBuffer.fromString(''), { overwrite: false });
						}
					} catch (error) {
						await this.services.error(`Unable to create '${value}'.`, String(error));
						await this.tree.updateChildren(parent);
						return;
					}
					await this.tree.updateChildren(parent);
					this.focusResource(parentKey, target);
					if (isDirectory) {
						this.tree.domFocus();
					} else {
						this._onDidOpenFile.fire({ uri: target, focusEditor: true });
					}
				},
			},
		};
		await this.tree.updateChildren(parent);
	}

	async deleteStat(stat: IFileStat): Promise<void> {
		const confirmed = await this.services.confirm({
			message: stat.isDirectory
				? `Are you sure you want to permanently delete '${stat.name}' and its contents?`
				: `Are you sure you want to permanently delete '${stat.name}'?`,
			detail: 'This action is irreversible!',
			primaryButton: 'Delete',
			type: 'warning',
		});
		if (!confirmed) {
			return;
		}
		try {
			await this.fs.fileService.del(stat.resource, { recursive: true });
			this._onDidDelete.fire(stat.resource);
		} catch (error) {
			await this.services.error(`Unable to delete '${stat.name}'.`, String(error));
		}
		await this.refresh();
		this.tree.domFocus();
	}
}
