#!/usr/bin/env bash
# Scaffolds a new app repo built on minwebide.
#
#   bash scripts/create-app.sh ../my-app
#
# The app consumes minwebide as a local path dependency (npm symlinks it), so
# library edits appear in the app immediately — the right mode while the
# minwebide API is still in flux. Once it stabilizes, switch the dependency to
# a git tag or a published version; nothing else in the app changes.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: bash scripts/create-app.sh <target-directory>" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$1"

if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "error: $TARGET already exists and is not empty" >&2
  exit 1
fi

mkdir -p "$TARGET"
cp -r "$ROOT/templates/app/." "$TARGET/"

APP_NAME="$(basename "$(cd "$TARGET" && pwd)")"
REL_PATH="$(realpath --relative-to="$TARGET" "$ROOT")"

find "$TARGET" -type f \( -name '*.json' -o -name '*.ts' -o -name '*.html' \) -print0 |
  xargs -0 sed -i "s|__APP_NAME__|$APP_NAME|g; s|__MINWEBIDE_PATH__|$REL_PATH|g"

echo "Created $APP_NAME at $TARGET (minwebide dependency: file:$REL_PATH)"
echo
echo "Next steps:"
echo "  cd $TARGET"
echo "  git init && npm install"
echo "  npm run dev"
