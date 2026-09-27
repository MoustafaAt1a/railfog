# T-0917 — Implement Milestone 0.9.1 Composition Verification Suite

Status: Done
Milestone: 0.9.1 Unified Four-Primitives & SDK Specification
Depends on: T-0911, T-0912, T-0913, T-0914, T-0915, T-0916, T-0918, T-0919, T-0920, T-0921, T-0922
Blocks: none

## Spec references

`PLAT-6`, `PLAT-7`, `CONCEPT-1`, `CONCEPT-2`, `CONCEPT-3`, `CONCEPT-4`, `CONCEPT-5`, `CONCEPT-6`, `CONCEPT-7`

## Scope

**In scope**:
- Author `tests/unit/milestone_091_concepts_test.ts`:
  - Test all six fundamental composition pathways defined in `concepts.contract.md#CONCEPT-4`:
    1. `Compute → State` (handler remembers state via CAS atomic operations)
    2. `Compute → Data` (handler persists binary payload by streaming reference)
    3. `Compute → Signal` (handler emits asynchronous work message)
    4. `Signal → Compute` (consumer triggered by queue message processing)
    5. `Data → Compute` (handler reads binary payload and processes)
    6. `State → Compute` (handler checks state for branching / circuit breaker)
  - Verify that `railfog.toml` permissive schema accepts `state`, `data`, and `signal`.
  - Verify that `packages/policy/permission-resolver.ts` normalizes conceptual aliases into scoped bindings without leaks.
  - Verify that `packages/core/artifact/packager.ts` and `cli/check.ts` enforce single-scoping and mutual exclusivity across capabilities.
  - Verify that `@railfog/sdk` exposes `StateBinding`, `DataBinding`, `SignalBinding`, `ComputeHandler`, and context getters (`c.state`, `c.data`, `c.signal`).
- Update `tasks/00-roadmap.md` to record Milestone 0.9.1 as decomposed.

**Out of scope**:
- Stress testing or benchmarking (covered by Milestone 1.0.0 LTS).
- Modifying production runtime daemon code.

## Interface to implement

```typescript
// Test assertions validating the 6 composition patterns and semantic honesty
Deno.test("Milestone 0.9.1 - Composition: Compute -> State");
Deno.test("Milestone 0.9.1 - Composition: Compute -> Data");
Deno.test("Milestone 0.9.1 - Composition: Compute -> Signal");
Deno.test("Milestone 0.9.1 - Composition: Signal -> Compute");
Deno.test("Milestone 0.9.1 - Composition: Data -> Compute");
Deno.test("Milestone 0.9.1 - Composition: State -> Compute");
Deno.test("Milestone 0.9.1 - Policy: Declared conceptual aliases normalized correctly");
Deno.test("Milestone 0.9.1 - SDK: Context getters provide non-breaking access");
Deno.test("Milestone 0.9.1 - Security: Cross-tenant isolation with conceptual aliases (PLAT-7)");
Deno.test("Milestone 0.9.1 - Security: Mutual exclusivity rejects dual declaration across pipeline (PLAT-6)");
```

## Acceptance criteria (Given/When/Then)

1. Given the 6 canonical composition combinations, when executed in test harnesses using conceptual names, then each composition behaves reliably and deterministically without requiring a fifth primitive.
2. Given a function configured with `permissions = { state = ["app:test"] }`, when evaluated through the policy resolver and SDK mock context, then `c.state.get` operates on `"app:test"` with correct scoping.
3. Given `deno test tests/unit/milestone_091_concepts_test.ts`, when executed, then all tests pass with 100% success rate.
4. Given two tenants declaring identical conceptual resource names (e.g. `state = ["session"]`), when resolved with distinct `org_id`/`project_id`, then their prefix keys remain strictly partitioned with zero leakage (PLAT-7).

## Tests required

- [x] Unit — Complete composition and alias verification suite in `tests/unit/milestone_091_concepts_test.ts`.
- [x] Integration — End-to-end trigger-to-function composition flow.
- [x] Security — Multi-tenant collision resistance test (`PLAT-7`) and structural inexpressibility test proving that dual declarations (`kv` + `state`) are rejected across schema, packager, CLI check, and permission resolver (`PLAT-6`).

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

The test suite runs against the local in-memory/SQLite mock providers without requiring cloud connectivity.
