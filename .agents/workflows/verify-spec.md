---
name: verify-spec
description: Spot-check the whole repository against one contract file for regressions of banned patterns or drifted clauses.
---

Usage: `/verify-spec <contract-file>`

Example: `/verify-spec contracts/kv.contract.md`

Use this periodically, and always before starting a new milestone that
depends on an earlier one's contracts (see `tasks/00-roadmap.md`'s dependency
notes).

## Steps

1. Read the target contract file in full, including its "Banned patterns"
   section.
2. Grep the codebase for each clause's key terms (e.g. for `kv.contract.md`:
   every `kv.set` call site, checking each one that's used as a dedupe/
   idempotency key actually has a `ttl`).
3. For every "Banned pattern" listed, search specifically for it — don't
   assume it's absent because no task intentionally introduced it; a later
   edit or a different task's implementer could have reintroduced one.
4. Report every match with a file:line reference and whether it's compliant
   or a finding. Do not fix findings inline — open a task or route through
   `/implement-task` so fixes go through the normal red-green-review loop.

## Do not

- Treat "no findings on this pass" as a permanent guarantee — re-run after
  any milestone that touches the same contract file's area.
