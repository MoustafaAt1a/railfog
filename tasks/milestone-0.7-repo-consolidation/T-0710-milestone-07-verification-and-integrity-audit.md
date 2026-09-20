# T-0710 — Milestone 0.7 Verification and Integrity Audit

Status: Complete
Milestone: 0.7 Repo Consolidation
Depends on: T-0701, T-0702, T-0703, T-0704, T-0705, T-0706, T-0707, T-0708, T-0709
Blocks: none

## Spec references

`PLAT-19`, `PLAT-20`

## Scope

**In scope**:
- `tests/contract/repo_structure_test.ts`: Comprehensive automated contract test suite validating:
  - Strict compliance with `PLAT-19` top-level directory layout (`apps/`, `packages/`, `primitives/`, `providers/`, `runtime/`, `sdk/`, `cli/`, `docs/`, `tests/`, `infra/`).
  - Package tree completeness (`packages/core`, `api`, `auth`, `config`, `errors`, `logging`, `metrics`, `policy`, `protocol`, `testing`).
  - Primitives completeness (`primitives/functions`, `kv`, `objects`, `queues`).
  - Providers completeness (`providers/compute`, `kv`, `objects`, `queues`).
  - Runtime module completeness (`runtime/api`, `sandbox`, `loader`, `limits`, `lifecycle`).
  - Absence of unmapped, orphaned, or unauthorized subdirectories violating `PLAT-19` or introducing `PLAT-20` prohibited scopes.
- Execution and verification of complete repo audit commands:
  - `deno test --allow-read --allow-write --allow-net --allow-run --allow-env` (100% pass)
  - `deno check **/*.ts` (0 errors)
  - `deno lint` (0 warnings)
  - `deno fmt --check` (0 formatting discrepancies)

**Out of scope**:
- Modifying contract files in `docs/contracts/` or ADRs.
- Introducing new architectural modules or changing existing business logic.

## Interface to implement

`tests/contract/repo_structure_test.ts`:

```typescript
// Contract test verifying directory tree and module boundaries against PLAT-19 and PLAT-20
Deno.test("PLAT-19: repository structure conforms to canonical specification", async () => {
  // Verifies all required apps, packages, primitives, providers, runtime modules, and tests subdirectories exist
});

Deno.test("PLAT-20: repository contains no prohibited submodules or scope creep", async () => {
  // Verifies no banned services (Kubernetes, active-active, custom DBs, third-party auth, UI dashboards)
});
```

## Acceptance criteria (Given/When/Then)

1. Given the RailFog repository file system, when `tests/contract/repo_structure_test.ts` runs, then it verifies every required directory from `PLAT-19` exists and contains valid source modules.
2. Given the repository directories, when checked against `PLAT-20`, then no prohibited submodules or out-of-scope services exist.
3. Given workspace verification commands (`deno check`, `deno lint`, `deno fmt --check`, `deno task test`), when executed across the entire repository, then all succeed with zero errors, zero warnings, and clean formatting.

## Tests required

- [x] Contract — `tests/contract/repo_structure_test.ts`: Automated validation of `PLAT-19` directory structure and `PLAT-20` scope boundaries.

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

None.

