#!/usr/bin/env bash
# Runs after any file edit inside the repo. Gives the agent real tool
# output to cite instead of an unverified claim that code "should" compile
# or lint cleanly — see docs/ANTIHALLUCINATION.md Rule 5.
# Non-fatal: reports status, never blocks the edit itself.

set -uo pipefail

if ! command -v deno >/dev/null 2>&1; then
  echo "post-edit-verify: deno not found on PATH, skipping." >&2
  exit 0
fi

echo "--- deno fmt --check ---"
deno fmt --check . 2>&1 || true

echo "--- deno lint ---"
deno lint . 2>&1 || true

echo "--- deno check (repo-wide) ---"
deno check '**/*.ts' 2>&1 || true

echo "post-edit-verify: done. Cite this output directly — do not paraphrase it as 'checks passed.'"
exit 0
