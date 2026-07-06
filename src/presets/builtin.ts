import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url';
import { loadColorTheme, WorkbenchTheme } from '../theme/themes';
import { registerTextMateSupport, type ExtensionManifest, type VendorExtension } from '../textmate/textmate';

// Ready-made access to the assets that ship inside the pinned VS Code
// checkout: the built-in color themes and the built-in extensions' language +
// grammar contributions. The import.meta.glob patterns are relative to THIS
// file, so they resolve into the minwebide package's vendor tree no matter
// where the consuming app lives.

const themeFiles = import.meta.glob('../../vendor/vscode/extensions/theme-defaults/themes/*.json', {
	query: '?raw',
	import: 'default',
}) as Record<string, () => Promise<string>>;

// The negative patterns exclude extensions with large manifests that
// contribute no languages or grammars (language contributions live in the
// '*-basics' style extensions). import.meta.glob only accepts literal arrays,
// so the list is repeated in both globs.
const manifests = import.meta.glob([
	'../../vendor/vscode/extensions/*/package.json',
	'!**/copilot/**',
	'!**/git/**',
	'!**/*-language-features/**',
	'!**/emmet/**',
	'!**/references-view/**',
	'!**/notebook-renderers/**',
	'!**/*-authentication/**',
], {
	eager: true,
	import: 'default',
}) as Record<string, ExtensionManifest>;

const extensionFiles = import.meta.glob([
	'../../vendor/vscode/extensions/*/syntaxes/**',
	'../../vendor/vscode/extensions/*/*.json',
	'!**/copilot/**',
	'!**/git/**',
	'!**/*-language-features/**',
	'!**/emmet/**',
	'!**/references-view/**',
	'!**/notebook-renderers/**',
	'!**/*-authentication/**',
], { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;

/** Names of the color themes bundled with VS Code, e.g. 'dark_modern'. */
export function builtinThemeNames(): string[] {
	return Object.keys(themeFiles)
		.map(path => path.replace(/^.*\/themes\//, '').replace(/\.json$/, ''))
		.sort();
}

/**
 * Loads one of VS Code's built-in color themes by file name
 * (e.g. 'dark_modern', 'light_modern', 'dark_plus', 'hc_black').
 */
export async function loadBuiltinTheme(name: string): Promise<WorkbenchTheme> {
	const entry = Object.keys(themeFiles).find(path => path.endsWith(`/themes/${name}.json`));
	if (!entry) {
		throw new Error(`Unknown built-in theme '${name}'. Available: ${builtinThemeNames().join(', ')}`);
	}
	return loadColorTheme(entry, async (path) => {
		const loader = themeFiles[path];
		if (!loader) {
			throw new Error(`Unknown theme file: ${path}`);
		}
		return loader();
	});
}

/**
 * Registers all languages and TextMate grammars contributed by VS Code's
 * built-in extensions (syntax highlighting, file associations, language
 * configurations), themed with the given color theme.
 */
export async function registerBuiltinLanguages(theme: WorkbenchTheme): Promise<void> {
	const extensions: VendorExtension[] = [];
	for (const [manifestPath, manifest] of Object.entries(manifests)) {
		if (!manifest.contributes?.languages && !manifest.contributes?.grammars) {
			continue;
		}
		extensions.push({
			path: manifestPath.replace(/\/package\.json$/, ''),
			manifest,
		});
	}
	await registerTextMateSupport({
		onigWasmUrl,
		extensions,
		readExtensionFile: async (path) => {
			const loader = extensionFiles[path];
			if (!loader) {
				throw new Error(`Unknown extension file: ${path}`);
			}
			return loader();
		},
		theme,
	});
}
