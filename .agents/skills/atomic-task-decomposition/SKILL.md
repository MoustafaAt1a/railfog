---
name: atomic-task-decomposition
description: Use when breaking a milestone, feature, or spec section into task files. Defines the sizing heuristic and required fields so every task stays small enough to review and verify in one pass.
---

# Atomic Task Decomposition

## Sizing heuristic

A task is correctly sized when it is **one** of:

- One interface definition (no implementation).
- One implementation of an already-defined interface.
- One behavior (a single Given/When/Then, or a small cluster of directly
  related ones — e.g. "CAS success and CAS conflict" is one behavior of one
  operation, not two tasks).

Signals a task is too big:

- Its title needs "and" to describe it.
- Its Interface section would need more than ~2–3 related function
  signatures.
- Its estimated diff (implementation + tests) would exceed a few hundred
  lines.
- It touches more than one directory under `docs/contracts/platform.contract.md`
  PLAT-19's top-level structure (e.g. both `providers/` and `runtime/`) —
  usually a sign it's actually "define the interface" + "consume the
  interface," two tasks.

Signals a task is too small to be worth a separate file: it has no
independently testable behavior of its own (e.g. "add a comment," "rename a
variable" — fold these into the task that actually needs them).

## Required fields (see `tasks/TASK-TEMPLATE.md`)

Every emitted task must have: Milestone, Depends on, Blocks, Spec references
(clause IDs — never a whole contract file), Scope (In/Out, Out is binding),
Interface to implement (exact signature or "none — this defines no new
interface"), Acceptance criteria (Given/When/Then), Tests required
(unit/integration/security, security only if `PLAT-4`, `PLAT-5`, `PLAT-6`,
`PLAT-7`, `PLAT-15`, `FN-6`, or `FN-7` is touched), Definition of Done
checklist, Assumptions made.

## Dependency ordering

Order tasks so that:

- Interfaces are defined before implementations that satisfy them.
- Implementations exist before anything that composes them (e.g. capability
  injection depends on all three provider implementations existing first —
  see `tasks/milestone-0.1-runtime-prototype/00-milestone-brief.md`'s
  dependency graph for the canonical worked example).
- Security-relevant composition (capability injection, isolation wiring)
  happens before anything downstream consumes it, never after, even if the
  downstream piece seems easier to build first.

## When no contract clause covers a needed task

Don't decompose around the gap. Route to the `architect` agent for an ADR
first (`docs/adr/template.md`), then decompose once the ADR gives you
something to cite.
