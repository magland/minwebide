import { IDisposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { CustomEditorSelector, matchesSelector } from './customEditors';
import type { LogOutputChannel } from './outputChannels';

// App-registered file runners. VS Code itself has no core "run this file"
// concept — extensions contribute commands to the `editor/title/run` menu and
// stream results to an output channel; this API is the app-level analog:
// a runner matched to file types by the same selector shape as custom
// editors, surfaced as a ▶ action in the tab bar, with output going to a
// VS Code-style output channel in the panel.

export interface RunContext {
	readonly uri: URI;
	/** Current file text — the open editor's (possibly unsaved) contents if the file is open. */
	getText(): Promise<string>;
	/** Raw file contents from the workspace file system. */
	readBytes(): Promise<Uint8Array>;
	/** This runner's output channel; already revealed when run() is invoked. */
	readonly output: LogOutputChannel;
}

export interface FileRunner {
	/** Unique id, e.g. 'myapp.runScript'. */
	readonly id: string;
	/** Shown in the ▶ button tooltip and as the output channel name. */
	readonly displayName: string;
	readonly selector: readonly CustomEditorSelector[];
	run(context: RunContext): void | Promise<void>;
}

export class RunnerRegistry {
	private readonly runners = new Map<string, FileRunner>();

	register(runner: FileRunner): IDisposable {
		if (this.runners.has(runner.id)) {
			throw new Error(`Runner '${runner.id}' is already registered`);
		}
		this.runners.set(runner.id, runner);
		return { dispose: () => this.runners.delete(runner.id) };
	}

	getForResource(resource: URI): FileRunner[] {
		const result: FileRunner[] = [];
		for (const runner of this.runners.values()) {
			if (runner.selector.some(selector => matchesSelector(selector, resource))) {
				result.push(runner);
			}
		}
		return result;
	}
}
