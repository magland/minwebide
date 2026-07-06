# minwebide

A minimalistic web IDE built from VS Code's own source code.

Rather than building the full VS Code workbench (which is enormous), minwebide
imports individual modules straight out of a pinned checkout of
[microsoft/vscode](https://github.com/microsoft/vscode) and adds only a thin
shell around them. The result looks and behaves like VS Code because, wherever
possible, it *is* VS Code's code — same editor, same widgets, same colors,
same icons, same grammars.

## What comes from the VS Code source tree

| Piece | VS Code module |
| --- | --- |
| Editor (Monaco) | `vs/editor/editor.api` + `editorWebWorkerMain` worker |
| File system | `vs/platform/files/browser/indexedDBFileSystemProvider` (the one behind vscode.dev) registered on `vs/platform/files/common/fileService` |
| Explorer / search trees | `vs/base/browser/ui/tree` (`AsyncDataTree`, `ObjectTree`) |
| Resizable layout | `vs/base/browser/ui/splitview` |
| Search input | `vs/base/browser/ui/findinput` (case/word/regex toggles) |
| Colors | `vs/platform/theme` color registry + `vs/workbench/common/theme`, applied as the same `--vscode-*` CSS variables the workbench uses |
| Color themes | the actual theme JSONs from `extensions/theme-defaults` (Dark Modern etc.) |
| Icons | codicons (`vs/base/.../codicon.css` + runtime icon registry stylesheet) |
| Syntax highlighting | the actual TextMate grammars from `extensions/*/syntaxes`, run by `vscode-textmate` + `vscode-oniguruma` (VS Code's own libraries) through VS Code's `TextMateTokenizationSupport` |
| Languages | language contributions (file extensions, aliases, configs) parsed from the built-in extensions' manifests |

The thin shell that minwebide adds itself (tabs, activity bar, status bar,
panel chrome, the workbench assembly) is styled exclusively with `--vscode-*`
theme variables, so any VS Code color theme applies to all of it.

## Setup

```sh
npm install   # postinstall shallow-clones the pinned VS Code tag into vendor/vscode
npm run dev   # start the demo app
```

- `.vscode-version` pins the VS Code release (currently 1.127.0);
  `scripts/fetch-vscode.sh` fetches it into `vendor/vscode` (gitignored).
- `npm run build` produces a static bundle (~780 kB gzipped core + lazy chunks
  per grammar/theme).
- `npm run typecheck` typechecks `src/` and `demo/` (diagnostics inside
  `vendor/` are counted but not failing — they come from TS-version and
  ambient-type differences with VS Code's own build setup and never affect the
  bundle, which is transpiled by esbuild).
- `npm run smoke` runs a headless end-to-end test (edit → Ctrl+S → reload →
  persisted; search; custom editors; runner) against the built app. Requires Chrome.

## Building apps on minwebide

**Full guide: [docs/creating-an-app.md](docs/creating-an-app.md)** — project
setup, the boot sequence, file system, themes/languages, custom editors,
output channels, file runners, secondary side bar views, deployment, gotchas.

minwebide is distributed as *source* (its `package.json` exports point at
`src/*.ts`; Vite compiles it as part of the app). To start a new app repo:

```sh
bash scripts/create-app.sh ../my-app
cd ../my-app && git init && npm install && npm run dev
```

The scaffolded app is ~6 files. It consumes minwebide as a **local path
dependency** (`"minwebide": "file:../minwebide"`, symlinked by npm), which is
the intended mode while the API is still in flux:

- library edits appear in every app immediately — no publish step;
- breaking changes surface as build/typecheck errors in the app, so both
  sides get fixed together;
- all apps share this repo's single `vendor/vscode` checkout — apps never
  fetch their own.

The build conventions live in minwebide, not in each app:
`vite.config.ts` is two lines (`mergeConfig(minwebide(), {...})` from
`minwebide/vite`) and `tsconfig.json` extends `minwebide/tsconfig.base.json`.
When the API stabilizes, pin apps by switching the dependency line to a git
tag (`github:<user>/minwebide#v0.x`) or a published package — nothing else in
the app changes.

## Using the library

`src/` is a framework-agnostic TypeScript library; `demo/` is a small app that
exercises it:

```ts
import { createIndexedDBFileSystem, createWorkbench, loadBuiltinTheme, registerBuiltinLanguages } from 'minwebide';

const fs = await createIndexedDBFileSystem({ dbName: 'my-app' });
await fs.seed({ '/hello.ts': 'console.log("hi")' });

const theme = await loadBuiltinTheme('dark_modern');   // any theme in extensions/theme-defaults
await registerBuiltinLanguages(theme);                 // all built-in grammars + file associations

const workbench = createWorkbench(document.getElementById('app')!, {
  fileSystem: fs,
  theme,
  workspaceName: 'my workspace',
});
workbench.openFile(fs.root.with({ path: '/hello.ts' }));
```

The `fs.fileService` property is VS Code's full `FileService`, so application
code can read/write/watch workspace files with the same API VS Code uses
internally. `workbench.editorArea.editor` is a real
`monaco.editor.IStandaloneCodeEditor`.

### Custom editors

Apps can replace (or complement) the text editor for chosen file types. The
registration shape mirrors VS Code's `contributes.customEditors` extension
point and the provider mirrors `CustomTextEditorProvider` — but there is no
extension host or webview: the pane is plain DOM, because the embedding app is
trusted code running in the same page.

```ts
workbench.registerCustomEditor({
  viewType: 'myapp.csvViewer',
  displayName: 'CSV Table',
  selector: [{ filenamePattern: '*.csv' }],
  priority: 'default',            // replaces the text editor ('option' = offered alongside)
  async resolveCustomEditor(document) {
    const model = await document.getTextModel(); // shared with the text editor
    // const bytes = await document.readBytes(); // or raw contents for binary files
    const element = renderMyEditor(model);
    return { element };            // + optional layout/focus/dispose/save/onDidChangeDirty
  },
});
```

Text-based panes share the file's text model with the built-in editor, so
edits, dirty state, and Ctrl+S stay consistent when a file is reopened the
other way (the tab bar offers "Reopen as Text Editor" / "Open with ..."
actions, like VS Code's editor title area). The demo registers three:
a markdown preview (rendered by VS Code's own `vs/base` markdownRenderer),
a CSV table viewer, and a binary image viewer.

### Output channels and file runners

The panel has an Output view built the way VS Code builds its own: a read-only
code editor over append-only channels, colorized by the built-in `log`
TextMate grammar, with a channel-switcher dropdown and clear action in the
panel title area. The API mirrors `vscode.window.createOutputChannel`:

```ts
const channel = workbench.createOutputChannel('My Tool', { log: true });
channel.info('starting');          // 2026-07-06 15:29:26.263 [info] starting
channel.appendLine('raw output');  // no prefix
channel.show();                    // reveal the Output view on this channel
```

"Run this file" is app-defined (in the browser that might mean eval'd JS, a
worker, Pyodide, ...), so — like VS Code, where run buttons come from
extensions contributing to the `editor/title/run` menu — apps register
runners, and a ▶ action appears in the tab bar for matching files:

```ts
workbench.registerRunner({
  id: 'myapp.runScript',
  displayName: 'Run Script',
  selector: [{ filenamePattern: '*.{js,mjs}' }],
  async run({ uri, getText, output }) {   // output: this runner's LogOutputChannel, already revealed
    output.info(`Running ${uri.path}`);
    ...
  },
});
```

`getText()` returns the open editor's (possibly unsaved) contents; the demo
registers a JavaScript runner with a captured console and a word-count runner.

For rich output (plots, tables, ...) a run context also has `getView()`: it
lazily creates the runner's view in the **secondary side bar** (right of the
editor — where VS Code extensions like Julia's plot pane dock tool-owned
views) and hands the runner a plain DOM container whose rendering it fully
controls. `view.show()` reveals it. Text belongs in the output channel; rich
things belong in the view:

```ts
async run({ getText, output, getView }) {
  output.info('running…');                 // → bottom panel
  const view = getView();
  view.element.replaceChildren(renderMyPlot(await getText()));
  view.show();                             // → secondary side bar
}
```

Apps can also create side bar views unrelated to runners with
`workbench.createAuxiliaryView(id, title)`. The demo's JavaScript runner
injects a `plot()` function into executed scripts (see
`scripts/sine-wave.js` in the sample workspace), themed with VS Code's own
`charts.*` colors.

Because the library imports `vs/*` modules from source, consuming apps need
the same two build conventions (see `vite.config.ts` and `tsconfig.json`):

1. alias `vs` → `vendor/vscode/src/vs`
2. TypeScript flags compatible with the VS Code source
   (`useDefineForClassFields: false`, `experimentalDecorators: true`)

## Layout

- `src/` — the library
  - `fs/` — IndexedDB file system (VS Code provider + FileService)
  - `theme/` — VS Code color theme loading, CSS variable application, editor theme
  - `textmate/` — language registration + TextMate tokenization
  - `editor/` — Monaco re-export with worker wiring
  - `workbench/` — the shell: workbench assembly, explorer, search, editor area, panel with output view, secondary side bar, activity/status bars
- `demo/` — demo IDE app (Vite root is the repo root, `index.html`)
- `templates/app/` — starter for new app repos (see `scripts/create-app.sh`)
- `vendor/vscode/` — pinned VS Code source checkout (not committed)
- `scripts/` — vendor fetch, asset setup, app scaffolding, typecheck gate, headless smoke test
- `vite.mjs`, `tsconfig.base.json` — the build conventions apps import (`minwebide/vite`, `minwebide/tsconfig.base.json`)

## Updating VS Code

Bump `.vscode-version`, run `bash scripts/fetch-vscode.sh`, rebuild, and fix
whatever changed upstream. Everything reused from the tree is imported by
explicit module path, so breakage surfaces at build/typecheck time.

## License

minwebide is MIT. The VS Code source it consumes is Copyright (c) Microsoft
Corporation, MIT-licensed (Code - OSS). The bundled output includes MIT-licensed
code from microsoft/vscode, vscode-textmate, and vscode-oniguruma.
