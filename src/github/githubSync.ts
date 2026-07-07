import { URI } from 'vs/base/common/uri';
import type { WorkspaceFileSystem } from '../fs/fileSystem';
import {
	fetchBlob, getGitHubRepoMetadata, githubApi, GitHubApiError, importGitHubRepo, parseGitHubSpec, runLimited, setGitHubRepoMetadata,
	type GitHubFileState, type GitHubImportOptions, type GitHubImportResult,
} from './githubImport';

// Change tracking for imported GitHub folders. The working tree is compared
// against the blob SHAs recorded at import time the way git itself would —
// a file's blob SHA is sha1('blob <size>\0' + contents) — so a file only
// counts as modified when its bytes actually differ from the imported commit.

export interface GitHubWorkspaceChanges {
	/** Files whose contents differ from the imported commit. Target-relative paths, sorted. */
	readonly modified: readonly string[];
	/** Files that don't exist in the imported commit. */
	readonly added: readonly string[];
	/** Files of the imported commit that are gone from the workspace. */
	readonly deleted: readonly string[];
	readonly total: number;
}

/** The git blob SHA-1 of the given contents (what `git hash-object` prints). */
export async function computeGitBlobSha(contents: Uint8Array): Promise<string> {
	const header = new TextEncoder().encode(`blob ${contents.byteLength}\0`);
	const data = new Uint8Array(header.length + contents.byteLength);
	data.set(header);
	data.set(contents, header.length);
	const digest = await crypto.subtle.digest('SHA-1', data);
	return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** All files under a workspace folder, as target-relative path → URI. */
async function collectWorkspaceFiles(fs: WorkspaceFileSystem, target: string): Promise<Map<string, URI>> {
	const prefixLength = (target === '/' ? '' : target).length + 1;
	const present = new Map<string, URI>();
	const walk = async (uri: URI): Promise<void> => {
		const stat = await fs.fileService.resolve(uri);
		for (const child of stat.children ?? []) {
			if (child.isDirectory) {
				await walk(child.resource);
			} else {
				present.set(child.resource.path.slice(prefixLength), child.resource);
			}
		}
	};
	await walk(fs.root.with({ path: target }));
	return present;
}

/** Diffs the workspace folder against the GitHub commit it was imported from. */
export async function diffGitHubWorkspace(fs: WorkspaceFileSystem, target = '/'): Promise<GitHubWorkspaceChanges> {
	const metadata = getGitHubRepoMetadata(fs, target);
	if (!metadata) {
		throw new Error(`${target} was not imported from GitHub (no import metadata)`);
	}
	const present = await collectWorkspaceFiles(fs, target);

	const modified: string[] = [];
	const added: string[] = [];
	for (const [path, uri] of present) {
		const imported = metadata.files[path];
		if (!imported) {
			added.push(path);
		} else {
			const content = await fs.fileService.readFile(uri);
			if (await computeGitBlobSha(content.value.buffer) !== imported.sha) {
				modified.push(path);
			}
		}
	}
	const deleted = Object.keys(metadata.files).filter(path => !present.has(path));
	for (const list of [modified, added, deleted]) {
		list.sort();
	}
	return { modified, added, deleted, total: modified.length + added.length + deleted.length };
}

export interface GitHubRevertOptions {
	/** GitHub token — needed for private repositories. */
	readonly auth?: string;
	readonly onProgress?: (done: number, total: number) => void;
}

/**
 * Reverts the given target-relative paths to the imported baseline commit:
 * modified and deleted files are restored from their pinned blobs, added
 * files are deleted. The per-file counterpart of {@link resyncGitHubRepo} —
 * the baseline itself does not move, and other files are untouched.
 */
export async function revertGitHubFiles(
	fs: WorkspaceFileSystem,
	target = '/',
	paths: readonly string[],
	options: GitHubRevertOptions = {},
): Promise<void> {
	const metadata = getGitHubRepoMetadata(fs, target);
	if (!metadata) {
		throw new Error(`${target} was not imported from GitHub (no import metadata)`);
	}
	const { owner, repo, commitSha, dir } = metadata;
	const uriFor = (path: string) => target === '/' ? `/${path}` : `${target}/${path}`;
	const restore = paths.filter(path => metadata.files[path]);
	const remove = paths.filter(path => !metadata.files[path]);
	let done = 0;
	// like the import: fetches run concurrently, IndexedDB writes serialized
	// (concurrent createFolder calls on shared parents race)
	let writeQueue: Promise<void> = Promise.resolve();
	await runLimited(restore, 6, async path => {
		const bytes = await fetchBlob(owner, repo, commitSha, {
			repoPath: dir ? `${dir}/${path}` : path,
			sha: metadata.files[path].sha,
		}, options.auth);
		writeQueue = writeQueue.then(async () => {
			await fs.writeFile(uriFor(path), bytes);
			options.onProgress?.(++done, paths.length);
		});
		await writeQueue;
	});
	for (const path of remove) {
		await fs.deleteFile(uriFor(path)).catch(() => undefined);
		options.onProgress?.(++done, paths.length);
	}
}

export interface GitHubPushOptions {
	/** GitHub token with write access to the repository. */
	readonly auth: string;
	/** Commit message. Default: `Update <file>` / `Update <n> files`. */
	readonly message?: string;
	readonly onProgress?: (uploaded: number, total: number) => void;
}

export interface GitHubPushResult {
	readonly commitSha: string;
	/** github.com URL of the pushed commit. */
	readonly htmlUrl: string;
	readonly pushed: GitHubWorkspaceChanges;
}

/**
 * Commits the local changes on top of the imported commit and pushes them to
 * the repository's branch, via the Git Data API (blobs → tree → commit → ref
 * update). Fast-forward only: if the branch has moved on GitHub since the
 * import, the push is refused rather than merged. On success the stored
 * provenance advances to the new commit, so the workspace reads as clean.
 */
export async function pushGitHubChanges(fs: WorkspaceFileSystem, target = '/', options: GitHubPushOptions): Promise<GitHubPushResult> {
	const metadata = getGitHubRepoMetadata(fs, target);
	if (!metadata) {
		throw new Error(`${target} was not imported from GitHub (no import metadata)`);
	}
	const changes = await diffGitHubWorkspace(fs, target);
	if (changes.total === 0) {
		throw new Error('No local changes to push');
	}
	const { owner, repo, ref, dir } = metadata;
	const auth = options.auth;

	// no pre-checks against read endpoints (which can serve stale answers) —
	// the non-force ref update at the end is GitHub's own atomic fast-forward
	// check, and it is the only authoritative one

	// upload changed and added files as blobs
	const uriFor = (path: string) => fs.root.with({ path: target === '/' ? `/${path}` : `${target}/${path}` });
	const upload = [...changes.modified, ...changes.added];
	const newBlobs = new Map<string, string>();
	let uploaded = 0;
	await runLimited(upload, 6, async path => {
		const bytes = (await fs.fileService.readFile(uriFor(path))).value.buffer;
		const blob = await githubApi('POST', `/repos/${owner}/${repo}/git/blobs`, auth, {
			content: bytesToBase64(bytes),
			encoding: 'base64',
		});
		newBlobs.set(path, blob.sha);
		options.onProgress?.(++uploaded, upload.length);
	});

	// one tree on top of the imported root tree, then the commit and the ref
	const prefix = dir ? `${dir}/` : '';
	const treeEntries = [
		...upload.map(path => ({
			path: prefix + path,
			mode: metadata.files[path]?.mode ?? '100644',
			type: 'blob',
			sha: newBlobs.get(path)!,
		})),
		...changes.deleted.map(path => ({
			path: prefix + path,
			mode: metadata.files[path].mode,
			type: 'blob',
			sha: null,
		})),
	];
	const tree = await githubApi('POST', `/repos/${owner}/${repo}/git/trees`, auth, {
		base_tree: metadata.treeSha,
		tree: treeEntries,
	});
	const allPaths = [...upload, ...changes.deleted];
	const message = options.message?.trim()
		|| (allPaths.length === 1 ? `Update ${allPaths[0]}` : `Update ${allPaths.length} files`);
	const commit = await githubApi('POST', `/repos/${owner}/${repo}/git/commits`, auth, {
		message,
		tree: tree.sha,
		parents: [metadata.commitSha],
	});
	await updateRef(owner, repo, ref, commit.sha, auth);

	// the pushed commit is the new baseline
	const files: Record<string, GitHubFileState> = { ...metadata.files };
	for (const path of upload) {
		files[path] = { sha: newBlobs.get(path)!, mode: metadata.files[path]?.mode ?? '100644' };
	}
	for (const path of changes.deleted) {
		delete files[path];
	}
	setGitHubRepoMetadata(fs, target, { ...metadata, commitSha: commit.sha, treeSha: commit.tree.sha, files });

	return { commitSha: commit.sha, htmlUrl: commit.html_url, pushed: changes };
}

// Seeding an empty repository: the file and message of the throwaway commit
// (see publishGitHubRepo). Recognized on retry so a failed publish can resume.
const BOOTSTRAP_FILE = '.publish-bootstrap';
const BOOTSTRAP_MESSAGE = 'minwebide publish bootstrap';

/**
 * GitHub's git database lags a moment behind a repository's very first
 * commit: right after the bootstrap lands, Git Data API writes can still
 * answer 409 "Git Repository is empty". Retries that specific answer with
 * backoff (~10s total) before giving up.
 */
async function retryWhileEmpty<T>(task: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await task();
		} catch (error) {
			if (attempt < 6 && error instanceof GitHubApiError && error.status === 409 && /empty/i.test(error.message)) {
				await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
				continue;
			}
			throw error;
		}
	}
}

