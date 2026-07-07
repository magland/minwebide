import { URI } from 'vs/base/common/uri';
import type { WorkspaceFileSystem } from '../fs/fileSystem';

// Anonymous import of public GitHub repositories into the workspace.
//
// The listing comes from the REST API (CORS-enabled, but anonymous clients
// are limited to 60 requests/hour); file contents come from
// raw.githubusercontent.com, which is also CORS-enabled and not counted
// against that limit — so an import costs at most 3 API requests regardless
// of repository size. The tarball endpoint would be a single request, but its
// redirect target (codeload.github.com) does not allow cross-origin reads.

export interface GitHubRepoSpec {
	readonly owner: string;
	readonly repo: string;
	/** Branch, tag, or commit SHA. Default: the repository's default branch. */
	readonly ref?: string;
	/** Subdirectory of the repository to import. Default: the whole repository. */
	readonly dir?: string;
}

export interface GitHubImportProgress {
	/** Files written so far. */
	readonly written: number;
	/** Total files to import. */
	readonly total: number;
	/** Repository-relative path of the file just written. */
	readonly path: string;
}

export interface GitHubImportOptions {
	/**
	 * Workspace folder to import into. Default: `/<repo>`. Pass `'/'` to make
	 * the repository the entire workspace (e.g. into a dedicated file system).
	 */
	readonly target?: string;
	/** Replace an existing non-empty target before importing. Default: false — the import fails instead. */
	readonly clean?: boolean;
	/** Skip files larger than this many bytes. Default: 10 MiB. */
	readonly maxFileSize?: number;
	/** GitHub token — raises the API rate limit and allows private repositories. */
	readonly auth?: string;
	readonly onProgress?: (progress: GitHubImportProgress) => void;
}

export interface GitHubImportResult {
	readonly owner: string;
	readonly repo: string;
	/** The ref that was imported (resolved to the default branch when the spec had none). */
	readonly ref: string;
	/** Commit the import is pinned to. */
	readonly commitSha: string;
	/** Workspace folder the repository was imported into. */
	readonly root: URI;
	readonly fileCount: number;
	readonly skipped: readonly SkippedFile[];
}

export interface SkippedFile {
	readonly path: string;
	readonly reason: 'too-large' | 'symlink' | 'submodule';
}

/** A file of the imported commit: its git blob SHA and git mode ('100644' or '100755'). */
export interface GitHubFileState {
	readonly sha: string;
	readonly mode: string;
}

/**
 * Provenance of an imported folder, persisted in localStorage: the baseline
 * that change tracking diffs against and that pushes commit on top of.
 */
export interface GitHubRepoMetadata {
	readonly owner: string;
	readonly repo: string;
	readonly ref: string;
	readonly commitSha: string;
	readonly treeSha: string;
	readonly dir?: string;
	/** Target-relative file path → blob SHA + mode as of the imported commit. */
	readonly files: Record<string, GitHubFileState>;
}

/**
 * Parses `owner/repo`, `owner/repo@ref`, and github.com URLs (including
 * `/tree/<ref>/<dir>` URLs). Branch names containing `/` are only supported
 * in the `owner/repo@ref` shorthand — in a `/tree/` URL the first path
 * segment is taken as the ref.
 */
export function parseGitHubSpec(spec: string): GitHubRepoSpec {
	let s = spec.trim();
	const host = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i.exec(s);
	if (host) {
		s = s.slice(host[0].length);
	}
	s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
	const m = /^([^/@\s]+)\/([^/@\s]+?)(?:\.git)?(?:@([^\s]+))?(?:\/(.*))?$/.exec(s);
	if (!m) {
		throw new Error(`Not a GitHub repository reference: "${spec}" (expected "owner/repo", "owner/repo@ref", or a github.com URL)`);
	}
	const [, owner, repo, refFromShorthand, rest] = m;
	let ref = refFromShorthand;
	let dir: string | undefined;
	if (rest) {
		const t = /^(?:tree|blob)\/([^/]+)(?:\/(.*))?$/.exec(rest);
		if (t) {
			ref = t[1];
			dir = t[2]?.replace(/\/+$/, '') || undefined;
		}
	}
	return { owner, repo, ref, dir };
}

