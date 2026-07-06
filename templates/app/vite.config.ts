import { defineConfig, mergeConfig } from 'vite';
import { minwebide } from 'minwebide/vite';

export default defineConfig(mergeConfig(minwebide(), {
	// app-specific Vite config goes here
}));
