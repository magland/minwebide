import { match as matchGlob } from 'vs/base/common/glob';
import { Event } from 'vs/base/common/event';
import { IDisposable } from 'vs/base/common/lifecycle';
import { basename } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import type * as monaco from '../editor/monaco';

// App-registered custom editors. The registration shape mirrors VS Code's
// `contributes.customEditors` extension point (viewType / displayName /
// selector / priority) and the provider mirrors CustomTextEditorProvider's
// resolve(document, panel) — but panes are plain DOM in the page, since the
// embedding app is trusted code. No extension host, no webviews.

export interface CustomEditorSelector {
	/** Glob matched against the file name (or the full path if it contains '/'). */
	readonly filenamePattern: string;
}

export type CustomEditorPriority = 'default' | 'option';

export interface CustomEditorDescriptor {
	/** Unique id, e.g. 'myapp.csvViewer'. */
	readonly viewType: string;
	/** Human-readable name, shown in "open with" affordances. */
	readonly displayName: string;
	readonly selector: readonly CustomEditorSelector[];
	/**
	 * 'default': this editor replaces the text editor for matching files.
	 * 'option': offered next to the text editor (e.g. a preview).
	 * Defaults to 'default', like VS Code.
	 */
	readonly priority?: CustomEditorPriority;
}

/**
 * The document a custom editor works against. Text-based editors share the
 * text model with the built-in text editor (edits, dirty state, and saving
 * stay consistent when a file is reopened the other way); binary editors read
 * bytes from the file service.
 */
export interface CustomEditorDocument {
	readonly uri: URI;
	/** The shared text model for this file (creates it on first call). */
	getTextModel(): Promise<monaco.editor.ITextModel>;
	/** Raw file contents from the workspace file system. */
	readBytes(): Promise<Uint8Array>;
}

/**
 * What a provider returns: a DOM pane plus optional lifecycle/edit hooks.
 */
export interface CustomEditorPane {
	readonly element: HTMLElement;
	layout?(width: number, height: number): void;
	focus?(): void;
	dispose?(): void;
	/** For panes that edit: report dirty-state changes to drive the tab dot. */
	readonly onDidChangeDirty?: Event<boolean>;
	/** For panes that edit without the shared text model: handle Ctrl+S. */
	save?(): Promise<void>;
}

export interface CustomEditorProvider extends CustomEditorDescriptor {
	resolveCustomEditor(document: CustomEditorDocument): CustomEditorPane | Promise<CustomEditorPane>;
}

export class CustomEditorRegistry {
	private readonly providers = new Map<string, CustomEditorProvider>();

	register(provider: CustomEditorProvider): IDisposable {
		if (this.providers.has(provider.viewType)) {
			throw new Error(`Custom editor '${provider.viewType}' is already registered`);
		}
		this.providers.set(provider.viewType, provider);
		return { dispose: () => this.providers.delete(provider.viewType) };
	}

	get(viewType: string): CustomEditorProvider | undefined {
		return this.providers.get(viewType);
	}

	/** All providers whose selector matches the resource, registration order. */
	getForResource(resource: URI): CustomEditorProvider[] {
		const result: CustomEditorProvider[] = [];
		for (const provider of this.providers.values()) {
			if (provider.selector.some(selector => matchesSelector(selector, resource))) {
				result.push(provider);
			}
		}
		return result;
	}

	/** The provider that should open the resource instead of the text editor. */
	getDefaultForResource(resource: URI): CustomEditorProvider | undefined {
		return this.getForResource(resource).find(provider => (provider.priority ?? 'default') === 'default');
	}
}

export function matchesSelector(selector: CustomEditorSelector, resource: URI): boolean {
	const pattern = selector.filenamePattern;
	return matchGlob(pattern, pattern.includes('/') ? resource.path : basename(resource));
}
