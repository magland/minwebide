import { $, append } from 'vs/base/browser/dom';
import { Delayer } from 'vs/base/common/async';
import { DisposableStore } from 'vs/base/common/lifecycle';
import type { Workbench } from '../workbench/workbench';
import type { WorkspaceFileSystem } from '../fs/fileSystem';
import type { OutputChannel } from '../workbench/outputChannels';
import { clearGitHubToken, getGitHubTokenUser, getStoredGitHubToken, requestGitHubToken } from './githubAuth';
import { getGitHubRepoMetadata, GitHubApiError, importGitHubRepo, parseGitHubSpec, type GitHubImportResult, type GitHubRepoSpec } from './githubImport';
import { diffGitHubWorkspace, publishGitHubRepo, pushGitHubChanges, resyncGitHubRepo, type GitHubPublishResult, type GitHubWorkspaceChanges } from './githubSync';

// A VS Code-style source control experience over a workspace's GitHub state.
// Two modes, switching automatically:
//  - not connected: a "Publish to GitHub" form (new repo on the user's
//    account), like VS Code's empty source control view;
//  - connected (imported or published): a change list against the baseline
//    commit (activity bar badge, dirty `*` on the status bar item),
//    "Commit & Push", and "Reload from GitHub".
// Sign-in reproduces VS Code's PAT flow: a pre-filled token page plus one
// paste; the token stays in localStorage.

export interface GitHubSourceControlOptions {
	/** Workspace folder holding the repo. Default: `'/'` (repo-as-workspace). */
	readonly target?: string;
	/** GitHub token — used instead of the sign-in flow when provided. */
	readonly auth?: string;
	/** Name shown in the pre-filled token description on GitHub. Default: 'minwebide'. */
	readonly appName?: string;
	/** Suggested repository name, pre-filled on GitHub's create-repository page. */
	readonly defaultRepoName?: string;
	/**
	 * Called after a successful publish, typically to navigate the app to its
	 * GitHub route for the new repo. When absent, the view switches to change
	 * tracking in place.
	 */
	readonly onPublished?: (result: GitHubPublishResult) => void;
}

export interface GitHubWorkspaceOptions extends GitHubSourceControlOptions {
	/** Open the repository README after a first import. Default: true. */
	readonly autoOpenReadme?: boolean;
}

export interface GitHubWorkspaceView {
	/** Import result when attaching had to import (first visit); undefined when the stored copy was reused. */
	readonly imported: GitHubImportResult | undefined;
	/** Re-diffs the workspace and updates the view, badge, and status bar item. */
	refresh(): Promise<void>;
	dispose(): void;
}

/**
 * Runs a GitHub read (import, resync) with the best available credential:
 * `options.auth`, else the stored token, else anonymously. A stale stored
 * token (401) is cleared and the read retried without it; a 404 with no
 * credential — which is also how GitHub answers for private repositories —
 * prompts for sign-in once and retries.
 */
async function withReadAuth<T>(
	workbench: Workbench,
	options: GitHubSourceControlOptions,
	describe: string,
	run: (auth: string | undefined) => Promise<T>,
): Promise<T> {
	let auth = options.auth ?? getStoredGitHubToken();
	let prompted = false;
	for (;;) {
		try {
			return await run(auth);
		} catch (error) {
			if (error instanceof GitHubApiError && error.status === 401 && auth && auth !== options.auth) {
				clearGitHubToken();
				auth = undefined;
				continue;
			}
			if (error instanceof GitHubApiError && error.status === 404 && !auth && !prompted) {
				prompted = true;
				const token = await requestGitHubToken(workbench.element, options.appName ?? 'minwebide',
					`${describe} was not found — if it is a private repository, sign in to access it. ` +
					'Continue to GitHub to create a personal access token, then paste it below. The token is stored only in this browser.');
				if (token) {
					auth = token;
					continue;
				}
			}
			throw error;
		}
	}
}

