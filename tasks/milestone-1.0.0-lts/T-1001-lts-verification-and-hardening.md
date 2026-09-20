# T-1001 — Milestone 1.0.0 LTS Verification and Platform Hardening

Status: Done
Milestone: 1.0.0 LTS
Depends on: T-0812, T-0813, T-0814
Blocks: none

## Spec references

`PLAT-1`, `PLAT-2`, `PLAT-3`, `PLAT-4`, `PLAT-5`, `PLAT-6`, `PLAT-7`, `PLAT-8`,
`PLAT-9`, `PLAT-10`, `PLAT-11`, `PLAT-12`, `PLAT-13`, `PLAT-14`, `PLAT-15`,
`PLAT-16`, `PLAT-17`, `PLAT-18`, `PLAT-19`, `PLAT-20`,
`FN-1`, `FN-2`, `FN-3`, `FN-4`, `FN-5`, `FN-6`, `FN-7`, `FN-8`,
`KV-1`, `KV-2`, `KV-3`, `KV-4`, `KV-5`,
`OBJ-1`, `OBJ-2`, `OBJ-3`, `OBJ-4`,
`Q-1`, `Q-2`, `Q-3`, `Q-4`, `Q-5`, `Q-6`

## Scope

**In scope**:
- Verification of full repository test suite across unit, contract, security, integration, and e2e suites.
- Elimination of memory leaks, resource handles, and unclosed database handles in SQLite providers (`providers/kv/sqlite-provider.ts`, `providers/queues/sqlite-queue-provider.ts`).
- Rate limiting bucket memory management and pruning (`packages/policy/rate-limiter.ts`).
- Route matching performance optimization via URLPattern caching (`runtime/router/route-matcher.ts`).
- Micro-router route parameter extraction ergonomics (`sdk/typescript/wrapper.ts`).
- Ingress request payload ceiling enforcement (`apps/runtime/runtime-server.ts`).
- Developer experience polish and general help formatting (`cli/main.ts`).
- Full compliance with `deno check`, `deno lint`, `deno fmt --check`, and `deno test`.

**Out of scope**:
- Adding a fifth primitive (banned by `PLAT-2`, `PLAT-20`).
- Adding Kubernetes, service mesh, or canary traffic splitting (`PLAT-20`).
- Changing error code taxonomy (`PLAT-12`).

## Interface to implement

```typescript
export interface LtsReleaseVerification {
  version: string;
  contractsVerified: boolean;
  securityAudited: boolean;
  dxPolishVerified: boolean;
  totalTestsPassed: number;
}
```

## Acceptance criteria (Given/When/Then)

1. Given the complete RailFog codebase, when `deno check **/*.ts` is executed, then 0 errors are produced.
2. Given the complete RailFog codebase, when `deno lint` is executed, then 0 problems are reported across all files.
3. Given the complete RailFog codebase, when `deno fmt --check` is executed, then all files conform to formatting standards.
4. Given the entire test suite, when executed, all unit, contract, security, integration, and e2e tests pass without failure.
5. Given customer requests targeting parameterized routes, when matched by `api()`, then `c.params` provides named URL route parameters.
6. Given long-running rate limiter instances, when idle buckets exceed retention windows, then `prune()` reclaims memory without observable state drift.

## Tests required

- [x] Unit — `tests/unit/` (all 60+ unit test files passing)
- [x] Contract — `tests/contract/` (parity and repo structure passing)
- [x] Security — `tests/security/` (adversarial, isolation, zero secret leakage passing)
- [x] Integration — `tests/integration/` (backing services and auth passing)
- [x] E2E — `tests/e2e/` (public beta soak, cloud prototype, and UX/DX passing)

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
