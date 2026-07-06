import { $, append } from 'vs/base/browser/dom';
import { Disposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import * as monaco from '../editor/monaco';

// Output channels, mirroring VS Code's `window.createOutputChannel(name)` and
// its `{ log: true }` variant. Like VS Code, the Output view is a read-only
// code editor over an append-only buffer, colorized by the built-in `log`
// TextMate grammar, with a dropdown to switch channels.

export interface OutputChannel {
	readonly name: string;
	append(value: string): void;
	appendLine(value: string): void;
	/** Replaces the entire channel content. */
	replace(value: string): void;
	clear(): void;
	/** Reveals the Output view and switches to this channel. */
	show(): void;
	dispose(): void;
}

export interface LogOutputChannel extends OutputChannel {
	trace(message: string): void;
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string | Error): void;
}

export interface OutputChannelOptions {
	/** Adds trace/debug/info/warn/error methods that prefix VS Code-style `timestamp [level]` headers. */
	readonly log?: boolean;
}

interface ChannelData {
	readonly name: string;
	readonly model: monaco.editor.ITextModel;
}

function timestamp(): string {
	const now = new Date();
	const pad = (n: number, width = 2) => String(n).padStart(width, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
		`${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

/**
 * The Output panel view: a read-only editor showing the active channel, with
 * a channel selector and a clear action rendered in the panel title area.
 */
export class OutputView extends Disposable {
	readonly element: HTMLElement;
	/** Mounted in the panel header while the Output tab is active. */
	readonly actionsElement: HTMLElement;

	private readonly editor: monaco.editor.IStandaloneCodeEditor;
	private readonly selectEl: HTMLSelectElement;
	private readonly channels = new Map<string, ChannelData>();
	private activeChannel: string | undefined;
	private width = 0;
	private height = 0;

	constructor(theme: string, private readonly revealPanel: () => void) {
		super();

		this.element = $('.mw-output');

		this.editor = this._register(monaco.editor.create(this.element, {
			model: null,
			theme,
			readOnly: true,
			automaticLayout: false,
			minimap: { enabled: false },
			lineNumbers: 'off',
			folding: false,
			glyphMargin: false,
			lineDecorationsWidth: 8,
			renderLineHighlight: 'none',
			scrollBeyondLastLine: false,
			wordWrap: 'on',
			overviewRulerLanes: 0,
			scrollbar: { vertical: 'auto', horizontal: 'auto' },
			stickyScroll: { enabled: false },
			fontSize: 12,
		}));

		this.actionsElement = $('.mw-panel-tab-actions');
		this.selectEl = append(this.actionsElement, $('select.mw-output-select')) as HTMLSelectElement;
		this.selectEl.title = 'Output Channel';
		this.selectEl.addEventListener('change', () => this.setActiveChannel(this.selectEl.value));
		const clearButton = append(this.actionsElement, $('.mw-panel-action'));
		clearButton.title = 'Clear Output';
		append(clearButton, $('span.codicon.codicon-clear-all'));
		clearButton.addEventListener('click', () => {
			if (this.activeChannel) {
				this.channels.get(this.activeChannel)?.model.setValue('');
			}
		});
	}

	createChannel(name: string, options?: OutputChannelOptions & { log?: false }): OutputChannel;
	createChannel(name: string, options: OutputChannelOptions & { log: true }): LogOutputChannel;
	createChannel(name: string, options?: OutputChannelOptions): OutputChannel | LogOutputChannel {
		if (this.channels.has(name)) {
			throw new Error(`Output channel '${name}' already exists`);
		}
		// the same recipe as VS Code's output editor: a model in the 'log'
		// language, tokenized by the built-in log TextMate grammar
		const uri = URI.from({ scheme: 'output', path: `/${encodeURIComponent(name)}.log` });
		const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel('', 'log', uri);
		const data: ChannelData = { name, model };
		this.channels.set(name, data);
		this.refreshSelect();
		if (!this.activeChannel) {
			this.setActiveChannel(name);
		}

		const view = this;
		const channel: LogOutputChannel = {
			name,
			append(value: string): void {
				view.appendTo(data, value);
			},
			appendLine(value: string): void {
				view.appendTo(data, value + '\n');
			},
			replace(value: string): void {
				model.setValue(value);
			},
			clear(): void {
				model.setValue('');
			},
			show(): void {
				view.setActiveChannel(name);
				view.revealPanel();
			},
			dispose(): void {
				view.removeChannel(name);
			},
			trace(message: string): void {
				this.appendLine(`${timestamp()} [trace] ${message}`);
			},
			debug(message: string): void {
				this.appendLine(`${timestamp()} [debug] ${message}`);
			},
			info(message: string): void {
				this.appendLine(`${timestamp()} [info] ${message}`);
			},
			warn(message: string): void {
				this.appendLine(`${timestamp()} [warning] ${message}`);
			},
			error(message: string | Error): void {
				const text = message instanceof Error ? (message.stack ?? message.message) : message;
				this.appendLine(`${timestamp()} [error] ${text}`);
			},
		};
		return channel;
	}

	setActiveChannel(name: string): void {
		const data = this.channels.get(name);
		if (!data) {
			return;
		}
		this.activeChannel = name;
		this.editor.setModel(data.model);
		this.selectEl.value = name;
		this.revealLastLine();
	}

	layout(width: number, height: number): void {
		this.width = width;
		this.height = height;
		this.editor.layout({ width, height });
	}

	private appendTo(data: ChannelData, text: string): void {
		const model = data.model;
		const lastLine = model.getLineCount();
		const lastColumn = model.getLineMaxColumn(lastLine);
		const atBottom = this.isScrolledToBottom();
		model.applyEdits([{
			range: new monaco.Range(lastLine, lastColumn, lastLine, lastColumn),
			text,
		}]);
		if (data.name === this.activeChannel && atBottom) {
			this.revealLastLine();
		}
	}

	private isScrolledToBottom(): boolean {
		const scrollTop = this.editor.getScrollTop();
		const scrollHeight = this.editor.getScrollHeight();
		return scrollTop + this.height >= scrollHeight - 30;
	}

	private revealLastLine(): void {
		const model = this.editor.getModel();
		if (model) {
			this.editor.revealLine(model.getLineCount());
		}
	}

	private removeChannel(name: string): void {
		const data = this.channels.get(name);
		if (!data) {
			return;
		}
		this.channels.delete(name);
		data.model.dispose();
		if (this.activeChannel === name) {
			this.activeChannel = undefined;
			this.editor.setModel(null);
			const next = this.channels.keys().next();
			if (!next.done) {
				this.setActiveChannel(next.value);
			}
		}
		this.refreshSelect();
	}

	private refreshSelect(): void {
		this.selectEl.textContent = '';
		for (const name of this.channels.keys()) {
			const option = document.createElement('option');
			option.value = name;
			option.textContent = name;
			this.selectEl.appendChild(option);
		}
		if (this.activeChannel) {
			this.selectEl.value = this.activeChannel;
		}
	}
}
