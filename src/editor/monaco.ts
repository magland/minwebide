/// <reference path="../../vendor/vscode/src/vs/monaco.d.ts" />

// The Monaco editor API, imported straight from the VS Code source tree.
//
// Values come from 'vs/editor/editor.api'; the `editor` and `languages`
// namespaces are re-exported through the ambient `monaco` namespace declared
// by vendor/vscode/src/vs/monaco.d.ts, which makes their *types*
// (e.g. monaco.editor.ITextModel) available too — the source module only
// exports them as plain values.
import './environment';
import 'vs/editor/editor.api';

export * from 'vs/editor/editor.api';

/* eslint-disable no-restricted-syntax */
export import editor = monaco.editor;
export import languages = monaco.languages;

export type IRange = monaco.IRange;
export type IPosition = monaco.IPosition;
export type IMarkdownString = monaco.IMarkdownString;