/**
 * Makes a workbench a GitHub-backed workspace: imports the repository on
 * first visit (with status bar progress and a `GitHub` output channel log),
 * then attaches the source control view. Reads use the stored token when one
 * exists, so private repositories work; an anonymous 404 offers sign-in.
 */
export async function attachGitHubWorkspace(
	workbench: Workbench,
	fs: WorkspaceFileSystem,
	spec: string | GitHubRepoSpec,
	options: GitHubWorkspaceOptions = {},
): Promise<GitHubWorkspaceView> {
	const parsed = typeof spec === 'string' ? parseGitHubSpec(spec) : spec;
	const target = options.target ?? '/';
	const channel = workbench.createOutputChannel('GitHub');

	let imported: GitHubImportResult | undefined;
	if (!getGitHubRepoMetadata(fs, target)) {
		channel.appendLine(`Importing github.com/${parsed.owner}/${parsed.repo}${parsed.ref ? `@${parsed.ref}` : ''}...`);
		try {
			imported = await withReadAuth(workbench, options, `github.com/${parsed.owner}/${parsed.repo}`, auth => importGitHubRepo(fs, parsed, {
				target,
				clean: true,
				auth,
				onProgress: p => workbench.statusBar.setItem('github', 'left', `Importing ${p.written}/${p.total}`, { icon: 'cloud-download' }),
			}));
			channel.appendLine(`Imported ${imported.fileCount} files at commit ${imported.commitSha.slice(0, 7)}`);
			for (const skip of imported.skipped) {
				channel.appendLine(`Skipped ${skip.path} (${skip.reason})`);
			}
		} catch (error) {
			workbench.statusBar.removeItem('github');
			channel.appendLine(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
			channel.show();
			throw error;
		}
	}

	const view = attachView(workbench, fs, channel, options);
	await view.refresh();

	if (imported && options.autoOpenReadme !== false) {
		const paths = Object.keys(getGitHubRepoMetadata(fs, target)?.files ?? {});
		const readme = paths.find(p => /^readme\.md$/i.test(p)) ?? paths.find(p => /^readme(\.|$)/i.test(p));
		if (readme) {
			await workbench.openFile(fs.root.with({ path: target === '/' ? `/${readme}` : `${target}/${readme}` }));
		}
	}

	return { imported, refresh: view.refresh, dispose: view.dispose };
}

/**
 * Attaches the source control view to a workspace that may or may not be
 * connected to GitHub yet: connected workspaces get change tracking and push,
 * unconnected ones get a "Publish to GitHub" form that creates a new
 * repository from the workspace contents (and then switches to tracking).
 */
export async function attachGitHubSourceControl(
	workbench: Workbench,
	fs: WorkspaceFileSystem,
	options: GitHubSourceControlOptions = {},
): Promise<GitHubWorkspaceView> {
	const channel = workbench.createOutputChannel('GitHub');
	const view = attachView(workbench, fs, channel, options);
	await view.refresh();
	return { imported: undefined, refresh: view.refresh, dispose: view.dispose };
}

function attachView(
	workbench: Workbench,
	fs: WorkspaceFileSystem,
	channel: OutputChannel,
	options: GitHubSourceControlOptions,
): { refresh(): Promise<void>; dispose(): void } {
	const target = options.target ?? '/';
	const statusId = 'github';
	const disposables = new DisposableStore();
	const modeDisposables = disposables.add(new DisposableStore());

	const root = $('.mw-sidebar-pane.mw-github');
	let refresh: () => Promise<void> = async () => undefined;
	let onShow: () => void = () => undefined;
	workbench.registerSideView('github', 'Source Control', root, {
		icon: 'source-control',
		onShow: () => onShow(),
	});

	const ensureToken = async (): Promise<string | undefined> => {
		return options.auth
			?? getStoredGitHubToken()
			?? requestGitHubToken(workbench.element, options.appName ?? 'minwebide');
	};

	const appendAccountLine = (container: HTMLElement): { update(): Promise<void> } => {
		const accountEl = append(container, $('.mw-github-account'));
		const accountText = append(accountEl, $('span'));
		const signOutLink = append(accountEl, $('a.mw-github-account-link', undefined, 'Sign out'));
		const update = async () => {
			const token = getStoredGitHubToken();
			signOutLink.style.display = token ? '' : 'none';
			if (!token) {
				accountText.textContent = 'Not signed in to GitHub';
				return;
			}
			accountText.textContent = 'Signed in to GitHub';
			const login = await getGitHubTokenUser(token);
			if (login && getStoredGitHubToken() === token) {
				accountText.textContent = `Signed in to GitHub as ${login}`;
			}
		};
		signOutLink.addEventListener('click', () => {
			clearGitHubToken();
			void update();
		});
		void update();
		return { update };
	};

	const renderMode = (): void => {
		modeDisposables.clear();
		root.textContent = '';
		if (getGitHubRepoMetadata(fs, target)) {
			refresh = renderTracking();
			onShow = () => void refresh();
		} else {
			renderPublish();
			refresh = async () => undefined;
			onShow = () => undefined;
		}
	};

	// ---- unconnected: the publish form ----
	const renderPublish = (): void => {
		workbench.setSideViewBadge('github', 0);
		workbench.statusBar.setItem(statusId, 'left', 'Publish to GitHub', {
			icon: 'cloud-upload',
			title: 'Publish this workspace to a new GitHub repository',
			onClick: () => workbench.showSideView('github'),
		});

		const form = append(root, $('.mw-github-form'));
		append(form, $('p.mw-github-form-text', undefined,
			'This workspace is not connected to GitHub. To publish it: create an empty repository on GitHub (no README), then paste its URL here.'));
		const createButton = append(form, $('button.mw-github-button.secondary')) as HTMLButtonElement;
		createButton.textContent = 'Create repository on GitHub';
		createButton.title = 'Opens github.com/new — create the repository without initializing it';
		createButton.addEventListener('click', () => {
			const suggested = (options.defaultRepoName ?? '').replace(/[^A-Za-z0-9._-]+/g, '-');
			window.open(`https://github.com/new${suggested ? `?name=${encodeURIComponent(suggested)}` : ''}`);
			urlInput.focus();
		});
		const urlInput = append(form, $('input.mw-github-commit-message')) as HTMLInputElement;
		urlInput.placeholder = 'https://github.com/you/repo';
		urlInput.spellcheck = false;
		const publishButton = append(form, $('button.mw-github-button')) as HTMLButtonElement;
		publishButton.textContent = 'Publish';
		publishButton.title = 'Push this workspace as the initial commit of the (empty) repository';
		const messageEl = append(root, $('.mw-github-message'));
		const account = appendAccountLine(root);

		publishButton.addEventListener('click', () => void (async () => {
			let repoSpec: { owner: string; repo: string };
			try {
				const parsed = parseGitHubSpec(urlInput.value);
				repoSpec = { owner: parsed.owner, repo: parsed.repo };
			} catch {
				messageEl.textContent = 'Enter the repository as owner/repo or a github.com URL.';
				urlInput.focus();
				return;
			}
			const token = await ensureToken();
			if (!token) {
				return;
			}
			void account.update();
			publishButton.disabled = true;
			try {
				const result = await publishGitHubRepo(fs, target, {
					auth: token,
					repo: repoSpec,
					onProgress: (uploaded, total) => { messageEl.textContent = `Uploading ${uploaded}/${total}...`; },
				});
				channel.appendLine(`Published ${result.fileCount} files to ${result.htmlUrl} (${result.ref} @ ${result.commitSha.slice(0, 7)})`);
				if (options.onPublished) {
					options.onPublished(result);
					return;
				}
			} catch (error) {
				if (error instanceof GitHubApiError && error.status === 401) {
					clearGitHubToken();
					void account.update();
					messageEl.textContent = 'GitHub rejected the token — it may have expired. Publish again to sign in.';
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				channel.appendLine(`Publish failed: ${message}`);
				messageEl.textContent = `Publish failed: ${message}`;
				return;
			} finally {
				publishButton.disabled = false;
			}
			renderMode();
			await refresh();
		})());
	};

	// ---- connected: change tracking, push, reload ----
	const renderTracking = (): (() => Promise<void>) => {
		const metadata = getGitHubRepoMetadata(fs, target)!;
		const repoLabel = `${metadata.owner}/${metadata.repo}`;

		const header = append(root, $('.mw-github-repo'));
		append(header, $('span.codicon.codicon-github'));
		const headerText = append(header, $('.mw-github-repo-text'));
		const titleEl = append(headerText, $('.mw-github-repo-name', undefined, repoLabel));
		titleEl.title = 'Open on GitHub';
		titleEl.addEventListener('click', () => {
			const m = getGitHubRepoMetadata(fs, target)!;
			window.open(`https://github.com/${m.owner}/${m.repo}/tree/${m.commitSha}`);
		});
		const refEl = append(headerText, $('.mw-github-repo-ref'));

		const commitEl = append(root, $('.mw-github-commit'));
		const commitInput = append(commitEl, $('input.mw-github-commit-message')) as HTMLInputElement;
		commitInput.placeholder = 'Commit message (Ctrl+Enter to push)';
		commitInput.spellcheck = false;

		const actions = append(root, $('.mw-github-actions'));
		const pushButton = append(actions, $('button.mw-github-button')) as HTMLButtonElement;
		pushButton.textContent = 'Commit & Push';
		pushButton.title = 'Commit the local changes on top of the imported commit and push to the branch';
		const resyncButton = append(actions, $('button.mw-github-button.secondary')) as HTMLButtonElement;
		resyncButton.textContent = 'Reload from GitHub';
		resyncButton.title = 'Discard local changes and re-import the repository at its ref';

		const messageEl = append(root, $('.mw-github-message'));
		const changesEl = append(root, $('.mw-github-changes'));
		const account = appendAccountLine(root);

		const renderChanges = (changes: GitHubWorkspaceChanges) => {
			changesEl.textContent = '';
			const rows: { path: string; kind: 'M' | 'A' | 'D' }[] = [
				...changes.modified.map(path => ({ path, kind: 'M' as const })),
				...changes.added.map(path => ({ path, kind: 'A' as const })),
				...changes.deleted.map(path => ({ path, kind: 'D' as const })),
			].sort((a, b) => a.path.localeCompare(b.path));
			for (const { path, kind } of rows) {
				const row = append(changesEl, $(`.mw-github-change.${kind === 'M' ? 'modified' : kind === 'A' ? 'added' : 'deleted'}`));
				append(row, $('span.codicon.codicon-file'));
				const slash = path.lastIndexOf('/');
				append(row, $('span.mw-github-change-name', undefined, path.slice(slash + 1)));
				if (slash > 0) {
					append(row, $('span.mw-github-change-dir', undefined, path.slice(0, slash)));
				}
				append(row, $('span.mw-github-change-kind', undefined, kind));
				row.title = path;
				if (kind !== 'D') {
					row.addEventListener('click', () => void workbench.openFile(fs.root.with({
						path: target === '/' ? `/${path}` : `${target}/${path}`,
					})));
				}
			}
		};

		let refreshing = false;
		const doRefresh = async (): Promise<void> => {
			if (refreshing || disposables.isDisposed) {
				return;
			}
			refreshing = true;
			try {
				const m = getGitHubRepoMetadata(fs, target)!;
				const changes = await diffGitHubWorkspace(fs, target);
				if (disposables.isDisposed) {
					return;
				}
				refEl.textContent = `${m.ref} @ ${m.commitSha.slice(0, 7)}`;
				messageEl.textContent = changes.total === 0
					? 'No local changes.'
					: `${changes.total} local change${changes.total === 1 ? '' : 's'}`;
				renderChanges(changes);
				workbench.setSideViewBadge('github', changes.total);
				workbench.statusBar.setItem(statusId, 'left', `${repoLabel}@${m.commitSha.slice(0, 7)}${changes.total > 0 ? '*' : ''}`, {
					icon: 'source-control',
					title: changes.total > 0
						? `${changes.total} local change${changes.total === 1 ? '' : 's'} — click to review`
						: `In sync with the imported commit — click for details`,
					onClick: () => workbench.showSideView('github'),
				});
			} finally {
				refreshing = false;
			}
		};

		const doPush = async (): Promise<void> => {
			const changes = await diffGitHubWorkspace(fs, target);
			if (changes.total === 0) {
				messageEl.textContent = 'No local changes to push.';
				return;
			}
			const token = await ensureToken();
			if (!token) {
				return;
			}
			void account.update();
			pushButton.disabled = true;
			resyncButton.disabled = true;
			try {
				const result = await pushGitHubChanges(fs, target, {
					auth: token,
					message: commitInput.value,
					onProgress: (uploaded, total) => { messageEl.textContent = `Pushing ${uploaded}/${total}...`; },
				});
				channel.appendLine(`Pushed commit ${result.commitSha.slice(0, 7)} (${result.pushed.total} change${result.pushed.total === 1 ? '' : 's'}): ${result.htmlUrl}`);
				commitInput.value = '';
			} catch (error) {
				if (error instanceof GitHubApiError && error.status === 401) {
					clearGitHubToken();
					void account.update();
					messageEl.textContent = 'GitHub rejected the token — it may have expired. Push again to sign in.';
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				channel.appendLine(`Push failed: ${message}`);
				messageEl.textContent = `Push failed: ${message}`;
				return;
			} finally {
				pushButton.disabled = false;
				resyncButton.disabled = false;
			}
			await doRefresh();
		};
		pushButton.addEventListener('click', () => void doPush());
		commitInput.addEventListener('keydown', e => {
			if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
				void doPush();
			}
		});

		resyncButton.addEventListener('click', () => void (async () => {
			const changes = await diffGitHubWorkspace(fs, target);
			const warning = changes.total > 0
				? `Discard ${changes.total} local change${changes.total === 1 ? '' : 's'} and reload ${repoLabel} from GitHub?`
				: `Reload ${repoLabel} from GitHub?`;
			if (!window.confirm(warning)) {
				return;
			}
			resyncButton.disabled = true;
			pushButton.disabled = true;
			try {
				const result = await withReadAuth(workbench, options, repoLabel, auth => resyncGitHubRepo(fs, target, {
					auth,
					onProgress: p => { messageEl.textContent = `Reloading ${p.written}/${p.total}...`; },
				}));
				channel.appendLine(`Reloaded ${result.fileCount} files at commit ${result.commitSha.slice(0, 7)}`);
				// the reload is an explicit revert: open editors follow, unsaved edits included
				await workbench.editorArea.reloadFromDisk(true);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				channel.appendLine(`Reload failed: ${message}`);
				messageEl.textContent = `Reload failed: ${message}`;
				return;
			} finally {
				resyncButton.disabled = false;
				pushButton.disabled = false;
			}
			await doRefresh();
		})());

		// re-diff on any workspace change (editor saves, explorer operations,
		// other tabs), debounced — hashing the tree on every event would be waste
		const delayer = modeDisposables.add(new Delayer<void>(500));
		modeDisposables.add(fs.fileService.onDidFilesChange(() => {
			delayer.trigger(() => doRefresh());
		}));

		return doRefresh;
	};

	renderMode();

	return {
		refresh: () => refresh(),
		dispose: () => {
			disposables.dispose();
			workbench.statusBar.removeItem(statusId);
		},
	};
}
