# T-0922 — Align SDK Overview Documentation with Four Primitives

Status: Done
Milestone: 0.9.1 Unified Four-Primitives & SDK Specification
Depends on: T-0911, T-0915, T-0916
Blocks: T-0917

## Spec references

`CONCEPT-1`, `CONCEPT-2`, `CONCEPT-3`, `CONCEPT-4`, `CONCEPT-5`, `CONCEPT-6`, `CONCEPT-7`, `CONCEPT-8`

## Scope

**In scope**:
- Modify `docs/sdk/overview.md`:
  - Introduce the developer mental model: RailFog as four fundamental concepts — Compute, State, Data, Signal (CONCEPT-1).
  - Include the conceptual layer vs infrastructure layer mapping table (CONCEPT-2).
  - Document the four fundamental actions: Transform (Compute), Remember (State), Persist (Data), Communicate (Signal) (CONCEPT-3).
  - Provide concise, idiomatic code examples using both conceptual context getters (`c.state`, `c.data`, `c.signal`) and classic primitive bindings.
  - Clarify the separation between developer abstractions and infrastructure providers, documenting that existing names (`kv`, `objects`, `queues`) remain fully supported with zero breaking changes.
  - Document the distinction between asynchronous `c.signal` (`SignalBinding`) and WHATWG `c.req.signal` (`AbortSignal` for request cancellation).

**Out of scope**:
- Modifying other SDK guide docs (`context.md`, `reliability.md`, `errors.md`).
- Modifying `docs/contracts/` (handled in T-0911).

## Interface to implement

N/A (Markdown documentation)

## Acceptance criteria (Given/When/Then)

1. Given a developer reading `docs/sdk/overview.md`, when they examine the conceptual model, then they clearly understand the relationship between `Compute/State/Data/Signal` and `Function/KV/Object/Queue`.
2. Given code snippets in `docs/sdk/overview.md`, when tested, then all TypeScript snippets are syntactically valid against `@railfog/sdk` exports.
3. Given the documentation, when inspected, then it contains no AI slop, no dead code, and strictly adheres to anti-slop guidelines.

## Tests required

- [x] Unit — Markdown link verification and snippet type-checking.
- [ ] Integration — none.
- [ ] Security — none.

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

The documentation update is purely informational and introduces no breaking changes to SDK APIs.
