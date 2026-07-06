import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url';
import { createIndexedDBFileSystem, createWorkbench, loadColorTheme, registerTextMateSupport } from '../src';
import { readExtensionFile, vendorExtensions } from './languages';
import { sampleWorkspace } from './sampleWorkspace';

// The pinned VS Code checkout ships the built-in color themes; load them as
// raw text (they are JSONC) and let the library resolve include chains.
const themeFiles = import.meta.glob('/vendor/vscode/extensions/theme-defaults/themes/*.json', {
	query: '?raw',
	import: 'default',
}) as Record<string, () => Promise<string>>;

async function readThemeFile(path: string): Promise<string> {
	const loader = themeFiles[path];
	if (!loader) {
		throw new Error(`Unknown theme file: ${path}`);
	}
	return loader();
}

async function main(): Promise<void> {
	const fs = await createIndexedDBFileSystem({ dbName: 'minwebide-demo' });
	await fs.seed(sampleWorkspace);

	const theme = await loadColorTheme('/vendor/vscode/extensions/theme-defaults/themes/dark_modern.json', readThemeFile);

	await registerTextMateSupport({
		onigWasmUrl,
		extensions: vendorExtensions(),
		readExtensionFile,
		theme,
	});

	createWorkbench(document.getElementById('app')!, {
		fileSystem: fs,
		theme,
		workspaceName: 'demo workspace',
	});
}

main();
