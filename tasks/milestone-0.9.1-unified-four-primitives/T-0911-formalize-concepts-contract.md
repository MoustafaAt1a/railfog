# T-0911 — Formalize Concepts Contract

Status: Done
Milestone: 0.9.1 Unified Four-Primitives & SDK Specification
Depends on: none
Blocks: T-0913, T-0914, T-0915, T-0916

## Spec references

`PLAT-2`, `PLAT-6`, `FN-1`, `FN-2`, `KV-1`, `OBJ-1`, `Q-1`

## Scope

**In scope**:
- Create `docs/contracts/concepts.contract.md` defining clauses `CONCEPT-1` through `CONCEPT-8`:
  - `CONCEPT-1`: Core four concepts (`Compute`, `State`, `Data`, `Signal`).
  - `CONCEPT-2`: Two-tier taxonomy (Developer layer vs. Infrastructure layer).
  - `CONCEPT-3`: Four fundamental verbs (`transform`, `remember`, `persist`, `communicate`).
  - `CONCEPT-4`: Composition-first principle & primitive addition test.
  - `CONCEPT-5`: Semantic honesty & provider independence.
  - `CONCEPT-6`: Conceptual capability mapping.
  - `CONCEPT-7`: Anti-proxy and zero-copy data reference model.
  - `CONCEPT-8`: Anti-framework boundary (no custom graph/workflow engines).
- Update `docs/glossary.md` to formally document the Developer-layer concepts mapped to Infrastructure-layer primitives.

**Out of scope**:
- Code changes in `runtime/` or `providers/`.
- Changing existing clauses in `functions.contract.md`, `kv.contract.md`, `objects.contract.md`, or `queues.contract.md`.

## Interface to implement

```markdown
# Contract — Concepts

## CONCEPT-1 — Four Fundamental Concepts
Compute, State, Data, Signal.

## CONCEPT-2 — Two-Layer Taxonomy
Developer Concept  | Infrastructure Primitive | Fundamental Role
Compute            | Function                 | Execute / Transform
State              | KV                       | Remember
Data               | Object                   | Persist
Signal             | Queue                    | Communicate

## CONCEPT-3 — Four Fundamental Verbs
Compute → transform
State   → remember
Data    → persist
Signal  → communicate

## CONCEPT-4 — Composition-First Principle & Addition Test
Applications emerge from composition. A fifth primitive is rejected unless composition cannot express it.

## CONCEPT-5 — Semantic Honesty
Never present a primitive as guaranteeing properties the underlying provider lacks.

## CONCEPT-6 — Conceptual Capability Scoping
Capabilities are declared and injected at the conceptual boundary.

## CONCEPT-7 — Data by Reference
Data operations preserve streaming and reference semantics, never proxying bulk bytes into memory.

## CONCEPT-8 — Anti-Framework Boundary
No workflow engines, schedulers, or distributed graph runtimes in the core SDK.
```

## Acceptance criteria (Given/When/Then)

1. Given `docs/contracts/concepts.contract.md`, when inspected by any agent, then every section has a formal clause ID (`CONCEPT-1` through `CONCEPT-8`).
2. Given `docs/glossary.md`, when checked, then `Compute`, `State`, `Data`, and `Signal` are defined as canonical developer-layer nouns mapped to `Function`, `KV`, `Object`, and `Queue`.
3. Given `docs/contracts/platform.contract.md` line 28 citing `CONCEPT-1`, when verified, then the referenced clause directly matches the definition in `concepts.contract.md`.

## Tests required

- [x] Unit — Contract link verification and glossary validation in test suite (`tests/contract/concepts_contract_test.ts`).
- [x] Integration — none.
- [x] Security — Security auditor verification of PLAT-6 capability scoping and banned patterns.

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

The existing `docs/contracts/platform.contract.md` reference to `concepts.contract.md CONCEPT-1` is canonical and ratified by this task.
