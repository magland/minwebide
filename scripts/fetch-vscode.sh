#!/usr/bin/env bash
# Fetches the VS Code source tree that minwebide reuses.
# The tree lands in vendor/vscode (gitignored); the pinned tag lives in .vscode-version.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-$(cat "$ROOT/.vscode-version")}"
DEST="$ROOT/vendor/vscode"

if [ -d "$DEST" ]; then
  CURRENT="$(git -C "$DEST" describe --tags --exact-match 2>/dev/null || echo unknown)"
  if [ "$CURRENT" = "$TAG" ]; then
    echo "vendor/vscode already at $TAG"
    exit 0
  fi
  echo "vendor/vscode is at '$CURRENT', want '$TAG' — refetching"
  rm -rf "$DEST"
fi

mkdir -p "$ROOT/vendor"
git clone --depth 1 --branch "$TAG" https://github.com/microsoft/vscode.git "$DEST"
echo "Fetched microsoft/vscode at $TAG"
