# T-0709 — Centralize Unit Tests and Clean Obsolete Keep Files

Status: Complete
Milestone: 0.7 Repo Consolidation
Depends on: T-0701, T-0702, T-0703, T-0704, T-0705, T-0706, T-0707, T-0708
Blocks: T-0710

## Spec references

`PLAT-19`

## Scope

**In scope**:
- Relocating all collocated unit test files scattered across `apps/`, `cli/`, `packages/`, `primitives/`, `providers/`, and `runtime/` into `tests/unit/` per the repository structure defined in `PLAT-19`:
  - `apps/api/*_test.ts` -> `tests/unit/apps_api_*_test.ts`
  - `apps/gateway/*_test.ts` -> `tests/unit/apps_gateway_*_test.ts`
  - `apps/worker/*_test.ts` -> `tests/unit/apps_worker_*_test.ts`
  - `cli/*_test.ts` -> `tests/unit/cli_*_test.ts`
  - `packages/*/*_test.ts` -> `tests/unit/packages_*_test.ts`
  - `primitives/*/*_test.ts` -> `tests/unit/primitives_*_test.ts`
  - `providers/*/*_test.ts` -> `tests/unit/providers_*_test.ts`
  - `runtime/*/*_test.ts` -> `tests/unit/runtime_*_test.ts`
- Updating relative import paths in all relocated test files, adopting `@railfog/*` workspace aliases where appropriate.
- Removing obsolete `.gitkeep` placeholder files from directories that contain source code files.

**Out of scope**:
- Changing test assertions, test behaviors, or production code logic.
- Modifying contract tests in `tests/contract/`, security tests in `tests/security/`, or load/e2e tests in `tests/load/` and `tests/e2e/`.

## Interface to implement

none — this task defines no new interface (structural consolidation task).

## Acceptance criteria (Given/When/Then)

1. Given the relocated unit test files in `tests/unit/`, when running `deno task test:unit`, then all unit tests execute and pass with 100% success rate without import or path resolution errors.
2. Given populated directories across `apps/`, `packages/`, `primitives/`, `providers/`, and `runtime/`, when inspected, then no orphan `.gitkeep` files remain in directories containing TypeScript source files.
3. Given the complete test suite execution via `deno task test`, when executed, then all existing tests across the repository pass without degradation.

## Tests required

- [x] Unit — `tests/unit/`: Run complete relocated unit test suite to verify 100% passing tests and zero missing import errors.

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