export interface GitHubPublishOptions {
	/** GitHub token with write access to the repository (a fine-grained token scoped to it works). */
	readonly auth: string;
	/** The empty repository to publish into: `owner/repo` or a github.com URL. The user creates it on GitHub first. */
	readonly repo: string | { owner: string; repo: string };
	/** Initial commit message. Default: 'Initial commit'. */
	readonly message?: string;
	readonly onProgress?: (uploaded: number, total: number) => void;
}

export interface GitHubPublishResult {
	readonly owner: string;
	readonly repo: string;
	/** The repository's default branch. */
	readonly ref: string;
	readonly commitSha: string;
	/** github.com URL of the repository. */
	readonly htmlUrl: string;
	readonly fileCount: number;
}

/**
 * Publishes a local workspace folder into an existing but EMPTY GitHub
 * repository (the user creates it on github.com first — no repository is
 * created programmatically): uploads every file, makes the initial commit on
 * the default branch, and records provenance — so from then on the workspace
 * behaves exactly like an imported one (change tracking, push, reload). A
 * repository that already has commits is refused, so pasting the wrong URL
 * can never overwrite anything.
 */
export async function publishGitHubRepo(fs: WorkspaceFileSystem, target = '/', options: GitHubPublishOptions): Promise<GitHubPublishResult> {
	if (getGitHubRepoMetadata(fs, target)) {
		throw new Error(`${target} is already connected to a GitHub repository`);
	}
	const present = await collectWorkspaceFiles(fs, target);
	if (present.size === 0) {
		throw new Error('Nothing to publish — the workspace is empty');
	}
	const auth = options.auth;
	const { owner, repo } = typeof options.repo === 'string' ? parseGitHubSpec(options.repo) : options.repo;

	let info;
	try {
		info = await githubApi('GET', `/repos/${owner}/${repo}`, auth);
	} catch (error) {
		if (error instanceof GitHubApiError && error.status === 404) {
			throw new Error(`${owner}/${repo} was not found on GitHub — create it first, and make sure the token can access it`);
		}
		throw error;
	}
	const ref = (info.default_branch as string) || 'main';
	let headRef;
	try {
		headRef = await githubApi('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(ref)}`, auth);
	} catch (error) {
		// 409 is GitHub's "Git Repository is empty"; 404 is a branchless repo
		if (!(error instanceof GitHubApiError) || (error.status !== 404 && error.status !== 409)) {
			throw error;
		}
	}
	// only an empty repository may be published into — except a leftover
	// bootstrap commit from an earlier failed publish attempt, which is reused
	let bootstrapSha: string | undefined;
	if (headRef) {
		const head = await githubApi('GET', `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, auth);
		const onlyBootstrap = head.parents.length === 0
			&& head.commit.message === BOOTSTRAP_MESSAGE
			&& head.files?.length === 1 && head.files[0].filename === BOOTSTRAP_FILE;
		if (!onlyBootstrap) {
			throw new Error(`${owner}/${repo} already has commits. Publishing needs an empty repository — create one without a README, or open that repository and copy your files into it.`);
		}
		bootstrapSha = head.sha as string;
	}
	if (!bootstrapSha) {
		// the Git Data API refuses every write to a completely empty repository
		// (409 "Git Repository is empty"), so seed the branch with a throwaway
		// commit through the contents API; the final force-update orphans it,
		// leaving a single clean initial commit.
		const bootstrap = await githubApi('PUT', `/repos/${owner}/${repo}/contents/${BOOTSTRAP_FILE}`, auth, {
			message: BOOTSTRAP_MESSAGE,
			content: btoa('bootstrap'),
			branch: ref,
		});
		bootstrapSha = bootstrap.commit.sha as string;
	}

	const paths = [...present.keys()].sort();
	const files: Record<string, GitHubFileState> = {};
	let uploaded = 0;
	await runLimited(paths, 6, async path => {
		const bytes = (await fs.fileService.readFile(present.get(path)!)).value.buffer;
		const blob = await retryWhileEmpty(() => githubApi('POST', `/repos/${owner}/${repo}/git/blobs`, auth, {
			content: bytesToBase64(bytes),
			encoding: 'base64',
		}));
		files[path] = { sha: blob.sha, mode: '100644' };
		options.onProgress?.(++uploaded, paths.length);
	});

	const tree = await retryWhileEmpty(() => githubApi('POST', `/repos/${owner}/${repo}/git/trees`, auth, {
		tree: paths.map(path => ({ path, mode: '100644', type: 'blob', sha: files[path].sha })),
	}));
	// the initial commit sits on top of the bootstrap seed (whose file is not
	// in this tree, so it reads as deleted) — the ref update is then a plain
	// fast-forward: atomic, no force, no orphaned commits, no read-back races
	const commit = await githubApi('POST', `/repos/${owner}/${repo}/git/commits`, auth, {
		message: options.message?.trim() || 'Initial commit',
		tree: tree.sha,
		parents: [bootstrapSha],
	});
	await updateRef(owner, repo, ref, commit.sha, auth);

	setGitHubRepoMetadata(fs, target, { owner, repo, ref, commitSha: commit.sha, treeSha: tree.sha, files });

	return { owner, repo, ref, commitSha: commit.sha, htmlUrl: info.html_url as string, fileCount: paths.length };
}

/**
 * Copies a GitHub-connected workspace — every file plus the provenance
 * baseline — into another (empty) workspace file system, entirely locally.
 * Used after a publish to seed the app's per-repo workspace without going
 * back to GitHub: the local state IS the pushed state, byte for byte.
 */
export async function transplantGitHubWorkspace(source: WorkspaceFileSystem, targetFs: WorkspaceFileSystem): Promise<void> {
	const metadata = getGitHubRepoMetadata(source, '/');
	if (!metadata) {
		throw new Error('The source workspace is not connected to a GitHub repository');
	}
	const files = await collectWorkspaceFiles(source, '/');
	for (const [path, uri] of files) {
		const content = await source.fileService.readFile(uri);
		await targetFs.writeFile(`/${path}`, content.value.buffer);
	}
	setGitHubRepoMetadata(targetFs, '/', metadata);
}

/**
 * Fast-forwards a branch to `sha` via a non-force ref update — GitHub's
 * atomic compare-and-swap. A 422 means the branch moved (or isn't a branch);
 * both become actionable errors.
 */
async function updateRef(owner: string, repo: string, ref: string, sha: string, auth: string): Promise<void> {
	try {
		await githubApi('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(ref)}`, auth, { sha });
	} catch (error) {
		if (error instanceof GitHubApiError && error.status === 422) {
			if (/fast forward/i.test(error.message)) {
				throw new Error(`${ref} has new commits on GitHub since the import. Save your changes elsewhere, then Reload from GitHub and redo them — merging is not supported yet.`);
			}
			if (/does not exist/i.test(error.message)) {
				throw new Error(`"${ref}" is not a branch on ${owner}/${repo} — pushing needs a branch (a tag or commit import is read-only)`);
			}
		}
		throw error;
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/**
 * Discards local changes by re-importing the folder's repository at its
 * stored ref — for a branch ref that also picks up the newest upstream commit.
 */
export async function resyncGitHubRepo(
	fs: WorkspaceFileSystem,
	target = '/',
	options: Pick<GitHubImportOptions, 'auth' | 'maxFileSize' | 'onProgress'> = {},
): Promise<GitHubImportResult> {
	const metadata = getGitHubRepoMetadata(fs, target);
	if (!metadata) {
		throw new Error(`${target} was not imported from GitHub (no import metadata)`);
	}
	const { owner, repo, ref, dir } = metadata;
	return importGitHubRepo(fs, { owner, repo, ref, dir }, { ...options, target, clean: true });
}
