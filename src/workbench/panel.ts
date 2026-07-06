import { $, append } from 'vs/base/browser/dom';
import { Disposable } from 'vs/base/common/lifecycle';

export interface PanelTab {
	readonly id: string;
	readonly title: string;
	readonly element: HTMLElement;
	/** Mounted in the panel title area while this tab is active. */
	readonly actions?: HTMLElement;
	onLayout?(width: number, height: number): void;
}

/**
 * The bottom panel: a VS Code-style panel title bar with switchable tabs
 * (terminal, output, ...) and per-tab title-area actions.
 */
export class Panel extends Disposable {
	readonly element: HTMLElement;

	private readonly headerEl: HTMLElement;
	private readonly tabsEl: HTMLElement;
	private readonly actionsHostEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private readonly tabs = new Map<string, { headerEl: HTMLElement; tab: PanelTab }>();
	private activeId: string | undefined;
	private width = 0;
	private height = 0;

	constructor() {
		super();
		this.element = $('.mw-panel');
		this.headerEl = append(this.element, $('.mw-panel-header'));
		this.tabsEl = append(this.headerEl, $('.mw-panel-tabs'));
		this.actionsHostEl = append(this.headerEl, $('.mw-panel-actions'));
		this.bodyEl = append(this.element, $('.mw-panel-body'));
	}

	addTab(tab: PanelTab): void {
		const headerEl = append(this.tabsEl, $('.mw-panel-tab'));
		headerEl.textContent = tab.title;
		headerEl.addEventListener('click', () => this.setActive(tab.id));
		tab.element.style.position = 'absolute';
		tab.element.style.inset = '0';
		tab.element.style.display = 'none';
		append(this.bodyEl, tab.element);
		if (tab.actions) {
			tab.actions.style.display = 'none';
			append(this.actionsHostEl, tab.actions);
		}
		this.tabs.set(tab.id, { headerEl, tab });
		if (!this.activeId) {
			this.setActive(tab.id);
		}
	}

	setActive(id: string): void {
		const next = this.tabs.get(id);
		if (!next) {
			return;
		}
		for (const { headerEl, tab } of this.tabs.values()) {
			const active = tab.id === id;
			headerEl.classList.toggle('active', active);
			tab.element.style.display = active ? '' : 'none';
			if (tab.actions) {
				tab.actions.style.display = active ? '' : 'none';
			}
		}
		this.activeId = id;
		this.layoutActiveTab();
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.layoutActiveTab();
	}

	private layoutActiveTab(): void {
		const active = this.activeId ? this.tabs.get(this.activeId) : undefined;
		if (active && this.width > 0 && this.height > 0) {
			active.tab.onLayout?.(this.width, Math.max(0, this.height - this.headerEl.offsetHeight));
		}
	}
}
