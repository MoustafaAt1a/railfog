#!/usr/bin/env bash
# Blocks obviously destructive commands before they run.
# Wired as a pre-execution hook in hooks.json.
# Exit 1 = block the command; exit 0 = allow it.

cmd="$1"

deny_patterns=(
  'rm[[:space:]]+-rf[[:space:]]+/'
  'rm[[:space:]]+-rf[[:space:]]+\*'
  'git[[:space:]]+push[[:space:]]+.*--force'
  'git[[:space:]]+push[[:space:]]+.*-f[[:space:]]'
  'DROP[[:space:]]+TABLE'
  'DROP[[:space:]]+DATABASE'
  'TRUNCATE[[:space:]]+TABLE'
  ':(){ :\|:& };:'   # fork bomb
  'chmod[[:space:]]+-R[[:space:]]+777[[:space:]]+/'
)

for pattern in "${deny_patterns[@]}"; do
  if echo "$cmd" | grep -qiE "$pattern"; then
    echo "BLOCKED by block-destructive-ops.sh: command matches '$pattern'" >&2
    echo "If this is genuinely intended, run it manually outside the agent session." >&2
    exit 1
  fi
done

exit 0
