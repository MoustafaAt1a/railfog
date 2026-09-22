# T-0903 — Type Strictness & Lint Hygiene Polish

Status: Done
Milestone: 0.9 Deep System Audit & Hardening
Depends on: none
Blocks: T-0905

## Spec references

`PLAT-19`, `docs/ANTI-SLOP.md`

## Scope

**In scope**:
- `tests/unit/features_enhancement_test.ts`: Eliminate `as any` casts and redundant expressions.
- `tests/unit/cli_ui_test.ts`: Remove unused import `renderModernTable`.
- `tests/unit/cli_spinner_test.ts`: Remove unused import `SPINNER_STYLES`.

**Out of scope**:
- Modifying test assertions or breaking existing test expectations.

## Interface to implement

None (internal hygiene and lint elimination).

## Acceptance criteria (Given/When/Then)

1. Given the entire RailFog codebase, when `deno lint` is executed, then 0 problems are reported across all 235+ files.
2. Given `tests/unit/features_enhancement_test.ts`, when checked, then no `any` types exist.

## Tests required

- [x] Lint — `deno lint`
- [x] Type check — `deno task check`

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] `deno check` run, zero errors
- [x] `deno lint` run, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated

## Assumptions made

None.
