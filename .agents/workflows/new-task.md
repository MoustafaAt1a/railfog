---
name: new-task
description: Decompose a milestone or spec section into atomic task files.
---

Usage: `/new-task <milestone-id-or-spec-section>`

Examples: `/new-task 0.2`, `/new-task kv.contract.md#KV-5`

## Steps

1. Invoke `architect` to confirm the design/scope for the target milestone or
   section is settled — resolve any open ambiguity into an explicit decision
   or ADR draft (`docs/adr/template.md`) before decomposing anything.
2. Invoke `task-decomposer` with:
   - The target milestone or spec section.
   - The current repository tree (so sizing reflects what already exists,
     not a from-scratch guess).
   - `tasks/00-roadmap.md`'s dependency notes for this milestone, if any.
3. `task-decomposer` writes one file per atomic task under
   `tasks/<milestone>/`, following `tasks/TASK-TEMPLATE.md` and
   `.agents/skills/atomic-task-decomposition/SKILL.md`, and a
   `00-milestone-brief.md` with a dependency graph
   (`tasks/milestone-0.1-runtime-prototype/00-milestone-brief.md` is the
   reference shape).
4. Stop and present the task list for human confirmation before any
   `/implement-task` is run against it — decomposition is cheap to redo,
   implementation is not.

## Do not

- Skip step 1 and decompose directly from the spec — ambiguity resolved
  during decomposition instead of design tends to get baked into task
  boundaries silently.
- Let `task-decomposer` write any implementation code.
