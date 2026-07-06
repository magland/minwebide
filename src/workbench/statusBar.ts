import { $, append } from 'vs/base/browser/dom';
import { Disposable } from 'vs/base/common/lifecycle';

export class StatusBar extends Disposable {
	readonly element: HTMLElement;

	private readonly leftEl: HTMLElement;
	private readonly rightEl: HTMLElement;
	private readonly items = new Map<string, HTMLElement>();

	constructor() {
		super();
		this.element = $('.mw-statusbar');
		this.leftEl = append(this.element, $('.mw-statusbar-item'));
		this.leftEl.style.display = 'contents';
		append(this.element, $('.mw-statusbar-spacer'));
		this.rightEl = append(this.element, $('.mw-statusbar-item'));
		this.rightEl.style.display = 'contents';
	}

	/**
	 * Adds or updates a status bar entry. Icon is a codicon name.
	 */
	setItem(id: string, side: 'left' | 'right', text: string, options?: { icon?: string; title?: string; onClick?: () => void }): void {
		let item = this.items.get(id);
		if (!item) {
			item = $('.mw-statusbar-item');
			(side === 'left' ? this.leftEl : this.rightEl).appendChild(item);
			this.items.set(id, item);
		}
		item.textContent = '';
		if (options?.icon) {
			append(item, $(`span.codicon.codicon-${options.icon}`));
		}
		append(item, $('span', undefined, text));
		if (options?.title) {
			item.title = options.title;
		}
		if (options?.onClick) {
			item.classList.add('clickable');
			item.onclick = options.onClick;
		}
	}

	removeItem(id: string): void {
		this.items.get(id)?.remove();
		this.items.delete(id);
	}
}
