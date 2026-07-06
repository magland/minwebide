import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// minwebide bundles modules straight out of the pinned VS Code source checkout
// in vendor/vscode. The `vs` alias mirrors the import root that the VS Code
// codebase uses internally.
export default defineConfig({
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
