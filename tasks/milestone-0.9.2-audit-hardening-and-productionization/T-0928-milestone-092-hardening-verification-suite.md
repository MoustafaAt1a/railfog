# T-0928 — Milestone 0.9.2 Forensic Hardening & Adversarial Verification Suite

Status: Done
Milestone: 0.9.2 Master Autonomous Engineering, Forensic Audit, Hardening & Productionization Gate
Depends on: T-0923, T-0924, T-0925, T-0926, T-0927
Blocks: none

## Spec references

`PLAT-5`, `PLAT-6`, `PLAT-11`, `PLAT-15`, `PLAT-19`

## Scope

**In scope**:
- `tests/unit/milestone_092_hardening_test.ts`
- Tests verifying SSRF blocking of RFC 6598 (`100.64.0.0/10`) and RFC 4193 (`fc00::/7`).
- Tests verifying static secret detection for `c.env.get` and `c.env.require`.
- Tests verifying routing specificity scoring and tie-breaking determinism.
- Tests verifying multi-tenant data isolation and anti-slop compliance.

**Out of scope**:
- Modifying existing unit or contract tests.

## Interface to implement

```typescript
// tests/unit/milestone_092_hardening_test.ts
// Test suite covering all Milestone 0.9.2 invariants.
```

## Acceptance criteria (Given/When/Then)

1. Given the verification suite, when `deno test tests/unit/milestone_092_hardening_test.ts` is executed, then all tests pass with zero failures.
2. Given the full verification command `deno task verify`, then all tasks pass cleanly.

## Tests required

- [x] Unit — `tests/unit/milestone_092_hardening_test.ts`
- [x] Security — `PLAT-5`, `PLAT-6`, `PLAT-15` adversarial verification

## Definition of Done

- [x] Comprehensive test suite implemented and passing
- [x] All cited clause IDs verified
- [x] `deno check` clean
- [x] `deno lint` clean
- [x] `deno fmt --check` clean
- [x] Full release gate succeeds

## Assumptions made

None.
