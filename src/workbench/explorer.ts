import { $, append } from 'vs/base/browser/dom';
import { IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { AsyncDataTree } from 'vs/base/browser/ui/tree/asyncDataTree';
import { IAsyncDataSource, ITreeNode, ITreeRenderer } from 'vs/base/browser/ui/tree/tree';
import { Delayer } from 'vs/base/common/async';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { IFileStat } from 'vs/platform/files/common/files';
import { defaultListStyles } from 'vs/platform/theme/browser/defaultStyles';
import type { WorkspaceFileSystem } from '../fs/fileSystem';

interface FileTemplate {
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
}

const TEMPLATE_ID = 'mw-file';

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

	renderTemplate(container: HTMLElement): FileTemplate {
		const row = append(container, $('.mw-explorer-item'));
		const icon = append(row, $('span.codicon'));
		const label = append(row, $('span.mw-explorer-item-label'));
		return { icon, label };
	}

	renderElement(node: ITreeNode<IFileStat, void>, _index: number, template: FileTemplate): void {
		const stat = node.element;
		template.icon.classList.remove('codicon-file', 'codicon-folder');
		template.icon.classList.add(stat.isDirectory ? 'codicon-folder' : 'codicon-file');
		template.label.textContent = stat.name;
	}

	disposeTemplate(): void {
		// nothing to dispose: template DOM is owned by the tree row
	}
}

class FileDataSource implements IAsyncDataSource<IFileStat, IFileStat> {
	constructor(private readonly fs: WorkspaceFileSystem) { }

	hasChildren(element: IFileStat): boolean {
		return element.isDirectory;
	}

	async getChildren(element: IFileStat): Promise<IFileStat[]> {
		const stat = await this.fs.fileService.resolve(element.resource);
		const children = [...(stat.children ?? [])];
		children.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) {
				return a.isDirectory ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});
		return children;
	}
}

/**
 * The Explorer view: VS Code's AsyncDataTree over the workspace file system.
 */
export class ExplorerView extends Disposable {
	readonly element: HTMLElement;

	private readonly tree: AsyncDataTree<IFileStat, IFileStat>;
	private readonly refreshDelayer = this._register(new Delayer<void>(150));
	private rootStat: IFileStat | undefined;

	private readonly _onDidOpenFile = this._register(new Emitter<URI>());
	readonly onDidOpenFile: Event<URI> = this._onDidOpenFile.event;

	constructor(private readonly fs: WorkspaceFileSystem) {
		super();

		this.element = $('.mw-sidebar-pane.mw-explorer');

		this.tree = this._register(new AsyncDataTree<IFileStat, IFileStat>(
			'minwebide.explorer',
			this.element,
			new FileDelegate(),
			[new FileRenderer()],
			new FileDataSource(fs),
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
			if (stat && !stat.isDirectory) {
				this._onDidOpenFile.fire(stat.resource);
			}
		}));

		// refresh when anything in the workspace changes (also across windows,
		// via the provider's BroadcastChannel-based watching)
		this._register(fs.fileService.onDidFilesChange(() => {
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
}
