import type { FileRunner } from '../src';
import { renderPlot, type PlotSpec } from './plot';

// Two example file runners. Execution strategy is entirely app-defined —
// here: in-page JavaScript evaluation with a captured console, and a trivial
// text statistics command. Output goes to VS Code-style output channels.

function formatValue(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value instanceof Error) {
		return value.stack ?? value.message;
	}
	try {
		return JSON.stringify(value, undefined, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Runs JavaScript files in the page (the app is trusted code; a real app
 * might instead target a worker, an iframe sandbox, or Pyodide).
 * console.* is captured into the output channel; a plot() function renders
 * charts into the runner's view in the secondary side bar.
 */
export const jsRunner: FileRunner = {
	id: 'demo.runJavaScript',
	displayName: 'Run JavaScript',
	selector: [{ filenamePattern: '*.{js,mjs}' }],
	async run({ uri, getText, output, getView }) {
		output.info(`Running ${uri.path}`);
		const code = await getText();
		const capturedConsole = {
			log: (...args: unknown[]) => output.appendLine(args.map(formatValue).join(' ')),
			info: (...args: unknown[]) => output.appendLine(args.map(formatValue).join(' ')),
			warn: (...args: unknown[]) => output.warn(args.map(formatValue).join(' ')),
			error: (...args: unknown[]) => output.error(args.map(formatValue).join(' ')),
		};
		let plotsEl: HTMLElement | undefined;
		const plot = (spec: PlotSpec | number[]) => {
			if (!plotsEl) {
				// first plot of this run: take over the runner's side bar
				// view and reveal it
				const view = getView();
				view.element.textContent = '';
				plotsEl = document.createElement('div');
				plotsEl.className = 'demo-plots';
				view.element.appendChild(plotsEl);
				view.show();
			}
			renderPlot(plotsEl, Array.isArray(spec) ? { y: spec } : spec);
		};
		const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>;
		const started = performance.now();
		try {
			await new AsyncFunction('console', 'plot', code)(capturedConsole, plot);
			output.info(`Finished in ${Math.round(performance.now() - started)}ms`);
		} catch (error) {
			output.error(error instanceof Error ? error : String(error));
		}
	},
};

export const wordCountRunner: FileRunner = {
	id: 'demo.wordCount',
	displayName: 'Word Count',
	selector: [{ filenamePattern: '*.{md,txt}' }],
	async run({ uri, getText, output }) {
		const text = await getText();
		const lines = text.split(/\r\n|\r|\n/).length;
		const words = (text.match(/\S+/g) ?? []).length;
		output.info(`${uri.path}: ${lines} lines, ${words} words, ${text.length} characters`);
	},
};

export const demoRunners: FileRunner[] = [jsRunner, wordCountRunner];
