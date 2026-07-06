import * as monaco from '../editor/monaco';

// Converts a language-configuration.json (as shipped in VS Code's built-in
// extensions) into Monaco's LanguageConfiguration. The JSON encodes regexes as
// strings or { pattern, flags } objects and enter-actions as strings.

type RawRegExp = string | { pattern: string; flags?: string };

function toRegExp(value: RawRegExp | undefined): RegExp | undefined {
	try {
		if (typeof value === 'string') {
			return new RegExp(value);
		}
		if (value && typeof value.pattern === 'string') {
			return new RegExp(value.pattern, value.flags);
		}
	} catch {
		// invalid or unsupported regex: skip this rule
	}
	return undefined;
}

function toAutoClosingPairs(value: unknown): monaco.languages.IAutoClosingPairConditional[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const result: monaco.languages.IAutoClosingPairConditional[] = [];
	for (const entry of value) {
		if (Array.isArray(entry) && entry.length === 2) {
			result.push({ open: entry[0], close: entry[1] });
		} else if (entry && typeof entry.open === 'string' && typeof entry.close === 'string') {
			result.push({ open: entry.open, close: entry.close, notIn: entry.notIn });
		}
	}
	return result;
}

function toEnterAction(value: any): monaco.languages.EnterAction | undefined {
	const indentAction = typeof value === 'string' ? value : value?.indent ?? value?.indentAction;
	let action: monaco.languages.IndentAction;
	switch (indentAction) {
		case 'none': action = monaco.languages.IndentAction.None; break;
		case 'indent': action = monaco.languages.IndentAction.Indent; break;
		case 'indentOutdent': action = monaco.languages.IndentAction.IndentOutdent; break;
		case 'outdent': action = monaco.languages.IndentAction.Outdent; break;
		default: return undefined;
	}
	return {
		indentAction: action,
		appendText: typeof value === 'object' ? value?.appendText : undefined,
		removeText: typeof value === 'object' ? value?.removeText : undefined,
	};
}

export function toMonacoLanguageConfiguration(raw: any): monaco.languages.LanguageConfiguration {
	const config: monaco.languages.LanguageConfiguration = {};

	if (raw.comments) {
		config.comments = raw.comments;
	}
	if (Array.isArray(raw.brackets)) {
		config.brackets = raw.brackets;
	}
	const autoClosingPairs = toAutoClosingPairs(raw.autoClosingPairs);
	if (autoClosingPairs) {
		config.autoClosingPairs = autoClosingPairs;
	}
	const surroundingPairs = toAutoClosingPairs(raw.surroundingPairs);
	if (surroundingPairs) {
		config.surroundingPairs = surroundingPairs;
	}
	const wordPattern = toRegExp(raw.wordPattern);
	if (wordPattern) {
		config.wordPattern = wordPattern;
	}
	if (raw.folding?.markers) {
		const start = toRegExp(raw.folding.markers.start);
		const end = toRegExp(raw.folding.markers.end);
		if (start && end) {
			config.folding = { markers: { start, end }, offSide: raw.folding.offSide };
		}
	} else if (raw.folding?.offSide !== undefined) {
		config.folding = { offSide: raw.folding.offSide };
	}
	if (raw.indentationRules) {
		const increaseIndentPattern = toRegExp(raw.indentationRules.increaseIndentPattern);
		const decreaseIndentPattern = toRegExp(raw.indentationRules.decreaseIndentPattern);
		if (increaseIndentPattern && decreaseIndentPattern) {
			config.indentationRules = {
				increaseIndentPattern,
				decreaseIndentPattern,
				indentNextLinePattern: toRegExp(raw.indentationRules.indentNextLinePattern),
				unIndentedLinePattern: toRegExp(raw.indentationRules.unIndentedLinePattern),
			};
		}
	}
	if (Array.isArray(raw.onEnterRules)) {
		const rules: monaco.languages.OnEnterRule[] = [];
		for (const rule of raw.onEnterRules) {
			const beforeText = toRegExp(rule.beforeText);
			const action = toEnterAction(rule.action);
			if (beforeText && action) {
				rules.push({
					beforeText,
					afterText: toRegExp(rule.afterText),
					previousLineText: toRegExp(rule.previousLineText),
					action,
				});
			}
		}
		if (rules.length) {
			config.onEnterRules = rules;
		}
	}
	return config;
}
