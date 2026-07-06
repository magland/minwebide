import { ColorScheme } from 'vs/platform/theme/common/theme';
import * as monaco from '../editor/monaco';
import type { TokenColorRule, WorkbenchTheme } from './themes';

const EDITOR_THEME_NAME = 'minwebide';

function baseThemeOf(type: ColorScheme): monaco.editor.BuiltinTheme {
	switch (type) {
		case ColorScheme.LIGHT: return 'vs';
		case ColorScheme.HIGH_CONTRAST_DARK: return 'hc-black';
		case ColorScheme.HIGH_CONTRAST_LIGHT: return 'hc-light';
		default: return 'vs-dark';
	}
}

function toTokenThemeRules(tokenColors: readonly TokenColorRule[]): monaco.editor.ITokenThemeRule[] {
	const rules: monaco.editor.ITokenThemeRule[] = [];
	for (const rule of tokenColors) {
		if (!rule.settings) {
			continue;
		}
		const scopes = typeof rule.scope === 'string' ? rule.scope.split(',').map(s => s.trim()) : (rule.scope ?? ['']);
		for (const scope of scopes) {
			rules.push({
				token: scope,
				foreground: rule.settings.foreground?.replace('#', ''),
				background: rule.settings.background?.replace('#', ''),
				fontStyle: rule.settings.fontStyle,
			});
		}
	}
	return rules;
}

/**
 * Registers the given workbench theme as the standalone editor theme and
 * returns its name for use in editor construction options.
 */
export function defineEditorTheme(theme: WorkbenchTheme): string {
	monaco.editor.defineTheme(EDITOR_THEME_NAME, {
		base: baseThemeOf(theme.type),
		inherit: true,
		colors: { ...theme.rawColors },
		rules: toTokenThemeRules(theme.tokenColors),
	});
	return EDITOR_THEME_NAME;
}
