---
name: implement-task
description: Run the full red-green-review loop for one atomic task.
---

Usage: `/implement-task <task-id>`

Example: `/implement-task T-0104`

## Steps

1. Load the task file. Confirm its `Depends on` list is already closed
   (check each dependency's Definition of Done) — refuse to start otherwise
   and say which dependency is blocking. Set the task's `Status:` field to
   `In progress`.
2. Invoke `test-writer` per `.agents/skills/tdd-atomic-protocol/SKILL.md`
   step 1 (Red). Confirm real failing output before proceeding.
3. Invoke `implementer` per the same skill's step 2 (Green). Confirm real
   `deno check`/`deno test`/`deno lint` output before proceeding.
4. Set `Status:` to `In review`. Invoke `reviewer` per step 3. If it returns
   any unresolved finding, set `Status:` back to `In progress` and loop back
   to `implementer` (or `test-writer` if the finding is in the tests) rather
   than closing the task.
5. If the task's Spec references include any of `PLAT-4`, `PLAT-5`,
   `PLAT-6`, `PLAT-7`, `PLAT-15`, `FN-6`, `FN-7` — invoke `security-auditor`
   per step 4. Same rule: any
   unresolved finding sets `Status:` back to `In progress` and loops back.
6. Check every Definition of Done box against actual evidence gathered in
   steps 2–5. Fill in the task's Assumptions section. Only then set
   `Status:` to `Done` and consider the task closed.

## Do not

- Skip the security-auditor step because the reviewer already approved —
  they check different things.
- Mark a task done because the implementer reported success — the reviewer
  step is not optional.
- Proceed to a dependent task before this one's Definition of Done is fully
  checked with real evidence.
