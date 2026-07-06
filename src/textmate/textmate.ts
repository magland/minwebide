import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { INITIAL, parseRawGrammar, Registry, type IRawTheme } from 'vscode-textmate';
import { parse as parseJsonc } from 'vs/base/common/json';
import { LazyTokenizationSupport, TokenizationRegistry } from 'vs/editor/common/languages';
import { TextMateTokenizationSupport } from 'vs/workbench/services/textMate/browser/tokenizationSupport/textMateTokenizationSupport';
import * as monaco from '../editor/monaco';
import type { WorkbenchTheme } from '../theme/themes';
import { toMonacoLanguageConfiguration } from './languageConfiguration';

// The relevant subset of a VS Code extension manifest (package.json).
export interface ExtensionManifest {
	contributes?: {
		languages?: {
			id: string;
			extensions?: string[];
			filenames?: string[];
			filenamePatterns?: string[];
			aliases?: string[];
			mimetypes?: string[];
			firstLine?: string;
			configuration?: string;
		}[];
		grammars?: {
			language?: string;
			scopeName: string;
			path: string;
			injectTo?: string[];
		}[];
	};
}

export interface VendorExtension {
	/** Folder of the extension, e.g. '/vendor/vscode/extensions/typescript-basics' */
	readonly path: string;
	readonly manifest: ExtensionManifest;
}

export interface TextMateSetupOptions {
	/** URL of vscode-oniguruma's onig.wasm. */
	readonly onigWasmUrl: string;
	/** Extension manifests to take language + grammar contributions from. */
	readonly extensions: readonly VendorExtension[];
	/** Reads a file referenced by a manifest (grammar, language configuration). */
	readonly readExtensionFile: (path: string) => Promise<string>;
	readonly theme: WorkbenchTheme;
}

function joinPath(base: string, relative: string): string {
	return `${base}/${relative.replace(/^\.\//, '')}`;
}

/**
 * Registers VS Code's built-in languages with the editor and wires up real
 * TextMate tokenization: the same grammars VS Code ships, run through
 * vscode-textmate/vscode-oniguruma (the same libraries VS Code uses), plugged
 * into the editor with VS Code's own TextMateTokenizationSupport.
 */
export async function registerTextMateSupport(options: TextMateSetupOptions): Promise<void> {
	const grammarPathByScope = new Map<string, string>();
	const injectionsByScope = new Map<string, string[]>();
	const scopeByLanguage = new Map<string, string>();

	// collect grammar contributions
	for (const extension of options.extensions) {
		for (const grammar of extension.manifest.contributes?.grammars ?? []) {
			if (!grammarPathByScope.has(grammar.scopeName)) {
				grammarPathByScope.set(grammar.scopeName, joinPath(extension.path, grammar.path));
			}
			if (grammar.language && !scopeByLanguage.has(grammar.language)) {
				scopeByLanguage.set(grammar.language, grammar.scopeName);
			}
			for (const target of grammar.injectTo ?? []) {
				let list = injectionsByScope.get(target);
				if (!list) {
					injectionsByScope.set(target, list = []);
				}
				list.push(grammar.scopeName);
			}
		}
	}

	// register language contributions (monaco merges repeated registrations of an id)
	for (const extension of options.extensions) {
		for (const language of extension.manifest.contributes?.languages ?? []) {
			monaco.languages.register({
				id: language.id,
				extensions: language.extensions,
				filenames: language.filenames,
				filenamePatterns: language.filenamePatterns,
				aliases: language.aliases,
				mimetypes: language.mimetypes,
				firstLine: language.firstLine,
			});
			if (language.configuration) {
				const configPath = joinPath(extension.path, language.configuration);
				monaco.languages.onLanguage(language.id, async () => {
					try {
						const raw = parseJsonc(await options.readExtensionFile(configPath));
						monaco.languages.setLanguageConfiguration(language.id, toMonacoLanguageConfiguration(raw));
					} catch (error) {
						console.warn(`minwebide: failed to load language configuration for ${language.id}`, error);
					}
				});
			}
		}
	}

	// oniguruma (the regex engine behind TextMate grammars), then the registry
	await loadWASM(await fetch(options.onigWasmUrl));
	const registry = new Registry({
		onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
		loadGrammar: async (scopeName) => {
			const path = grammarPathByScope.get(scopeName);
			if (!path) {
				return null;
			}
			return parseRawGrammar(await options.readExtensionFile(path), path);
		},
		getInjections: (scopeName) => injectionsByScope.get(scopeName),
	});

	// token colors: default foreground/background first, then the theme rules
	const defaultForeground = options.theme.getColor('editor.foreground');
	const defaultBackground = options.theme.getColor('editor.background');
	const rawTheme: IRawTheme = {
		name: options.theme.label,
		settings: [
			{
				settings: {
					foreground: defaultForeground?.toString(),
					background: defaultBackground?.toString(),
				},
			},
			...options.theme.tokenColors.map(rule => ({ scope: rule.scope, settings: rule.settings })),
		],
	};
	registry.setTheme(rawTheme);
	monaco.languages.setColorMap(registry.getColorMap());

	// tokenization: lazily load each grammar on first use, driven by VS Code's
	// own TextMate tokenization support
	for (const [languageId, scopeName] of scopeByLanguage) {
		TokenizationRegistry.registerFactory(languageId, new LazyTokenizationSupport(async () => {
			const grammar = await registry.loadGrammar(scopeName);
			if (!grammar) {
				return null;
			}
			return new TextMateTokenizationSupport(
				grammar,
				INITIAL,
				false,
				undefined,
				() => false,
				() => { },
				false,
			);
		}));
	}
}
