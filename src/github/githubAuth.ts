import { $, append } from 'vs/base/browser/dom';
import { githubApi } from './githubImport';

// GitHub sign-in, modeled on VS Code's own PAT flow (the flow VS Code ships
// for web embedders that aren't vscode.dev): a "Continue to GitHub" button
// opens the token-creation page pre-filled with a description and the `repo`
// scope, and the user pastes the resulting token into a dialog. The token
// never leaves the browser — it is kept in localStorage and sent only to
// api.github.com. Fine-grained tokens (scoped to a single repository) work
// too; the pre-filled page is just the lowest-friction path.

const TOKEN_KEY = 'minwebide-github-token';

export function getStoredGitHubToken(): string | undefined {
	return localStorage.getItem(TOKEN_KEY) ?? undefined;
}

export function storeGitHubToken(token: string): void {
	localStorage.setItem(TOKEN_KEY, token);
}

export function clearGitHubToken(): void {
	localStorage.removeItem(TOKEN_KEY);
}

/** The GitHub login the token belongs to, or undefined if the token is invalid. */
export async function getGitHubTokenUser(token: string): Promise<string | undefined> {
	try {
		const user = await githubApi('GET', '/user', token);
		return user.login as string;
	} catch {
		return undefined;
	}
}

/**
 * Shows a VS Code-style sign-in dialog anchored in `container` (typically the
 * workbench element): opens GitHub's pre-filled token page, takes a paste,
 * validates it, stores it, and resolves with the token — or undefined if the
 * user cancels.
 */
export function requestGitHubToken(container: HTMLElement, appName = 'minwebide'): Promise<string | undefined> {
	return new Promise(resolve => {
		const overlay = append(container, $('.mw-github-auth-overlay'));
		const dialog = append(overlay, $('.mw-github-auth-dialog'));
		append(dialog, $('.mw-github-auth-title', undefined, 'Sign in to GitHub'));
		append(dialog, $('p.mw-github-auth-text', undefined,
			'To push changes, continue to GitHub to create a personal access token, then paste it below. ' +
			'The token is stored only in this browser. A fine-grained token limited to this repository works too.'));

		const openButton = append(dialog, $('button.mw-github-button')) as HTMLButtonElement;
		openButton.textContent = 'Continue to GitHub';
		openButton.addEventListener('click', () => {
			const query = `description=${encodeURIComponent(appName)}&scopes=repo`;
			window.open(`https://github.com/settings/tokens/new?${query}`);
			input.focus();
		});

		const input = append(dialog, $('input.mw-github-auth-input')) as HTMLInputElement;
		input.type = 'password';
		input.placeholder = 'ghp_… or github_pat_…';
		input.spellcheck = false;

		const errorEl = append(dialog, $('.mw-github-auth-error'));

		const buttons = append(dialog, $('.mw-github-auth-buttons'));
		const signIn = append(buttons, $('button.mw-github-button')) as HTMLButtonElement;
		signIn.textContent = 'Sign in';
		const cancel = append(buttons, $('button.mw-github-button.secondary')) as HTMLButtonElement;
		cancel.textContent = 'Cancel';

		const finish = (token: string | undefined) => {
			document.removeEventListener('keydown', onKeyDown, true);
			overlay.remove();
			resolve(token);
		};

		const submit = async () => {
			const token = input.value.trim();
			if (!token) {
				return;
			}
			signIn.disabled = true;
			errorEl.textContent = 'Verifying…';
			const login = await getGitHubTokenUser(token);
			if (!login) {
				signIn.disabled = false;
				errorEl.textContent = 'GitHub rejected this token. Check that it was copied completely.';
				input.focus();
				input.select();
				return;
			}
			storeGitHubToken(token);
			finish(token);
		};

		// document-level so Escape works wherever focus ends up
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				finish(undefined);
			} else if (e.key === 'Enter' && overlay.contains(e.target as Node)) {
				void submit();
			}
		};
		document.addEventListener('keydown', onKeyDown, true);

		signIn.addEventListener('click', () => void submit());
		cancel.addEventListener('click', () => finish(undefined));
		overlay.addEventListener('mousedown', e => {
			if (e.target === overlay) {
				finish(undefined);
			}
		});
		input.focus();
	});
}
