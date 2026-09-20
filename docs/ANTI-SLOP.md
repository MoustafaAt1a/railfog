# ANTI-SLOP — Code Quality Rules

Concrete, checkable rules against the specific patterns that make
AI-generated code look and feel generic. Every reviewer pass checks this file
in addition to spec compliance — matching the contract and being well-built
are separate, both-required conditions.

## Naming

- Names come from `docs/glossary.md` only. No invented synonyms for
  Project/Function/KV/Object/Queue/Deployment/Revision/Secret/Domain.
- No `Manager`, `Helper`, `Utils`, `Service` catch-alls. Name a class or module
  after the one responsibility it has (`PermissionResolver`, not
  `PolicyManager`).
- No abbreviations that aren't already in the spec's own vocabulary (`ctx` is
  fine — it's in the spec's own code samples; don't invent others).

## Comments

- A comment explains *why*, not *what*. If it restates the line below it,
  delete it.
- When the "why" is spec-driven, cite the clause (`docs/ANTIHALLUCINATION.md`
  Rule 1) instead of paraphrasing the spec from memory.
- No commented-out code, ever. Delete it — git history is the archive.

## Structure

- No speculative generality. Don't build a plugin system, a generic strategy
  registry, or a config surface for a feature the spec marks out of scope for
  1.0.0 (`docs/contracts/platform.contract.md` PLAT-20). This is the
  spec's own Principle 5, applied to the build process, not just the product.
- One level of abstraction per function body. If a function mixes "loop over
  bytes" with "decide the HTTP status code," split it.
- No magic numbers. Every limit, timeout, or threshold is a named constant
  that traces to a limits table in `docs/contracts/`.
- No copy-pasted logic across provider adapters. Shared behavior (e.g. key
  namespacing, PLAT-7) lives in one place; only genuinely
  provider-specific behavior lives in the adapter.

## Error handling

- One error taxonomy, matching `docs/contracts/platform.contract.md`'s error
  code table exactly (`RESOURCE_NOT_FOUND`, `PERMISSION_DENIED`,
  `VALIDATION_FAILED`, `RATE_LIMITED`, `CALL_DEPTH_EXCEEDED`, `TIMEOUT`,
  `PAYLOAD_TOO_LARGE`, `CONFLICT`, `UNAVAILABLE`, `INTERNAL`). No ad hoc thrown
  strings, no silently swallowed errors, no mixing thrown exceptions with
  returned error objects for the same kind of failure.
- Never log or return a secret value in an error, even accidentally via a
  stringified object (`docs/contracts/platform.contract.md` PLAT-15 —
  structured logging must auto-redact bound secret names).

## Completeness

- No `TODO`, `FIXME`, or stub function bodies merged as if a task were done. A
  task with a stub in its diff is not at Definition of Done.
- No test doubles, fixtures, or mock data reachable from a production code
  path — they live under `tests/` only.
- No dead code: an unused export, an unreferenced interface, a leftover
  experiment — delete before marking a task complete.

## Diff hygiene

- One atomic task, one concern, one reviewable diff. If a PR description needs
  "and" to summarize it, it should have been two tasks
  (`.agents/skills/atomic-task-decomposition/SKILL.md`).
- A diff that touches files outside the task's declared scope is a scope
  violation (`docs/ANTIHALLUCINATION.md` Rule 6), not a bonus.
