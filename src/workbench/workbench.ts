import { $, append } from 'vs/base/browser/dom';
import { DEFAULT_FONT_FAMILY } from 'vs/base/browser/fonts';
import { Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { LayoutPriority, Orientation, Sizing, SplitView, IView } from 'vs/base/browser/ui/splitview/splitview';
import { getIconsStyleSheet } from 'vs/platform/theme/browser/iconsStyleSheet';
import 'vs/base/browser/ui/codicons/codicon/codicon.css';
import 'vs/base/browser/ui/codicons/codicon/codicon-modifiers.css';
import './workbench.css';

import * as monaco from '../editor/monaco';
import type { WorkspaceFileSystem } from '../fs/fileSystem';
import { defineEditorTheme } from '../theme/editorTheme';
import { applyThemeToElement, WorkbenchTheme } from '../theme/themes';
import { ActivityBar } from './activityBar';
import { CustomEditorProvider, CustomEditorRegistry } from './customEditors';
import { EditorArea, OpenFileOptions } from './editorArea';
import { ExplorerView } from './explorer';
import { LogOutputChannel, OutputChannel, OutputChannelOptions, OutputView } from './outputChannels';
import { Panel } from './panel';
import { FileRunner, RunnerRegistry } from './runners';
import { SearchView } from './searchView';
import { StatusBar } from './statusBar';

export interface WorkbenchOptions {
	readonly fileSystem: WorkspaceFileSystem;
	readonly theme: WorkbenchTheme;
	readonly workspaceName?: string;
	/** Custom editors to register up front (more can be added via registerCustomEditor). */
	readonly customEditors?: readonly CustomEditorProvider[];
}

let iconsInjected = false;
function injectIconsStyleSheet(): void {
	// VS Code generates the codicon CSS classes at runtime from its icon
	// registry; do the same (the codicon font itself comes via codicon.css).
	if (iconsInjected) {
		return;
	}
	iconsInjected = true;
	const sheet = getIconsStyleSheet(undefined);
	const style = document.createElement('style');
	style.textContent = sheet.getCSS();
	sheet.onDidChange(() => { style.textContent = sheet.getCSS(); });
	document.head.appendChild(style);
}

class ElementView implements IView {
	readonly maximumSize = Number.POSITIVE_INFINITY;
	readonly onDidChange = Event.None;
	constructor(
		readonly element: HTMLElement,
		readonly minimumSize: number,
		readonly priority: LayoutPriority,
		private readonly onLayout: (size: number) => void,
	) { }
	layout(size: number): void {
		this.onLayout(size);
	}
}

export class Workbench extends Disposable {
	readonly element: HTMLElement;
	readonly explorer: ExplorerView;
	readonly search: SearchView;
	readonly editorArea: EditorArea;
	readonly panel: Panel;
	readonly statusBar: StatusBar;
	readonly activityBar: ActivityBar;
	readonly customEditors = new CustomEditorRegistry();
	readonly runners = new RunnerRegistry();
	readonly output: OutputView;

	private readonly runnerChannels = new Map<string, LogOutputChannel>();

	private readonly outerSplit: SplitView;
	private readonly innerSplit: SplitView;
	private readonly sidebarBodyEl: HTMLElement;
	private readonly sidebarTitleEl: HTMLElement;
	private readonly sidebarPanes = new Map<string, { title: string; element: HTMLElement; onShow?: () => void }>();

	private mainHeight = 0;
	private sidebarWidth = 0;
	private columnWidth = 0;
	private editorHeight = 0;
	private panelHeight = 0;
	private activeSideViewId = 'explorer';

	constructor(container: HTMLElement, private readonly options: WorkbenchOptions) {
		super();

		injectIconsStyleSheet();

		this.element = $('.minwebide-workbench');
		this.element.style.fontFamily = DEFAULT_FONT_FAMILY;
		applyThemeToElement(options.theme, this.element);
		const editorThemeName = defineEditorTheme(options.theme);

		const mainEl = append(this.element, $('.mw-main'));

		// activity bar
		this.activityBar = this._register(new ActivityBar([
			{ id: 'explorer', icon: 'files', title: 'Explorer' },
			{ id: 'search', icon: 'search', title: 'Search' },
		]));
		mainEl.appendChild(this.activityBar.element);
		this._register(this.activityBar.onDidSelect(id => this.showSideView(id)));

		// split area: [ sidebar | editor column ]
		const splitsEl = append(mainEl, $('.mw-splits'));
		splitsEl.style.flex = '1';
		splitsEl.style.minWidth = '0';
		splitsEl.style.position = 'relative';

		// sidebar
		const sidebarEl = $('.mw-sidebar');
		this.sidebarTitleEl = append(sidebarEl, $('.mw-sidebar-title'));
		this.sidebarBodyEl = append(sidebarEl, $('.mw-sidebar-body'));

		// editor + panel column
		const columnEl = $('.mw-column');
		columnEl.style.height = '100%';
		columnEl.style.position = 'relative';

		for (const provider of options.customEditors ?? []) {
			this.customEditors.register(provider);
		}

		// construct all parts before wiring them into splitviews: addView
		// fires layout callbacks synchronously
		this.editorArea = this._register(new EditorArea(
			options.fileSystem,
			editorThemeName,
			this.customEditors,
			this.runners,
			(runner, uri) => this.runFile(runner, uri),
		));
		this.panel = this._register(new Panel());
		this.explorer = this._register(new ExplorerView(options.fileSystem));
		this.search = this._register(new SearchView(options.fileSystem));
		this.output = this._register(new OutputView(editorThemeName, () => this.panel.setActive('output')));

		this.outerSplit = this._register(new SplitView(splitsEl, { orientation: Orientation.HORIZONTAL, proportionalLayout: false }));
		this.outerSplit.addView(new ElementView(sidebarEl, 170, LayoutPriority.Low, (size) => {
			this.sidebarWidth = size;
			this.layoutSidebar();
		}), 260);
		this.outerSplit.addView(new ElementView(columnEl, 300, LayoutPriority.High, (size) => {
			this.columnWidth = size;
			this.editorArea.layout(size, this.editorHeight);
			this.panel.layout(size, this.panelHeight);
		}), Sizing.Distribute);

		this.innerSplit = this._register(new SplitView(columnEl, { orientation: Orientation.VERTICAL, proportionalLayout: false }));
		this.innerSplit.addView(new ElementView(this.editorArea.element, 100, LayoutPriority.High, (size) => {
			this.editorHeight = size;
			this.editorArea.layout(this.columnWidth, size);
		}), Sizing.Distribute);
		this.innerSplit.addView(new ElementView(this.panel.element, 60, LayoutPriority.Low, (size) => {
			this.panelHeight = size;
			this.panel.layout(this.columnWidth, size);
		}), 200);

		// sidebar views
		this.registerSideView('explorer', options.workspaceName ? `Explorer: ${options.workspaceName}` : 'Explorer', this.explorer.element, () => this.layoutSidebar());
		this._register(this.explorer.onDidOpenFile(uri => this.openFile(uri)));

		this.registerSideView('search', 'Search', this.search.element, () => {
			this.layoutSidebar();
			this.search.focus();
		});
		this._register(this.search.onDidOpenMatch(match => this.openFile(match.uri, {
			revealRange: {
				startLineNumber: match.lineNumber,
				startColumn: match.column,
				endLineNumber: match.lineNumber,
				endColumn: match.column + match.length,
			},
		})));

		// panel tabs
		this.panel.addTab({
			id: 'output',
			title: 'Output',
			element: this.output.element,
			actions: this.output.actionsElement,
			onLayout: (width, height) => this.output.layout(width, height),
		});

		// status bar
		this.statusBar = this._register(new StatusBar());
		this.element.appendChild(this.statusBar.element);
		this.statusBar.setItem('branding', 'left', options.workspaceName ?? 'minwebide', { icon: 'vm' });
		this.statusBar.setItem('theme', 'right', options.theme.label, { icon: 'color-mode' });
		this.wireStatusBarEditorInfo();

		// keep browser Ctrl+S from hijacking save anywhere in the workbench
		this.element.addEventListener('keydown', (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 's') {
				e.preventDefault();
				this.editorArea.saveActive();
			}
		});

		container.appendChild(this.element);

		// drive layout from the split container's size
		let didInitialSizing = false;
		const observer = new ResizeObserver((entries) => {
			const rect = entries[entries.length - 1].contentRect;
			this.mainHeight = rect.height;
			this.outerSplit.layout(rect.width);
			this.innerSplit.layout(rect.height);
			if (!didInitialSizing && rect.width > 0 && rect.height > 0) {
				// views were added while the container had no size, which
				// squeezes them to their minimums; apply the intended initial
				// sizes now that real dimensions exist
				didInitialSizing = true;
				this.outerSplit.resizeView(0, 260);
				this.innerSplit.resizeView(1, Math.min(240, Math.floor(rect.height * 0.3)));
			}
			this.layoutSidebar();
		});
		observer.observe(splitsEl);
		this._register({ dispose: () => observer.disconnect() });

		this.showSideView('explorer');
		this.explorer.setRoot();
	}

	registerSideView(id: string, title: string, element: HTMLElement, onShow?: () => void): void {
		element.style.display = 'none';
		this.sidebarBodyEl.appendChild(element);
		this.sidebarPanes.set(id, { title, element, onShow });
	}

	showSideView(id: string): void {
		const pane = this.sidebarPanes.get(id);
		if (!pane) {
			return;
		}
		for (const [paneId, p] of this.sidebarPanes) {
			p.element.style.display = paneId === id ? '' : 'none';
		}
		this.activeSideViewId = id;
		this.sidebarTitleEl.textContent = pane.title;
		this.activityBar.setActive(id);
		pane.onShow?.();
	}

	async openFile(uri: URI, options?: OpenFileOptions): Promise<void> {
		await this.editorArea.openFile(uri, options);
	}

	registerCustomEditor(provider: CustomEditorProvider) {
		const disposable = this.customEditors.register(provider);
		this.editorArea.refreshActions();
		return disposable;
	}

	/** Mirrors VS Code's `window.createOutputChannel(name, { log })`. */
	createOutputChannel(name: string, options?: OutputChannelOptions & { log?: false }): OutputChannel;
	createOutputChannel(name: string, options: OutputChannelOptions & { log: true }): LogOutputChannel;
	createOutputChannel(name: string, options?: OutputChannelOptions): OutputChannel | LogOutputChannel {
		return options?.log
			? this.output.createChannel(name, { log: true })
			: this.output.createChannel(name);
	}

	registerRunner(runner: FileRunner) {
		const disposable = this.runners.register(runner);
		this.editorArea.refreshActions();
		return disposable;
	}

	private async runFile(runner: FileRunner, uri: URI): Promise<void> {
		let channel = this.runnerChannels.get(runner.id);
		if (!channel) {
			channel = this.output.createChannel(runner.displayName, { log: true });
			this.runnerChannels.set(runner.id, channel);
		}
		channel.show();
		try {
			await runner.run({
				uri,
				// prefer the open editor's (possibly unsaved) contents
				getText: async () => {
					const model = monaco.editor.getModel(uri);
					if (model) {
						return model.getValue();
					}
					return (await this.options.fileSystem.fileService.readFile(uri)).value.toString();
				},
				readBytes: async () => (await this.options.fileSystem.fileService.readFile(uri)).value.buffer,
				output: channel,
			});
		} catch (error) {
			channel.error(error instanceof Error ? error : String(error));
		}
	}

	private layoutSidebar(): void {
		const height = this.sidebarBodyEl.clientHeight || (this.mainHeight - 35);
		if (this.activeSideViewId === 'search') {
			this.search.layout(height, this.sidebarWidth);
		} else {
			this.explorer.layout(height, this.sidebarWidth);
		}
	}

	private wireStatusBarEditorInfo(): void {
		const editor = this.editorArea.editor;
		const update = () => {
			const model = editor.getModel();
			if (!model) {
				this.statusBar.removeItem('cursor');
				this.statusBar.removeItem('language');
				return;
			}
			const pos = editor.getPosition();
			if (pos) {
				this.statusBar.setItem('cursor', 'right', `Ln ${pos.lineNumber}, Col ${pos.column}`);
			}
			this.statusBar.setItem('language', 'right', model.getLanguageId());
		};
		this._register(editor.onDidChangeCursorPosition(update));
		this._register(editor.onDidChangeModel(update));
		this._register(editor.onDidChangeModelLanguage(update));
	}
}

export function createWorkbench(container: HTMLElement, options: WorkbenchOptions): Workbench {
	return new Workbench(container, options);
}
