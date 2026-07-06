# __APP_NAME__

Built on [minwebide](https://github.com/magland/minwebide) — a minimalistic
web IDE built from VS Code's own source code, with the file system persisted
in the browser's IndexedDB.

## Development

Requires a sibling checkout of minwebide (`__MINWEBIDE_PATH__`):

```sh
(cd __MINWEBIDE_PATH__ && npm install)   # fetches the pinned VS Code source
npm install
npm run dev
```

- `npm run build` — static bundle in `dist/`
- `npm run typecheck` — typechecks app code (vendor diagnostics suppressed)

## Extending

See minwebide's
[creating-an-app guide](https://github.com/magland/minwebide/blob/main/docs/creating-an-app.md)
for the full API: custom editors per file type, file runners with output
channels, and rich-output views in the secondary side bar.
