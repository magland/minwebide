#!/usr/bin/env bash
# Places assets that VS Code's build normally provides into the vendor tree.
# Currently: the codicon icon font, which vendor CSS references as ./codicon.ttf
# but which ships in the @vscode/codicons npm package rather than the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TTF_SRC="$ROOT/node_modules/@vscode/codicons/dist/codicon.ttf"
TTF_DEST="$ROOT/vendor/vscode/src/vs/base/browser/ui/codicons/codicon/codicon.ttf"

if [ ! -f "$TTF_SRC" ]; then
  echo "warning: $TTF_SRC not found (run npm install first); skipping codicon font setup"
  exit 0
fi
cp "$TTF_SRC" "$TTF_DEST"
echo "Copied codicon.ttf into vendor tree"