/**
 * Imports a public GitHub repository (or a subdirectory of one) into a
 * workspace folder, anonymously, and records provenance metadata retrievable
 * via {@link getGitHubRepoMetadata}.
 */
export async function importGitHubRepo(
	fs: WorkspaceFileSystem,
	spec: string | GitHubRepoSpec,
	options: GitHubImportOptions = {},
): Promise<GitHubImportResult> {
	const parsed = typeof spec === 'string' ? parseGitHubSpec(spec) : spec;
	const { owner, repo, dir } = parsed;
	let ref = parsed.ref;
	const maxFileSize = options.maxFileSize ?? 10 * 1024 * 1024;

	let target = options.target ?? `/${repo}`;
	target = (target.startsWith('/') ? target : `/${target}`).replace(/\/+$/, '') || '/';
	const root = fs.root.with({ path: target });
	const joinTarget = (rel: string) => target === '/' ? `/${rel}` : `${target}/${rel}`;

	// The workspace root always exists, so "occupied" means "has children"
	// there; for any other target, plain existence.
	if (target === '/') {
		const children = await listChildren(fs, root);
		if (children.length > 0) {
			if (!options.clean) {
				throw new Error(`The workspace root is not empty (pass clean: true to replace its contents)`);
			}
			for (const child of children) {
				await fs.fileService.del(child, { recursive: true });
			}
		}
	} else if (await fs.fileService.exists(root)) {
		if (!options.clean) {
			throw new Error(`Import target ${target} already exists (pass clean: true to replace it)`);
		}
		await fs.deleteFile(target);
	}

	if (!ref) {
		ref = (await apiGet(`/repos/${owner}/${repo}`, options.auth)).default_branch as string;
	}
	const commit = await apiGet(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, options.auth);
	const commitSha = commit.sha as string;
	const treeSha = commit.commit.tree.sha as string;
	const tree = await apiGet(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`, options.auth);
	if (tree.truncated) {
		throw new Error(`Repository ${owner}/${repo} is too large to import (tree listing was truncated by GitHub)`);
	}

	interface TreeEntry { path: string; mode: string; type: string; sha: string; size?: number }
	const skipped: SkippedFile[] = [];
	const files: { repoPath: string; relPath: string; sha: string; mode: string }[] = [];
	const dirPrefix = dir ? `${dir}/` : '';
	for (const entry of tree.tree as TreeEntry[]) {
		if (dir && !entry.path.startsWith(dirPrefix)) {
			continue;
		}
		const relPath = entry.path.slice(dirPrefix.length);
		if (entry.type === 'commit') {
			skipped.push({ path: entry.path, reason: 'submodule' });
		} else if (entry.mode === '120000') {
			skipped.push({ path: entry.path, reason: 'symlink' });
		} else if (entry.type === 'blob') {
			if ((entry.size ?? 0) > maxFileSize) {
				skipped.push({ path: entry.path, reason: 'too-large' });
			} else {
				files.push({ repoPath: entry.path, relPath, sha: entry.sha, mode: entry.mode });
			}
		}
	}
	if (dir && files.length === 0 && skipped.length === 0) {
		throw new Error(`Directory "${dir}" not found in ${owner}/${repo}@${ref}`);
	}

	try {
		await fs.fileService.createFolder(root);
		let written = 0;
		// Fetches run concurrently; IndexedDB writes are serialized through a
		// queue because concurrent createFolder calls on shared parents race.
		let writeQueue: Promise<void> = Promise.resolve();
		await runLimited(files, 8, async file => {
			const bytes = await fetchBlob(owner, repo, commitSha, file, options.auth);
			writeQueue = writeQueue.then(async () => {
				await fs.writeFile(joinTarget(file.relPath), bytes);
				written++;
				options.onProgress?.({ written, total: files.length, path: file.repoPath });
			});
			await writeQueue;
		});
	} catch (error) {
		// leave no partial import behind: remove the target folder, or for a
		// root import the top-level entries the file list would have created
		const partialRoots = target === '/'
			? [...new Set(files.map(f => f.relPath.split('/')[0]))].map(name => `/${name}`)
			: [target];
		for (const path of partialRoots) {
			await fs.deleteFile(path).catch(() => undefined);
		}
		throw error;
	}

	const metadata: GitHubRepoMetadata = {
		owner, repo, ref, commitSha, treeSha, dir,
		files: Object.fromEntries(files.map(f => [f.relPath, { sha: f.sha, mode: f.mode }])),
	};
	setGitHubRepoMetadata(fs, target, metadata);

	return { owner, repo, ref, commitSha, root, fileCount: files.length, skipped };
}

/** Returns the provenance metadata recorded when `target` was imported, if any. */
export function getGitHubRepoMetadata(fs: WorkspaceFileSystem, target: string): GitHubRepoMetadata | undefined {
	const raw = localStorage.getItem(metadataKey(fs, target));
	if (!raw) {
		return undefined;
	}
	const metadata = JSON.parse(raw) as GitHubRepoMetadata;
	// early versions stored a bare blob SHA per file, without the mode
	for (const [path, state] of Object.entries(metadata.files)) {
		if (typeof state === 'string') {
			metadata.files[path] = { sha: state, mode: '100644' };
		}
	}
	return metadata;
}

/** Persists new provenance for `target` (after an import or a push). */
export function setGitHubRepoMetadata(fs: WorkspaceFileSystem, target: string, metadata: GitHubRepoMetadata): void {
	try {
		localStorage.setItem(metadataKey(fs, target), JSON.stringify(metadata));
	} catch (error) {
		console.warn('minwebide: could not persist GitHub import metadata', error);
	}
}

async function listChildren(fs: WorkspaceFileSystem, folder: URI): Promise<URI[]> {
	try {
		const stat = await fs.fileService.resolve(folder);
		return (stat.children ?? []).map(c => c.resource);
	} catch {
		return [];
	}
}

function metadataKey(fs: WorkspaceFileSystem, target: string): string {
	return `minwebide-github:${fs.dbName}:${target.startsWith('/') ? target : `/${target}`}`;
}

export class GitHubApiError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

/** A GitHub REST API call; throws {@link GitHubApiError} on non-2xx responses. */
export async function githubApi(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, auth: string | undefined, body?: unknown): Promise<any> {
	const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
	if (auth) {
		headers.authorization = `Bearer ${auth}`;
	}
	if (body !== undefined) {
		headers['content-type'] = 'application/json';
	}
	const res = await fetch(`https://api.github.com${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (res.ok) {
		return res.status === 204 ? undefined : res.json();
	}
	if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
		const reset = Number(res.headers.get('x-ratelimit-reset'));
		const when = reset ? new Date(reset * 1000).toLocaleTimeString() : 'later';
		throw new GitHubApiError(`GitHub API rate limit exceeded${auth ? '' : ' (anonymous clients get 60 requests/hour)'}; resets at ${when}`, res.status);
	}
	const detail = (await res.json().catch(() => undefined))?.message;
	if (res.status === 404) {
		throw new GitHubApiError(`GitHub: ${path} not found${auth ? '' : ' (private repositories require a token)'}`, res.status);
	}
	throw new GitHubApiError(`GitHub API ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`, res.status);
}

function apiGet(path: string, auth: string | undefined): Promise<any> {
	return githubApi('GET', path, auth);
}

async function fetchBlob(
	owner: string,
	repo: string,
	commitSha: string,
	file: { repoPath: string; sha: string },
	auth: string | undefined,
): Promise<Uint8Array> {
	// anonymous reads go through raw.githubusercontent.com because it doesn't
	// count against the API rate limit; authenticated reads (needed for
	// private repos, where raw + an Authorization header is unreliable across
	// CORS) use the blobs API directly — the authenticated limit is ample
	if (!auth) {
		const encodedPath = file.repoPath.split('/').map(encodeURIComponent).join('/');
		try {
			const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${encodedPath}`);
			if (res.ok) {
				return new Uint8Array(await res.arrayBuffer());
			}
		} catch {
			// fall through to the blobs API
		}
	}
	const blob = await apiGet(`/repos/${owner}/${repo}/git/blobs/${file.sha}`, auth);
	if (blob.encoding !== 'base64') {
		throw new Error(`Unexpected blob encoding "${blob.encoding}" for ${file.repoPath}`);
	}
	const binary = atob((blob.content as string).replace(/\n/g, ''));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export async function runLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			await task(items[next++]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
