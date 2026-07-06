import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { $ } from 'vs/base/browser/dom';
import { VSBuffer } from 'vs/base/common/buffer';
import { Disposable } from 'vs/base/common/lifecycle';
import { posix } from 'vs/base/common/path';
import { URI } from 'vs/base/common/uri';
import type { ITheme } from '@xterm/xterm';
import type { WorkspaceFileSystem } from '../fs/fileSystem';
import type { WorkbenchTheme } from '../theme/themes';

function terminalThemeOf(theme: WorkbenchTheme): ITheme {
	const color = (id: string) => theme.getColor(id)?.toString();
	return {
		background: color('terminal.background') ?? color('panel.background'),
		foreground: color('terminal.foreground'),
		cursor: color('terminalCursor.foreground'),
		cursorAccent: color('terminalCursor.background'),
		selectionBackground: color('terminal.selectionBackground'),
		black: color('terminal.ansiBlack'),
		red: color('terminal.ansiRed'),
		green: color('terminal.ansiGreen'),
		yellow: color('terminal.ansiYellow'),
		blue: color('terminal.ansiBlue'),
		magenta: color('terminal.ansiMagenta'),
		cyan: color('terminal.ansiCyan'),
		white: color('terminal.ansiWhite'),
		brightBlack: color('terminal.ansiBrightBlack'),
		brightRed: color('terminal.ansiBrightRed'),
		brightGreen: color('terminal.ansiBrightGreen'),
		brightYellow: color('terminal.ansiBrightYellow'),
		brightBlue: color('terminal.ansiBrightBlue'),
		brightMagenta: color('terminal.ansiBrightMagenta'),
		brightCyan: color('terminal.ansiBrightCyan'),
		brightWhite: color('terminal.ansiBrightWhite'),
	};
}

/**
 * A terminal panel: xterm.js (the terminal frontend VS Code uses) running a
 * small built-in shell against the workspace file system.
 */
export class TerminalView extends Disposable {
	readonly element: HTMLElement;

	private readonly terminal: Terminal;
	private readonly fitAddon: FitAddon;
	private opened = false;

	private cwd = '/';
	private buffer = '';
	private readonly history: string[] = [];
	private historyIndex = 0;
	private running = false;

	constructor(private readonly fs: WorkspaceFileSystem, theme: WorkbenchTheme) {
		super();
		this.element = $('.mw-terminal');
		this.element.style.height = '100%';
		this.element.style.padding = '4px 0 0 10px';
		this.element.style.boxSizing = 'border-box';

		this.terminal = new Terminal({
			fontSize: 13,
			fontFamily: 'ui-monospace, Menlo, Monaco, "Cascadia Mono", "Segoe UI Mono", monospace',
			cursorBlink: true,
			theme: terminalThemeOf(theme),
		});
		this.fitAddon = new FitAddon();
		this.terminal.loadAddon(this.fitAddon);
		this._register({ dispose: () => this.terminal.dispose() });

		this.terminal.onData((data) => this.handleInput(data));
	}

	/** Attach xterm to the DOM; call once the element is in the document. */
	open(): void {
		if (this.opened) {
			return;
		}
		this.opened = true;
		this.terminal.open(this.element);
		this.fitAddon.fit();
		this.terminal.writeln('minwebide shell — the workspace below is stored in IndexedDB');
		this.terminal.writeln('Type "help" for available commands.');
		this.prompt();
	}

	layout(): void {
		if (this.opened && this.element.clientHeight > 0) {
			this.fitAddon.fit();
		}
	}

	focus(): void {
		this.terminal.focus();
	}

	private prompt(): void {
		this.terminal.write(`\x1b[1;32mworkspace\x1b[0m:\x1b[1;34m${this.cwd}\x1b[0m$ `);
	}

	private handleInput(data: string): void {
		if (this.running) {
			return;
		}
		switch (data) {
			case '\r':
				this.terminal.write('\r\n');
				this.execute(this.buffer.trim());
				this.buffer = '';
				break;
			case '\x7f': // backspace
				if (this.buffer.length > 0) {
					this.buffer = this.buffer.slice(0, -1);
					this.terminal.write('\b \b');
				}
				break;
			case '\x03': // ctrl+c
				this.terminal.write('^C\r\n');
				this.buffer = '';
				this.prompt();
				break;
			case '\x0c': // ctrl+l
				this.terminal.clear();
				break;
			case '\x1b[A': // up
				this.recall(-1);
				break;
			case '\x1b[B': // down
				this.recall(1);
				break;
			default:
				if (data >= ' ' || data === '\t') {
					this.buffer += data;
					this.terminal.write(data);
				}
		}
	}

