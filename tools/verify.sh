#!/usr/bin/env bash
# Integrity check: flags mount-corruption (trailing NUL bytes), JS syntax errors,
# and TypeScript errors in the React client (if its deps are installed).
set -u
cd "$(dirname "$0")/.."
problems=0
files=$(find server config.json package.json -type f \( -name '*.js' -o -name '*.json' \) 2>/dev/null)
for f in $files; do
  if [ -s "$f" ] && tail -c 16 "$f" | od -An -tx1 | grep -q '00'; then echo "NUL bytes:   $f"; problems=1; fi
  case "$f" in *.js) node --check "$f" 2>/dev/null || { echo "Syntax error: $f"; problems=1; } ;; esac
done
if [ -d client/node_modules ]; then
  echo "· typechecking client (tsc)…"
  (cd client && npx tsc --noEmit) || { echo "TypeScript errors in client/"; problems=1; }
fi
if [ "$problems" -eq 0 ]; then echo "✓ all files clean"; else echo "✗ problems found (see above)"; fi
exit $problems
