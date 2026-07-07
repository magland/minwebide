import type { GitHubRepoSpec } from '../github/githubImport';

// Recently visited #/github routes, persisted per app in localStorage so the
// landing page can list them alongside local projects. Entries are deduped on
// the lowercased canonical spec — the same normalization as the per-repo
// workspace database name, so two spellings of one repo share one entry.

export interface GitHubVisit {
	/** Canonical spec text — round-trips through parseGitHubSpec and slots into `#/github/<spec>`. */
	readonly spec: string;
	readonly lastVisitedAt: number;
}

const MAX_ENTRIES = 50;

/** Canonical spec text: `owner/repo`, `owner/repo@ref`, or `owner/repo/tree/<ref>/<dir>`. */
export function canonicalGitHubSpec(spec: GitHubRepoSpec): string {
	if (spec.dir && spec.ref) {
		return `${spec.owner}/${spec.repo}/tree/${spec.ref}/${spec.dir}`;
	}
	return `${spec.owner}/${spec.repo}${spec.ref ? `@${spec.ref}` : ''}`;
}

function historyKey(appId: string): string {
	return `${appId}.github-history`;
}

function readHistory(appId: string): GitHubVisit[] {
	try {
		const raw = localStorage.getItem(historyKey(appId));
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed.filter(v => v && typeof v.spec === 'string') : [];
	} catch {
		return [];
	}
}

function writeHistory(appId: string, visits: GitHubVisit[]): void {
	localStorage.setItem(historyKey(appId), JSON.stringify(visits));
}

/** Visited repositories, most recent first. */
export function listGitHubHistory(appId: string): GitHubVisit[] {
	return readHistory(appId).sort((a, b) => b.lastVisitedAt - a.lastVisitedAt);
}

/** Records a visit, replacing any earlier entry for the same repository. */
export function recordGitHubVisit(appId: string, spec: GitHubRepoSpec): void {
	const canonical = canonicalGitHubSpec(spec);
	const key = canonical.toLowerCase();
	const rest = readHistory(appId).filter(v => v.spec.toLowerCase() !== key);
	writeHistory(appId, [{ spec: canonical, lastVisitedAt: Date.now() }, ...rest].slice(0, MAX_ENTRIES));
}

/** Removes the entry for `spec` (canonical text) from the history. The local workspace copy is kept. */
export function removeGitHubVisit(appId: string, spec: string): void {
	const key = spec.toLowerCase();
	writeHistory(appId, readHistory(appId).filter(v => v.spec.toLowerCase() !== key));
}
