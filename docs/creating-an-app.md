# Creating an app with minwebide

This is the reference for building a web application on minwebide: a
VS Code-look-and-feel workbench (editor, explorer, search, output panel,
secondary side bar) over an IndexedDB file system, which you extend with your
own custom editors, file runners, output channels, and side bar views.

A complete working example is
[concept-collection/minwebide-demo](https://github.com/concept-collection/minwebide-demo)
(live at <https://concept-collection.github.io/minwebide-demo/>).

## 1. Project setup

### Scaffold (recommended)

From a checkout of this repo:

```sh
bash scripts/create-app.sh ../my-app
cd ../my-app
git init && npm install
npm run dev
```

### What the scaffold sets up (or: manual setup)

minwebide is distributed as **source** and consumed as a **path dependency**;
apps need a sibling checkout of minwebide and these files:

**package.json**

```json
{
  "type": "module",
  "dependencies": { "minwebide": "file:../minwebide" },
  "devDependencies": { "typescript": "^5.9.0", "vite": "^7.0.0" }
}
```

npm symlinks the dependency, so minwebide edits appear in your app
immediately, and your app reuses minwebide's single `vendor/vscode` checkout
(fetched by minwebide's `npm install`; never committed anywhere).

**vite.config.ts** — all VS Code-source build conventions come from one import:

```ts
import { defineConfig, mergeConfig } from 'vite';
import { minwebide } from 'minwebide/vite';

export default defineConfig(mergeConfig(minwebide(), {
  // app-specific config (base, plugins, ...)
}));
```

**tsconfig.json**

```json
{
  "extends": "minwebide/tsconfig.base.json",
  "compilerOptions": { "types": ["vite/client"] },
  "include": ["src"]
}
```

Typechecking note: `tsc` will pull VS Code source into the program and report
diagnostics inside `vendor/vscode` that come from TS-version differences with
VS Code's own build. They never affect the bundle (Vite/esbuild strips types).
The scaffolded `scripts/typecheck.sh` fails only on errors in *your* code.

## 2. Boot sequence

Every app initializes in the same order: file system → theme → languages →
workbench.

```ts
import {
  createIndexedDBFileSystem,
  createWorkbench,
  loadBuiltinTheme,
  registerBuiltinLanguages,
} from 'minwebide';

const fs = await createIndexedDBFileSystem({ dbName: 'my-app' });
await fs.seed({
  '/README.md': '# Hello\n',
  '/src/main.ts': 'console.log("hi");\n',
});

const theme = await loadBuiltinTheme('dark_modern');
await registerBuiltinLanguages(theme);

const workbench = createWorkbench(document.getElementById('app')!, {
  fileSystem: fs,
  theme,
  workspaceName: 'my workspace',
});
await workbench.openFile(fs.root.with({ path: '/README.md' }));
```

## 3. The file system

`createIndexedDBFileSystem(options)` persists a workspace in the browser's
IndexedDB using VS Code's own provider (the one behind vscode.dev).

- `options.dbName` — IndexedDB database name; use one per app (default
  `'minwebide-workspace'`). Two apps with different names have fully separate
  workspaces.
- `fs.root` — `URI` of the workspace root. Build file URIs with
  `fs.root.with({ path: '/some/file.ts' })`.
- `fs.seed(files)` — writes a `path → string | Uint8Array` map, **skipping
  files that already exist** (safe to call on every startup).
- `fs.writeFile(path, contents)` / `fs.deleteFile(path)` — single-file
  create-or-overwrite (parent folders included) and delete, taking `string |
  Uint8Array` — no `VSBuffer` needed.
- `fs.fileService` — VS Code's full `FileService`. The APIs your app will use
  most:

```ts
import { URI } from 'minwebide';
const file = fs.root.with({ path: '/data/x.json' });

await fs.fileService.exists(file);
const text = (await fs.fileService.readFile(file)).value.toString();
await fs.fileService.writeFile(file, VSBuffer.fromString('...'));  // VSBuffer: import from 'vs/base/common/buffer'
await fs.fileService.createFolder(fs.root.with({ path: '/data' }));
await fs.fileService.del(file, { recursive: true });
const stat = await fs.fileService.resolve(fs.root);                 // stat.children for listings
fs.fileService.onDidFilesChange(e => { /* fires for all changes, incl. other tabs */ });
```

Changes broadcast across browser tabs of the same app automatically
(BroadcastChannel), the explorer refreshes itself on any change, and open
editors with no unsaved edits reload from disk when their file changes
(`workbench.editorArea.reloadFromDisk(true)` forces the reload for unsaved
edits too — an explicit revert).

## 4. Themes and languages

- `loadBuiltinTheme(name)` — any theme shipped in VS Code:
  `'dark_modern'`, `'light_modern'`, `'dark_plus'`, `'light_plus'`,
  `'hc_black'`, `'hc_light'`, ... (`builtinThemeNames()` lists them).
- `registerBuiltinLanguages(theme)` — registers every language + TextMate
  grammar from VS Code's built-in extensions: file-extension detection,
  syntax highlighting, brackets/comments behavior. Grammars load lazily per
  language, so this is cheap up front.
- Custom themes: `loadColorTheme(entryPath, readFile)` takes any VS Code color
  theme JSON (include chains supported). Custom grammar sets:
  `registerTextMateSupport(options)`.

The whole UI — workbench chrome, your custom editors, plots — is themed
through the same `--vscode-*` CSS variables VS Code uses, so style your own
DOM with `var(--vscode-foreground)`, `var(--vscode-panel-border)`,
`var(--vscode-charts-blue)`, etc. and it will follow the theme.

## 5. The workbench

`createWorkbench(container, options)` builds the shell. Options:

| Option | |
| --- | --- |
| `fileSystem` | required, from `createIndexedDBFileSystem` |
| `theme` | required, a loaded `WorkbenchTheme` |
| `workspaceName` | shown in the explorer title and status bar |
| `customEditors` | providers to register up front (see §6) |

Useful members of the returned `Workbench`:

```ts
workbench.openFile(uri, {
  revealRange: { startLineNumber, startColumn, endLineNumber, endColumn },  // optional
  openWith: 'myapp.csvViewer' /* or 'text' */,                              // optional
});
workbench.editorArea.activeUri;                  // URI | undefined
workbench.editorArea.onDidChangeActiveFile(f => ...);
workbench.editorArea.saveActive();
workbench.editorArea.closeFile(uri);
workbench.editorArea.editor;                     // the monaco.editor.IStandaloneCodeEditor

workbench.statusBar.setItem('my-item', 'right', 'Ready', {
  icon: 'check',                                 // any codicon name
  title: 'tooltip',
  onClick: () => { ... },
});
workbench.statusBar.removeItem('my-item');
```

`Ctrl+S` saves the active editor (custom editors included); the browser's
save dialog is suppressed inside the workbench.

The raw Monaco API (same code as the real editor) is available as
`import { monaco } from 'minwebide'` — markers, decorations, model access,
`monaco.editor.getModel(uri)`, etc.

## 6. Custom editors

Replace or complement the text editor for chosen file types. Registration
mirrors VS Code's `contributes.customEditors`; the provider mirrors
`CustomTextEditorProvider` — but panes are plain DOM (no extension host,
no webview: your app is trusted code).

```ts
workbench.registerCustomEditor({
  viewType: 'myapp.csvViewer',           // unique id
  displayName: 'CSV Table',              // shown in tab tooltips + "open with" actions
  selector: [{ filenamePattern: '*.csv' }],
  priority: 'default',                   // 'default' replaces the text editor;
                                         // 'option' is offered alongside it
  async resolveCustomEditor(document) {
    // pick ONE data path:
    const model = await document.getTextModel();  // shared with the text editor
    const bytes = await document.readBytes();     // raw contents (binary files)

    const element = document.createElement('div');
    // ... render into element; model.onDidChangeContent for live updates ...
    return {
      element,
      // all optional:
      layout(width, height) { },
      focus() { },
      dispose() { },
      onDidChangeDirty,                  // Event<boolean> for panes that edit
      async save() { },                  // Ctrl+S handler for panes that edit
    };
  },
});
```

Semantics worth knowing:

- One tab per file URI. `filenamePattern` is a glob matched against the file
  name (or the full path if the pattern contains `/`).
- Text-based panes share the file's text model with the built-in editor, so
  edits, dirty state, and saving stay consistent when the user switches
  representation. The tab bar automatically offers "Reopen as Text Editor"
  and "Open with ..." actions.
- Panes that edit *without* the shared model report `onDidChangeDirty` and
  implement `save()`.

## 7. Output channels

The bottom panel's Output view mirrors `vscode.window.createOutputChannel`,
rendered exactly like VS Code's (read-only editor, `log` grammar
colorization, channel dropdown, clear action):

```ts
const plain = workbench.createOutputChannel('My Tool');
plain.appendLine('raw text');

const log = workbench.createOutputChannel('My Tool (log)', { log: true });
log.info('starting');        // 2026-07-06 15:29:26.263 [info] starting
log.warn('careful');
log.error(new Error('boom'));
log.show();                  // reveal the Output view on this channel
```

## 8. File runners

"Run this file" is app-defined (eval'd JS, a worker, Pyodide, a remote
service, ...). Register a runner and a ▶ action appears in the tab bar for
matching files:

```ts
workbench.registerRunner({
  id: 'myapp.runScript',
  displayName: 'Run Script',             // ▶ tooltip + output channel + view title
  selector: [{ filenamePattern: '*.{js,mjs}' }],
  async run({ uri, getText, readBytes, output, getView }) {
    output.info(`Running ${uri.path}`);  // this runner's LogOutputChannel, already revealed
    const code = await getText();        // the editor's (possibly unsaved) contents
    // ... execute ...
  },
});
```

Errors thrown from `run()` land in the channel as `[error]` lines.

A runner may also declare `stop(uri)` — while `run()` is pending, the tab's
▶ action becomes a ⏹ stop button that invokes it (e.g. terminate the worker
doing the work); `run()` should then resolve promptly. While a runner is
running, re-clicks are ignored; without `stop()` the ▶ button just stays.

`workbench.runFile(uri)` triggers the same flow programmatically (first
matching runner, channel reveal, ▶/⏹ swap) — for run buttons inside your
own views, like a custom editor.

## 9. Rich output: the secondary side bar

For output that isn't text (plots, tables, previews), a run context's
`getView()` lazily creates this runner's view in the secondary side bar
(right of the editor, VS Code style) and hands you a DOM container you fully
control:

```ts
async run({ getText, output, getView }) {
  const view = getView();
  view.element.replaceChildren(renderPlot(await getText()));
  view.show();                           // reveals the bar with this view active
}
```

Views not tied to a runner: `workbench.createAuxiliaryView(id, title)` returns
the same `AuxiliaryView` handle (`element`, `show()`, `dispose()`). The bar
stays hidden until a view calls `show()` and has a close button; multiple
views become tabs. `workbench.setAuxiliaryBarVisible(v)` toggles it
programmatically.

The demo's `plot()` implementation
([minwebide-demo/src/plot.ts](https://github.com/concept-collection/minwebide-demo/blob/main/src/plot.ts))
is a reasonable starting point for chart panes; for serious plotting, mount
your charting library of choice in the view's element.

## 10. Importing GitHub repositories

`importGitHubRepo(fs, spec, options)` copies a public GitHub repository (or a
subdirectory of one) into a workspace folder — anonymously, straight from the
browser, no token or backend required:

```ts
import { importGitHubRepo } from 'minwebide';

const result = await importGitHubRepo(fs, 'owner/repo', {
  onProgress: p => console.log(`${p.written}/${p.total} ${p.path}`),
});
// result: { owner, repo, ref, commitSha, root, fileCount, skipped }
```

- `spec` — `'owner/repo'`, `'owner/repo@ref'` (branch, tag, or commit SHA), a
  github.com URL (including `/tree/<ref>/<dir>` URLs, which import just that
  subdirectory), or a parsed `GitHubRepoSpec` object.
- `options.target` — destination folder (default `/<repo>`). The import fails
  if the target is already occupied unless you pass `clean: true`.
- `options.auth` — optional GitHub token. Anonymous imports work fine for
  public repos: the listing costs at most 3 API requests (rate-limited to
  60/hour per IP) and file contents come from `raw.githubusercontent.com`,
  which doesn't count against that limit.
- Symlinks, submodules, and files over `maxFileSize` (default 10 MiB) are
  skipped and reported in `result.skipped`.

**The share-link pattern.** For a "open this repo in the IDE" URL, don't
import into your app's regular workspace — give the repo a workspace of its
own: a dedicated file system (one `dbName` per repo) with the repo imported
at the root. `attachGitHubWorkspace(workbench, fs, spec, options?)` packages
the whole flow, VS Code style:

```ts
const fs = await createIndexedDBFileSystem({ dbName: `my-app-gh-${owner}-${repo}` });
const workbench = createWorkbench(container, { fileSystem: fs, theme, workspaceName: `${owner}/${repo}` });
await attachGitHubWorkspace(workbench, fs, `${owner}/${repo}`);
```

- The first visit imports the repo (status bar progress, a `GitHub` output
  channel) and opens its README (`autoOpenReadme: false` to disable). Later
  visits reopen the stored local copy, edits included. Reads use the stored
  sign-in token when one exists, so **private repositories work**; when an
  anonymous open 404s (GitHub's answer for private repos too), a sign-in
  prompt appears and the import retries.
- A **Source Control** side view (activity bar icon with a pending-changes
  badge) lists the files modified/added/deleted relative to the imported
  commit — compared by git blob SHA, so only real content differences count —
  with a *Reload from GitHub* action that discards local changes and
  re-imports the ref (picking up newer upstream commits).
- **Commit & Push** commits the changes on top of the imported commit and
  pushes to the branch via the Git Data API. Sign-in reproduces VS Code's own
  PAT flow: a dialog opens GitHub's token page pre-filled with a description
  (`options.appName`) and the `repo` scope, the user pastes the token once,
  and it stays in the browser's localStorage (fine-grained per-repo tokens
  work too). Pushes are fast-forward-only — if the branch moved on GitHub
  since the import, the push is refused rather than merged. On success the
  provenance advances, so the workspace reads as clean.
- The status bar shows `owner/repo@sha`, growing a `*` while the tree is
  dirty; clicking it reveals the view.

**Publishing a local workspace.** For workspaces that didn't come from GitHub
(a project the user built in the app), attach
`attachGitHubSourceControl(workbench, fs, { appName, defaultRepoName,
onPublished })` instead. While unconnected, the Source Control view shows a
publish form: a button opens github.com/new (name pre-filled from
`defaultRepoName`) where the user creates an **empty** repository themselves
— nothing is created programmatically, so a fine-grained token scoped to just
that repo suffices — then pastes its URL and publishes.
`publishGitHubRepo(fs, target, { auth, repo })` pushes the workspace as the
initial commit; a repository that already has commits is refused, so a
mistyped URL can never overwrite anything. Afterwards `onPublished` fires and
is awaited — typically to seed the app's per-repo workspace via
`transplantGitHubWorkspace(sourceFs, targetFs)` (a purely local copy of files
plus baseline; the local state IS the pushed state, so nothing is
re-downloaded) and then navigate to the app's GitHub route. Without the hook
the view switches to change tracking in place. Both demo flows use this:
the regular demo workspace is publishable, and `#github/...` workspaces track
their source repo.

The pieces are also exported individually: `diffGitHubWorkspace(fs, target)`
returns `{ modified, added, deleted }`, `resyncGitHubRepo(fs, target)`
re-imports at the stored ref, `computeGitBlobSha(bytes)` hashes like
`git hash-object`, and the import provenance (repo, ref, commit SHA, per-file
blob SHAs — persisted in localStorage keyed by the file system's `dbName`) is
available via `getGitHubRepoMetadata(fs, target)`. The demo's
`openGitHubWorkspace` in [demo/main.ts](../demo/main.ts) wires a
`#github/owner/repo` URL fragment to this pattern; the regular demo
workspace is never touched.

## 11. The project-app shell

For apps structured as "projects stored in your browser" (like stan-web-ide
and numbl-web-ide), the shell packages everything above into three routes —
`#/` (a project-picker landing page), `#/project/<id>` (the IDE on that
project's own IndexedDB database), and `#/github/<spec>` (a GitHub repo as
its own workspace) — plus per-project source control: publish, change
tracking, push, reload. An app supplies a config and its workbench assembly:

```ts
const config: ProjectAppConfig = {
  appId: 'my-app',                    // storage keys and database names
  appName: 'my app',                  // titles, GitHub token description
  assembleWorkbench: async (container, fs, workspaceName, theme) => {
    const workbench = createWorkbench(container, { fileSystem: fs, theme, workspaceName });
    workbench.registerRunner(myRunner);
    return { workbench, dispose: () => workbench.dispose() };
  },
  startingFiles: ['/main.foo', '/README.md'],  // first editor to open
  landing: {
    subtitle: 'Run foo in your browser.',
    links: [{ label: 'example.org', href: 'https://example.org' }],
    sampleWorkspace,                            // "New sample project" seed
    emptyWorkspace: (project) => ({ '/main.foo': `// ${project.name}\n` }),
  },
};

await startProjectApp(document.getElementById('app')!, theme, config);
```

Repositories opened via `#/github/<spec>` are also remembered (localStorage
key `<appId>.github-history`), and the landing page lists them under
"GitHub repositories", most recent first, each removable — removing an
entry keeps the local workspace copy. The history helpers are exported as
`listGitHubHistory`, `recordGitHubVisit`, `removeGitHubVisit`, and
`canonicalGitHubSpec`.

`startProjectApp` returns the `ProjectRegistry` (list/create/rename/
duplicate/delete projects, each backed by `<appId>-project-<id>` databases)
for app code that needs it; the pieces are also exported individually
(`createProjectRegistry`, `renderProjectLanding`, `openProjectIde`,
`openGitHubRoute`, `githubWorkspaceDbName`, `openStartingFile`) for apps
that want a different composition.

## 12. Deploying (GitHub Pages)

The build is fully static (`npm run build` → `dist/`). Because minwebide is a
path dependency, CI checks out both repos as siblings. See the demo's
[deploy.yml](https://github.com/concept-collection/minwebide-demo/blob/main/.github/workflows/deploy.yml)
for the complete recipe; the essential steps:

```yaml
- uses: actions/checkout@v4
  with: { path: my-app }
- uses: actions/checkout@v4
  with: { repository: magland/minwebide, path: minwebide }
- uses: actions/cache@v4          # the VS Code source fetch, keyed by pinned version
  with:
    path: minwebide/vendor/vscode
    key: vscode-vendor-${{ hashFiles('minwebide/.vscode-version') }}
- run: npm ci                     # in minwebide/ (fetches VS Code source)
  env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }
- run: npm ci && DEPLOY_BASE=/my-app/ npm run build   # in my-app/
```

If the site lives under a subpath (project pages), set Vite's `base`
accordingly (the demo reads `DEPLOY_BASE`).

## 13. Gotchas

- **`getText()` returns unsaved editor contents** when the file is open —
  usually what a runner wants; use `readBytes()`/`fileService.readFile` for
  the on-disk (on-IndexedDB) state.
- **Seeding never overwrites.** To reset a workspace during development,
  delete the IndexedDB database in devtools (Application → Storage) or bump
  `dbName`.
- **Closing a tab discards its undo history** (models are disposed on close).
- **Selectors don't re-match open tabs.** Registering a custom editor or
  runner after files are open updates the tab-bar actions, but already-open
  tabs keep their current editor until reopened.
- **Bundle size**: the core is ~850 kB gzipped; each grammar/theme is a lazy
  chunk loaded on first use. Vite will warn about chunk size — that's the
  editor itself, and it's expected.
