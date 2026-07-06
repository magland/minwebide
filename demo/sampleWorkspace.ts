export const sampleWorkspace: Record<string, string> = {
	'/README.md': `# Demo workspace

This workspace lives entirely in your browser's IndexedDB, served through
VS Code's own \`IndexedDBFileSystemProvider\` and \`FileService\`.

- Edit a file and press **Ctrl+S** to save it.
- Reload the page: your changes persist.
- Open this app in a second tab: changes broadcast across tabs.
`,
	'/src/main.ts': `import { greet } from './utils';

export function main(): void {
	const message = greet('minwebide');
	console.log(message);
}

main();
`,
	'/src/utils.ts': `const EXCLAMATIONS = 3;

export function greet(name: string): string {
	return \`Hello, \${name}\` + '!'.repeat(EXCLAMATIONS);
}
`,
	'/src/styles.css': `:root {
	--accent: #0078d4;
}

body {
	font-family: system-ui, sans-serif;
	color: var(--accent);
}
`,
	'/data/config.json': `{
	"name": "minwebide-demo",
	"version": "0.1.0",
	"features": {
		"indexeddb": true,
		"textmate": true
	}
}
`,
	'/docs/notes.md': `# Notes

Everything you see is either VS Code's own code (editor, file tree,
splitters, colors, icons) or a thin shell styled with VS Code's theme
variables.
`,
};
