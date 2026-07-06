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
	'/data/measurements.csv': `sample,voltage_mV,current_uA,temperature_C,status
s-001,12.4,340,21.5,ok
s-002,11.9,332,21.7,ok
s-003,12.1,,21.4,"missing current"
s-004,13.0,355,22.1,ok
s-005,12.6,349,21.9,recalibrated
s-006,12.2,338,21.6,ok
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
	'/scripts/fibonacci.js': `// Press the ▶ button in the tab bar to run this file.
// Output appears in the Output view of the bottom panel.

function fib(n) {
	return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

for (let i = 1; i <= 10; i++) {
	console.log(\`fib(\${i}) = \${fib(i)}\`);
}

console.warn('warnings and errors are colorized by the log grammar');
`,
	'/docs/notes.md': `# Notes

Everything you see is either VS Code's own code (editor, file tree,
splitters, colors, icons) or a thin shell styled with VS Code's theme
variables.
`,
};
