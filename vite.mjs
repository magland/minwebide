// Shared Vite configuration for apps built on minwebide.
//
// Usage in an app's vite.config.ts:
//
//   import { defineConfig, mergeConfig } from 'vite';
//   import { minwebide } from 'minwebide/vite';
//
//   export default defineConfig(mergeConfig(minwebide(), {
//     // app-specific config
//   }));
//
// It wires up everything consuming VS Code source requires: the `vs` alias
// into the pinned vendor checkout (which lives inside the minwebide package,
// shared by all apps), worker format, dev-server file access across the
// package symlink, and the vendored-sourcemap workaround.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { searchForWorkspaceRoot } from 'vite';

const packageDir = fileURLToPath(new URL('.', import.meta.url));
const vendorDir = fileURLToPath(new URL('./vendor/vscode/', import.meta.url));

// VS Code vendors a few prebuilt libraries (e.g. dompurify.js) whose trailing
// `//# sourceMappingURL=` comments point at map files the repo doesn't ship.
// Strip those comments so the dev server doesn't warn on every load.
function stripVendorSourcemapRefs() {
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

/**
 * @returns {import('vite').UserConfig}
 */
export function minwebide() {
	return {
		plugins: [stripVendorSourcemapRefs()],
		resolve: {
			alias: [
				{ find: 'vs', replacement: `${vendorDir}src/vs` },
			],
		},
		worker: {
			format: 'es',
		},
		build: {
			target: 'es2022',
		},
		server: {
			fs: {
				// the app is served from its own root, but library source and
				// the vendor tree live inside the (possibly symlinked)
				// minwebide package
				allow: [searchForWorkspaceRoot(process.cwd()), packageDir],
			},
		},
		optimizeDeps: {
			// minwebide is distributed as source; its ?worker and
			// import.meta.glob imports must be handled by Vite itself,
			// not esbuild pre-bundling
			exclude: ['minwebide'],
		},
	};
}
