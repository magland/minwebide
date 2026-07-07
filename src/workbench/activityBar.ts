import { $, append } from 'vs/base/browser/dom';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';

export interface ActivityBarItem {
	readonly id: string;
	/** codicon name, e.g. 'files' or 'search' */
	readonly icon: string;
	readonly title: string;
}

export class ActivityBar extends Disposable {
	readonly element: HTMLElement;

	private readonly itemEls = new Map<string, HTMLElement>();
	private activeId: string | undefined;

	private readonly _onDidSelect = this._register(new Emitter<string>());
	readonly onDidSelect: Event<string> = this._onDidSelect.event;

	constructor(items: readonly ActivityBarItem[]) {
		super();
		this.element = $('.mw-activitybar');
		for (const item of items) {
			this.addItem(item);
		}
	}

	addItem(item: ActivityBarItem): void {
		const el = append(this.element, $('.mw-activitybar-item'));
		el.title = item.title;
		append(el, $(`span.codicon.codicon-${item.icon}`));
		el.addEventListener('click', () => this._onDidSelect.fire(item.id));
		this.itemEls.set(item.id, el);
	}

	/** Shows a count badge on an item (VS Code's activity bar badge); 0 hides it. */
	setBadge(id: string, count: number): void {
		const el = this.itemEls.get(id);
		if (!el) {
			return;
		}
		el.querySelector('.mw-activitybar-badge')?.remove();
		if (count > 0) {
			append(el, $('.mw-activitybar-badge', undefined, count > 99 ? '99+' : String(count)));
		}
	}

	setActive(id: string): void {
		if (this.activeId) {
			this.itemEls.get(this.activeId)?.classList.remove('active');
		}
		this.activeId = id;
		this.itemEls.get(id)?.classList.add('active');
	}
}
