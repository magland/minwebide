import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url';
import { createIndexedDBFileSystem, createWorkbench, loadColorTheme, registerTextMateSupport } from '../src';
import { demoCustomEditors } from './customEditors';
import { readExtensionFile, vendorExtensions } from './languages';
import { demoRunners } from './runners';
import { sampleWorkspace } from './sampleWorkspace';

/** A sample PNG, generated on the fly, to exercise the binary file path. */
async function generateSampleImage(): Promise<Uint8Array> {
	const canvas = document.createElement('canvas');
	canvas.width = 320;
	canvas.height = 200;
	const ctx = canvas.getContext('2d')!;
	const gradient = ctx.createLinearGradient(0, 0, 320, 200);
	gradient.addColorStop(0, '#0078d4');
	gradient.addColorStop(1, '#4ec9b0');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, 320, 200);
	ctx.fillStyle = 'white';
	ctx.font = 'bold 28px sans-serif';
	ctx.textAlign = 'center';
	ctx.fillText('minwebide', 160, 108);
	const blob = await new Promise<Blob>((resolve, reject) =>
		canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png'));
	return new Uint8Array(await blob.arrayBuffer());
}

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
	await fs.seed({
		...sampleWorkspace,
		'/assets/banner.png': await generateSampleImage(),
	});

	const theme = await loadColorTheme('/vendor/vscode/extensions/theme-defaults/themes/dark_modern.json', readThemeFile);

	await registerTextMateSupport({
		onigWasmUrl,
		extensions: vendorExtensions(),
		readExtensionFile,
		theme,
	});

	const workbench = createWorkbench(document.getElementById('app')!, {
		fileSystem: fs,
		theme,
		workspaceName: 'demo workspace',
		customEditors: demoCustomEditors,
	});
	for (const runner of demoRunners) {
		workbench.registerRunner(runner);
	}
}

main();
