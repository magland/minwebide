import { createIndexedDBFileSystem, createWorkbench, loadBuiltinTheme, registerBuiltinLanguages } from 'minwebide';

async function main(): Promise<void> {
	const fs = await createIndexedDBFileSystem({ dbName: '__APP_NAME__' });
	await fs.seed({
		'/hello.ts': `export function greet(name: string): string {\n\treturn \`Hello, \${name}!\`;\n}\n`,
		'/README.md': `# __APP_NAME__\n\nBuilt on minwebide.\n`,
	});

	const theme = await loadBuiltinTheme('dark_modern');
	await registerBuiltinLanguages(theme);

	const workbench = createWorkbench(document.getElementById('app')!, {
		fileSystem: fs,
		theme,
		workspaceName: '__APP_NAME__',
	});

	// From here, make it yours:
	//   workbench.registerCustomEditor({ ... })   custom views for file types
	//   workbench.registerRunner({ ... })         run files, output to the panel
	//   workbench.createOutputChannel(name)       VS Code-style output channels
	//   workbench.createAuxiliaryView(id, title)  views in the secondary side bar
	await workbench.openFile(fs.root.with({ path: '/hello.ts' }));
}

main();
