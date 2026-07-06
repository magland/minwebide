import { $, append } from 'vs/base/browser/dom';
import { Disposable } from 'vs/base/common/lifecycle';

export interface PanelTab {
	readonly id: string;
	readonly title: string;
	readonly element: HTMLElement;
}

/**
 * The bottom panel: a VS Code-style panel title bar with switchable tabs
 * (terminal, output, ...).
 */
export class Panel extends Disposable {
	readonly element: HTMLElement;

	private readonly headerEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private readonly tabs = new Map<string, { headerEl: HTMLElement; tab: PanelTab }>();
	private activeId: string | undefined;
	private readonly onDidActivate: (id: string) => void;

	constructor(onDidActivate: (id: string) => void = () => { }) {
		super();
		this.onDidActivate = onDidActivate;
		this.element = $('.mw-panel');
		this.headerEl = append(this.element, $('.mw-panel-header'));
		this.bodyEl = append(this.element, $('.mw-panel-body'));
	}

	addTab(tab: PanelTab): void {
		const headerEl = append(this.headerEl, $('.mw-panel-tab'));
		headerEl.textContent = tab.title;
		headerEl.addEventListener('click', () => this.setActive(tab.id));
		tab.element.style.position = 'absolute';
		tab.element.style.inset = '0';
		tab.element.style.display = 'none';
		append(this.bodyEl, tab.element);
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
			headerEl.classList.toggle('active', tab.id === id);
			tab.element.style.display = tab.id === id ? '' : 'none';
		}
		this.activeId = id;
		this.onDidActivate(id);
	}

	get body(): HTMLElement {
		return this.bodyEl;
	}
}
