import {
	attachGitHubSourceControl, attachGitHubWorkspace, createIndexedDBFileSystem, createWorkbench,
	loadBuiltinTheme, parseGitHubSpec, registerBuiltinLanguages, transplantGitHubWorkspace,
	GitHubRepoSpec, Workbench, WorkspaceFileSystem,
} from '../src';
import { demoCustomEditors } from './customEditors';
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

async function createDemoWorkbench(fs: WorkspaceFileSystem, workspaceName: string): Promise<Workbench> {
	const theme = await loadBuiltinTheme('dark_modern');
	await registerBuiltinLanguages(theme);
	const workbench = createWorkbench(document.getElementById('app')!, {
		fileSystem: fs,
		theme,
		workspaceName,
		customEditors: demoCustomEditors,
	});
	for (const runner of demoRunners) {
		workbench.registerRunner(runner);
	}
	return workbench;
}

/**
 * A `#github/owner/repo[@ref]` fragment (full github.com URLs work too) opens
 * that repository as its own workspace — a per-repo IndexedDB database, so the
 * regular demo workspace is untouched. The first visit imports; later visits
 * reopen the stored copy, edits included, with the Source Control view
 * tracking local changes against the imported commit.
 */
function githubWorkspaceDbName(spec: Pick<GitHubRepoSpec, 'owner' | 'repo' | 'ref'>): string {
	return `minwebide-demo-gh-${spec.owner}-${spec.repo}${spec.ref ? `-${spec.ref}` : ''}`
		.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

async function openGitHubWorkspace(specText: string): Promise<void> {
	const spec = parseGitHubSpec(specText);
	const fs = await createIndexedDBFileSystem({ dbName: githubWorkspaceDbName(spec) });
	const workbench = await createDemoWorkbench(fs, `${spec.owner}/${spec.repo}`);
	await attachGitHubWorkspace(workbench, fs, spec);
}

async function main(): Promise<void> {
	const gh = /^#github\/(.+)$/.exec(window.location.hash);
	if (gh) {
		await openGitHubWorkspace(decodeURIComponent(gh[1]));
		return;
	}

	const fs = await createIndexedDBFileSystem({ dbName: 'minwebide-demo' });
	await fs.seed({
		...sampleWorkspace,
		'/assets/banner.png': await generateSampleImage(),
	});
	const workbench = await createDemoWorkbench(fs, 'demo workspace');
	// unconnected → "Publish to GitHub" form; once published → the repo's own
	// #github workspace becomes the place to work
	await attachGitHubSourceControl(workbench, fs, {
		appName: 'minwebide demo',
		defaultRepoName: 'minwebide-demo-workspace',
		onPublished: async ({ owner, repo }) => {
			// seed the repo's own workspace locally — no re-download
			const ghFs = await createIndexedDBFileSystem({ dbName: githubWorkspaceDbName({ owner, repo }) });
			try {
				await transplantGitHubWorkspace(fs, ghFs);
			} finally {
				ghFs.dispose();
			}
			window.location.hash = `#github/${owner}/${repo}`;
			window.location.reload();
		},
	});
}

main();