	private recall(direction: number): void {
		if (!this.history.length) {
			return;
		}
		this.historyIndex = Math.min(this.history.length, Math.max(0, this.historyIndex + direction));
		const entry = this.history[this.historyIndex] ?? '';
		this.terminal.write('\b \b'.repeat(this.buffer.length));
		this.buffer = entry;
		this.terminal.write(entry);
	}

	private resolvePath(arg: string): URI {
		const path = posix.normalize(arg.startsWith('/') ? arg : posix.join(this.cwd, arg));
		return this.fs.root.with({ path: path === '' ? '/' : path });
	}

	private async execute(line: string): Promise<void> {
		if (line) {
			this.history.push(line);
		}
		this.historyIndex = this.history.length;
		if (!line) {
			this.prompt();
			return;
		}

		this.running = true;
		try {
			await this.runCommand(line);
		} catch (error) {
			this.terminal.writeln(`\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
		} finally {
			this.running = false;
			this.prompt();
		}
	}

	private async runCommand(line: string): Promise<void> {
		// echo supports "> file" redirection; everything else is argv-style
		const redirect = line.match(/^(.*?)\s*>\s*(\S+)\s*$/);
		const [cmd, ...args] = (redirect ? redirect[1] : line).split(/\s+/);
		const write = (text: string) => this.terminal.writeln(text.replaceAll('\n', '\r\n'));
		const files = this.fs.fileService;

		switch (cmd) {
			case 'help':
				write('commands: ls [path], cd <path>, cat <file>, echo <text> [> file],');
				write('          mkdir <path>, touch <file>, rm [-r] <path>, pwd, clear, help');
				break;
			case 'pwd':
				write(this.cwd);
				break;
			case 'clear':
				this.terminal.clear();
				break;
			case 'ls': {
				const stat = await files.resolve(this.resolvePath(args[0] ?? '.'));
				if (!stat.isDirectory) {
					write(stat.name);
					break;
				}
				const children = [...(stat.children ?? [])].sort((a, b) =>
					a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : (a.isDirectory ? -1 : 1));
				for (const child of children) {
					write(child.isDirectory ? `\x1b[1;34m${child.name}/\x1b[0m` : child.name);
				}
				break;
			}
			case 'cd': {
				const target = this.resolvePath(args[0] ?? '/');
				const stat = await files.resolve(target);
				if (!stat.isDirectory) {
					throw new Error(`cd: not a directory: ${args[0]}`);
				}
				this.cwd = target.path;
				break;
			}
			case 'cat': {
				if (!args[0]) {
					throw new Error('cat: missing file');
				}
				const content = await files.readFile(this.resolvePath(args[0]));
				write(content.value.toString());
				break;
			}
			case 'echo': {
				const text = (redirect ? redirect[1] : line).replace(/^echo\s?/, '');
				if (redirect) {
					await files.writeFile(this.resolvePath(redirect[2]), VSBuffer.fromString(text + '\n'));
				} else {
					write(text);
				}
				break;
			}
			case 'mkdir':
				if (!args[0]) {
					throw new Error('mkdir: missing path');
				}
				await files.createFolder(this.resolvePath(args[0]));
				break;
			case 'touch': {
				if (!args[0]) {
					throw new Error('touch: missing file');
				}
				const target = this.resolvePath(args[0]);
				if (!(await files.exists(target))) {
					await files.writeFile(target, VSBuffer.fromString(''));
				}
				break;
			}
			case 'rm': {
				const recursive = args[0] === '-r';
				const pathArg = recursive ? args[1] : args[0];
				if (!pathArg) {
					throw new Error('rm: missing path');
				}
				await files.del(this.resolvePath(pathArg), { recursive });
				break;
			}
			default:
				throw new Error(`command not found: ${cmd} (try "help")`);
		}
	}
}
