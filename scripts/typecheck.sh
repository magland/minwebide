#!/usr/bin/env bash
# Typecheck the project. Errors inside vendor/vscode are reported as a count
# only (they stem from TS-version and ambient-type differences between this
# project and VS Code's own build; esbuild strips types, so they never affect
# the bundle). Errors in our own code fail the check.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="$(cd "$ROOT" && npx tsc --noEmit --pretty false 2>&1)"

OURS="$(printf '%s\n' "$OUTPUT" | grep -E '^(src|demo)/' || true)"
VENDOR_COUNT="$(printf '%s\n' "$OUTPUT" | grep -cE '^vendor/' || true)"
OTHER="$(printf '%s\n' "$OUTPUT" | grep -vE '^(src|demo|vendor)/|^ ' | grep -v '^$' || true)"

if [ -n "$VENDOR_COUNT" ] && [ "$VENDOR_COUNT" != "0" ]; then
  echo "note: $VENDOR_COUNT vendor/vscode diagnostics suppressed (run 'npx tsc --noEmit' to see them)"
fi
if [ -n "$OTHER" ]; then
  printf '%s\n' "$OTHER"
  exit 1
fi
if [ -n "$OURS" ]; then
  printf '%s\n' "$OURS"
  exit 1
fi
echo "typecheck OK"
