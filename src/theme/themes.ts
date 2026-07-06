import { Color } from 'vs/base/common/color';
import { parse as parseJsonc } from 'vs/base/common/json';
import { dirname, join } from 'vs/base/common/path';
import { asCssVariableName, getColorRegistry } from 'vs/platform/theme/common/colorRegistry';
import { ColorScheme } from 'vs/platform/theme/common/theme';
import type { IColorTheme, IFontTokenOptions, ITokenStyle } from 'vs/platform/theme/common/themeService';

// Side effect imports: these register VS Code's color contributions (with their
// real default values) into the color registry. The first block covers the
// platform colors (lists, inputs, menus, editor, ...); the second registers the
// workbench chrome colors (activity bar, side bar, tabs, status bar, panel, ...).
import 'vs/platform/theme/common/colorRegistry';
import 'vs/workbench/common/theme';

export interface TokenColorRule {
	readonly name?: string;
	readonly scope?: string | string[];
	readonly settings: {
		readonly foreground?: string;
		readonly background?: string;
		readonly fontStyle?: string;
	};
}

interface ThemeJson {
	name?: string;
	type?: string;
	include?: string;
	colors?: Record<string, string>;
	tokenColors?: TokenColorRule[];
	semanticHighlighting?: boolean;
}

function colorSchemeOf(type: string | undefined): ColorScheme {
	switch (type) {
		case 'light': return ColorScheme.LIGHT;
		case 'hcDark': case 'hc': return ColorScheme.HIGH_CONTRAST_DARK;
		case 'hcLight': return ColorScheme.HIGH_CONTRAST_LIGHT;
		default: return ColorScheme.DARK;
	}
}

/**
 * A loaded VS Code color theme. Implements VS Code's IColorTheme so color
 * lookups resolve exactly like they do in VS Code: explicit theme colors
 * first, then the registered default (which may derive from other colors).
 */
export class WorkbenchTheme implements IColorTheme {
	readonly type: ColorScheme;
	readonly label: string;
	readonly semanticHighlighting: boolean;
	readonly tokenColorMap: string[] = [];
	readonly tokenFontMap: IFontTokenOptions[] = [];

	/** Raw color id → '#rrggbb[aa]' strings as merged from the theme JSON chain. */
	readonly rawColors: Readonly<Record<string, string>>;
	readonly tokenColors: readonly TokenColorRule[];

	private readonly resolved = new Map<string, Color | undefined>();

	constructor(label: string, type: ColorScheme, rawColors: Record<string, string>, tokenColors: TokenColorRule[], semanticHighlighting: boolean) {
		this.label = label;
		this.type = type;
		this.rawColors = rawColors;
		this.tokenColors = tokenColors;
		this.semanticHighlighting = semanticHighlighting;
	}

	getColor(colorId: string, useDefault?: boolean): Color | undefined {
		if (this.resolved.has(colorId)) {
			return this.resolved.get(colorId);
		}
		let color: Color | undefined;
		const raw = this.rawColors[colorId];
		if (raw !== undefined) {
			color = Color.fromHex(raw);
		} else if (useDefault !== false) {
			color = getColorRegistry().resolveDefaultColor(colorId, this);
		}
		this.resolved.set(colorId, color);
		return color;
	}

	defines(colorId: string): boolean {
		return this.rawColors[colorId] !== undefined;
	}

	getTokenStyleMetadata(): ITokenStyle | undefined {
		return undefined;
	}
}

/**
 * Loads a VS Code color theme JSON (JSONC, with `include` chains resolved) —
 * e.g. one of the files in vendor/vscode/extensions/theme-defaults/themes.
 *
 * @param entryPath path of the theme file, used to resolve relative includes
 * @param readFile returns the text of a theme file given its path
 */
export async function loadColorTheme(entryPath: string, readFile: (path: string) => Promise<string>): Promise<WorkbenchTheme> {
	const colors: Record<string, string> = {};
	const tokenColors: TokenColorRule[] = [];
	let name: string | undefined;
	let type: string | undefined;
	let semanticHighlighting = false;

	const loadChain = async (path: string): Promise<void> => {
		const json = parseJsonc(await readFile(path)) as ThemeJson;
		if (json.include) {
			await loadChain(join(dirname(path), json.include));
		}
		// own values override / append to included ones
		Object.assign(colors, json.colors);
		if (Array.isArray(json.tokenColors)) {
			tokenColors.push(...json.tokenColors);
		}
		name = json.name ?? name;
		type = json.type ?? type;
		semanticHighlighting = json.semanticHighlighting ?? semanticHighlighting;
	};
	await loadChain(entryPath);

	if (!type) {
		// themes don't always declare a type; infer it from the editor background
		const background = colors['editor.background'];
		type = background && Color.fromHex(background).isLighter() ? 'light' : 'dark';
	}

	return new WorkbenchTheme(name ?? entryPath, colorSchemeOf(type), colors, tokenColors, semanticHighlighting);
}

/**
 * Applies a theme to an element by defining the same `--vscode-*` CSS custom
 * properties the VS Code workbench defines. All VS Code source CSS (and our
 * shell CSS) picks its colors up from these.
 */
export function applyThemeToElement(theme: WorkbenchTheme, element: HTMLElement): void {
	const applied = new Set<string>();
	for (const contribution of getColorRegistry().getColors()) {
		const color = theme.getColor(contribution.id);
		if (color) {
			element.style.setProperty(asCssVariableName(contribution.id), color.toString());
		}
		applied.add(contribution.id);
	}
	// colors the theme sets that no imported module registered
	for (const [id, raw] of Object.entries(theme.rawColors)) {
		if (!applied.has(id)) {
			element.style.setProperty(asCssVariableName(id), Color.fromHex(raw).toString());
		}
	}
}
