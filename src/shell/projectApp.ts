import { applyThemeToElement, type WorkbenchTheme } from '../theme/themes';
import { createIndexedDBFileSystem, type WorkspaceFileSystem } from '../fs/fileSystem';
import type { Workbench } from '../workbench/workbench';
import { attachGitHubSourceControl, attachGitHubWorkspace } from '../github/githubView';
import { parseGitHubSpec, type GitHubRepoSpec } from '../github/githubImport';
import { transplantGitHubWorkspace } from '../github/githubSync';
import { createProjectRegistry, type ProjectInfo, type ProjectRegistry } from './projectRegistry';
import './projectLanding.css';

// The project-app shell: everything a "projects stored in your browser" app
// shares — the landing page (project picker), the hash router, the project
// IDE wrapper (source control, publish, starting file), and the GitHub route
// (a repo as its own workspace). Apps provide a ProjectAppConfig: identity,
// how to assemble their workbench, and the landing content.
//
// Routes:
//   #/                     project picker (landing page)
//   #/project/<id>         the IDE, opened on that project's file system
//   #/github/<spec>        a GitHub repo as its own workspace (owner/repo[@ref],
//                          or a URL-encoded github.com URL); imports on first
//                          visit, then keeps a local editable copy — the URL
//                          stays on this route and no project is created

export interface ProjectAppConfig {
	/** Kebab-case id for storage keys and IndexedDB names, e.g. 'my-app'. */
	readonly appId: string;
	/** Display name, used in document titles and the GitHub token description. */
	readonly appName: string;
	/** Assembles the app's workbench (runners, custom editors, status items) on a file system. The caller disposes `fs`. */
	readonly assembleWorkbench: (container: HTMLElement, fs: WorkspaceFileSystem, workspaceName: string, theme: WorkbenchTheme) => Promise<AppWorkbench>;
	/** Paths tried, in order, for the initially opened editor. */
	readonly startingFiles: readonly string[];
	readonly landing: {
		readonly subtitle: string;
		readonly links: readonly { readonly label: string; readonly href: string }[];
		/** Files seeding a "New sample project". */
		readonly sampleWorkspace: Record<string, string | Uint8Array>;
		/** Tooltip of the "New sample project" button. */
		readonly sampleButtonTitle?: string;
		/** Files seeding a "New project", given the freshly created project. */
		readonly emptyWorkspace: (project: ProjectInfo) => Record<string, string | Uint8Array>;
	};
}

export interface AppWorkbench {
	readonly workbench: Workbench;
	dispose(): void;
}

