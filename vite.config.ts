import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const vendorDir = fileURLToPath(new URL('./vendor/vscode/', import.meta.url));

// VS Code vendors a few prebuilt libraries (e.g. dompurify.js) whose trailing
// `//# sourceMappingURL=` comments point at map files the repo doesn't ship.
// Strip those comments so the dev server doesn't warn on every load.
function stripVendorSourcemapRefs(): Plugin {
	return {
		name: 'minwebide:strip-vendor-sourcemap-refs',
		enforce: 'pre',
		async load(id) {
			if (id.startsWith(vendorDir) && id.endsWith('.js')) {
				const code = await readFile(id, 'utf8');
				if (code.includes('sourceMappingURL')) {
					return code.replace(/^\/\/#\s*sourceMappingURL=\S+\s*$/gm, '');
				}
			}
			return null;
		},
	};
}

// minwebide bundles modules straight out of the pinned VS Code source checkout
// in vendor/vscode. The `vs` alias mirrors the import root that the VS Code
// codebase uses internally.
export default defineConfig({
	plugins: [stripVendorSourcemapRefs()],
	resolve: {
		alias: [
			{
				find: 'vs',
				replacement: fileURLToPath(new URL('./vendor/vscode/src/vs', import.meta.url)),
			},
		],
	},
	worker: {
		format: 'es',
	},
	build: {
		target: 'es2022',
	},
});
