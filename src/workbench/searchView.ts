import { $, append } from 'vs/base/browser/dom';
import { FindInput } from 'vs/base/browser/ui/findinput/findInput';
import { HighlightedLabel } from 'vs/base/browser/ui/highlightedlabel/highlightedLabel';
import { IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { ObjectTree } from 'vs/base/browser/ui/tree/objectTree';
import { IObjectTreeElement, ITreeNode, ITreeRenderer } from 'vs/base/browser/ui/tree/tree';
import { Delayer } from 'vs/base/common/async';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { basename } from 'vs/base/common/resources';
import { escapeRegExpCharacters } from 'vs/base/common/strings';
import { URI } from 'vs/base/common/uri';
import { IFileStat } from 'vs/platform/files/common/files';
import { defaultInputBoxStyles, defaultListStyles, defaultToggleStyles } from 'vs/platform/theme/browser/defaultStyles';
import type { WorkspaceFileSystem } from '../fs/fileSystem';

const MAX_RESULTS = 1000;
const MAX_FILE_SIZE = 1024 * 1024;

export interface SearchMatch {
	readonly type: 'match';
	readonly uri: URI;
	readonly lineNumber: number;
	readonly column: number;
	readonly length: number;
	readonly preview: string;
	readonly previewStart: number;
}

interface FileMatches {
	readonly type: 'file';
	readonly uri: URI;
	readonly matches: SearchMatch[];
}

type SearchElement = FileMatches | SearchMatch;

class SearchDelegate implements IListVirtualDelegate<SearchElement> {
	getHeight(): number {
		return 22;
	}
	getTemplateId(element: SearchElement): string {
		return element.type;
	}
}

interface FileTemplate {
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	readonly badge: HTMLElement;
}

class FileMatchesRenderer implements ITreeRenderer<SearchElement, void, FileTemplate> {
	readonly templateId = 'file';

	renderTemplate(container: HTMLElement): FileTemplate {
		const row = append(container, $('.mw-search-file'));
		const icon = append(row, $('span.codicon.codicon-file'));
		const label = append(row, $('span.mw-search-file-name'));
		const badge = append(row, $('span.mw-search-badge'));
		return { icon, label, badge };
	}

	renderElement(node: ITreeNode<SearchElement, void>, _index: number, template: FileTemplate): void {
		const element = node.element as FileMatches;
		template.label.textContent = basename(element.uri);
		template.badge.textContent = String(element.matches.length);
	}

	disposeTemplate(): void { }
}

interface MatchTemplate {
	readonly label: HighlightedLabel;
}

class MatchRenderer implements ITreeRenderer<SearchElement, void, MatchTemplate> {
	readonly templateId = 'match';

	renderTemplate(container: HTMLElement): MatchTemplate {
		const row = append(container, $('.mw-search-match'));
		return { label: new HighlightedLabel(row) };
	}

	renderElement(node: ITreeNode<SearchElement, void>, _index: number, template: MatchTemplate): void {
		const element = node.element as SearchMatch;
		const start = element.previewStart;
		template.label.set(element.preview, [{ start, end: start + element.length }]);
	}

	disposeTemplate(): void { }
}

/**
 * Search across all files of the workspace file system, VS Code style:
 * FindInput (with case/word/regex toggles) above a tree of results grouped by
 * file, with highlighted match previews.
 */
export class SearchView extends Disposable {
	readonly element: HTMLElement;

	private readonly findInput: FindInput;
	private readonly messageEl: HTMLElement;
	private readonly treeContainer: HTMLElement;
	private readonly tree: ObjectTree<SearchElement>;
	private readonly searchDelayer = this._register(new Delayer<void>(200));
	private searchToken = 0;
	private height = 0;
	private width = 0;

	private readonly _onDidOpenMatch = this._register(new Emitter<SearchMatch>());
	readonly onDidOpenMatch: Event<SearchMatch> = this._onDidOpenMatch.event;

	constructor(private readonly fs: WorkspaceFileSystem) {
		super();

		this.element = $('.mw-sidebar-pane.mw-search');
		const inputContainer = append(this.element, $('.mw-search-input'));
		this.findInput = this._register(new FindInput(inputContainer, undefined, {
			label: 'Search',
			placeholder: 'Search',
			inputBoxStyles: defaultInputBoxStyles,
			toggleStyles: defaultToggleStyles,
		}));
		this.messageEl = append(this.element, $('.mw-search-message'));
		this.treeContainer = append(this.element, $('.mw-search-results'));

		this.tree = this._register(new ObjectTree<SearchElement>(
			'minwebide.search',
			this.treeContainer,
			new SearchDelegate(),
			[new FileMatchesRenderer(), new MatchRenderer()],
			{
				accessibilityProvider: {
					getAriaLabel: (element: SearchElement) => element.type === 'file' ? basename(element.uri) : element.preview,
					getWidgetAriaLabel: () => 'Search Results',
				},
			},
		));
		this.tree.style(defaultListStyles);

		this._register(this.tree.onDidChangeSelection((e) => {
			const element = e.elements[0];
			if (element && element.type === 'match') {
				this._onDidOpenMatch.fire(element);
			}
		}));

		const schedule = () => this.searchDelayer.trigger(() => this.runSearch());
		this._register(this.findInput.onInput(schedule));
		this._register(this.findInput.onDidOptionChange(schedule));
	}

	focus(): void {
		this.findInput.focus();
	}

	layout(height: number, width: number): void {
		this.height = height;
		this.width = width;
		const used = this.treeContainer.offsetTop;
		this.tree.layout(Math.max(0, height - used), width);
	}

	private buildPattern(): RegExp | undefined {
		const value = this.findInput.getValue();
		if (!value) {
			return undefined;
		}
		let source = this.findInput.getRegex() ? value : escapeRegExpCharacters(value);
		if (this.findInput.getWholeWords()) {
			source = `\\b(?:${source})\\b`;
		}
		try {
			return new RegExp(source, this.findInput.getCaseSensitive() ? 'g' : 'gi');
		} catch {
			return undefined;
		}
	}

	private async collectFiles(resource: URI, into: IFileStat[]): Promise<void> {
		const stat = await this.fs.fileService.resolve(resource);
		for (const child of stat.children ?? []) {
			if (child.isDirectory) {
				await this.collectFiles(child.resource, into);
			} else {
				into.push(child);
			}
		}
	}

	private async runSearch(): Promise<void> {
		const token = ++this.searchToken;
		const pattern = this.buildPattern();
		if (!pattern) {
			this.messageEl.textContent = '';
			this.tree.setChildren(null, []);
			return;
		}

		const files: IFileStat[] = [];
		await this.collectFiles(this.fs.root, files);
		files.sort((a, b) => a.resource.path.localeCompare(b.resource.path));

		const results: FileMatches[] = [];
		let total = 0;
		for (const file of files) {
			if (token !== this.searchToken || total >= MAX_RESULTS) {
				break;
			}
			if ((file.size ?? 0) > MAX_FILE_SIZE) {
				continue;
			}
			let text: string;
			try {
				text = (await this.fs.fileService.readFile(file.resource)).value.toString();
			} catch {
				continue;
			}
			const matches: SearchMatch[] = [];
			const lines = text.split(/\r\n|\r|\n/);
			for (let i = 0; i < lines.length && total < MAX_RESULTS; i++) {
				const line = lines[i];
				pattern.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = pattern.exec(line)) && total < MAX_RESULTS) {
					const previewStartInLine = Math.max(0, m.index - 40);
					matches.push({
						type: 'match',
						uri: file.resource,
						lineNumber: i + 1,
						column: m.index + 1,
						length: Math.max(1, m[0].length),
						preview: line.substring(previewStartInLine, previewStartInLine + 250).trimEnd(),
						previewStart: m.index - previewStartInLine,
					});
					total++;
					if (m[0].length === 0) {
						pattern.lastIndex++;
					}
				}
			}
			if (matches.length) {
				results.push({ type: 'file', uri: file.resource, matches });
			}
		}

		if (token !== this.searchToken) {
			return;
		}

		this.messageEl.textContent = total === 0
			? 'No results found.'
			: `${total}${total >= MAX_RESULTS ? '+' : ''} result${total === 1 ? '' : 's'} in ${results.length} file${results.length === 1 ? '' : 's'}`;

		const elements: IObjectTreeElement<SearchElement>[] = results.map(file => ({
			element: file,
			children: file.matches.map(match => ({ element: match })),
			collapsed: false,
		}));
		this.tree.setChildren(null, elements);
		this.layout(this.height, this.width);
	}
}
