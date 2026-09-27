# T-0924 — Pre-Deploy Diagnostic Scanner Context Ergonomics

Status: Done
Milestone: 0.9.2 Master Autonomous Engineering, Forensic Audit, Hardening & Productionization Gate
Depends on: none
Blocks: T-0928

## Spec references

`PLAT-6`, `PLAT-15`

## Scope

**In scope**:
- `packages/core/diagnostics/deploy-analyzer.ts`
- Updating `SECRET_ACCESS_REGEX` to support `c.env.get(...)` and `c.env.require(...)` in addition to `ctx.env` and `Deno.env`.

**Out of scope**:
- Modifying AST brace-counting DFA state machine.
- Modifying health check diagnostic analysis.
- Altering CLI check exit codes.

## Interface to implement

```typescript
// packages/core/diagnostics/deploy-analyzer.ts
// Expanded SECRET_ACCESS_REGEX matching c.env, ctx.env, and Deno.env:
const SECRET_ACCESS_REGEX: RegExp;
```

## Acceptance criteria (Given/When/Then)

1. Given a function source referencing secrets via `c.env.get("API_KEY")` or `c.env.require("API_KEY")`, when pre-deploy diagnostic scanning is executed, then `API_KEY` is extracted as a referenced secret.
2. Given a function source referencing secrets via `ctx.env.get("SECRET")` or `Deno.env.get("SECRET")`, when scanned, then `SECRET` is extracted.
3. Given undeclared secrets referenced via `c.env`, when scanned against declared permissions, then an error diagnostic is reported.

## Tests required

- [x] Unit — `tests/unit/milestone_092_hardening_test.ts`
- [x] Security — `PLAT-6`, `PLAT-15` static analysis validation

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-6`, `PLAT-15`)
- [x] Spec-anchor comments present at decision points
- [x] Unit tests written and verified passing
- [x] `deno check` run, zero errors
- [x] `deno test` run, zero failures
- [x] `deno lint` run, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched

## Assumptions made

None. SDK handlers canonicalize on `c` (`HandlerContext`).
