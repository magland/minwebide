import { defineConfig } from 'vite';
import { minwebide } from './vite.mjs';

// The demo app uses the same shared config that consuming apps use
// (via `import { minwebide } from 'minwebide/vite'`).
export default defineConfig(minwebide());
