# T-0912 — Architectural Decision Record for Unified Four Primitives

Status: Done
Milestone: 0.9.1 Unified Four-Primitives & SDK Specification
Depends on: none
Blocks: T-0913, T-0914, T-0915, T-0916

## Spec references

`PLAT-1`, `PLAT-2`, `PLAT-6`, `PLAT-16`, `FN-1`, `KV-1`, `OBJ-1`, `Q-1`

## Scope

**In scope**:
- Author `docs/adr/ADR-0005-unified-four-primitives.md` per `docs/adr/template.md`.
- Formalize:
  1. The two-tier terminology distinction: Developer Concept vs. Infrastructure Primitive.
  2. Disambiguation of the `Signal` primitive from the WHATWG Web API `AbortSignal`.
  3. Non-breaking capability aliasing in `railfog.toml` (`state` $\leftrightarrow$ `kv`, `data` $\leftrightarrow$ `objects`, `signal` $\leftrightarrow$ `queues`).
  4. Type aliasing strategy in `@railfog/sdk` ensuring zero breaking changes.

**Out of scope**:
- Direct modifications to SDK implementation files or schema files (covered by downstream tasks T-0913–T-0916).

## Interface to implement

```markdown
# ADR-0005 — Unified Four-Primitives and Developer Conceptual Model

Status: Accepted
Date: 2026-09-27
Raised by: architect

## Context
RailFog's original contracts used infrastructure names (Function, KV, Object, Queue) for both developer-facing APIs and internal runtime primitives. To prevent infrastructure leakage and formalize the four computational roles (Execute, Remember, Persist, Communicate), a developer layer of concepts (Compute, State, Data, Signal) is introduced.

## Decision
1. RailFog adopts a two-layer vocabulary: Developer Concept (Compute, State, Data, Signal) and Infrastructure Primitive (Function, KV, Object, Queue).
2. The developer layer is additive: existing SDK bindings (`kv`, `objects`, `queues`) remain canonical internally; `state`, `data`, `signal` are exposed as typed ergonomic aliases.
3. Web standard `AbortSignal` is protected: `c.req.signal` remains the request cancellation signal; queue communication is `c.signal.send()` (or `ctx.queues.send()`), avoiding naming collision.
4. `railfog.toml` accepts `state`, `data`, `signal` as validated aliases for `kv`, `objects`, `queues` under `[functions.<name>.permissions]`.

## Alternatives considered
- Renaming primitives breakingly: Rejected per Engineering Rule 6 & Spec §27 (do not introduce a breaking rewrite solely to rename concepts).
- Creating a unified `RailFogResource` object: Rejected per §24 (destroys semantic clarity, anti-slop violation).

## Consequences
- `docs/contracts/concepts.contract.md` created with clause IDs `CONCEPT-1` through `CONCEPT-8`.
- `schemas/railfog.schema.json` updated with permissive aliases.
- `@railfog/sdk` exports non-breaking aliases.

## Spec references
`CONCEPT-1` through `CONCEPT-8`, `PLAT-2`, `PLAT-6`, `FN-1`, `KV-1`, `OBJ-1`, `Q-1`
```

## Acceptance criteria (Given/When/Then)

1. Given `docs/adr/ADR-0005-unified-four-primitives.md`, when reviewed against `docs/adr/template.md`, then all required sections (Context, Decision, Alternatives considered, Consequences, Spec references) are present without missing fields.
2. Given the decision section, when verified against `AGENTS.md` Rule 3, then it explicitly protects existing APIs from breaking rewrites.
3. Given the Web API disambiguation clause, when checked, then `AbortSignal` collision risk is resolved.

## Tests required

- [x] Unit — ADR format and link linting (`tests/contract/adr_0005_test.ts`).
- [x] Integration — none.
- [x] Security — Security auditor verification of PLAT-6 capability scoping and AbortSignal decoupling.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Assumptions made

ADR-0005 is approved by the architect and serves as the architectural foundation for Milestone 0.9.1.