/** The per-repo workspace database backing a #/github route. */
export function githubWorkspaceDbName(appId: string, spec: Pick<GitHubRepoSpec, 'owner' | 'repo' | 'ref' | 'dir'>): string {
	return `${appId}-gh-${spec.owner}-${spec.repo}${spec.ref ? `-${spec.ref}` : ''}${spec.dir ? `-${spec.dir}` : ''}`
		.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

/** Opens the first of `paths` that exists, if any. */
export async function openStartingFile(fs: WorkspaceFileSystem, workbench: Workbench, paths: readonly string[]): Promise<void> {
	for (const path of paths) {
		const uri = fs.root.with({ path });
		if (await fs.fileService.exists(uri)) {
			await workbench.openFile(uri);
			return;
		}
	}
}

/**
 * Opens the IDE for a registry project: the app's workbench plus the project
 * status bar item and source control (publish to GitHub; once published —
 * or for a duplicate of an imported workspace — change tracking and push).
 * Returns a disposable view.
 */
export async function openProjectIde(container: HTMLElement, project: ProjectInfo, theme: WorkbenchTheme, config: ProjectAppConfig, registry: ProjectRegistry): Promise<{ dispose(): void }> {
	registry.touchProject(project.id);
	document.title = `${project.name} — ${config.appName}`;

	const fs = await registry.openProjectFileSystem(project.id);
	const ide = await config.assembleWorkbench(container, fs, project.name, theme);

	// the project indicator: click to go back to the project list
	ide.workbench.statusBar.setItem('project', 'left', project.name, {
		icon: 'folder-opened',
		title: 'Back to projects',
		onClick: () => { location.hash = '#/'; },
	});
	// replace the default branding item with the project indicator
	ide.workbench.statusBar.removeItem('branding');

	// source control: publish this project to a new GitHub repo, or — once
	// published — track changes and push
	const sourceControl = await attachGitHubSourceControl(ide.workbench, fs, {
		appName: config.appName,
		defaultRepoName: project.name,
		// after publishing, seed the repo's own workspace from the local copy
		// (no re-download — the local state IS the pushed state) and make its
		// route the canonical place to work
		onPublished: async ({ owner, repo }) => {
			const ghFs = await createIndexedDBFileSystem({ dbName: githubWorkspaceDbName(config.appId, { owner, repo }) });
			try {
				await transplantGitHubWorkspace(fs, ghFs);
			} finally {
				ghFs.dispose();
			}
			location.hash = `#/github/${owner}/${repo}`;
		},
	});

	await openStartingFile(fs, ide.workbench, config.startingFiles);

	return {
		dispose() {
			sourceControl.dispose();
			ide.dispose();
			fs.dispose();
		},
	};
}

/**
 * Handles a #/github/<spec> route: the repository as a workspace of its own.
 * <spec> is anything parseGitHubSpec accepts. The URL is the identity —
 * nothing is added to the project registry. The first visit imports into a
 * per-repo IndexedDB database; later visits reopen that local copy, edits
 * included, with the Source Control view tracking changes against the
 * imported commit. Returns a disposable view (the IDE, or an error screen).
 */
export async function openGitHubRoute(container: HTMLElement, specText: string, theme: WorkbenchTheme, config: ProjectAppConfig): Promise<{ dispose(): void }> {
	let fs: WorkspaceFileSystem | undefined;
	let ide: AppWorkbench | undefined;
	try {
		const spec = parseGitHubSpec(specText);
		const name = `${spec.owner}/${spec.repo}`;
		document.title = `${name} — ${config.appName}`;

		fs = await createIndexedDBFileSystem({ dbName: githubWorkspaceDbName(config.appId, spec) });
		ide = await config.assembleWorkbench(container, fs, name, theme);
		ide.workbench.statusBar.removeItem('branding');
		ide.workbench.statusBar.setItem('project', 'left', 'Projects', {
			icon: 'arrow-left',
			title: 'Back to projects',
			onClick: () => { location.hash = '#/'; },
		});

		// imports on first visit (status bar progress + GitHub output channel);
		// the README is left to openStartingFile, which prefers app entry points
		const view = await attachGitHubWorkspace(ide.workbench, fs, spec, { autoOpenReadme: false, appName: config.appName });
		await openStartingFile(fs, ide.workbench, config.startingFiles);

		return {
			dispose() {
				view.dispose();
				ide!.dispose();
				fs!.dispose();
			},
		};
	} catch (error) {
		ide?.dispose();
		fs?.dispose();
		container.textContent = '';
		const message = error instanceof Error ? error.message : String(error);
		return renderErrorScreen(container, theme, `Could not open repository: ${message}`);
	}
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

function renderErrorScreen(container: HTMLElement, theme: WorkbenchTheme, text: string): { dispose(): void } {
	const root = el('div', 'landing');
	applyThemeToElement(theme, root);
	const inner = el('div', 'landing-inner');
	inner.appendChild(el('p', 'landing-subtitle', text));
	const back = el('a', 'landing-link', 'Back to projects');
	back.href = '#/';
	inner.appendChild(back);
	root.appendChild(inner);
	container.appendChild(root);
	return { dispose: () => root.remove() };
}

function formatWhen(timestamp: number): string {
	const delta = Date.now() - timestamp;
	if (delta < 60_000) {
		return 'just now';
	}
	if (delta < 3_600_000) {
		return `${Math.round(delta / 60_000)}m ago`;
	}
	if (delta < 86_400_000) {
		return `${Math.round(delta / 3_600_000)}h ago`;
	}
	return new Date(timestamp).toLocaleDateString();
}

/** Renders the project-picker landing page. Returns a disposable view. */
export function renderProjectLanding(container: HTMLElement, theme: WorkbenchTheme, config: ProjectAppConfig, registry: ProjectRegistry): { dispose(): void } {
	const root = el('div', 'landing');
	applyThemeToElement(theme, root);
	container.appendChild(root);
	document.title = config.appName;

	const inner = el('div', 'landing-inner');
	root.appendChild(inner);

	const header = el('header', 'landing-header');
	header.appendChild(el('h1', undefined, config.appName));
	header.appendChild(el('p', 'landing-subtitle', config.landing.subtitle));
	const links = el('p', 'landing-links');
	config.landing.links.forEach((link, index) => {
		if (index > 0) {
			links.append(' · ');
		}
		const a = el('a', 'landing-link', link.label);
		a.href = link.href;
		links.append(a);
	});
	header.appendChild(links);
	inner.appendChild(header);

	const openProject = (id: string): void => {
		location.hash = `#/project/${id}`;
	};

	const createSampleProject = async (): Promise<ProjectInfo> => {
		const project = registry.createProject(registry.nextUntitledName('sample'));
		const fs = await registry.openProjectFileSystem(project.id);
		try {
			await fs.seed(config.landing.sampleWorkspace);
		} finally {
			fs.dispose();
		}
		return project;
	};

	const createEmptyProject = async (): Promise<ProjectInfo> => {
		const project = registry.createProject(registry.nextUntitledName());
		const fs = await registry.openProjectFileSystem(project.id);
		try {
			await fs.seed(config.landing.emptyWorkspace(project));
		} finally {
			fs.dispose();
		}
		return project;
	};

	// start section
	const start = el('section', 'landing-section');
	start.appendChild(el('h2', undefined, 'Start'));
	const startButtons = el('div', 'landing-start');
	const newButton = el('button', 'landing-button primary', 'New project');
	newButton.addEventListener('click', async () => {
		newButton.disabled = true;
		openProject((await createEmptyProject()).id);
	});
	const sampleButton = el('button', 'landing-button', 'New sample project');
	if (config.landing.sampleButtonTitle) {
		sampleButton.title = config.landing.sampleButtonTitle;
	}
	sampleButton.addEventListener('click', async () => {
		sampleButton.disabled = true;
		openProject((await createSampleProject()).id);
	});
	startButtons.append(newButton, sampleButton);
	start.appendChild(startButtons);
	inner.appendChild(start);

	// projects section
	const section = el('section', 'landing-section');
	section.appendChild(el('h2', undefined, 'Projects'));
	const list = el('div', 'landing-projects');
	section.appendChild(list);
	inner.appendChild(section);

	const renderList = () => {
		list.textContent = '';
		const projects = registry.listProjects();
		if (projects.length === 0) {
			list.appendChild(el('div', 'landing-empty', 'No projects yet.'));
			return;
		}
		for (const project of projects) {
			const row = el('div', 'landing-project');

			const name = el('a', 'landing-project-name', project.name);
			name.href = `#/project/${project.id}`;
			row.appendChild(name);

			row.appendChild(el('span', 'landing-project-meta', `opened ${formatWhen(project.lastOpenedAt)}`));

			const actions = el('span', 'landing-project-actions');
			const action = (label: string, handler: () => void | Promise<void>) => {
				const button = el('button', 'landing-action', label);
				button.addEventListener('click', () => handler());
				actions.appendChild(button);
			};
			action('Rename', () => {
				const name = prompt('Project name', project.name);
				if (name !== null) {
					registry.renameProject(project.id, name);
					renderList();
				}
			});
			action('Duplicate', async () => {
				await registry.duplicateProject(project.id);
				renderList();
			});
			action('Delete', async () => {
				if (confirm(`Delete project "${project.name}" and all of its files?`)) {
					await registry.deleteProject(project.id);
					renderList();
				}
			});
			row.appendChild(actions);
			list.appendChild(row);
		}
	};
	renderList();

	return {
		dispose() {
			root.remove();
		},
	};
}

/**
 * Boots the app: creates the registry, wires the hash router over the three
 * routes, and renders the current one. Returns the registry for app code
 * that needs it.
 */
export async function startProjectApp(container: HTMLElement, theme: WorkbenchTheme, config: ProjectAppConfig): Promise<ProjectRegistry> {
	const registry = createProjectRegistry(config.appId);

	let current: { dispose(): void } | undefined;
	let navigating = false;

	const route = async () => {
		if (navigating) {
			return;
		}
		navigating = true;
		try {
			current?.dispose();
			current = undefined;
			container.textContent = '';

			const github = location.hash.match(/^#\/github\/(.+)$/);
			if (github) {
				current = await openGitHubRoute(container, decodeURIComponent(github[1]), theme, config);
				return;
			}

			const match = location.hash.match(/^#\/project\/([a-z0-9]+)/i);
			if (match) {
				const project = registry.getProject(match[1]);
				if (project) {
					current = await openProjectIde(container, project, theme, config, registry);
					return;
				}
				// unknown project id: fall through to the landing page
				history.replaceState(null, '', '#/');
			}
			current = renderProjectLanding(container, theme, config, registry);
		} finally {
			navigating = false;
		}
	};

	window.addEventListener('hashchange', route);
	await route();
	return registry;
}
