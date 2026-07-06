import { Delayer } from 'vs/base/common/async';
import { DisposableStore } from 'vs/base/common/lifecycle';
import type { CustomEditorPane, CustomEditorProvider } from '../src';
import './customEditors.css';

// Three example custom editors exercising the app-level custom editor API.
// The registration shape mirrors VS Code's `contributes.customEditors`.

/**
 * Markdown preview (priority 'option': the text editor stays the default,
 * a tab-bar action offers the preview). Rendered by VS Code's own
 * vs/base markdownRenderer, live-updating against the shared text model.
 */
export const markdownPreview: CustomEditorProvider = {
	viewType: 'demo.markdownPreview',
	displayName: 'Markdown Preview',
	selector: [{ filenamePattern: '*.md' }],
	priority: 'option',
	async resolveCustomEditor(document): Promise<CustomEditorPane> {
		// markdownRenderer drags in marked + dompurify; load it only when a
		// preview is actually opened
		const { renderMarkdown } = await import('vs/base/browser/markdownRenderer');
		const disposables = new DisposableStore();
		const element = window.document.createElement('div');
		element.className = 'demo-markdown-preview';

		const model = await document.getTextModel();
		const render = () => {
			const rendered = disposables.add(renderMarkdown({ value: model.getValue() }));
			element.replaceChildren(rendered.element);
		};
		const delayer = disposables.add(new Delayer<void>(200));
		disposables.add(model.onDidChangeContent(() => delayer.trigger(() => render())));
		render();

		return { element, dispose: () => disposables.dispose() };
	},
};

function parseCsvLine(line: string): string[] {
	const cells: string[] = [];
	let current = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"' && line[i + 1] === '"') {
				current += '"';
				i++;
			} else if (ch === '"') {
				inQuotes = false;
			} else {
				current += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ',') {
			cells.push(current);
			current = '';
		} else {
			current += ch;
		}
	}
	cells.push(current);
	return cells;
}

/**
 * CSV table viewer (priority 'default': replaces the text editor for .csv;
 * "Reopen as Text Editor" stays available in the tab bar).
 */
export const csvViewer: CustomEditorProvider = {
	viewType: 'demo.csvViewer',
	displayName: 'CSV Table',
	selector: [{ filenamePattern: '*.csv' }],
	priority: 'default',
	async resolveCustomEditor(document): Promise<CustomEditorPane> {
		const disposables = new DisposableStore();
		const element = window.document.createElement('div');
		element.className = 'demo-csv-viewer';

		const model = await document.getTextModel();
		const render = () => {
			const lines = model.getValue().split(/\r\n|\r|\n/).filter(line => line.length > 0);
			const table = window.document.createElement('table');
			lines.forEach((line, index) => {
				const row = table.insertRow();
				for (const cell of parseCsvLine(line)) {
					const cellEl = window.document.createElement(index === 0 ? 'th' : 'td');
					cellEl.textContent = cell;
					row.appendChild(cellEl);
				}
			});
			element.replaceChildren(table);
		};
		const delayer = disposables.add(new Delayer<void>(200));
		disposables.add(model.onDidChangeContent(() => delayer.trigger(() => render())));
		render();

		return { element, dispose: () => disposables.dispose() };
	},
};

const IMAGE_MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
};

/**
 * Image viewer — exercises the binary document path (readBytes).
 */
export const imageViewer: CustomEditorProvider = {
	viewType: 'demo.imageViewer',
	displayName: 'Image Viewer',
	selector: [{ filenamePattern: '*.{png,jpg,jpeg,gif,webp,svg}' }],
	priority: 'default',
	async resolveCustomEditor(document): Promise<CustomEditorPane> {
		const element = window.document.createElement('div');
		element.className = 'demo-image-viewer';

		const bytes = await document.readBytes();
		const extension = document.uri.path.split('.').pop()?.toLowerCase() ?? '';
		const blob = new Blob([bytes as BlobPart], { type: IMAGE_MIME[extension] ?? 'application/octet-stream' });
		const url = URL.createObjectURL(blob);

		const img = window.document.createElement('img');
		img.src = url;
		element.appendChild(img);
		const caption = window.document.createElement('div');
		caption.className = 'demo-image-caption';
		img.addEventListener('load', () => {
			caption.textContent = `${img.naturalWidth} × ${img.naturalHeight}   ${bytes.byteLength.toLocaleString()} bytes`;
		});
		element.appendChild(caption);

		return { element, dispose: () => URL.revokeObjectURL(url) };
	},
};

export const demoCustomEditors: CustomEditorProvider[] = [markdownPreview, csvViewer, imageViewer];
