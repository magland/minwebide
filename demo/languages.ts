import type { ExtensionManifest, VendorExtension } from '../src/textmate/textmate';

// Harvest language + grammar contributions from the built-in extensions that
// ship inside the pinned VS Code checkout: the same grammars, language
// configurations, and file associations VS Code itself uses.

// The negative patterns exclude extensions with large manifests that
// contribute no languages or grammars (language contributions live in the
// '*-basics' style extensions). import.meta.glob only accepts literal arrays,
// so the list is repeated in both globs.
const manifests = import.meta.glob([
	'/vendor/vscode/extensions/*/package.json',
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
	'/vendor/vscode/extensions/*/syntaxes/**',
	'/vendor/vscode/extensions/*/*.json',
	'!**/copilot/**',
	'!**/git/**',
	'!**/*-language-features/**',
	'!**/emmet/**',
	'!**/references-view/**',
	'!**/notebook-renderers/**',
	'!**/*-authentication/**',
], { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;

export function vendorExtensions(): VendorExtension[] {
	const result: VendorExtension[] = [];
	for (const [manifestPath, manifest] of Object.entries(manifests)) {
		if (!manifest.contributes?.languages && !manifest.contributes?.grammars) {
			continue;
		}
		result.push({
			path: manifestPath.replace(/\/package\.json$/, ''),
			manifest,
		});
	}
	return result;
}

export async function readExtensionFile(path: string): Promise<string> {
	const loader = extensionFiles[path];
	if (!loader) {
		throw new Error(`Unknown extension file: ${path}`);
	}
	return loader();
}
