# T-0925 — Deterministic Route Matcher Specificity & Param-Group Stability

Status: Done
Milestone: 0.9.2 Master Autonomous Engineering, Forensic Audit, Hardening & Productionization Gate
Depends on: none
Blocks: T-0928

## Spec references

`PLAT-11`

## Scope

**In scope**:
- `runtime/router/route-matcher.ts`
- Verifying and ensuring mathematical stability of `specificityScore()` and `matchRoute()` when dealing with URLPattern parameter groups, regex constraints, and exact declaration-order tie-breaking.

**Out of scope**:
- Altering the scoring formula `score = (literal * 2) + (wildcard_or_named * 1)`.
- Changing URLPattern integration.

## Interface to implement

```typescript
// runtime/router/route-matcher.ts
export function specificityScore(pattern: string): number;
export function matchRoute(routes: RouteConfig[], path: string): RouteConfig | null;
```

## Acceptance criteria (Given/When/Then)

1. Given routes with identical specificity scores matching a path, when `matchRoute()` is evaluated, then the first declared route in declaration order wins monotonically.
2. Given complex routes with regex parameters (e.g. `/users/:id(\\d+)`), when scored, then literal and variable segments are weighted strictly per PLAT-11.
3. Given routes with trailing slashes, query strings, or hash fragments, when evaluated, then matching behaves deterministically without cache poisoning.

## Tests required

- [x] Unit — `tests/unit/milestone_092_hardening_test.ts`

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-11`)
- [x] Spec-anchor comments present
- [x] Unit tests written and verified passing
- [x] `deno check` run, zero errors
- [x] `deno test` run, zero failures
- [x] `deno lint` run, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched

## Assumptions made

None.
