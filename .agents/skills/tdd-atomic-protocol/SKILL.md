---
name: tdd-atomic-protocol
description: Use at the start of every /implement-task invocation. Defines the red-green loop and Definition of Done gate for one atomic task.
---

# TDD + Atomic Task Protocol

## The loop, in order

1. **Red** — `test-writer` reads the task's Acceptance criteria and Tests
   required checklist, writes tests only, runs them, confirms real failure
   output (not a guess that they'd fail).
2. **Green** — `implementer` writes the minimum code to pass those tests
   without leaving the task's "In scope" list, runs `deno check`/`deno test`/
   `deno lint` itself, reports real output.
3. **Independent review** — `reviewer` re-derives correctness from
   `docs/contracts/` directly and re-runs verification itself; does not
   trust the implementer's report.
4. **Security pass (conditional)** — `security-auditor` runs only if the
   task's Spec references include `PLAT-4`, `PLAT-5`, `PLAT-6`, `PLAT-7`,
   `PLAT-15`, `FN-6`, or `FN-7`; attempts real attacks, not a read-through.
5. **Close** — every box on the task's Definition of Done checklist is
   checked against evidence gathered in steps 1–4, plus the task's
   Assumptions section is filled in honestly.

## Gate — a task cannot close if

- Any Definition of Done box is unchecked.
- Any tool output (`deno check`/`test`/`lint`) was asserted rather than
  actually run in this session.
- The Assumptions section is missing (empty is fine; absent is not).
- Anything on the task's Out-of-scope list was touched.
- A required security-auditor pass didn't happen for a task that needed one.

## Sizing check before starting

If, partway through implementation, the task turns out to need "and" to
describe what's being built, stop — it should have been two tasks. Split it
using `.agents/skills/atomic-task-decomposition/SKILL.md` rather than
pushing through with a task file that no longer matches the diff.
