import { $, append } from 'vs/base/browser/dom';
import { Disposable } from 'vs/base/common/lifecycle';

// The auxiliary bar — VS Code's Secondary Side Bar, to the right of the
// editor. In VS Code this is where extensions dock tool-owned views (chat,
// plot panes, ...) via contributes.views + WebviewViewProvider; here apps
// create views imperatively and render plain DOM into them.

export interface AuxiliaryView {
	readonly id: string;
	readonly title: string;
	/** Render target owned by the view's creator. */
	readonly element: HTMLElement;
	/** Reveal the secondary side bar with this view active. */
	show(): void;
	dispose(): void;
}

export class AuxiliaryBar extends Disposable {
	readonly element: HTMLElement;

	private readonly tabsEl: HTMLElement;
	private readonly bodyEl: HTMLElement;
	private readonly views = new Map<string, { tabEl: HTMLElement; element: HTMLElement }>();
	private activeId: string | undefined;

	constructor(private readonly setVisible: (visible: boolean) => void) {
		super();
		this.element = $('.mw-auxbar');
		const headerEl = append(this.element, $('.mw-panel-header'));
		this.tabsEl = append(headerEl, $('.mw-panel-tabs'));
		const actionsEl = append(headerEl, $('.mw-panel-actions'));
		const closeButton = append(actionsEl, $('.mw-panel-action'));
		closeButton.title = 'Close Secondary Side Bar';
		append(closeButton, $('span.codicon.codicon-close'));
		closeButton.addEventListener('click', () => this.setVisible(false));
		this.bodyEl = append(this.element, $('.mw-panel-body'));
	}

	createView(id: string, title: string): AuxiliaryView {
		if (this.views.has(id)) {
			throw new Error(`Auxiliary view '${id}' already exists`);
		}
		const tabEl = append(this.tabsEl, $('.mw-panel-tab'));
		tabEl.textContent = title;
		tabEl.addEventListener('click', () => this.setActive(id));
		const element = append(this.bodyEl, $('.mw-auxbar-view'));
		element.style.display = 'none';
		this.views.set(id, { tabEl, element });
		if (!this.activeId) {
			this.setActive(id);
		}

		return {
			id,
			title,
			element,
			show: () => {
				this.setActive(id);
				this.setVisible(true);
			},
			dispose: () => this.removeView(id),
		};
	}

	setActive(id: string): void {
		if (!this.views.has(id)) {
			return;
		}
		for (const [viewId, view] of this.views) {
			view.tabEl.classList.toggle('active', viewId === id);
			view.element.style.display = viewId === id ? '' : 'none';
		}
		this.activeId = id;
	}

	private removeView(id: string): void {
		const view = this.views.get(id);
		if (!view) {
			return;
		}
		view.tabEl.remove();
		view.element.remove();
		this.views.delete(id);
		if (this.activeId === id) {
			this.activeId = undefined;
			const next = this.views.keys().next();
			if (!next.done) {
				this.setActive(next.value);
			} else {
				this.setVisible(false);
			}
		}
	}
}
