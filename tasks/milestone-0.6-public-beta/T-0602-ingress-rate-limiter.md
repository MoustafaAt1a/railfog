# T-0602 — Multi-Tenant Token Bucket Rate Limiter

Status: Done
Milestone: 0.6 Public Beta
Depends on: T-0102, T-0308
Blocks: T-0604, T-0609, T-0611

## Spec references

`PLAT-9`, `PLAT-12`, `PLAT-18`

## Scope

**In scope**:
- `apps/gateway/rate-limiter.ts`: High-performance in-memory token bucket rate limiter implementing the exact algorithm from `docs/contracts/platform.contract.md` PLAT-9 across Anonymous/IP, Identity (API token), and Project scopes.
- `apps/gateway/rate-limiter_test.ts`: Unit tests verifying token replenishment, burst capacity, scope isolation, and exact `Retry-After` calculation.

**Out of scope**:
- Ingress HTTP server socket listener (handled in T-0604).
- Distributed cluster cache / external Redis cluster (banned per `PLAT-20`).
- Function concurrency throttling (already implemented in `runtime/limits/` via `FN-5`).

## Interface to implement

```typescript
export type RateLimitScope = "ip" | "identity" | "project";

export interface RateLimitBucketConfig {
  rate: number; // tokens per second
  burst: number; // maximum burst capacity
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetMs: number;
  retryAfterSeconds?: number;
}

export const DEFAULT_RATE_LIMITS: Record<RateLimitScope, RateLimitBucketConfig> = {
  ip: { rate: 10, burst: 20 },
  identity: { rate: 50, burst: 100 },
  project: { rate: 200, burst: 400 },
};

export class MultiTenantRateLimiter {
  constructor(customConfigs?: Partial<Record<RateLimitScope, RateLimitBucketConfig>>);
  check(scope: RateLimitScope, key: string, now?: number): RateLimitDecision;
  reset(scope: RateLimitScope, key: string): void;
  prune(maxIdleMs?: number, now?: number): number;
}
```

## Acceptance criteria (Given/When/Then)

1. Given a series of requests arriving at rate $\le$ bucket rate, when `check` is called, then it returns `allowed: true` with `remaining` matching the remaining tokens.
2. Given burst requests exceeding the burst ceiling for Anonymous/IP (burst: 20), Identity (burst: 100), or Project (burst: 400), when the $(burst+1)$-th request arrives, then it returns `allowed: false` with integer `retryAfterSeconds` calculated as $\lceil(1 - tokens) / rate\rceil$ per `PLAT-9`.
3. Given an exhausted bucket, when elapsed time $\Delta t$ passes, then available tokens replenish according to $min(burst, tokens(t-1) + rate \times \Delta t)$ per `PLAT-9`.
4. Given multiple distinct clients or projects submitting requests concurrently, when checked, then each scope key maintains an isolated bucket without cross-tenant bleed per `PLAT-18`.
5. Given stale buckets that have been inactive beyond `maxIdleMs`, when `prune` is invoked, then idle bucket records are reclaimed to prevent unbounded memory growth.

## Tests required

- [x] Unit — `apps/gateway/rate-limiter_test.ts`: Test bucket depletion, burst absorption, token refill math, `Retry-After` formula, and multi-tenant key isolation.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-9`, `PLAT-12`, `PLAT-18`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

### Verification Outputs

```
$ deno check apps/gateway/rate-limiter.ts apps/gateway/rate-limiter_test.ts
(clean exit code 0, zero errors)
```

```
$ deno test -A apps/gateway/rate-limiter_test.ts
running 15 tests from ./apps/gateway/rate-limiter_test.ts
PLAT-9: DEFAULT_RATE_LIMITS matches exact spec configuration for all scopes ... ok (880µs)
AC1 / PLAT-9 (Unit): Initial request on fresh bucket consumes 1 token and returns remaining = burst - 1 ... ok (330µs)
AC1 / PLAT-9 (Unit): Consecutive checks consume exactly 1 token per check up to burst limit ... ok (1ms)
AC2 / PLAT-9 (Unit): Depleted bucket rejects (burst + 1)-th request with allowed: false ... ok (751µs)
AC2 / PLAT-9 (Unit): Retry-After strictly equals Math.ceil((1 - tokens) / rate) across scopes and fractional tokens ... ok (883µs)
AC3 / PLAT-9 (Unit): Tokens replenish according to min(burst, tokens(t-1) + rate * delta_t) ... ok (413µs)
AC3 / PLAT-9 (Unit): Fractional token accumulation requires >= 1 full token to allow request ... ok (273µs)
AC3 / PLAT-9 (Unit): Refilled tokens are capped at burst capacity and never exceed it ... ok (228µs)
AC3 / PLAT-9 (Unit): check() defaults to system clock when now parameter is omitted ... ok (418µs)
AC4 / PLAT-18 (Unit): Distinct keys within the same scope have isolated buckets ... ok (1ms)
AC4 / PLAT-18 (Unit): Same key under different scopes is completely isolated ... ok (346µs)
AC5 / PLAT-9 (Unit): prune(maxIdleMs, now) removes buckets inactive longer than maxIdleMs ... ok (3ms)
AC5 / PLAT-9 (Unit): prune() without arguments executes safely and returns non-negative count ... ok (455µs)
PLAT-9 (Unit): MultiTenantRateLimiter accepts custom bucket configs and preserves defaults for omitted scopes ... ok (259µs)
PLAT-9 (Unit): reset(scope, key) resets bucket state immediately ... ok (215µs)

ok | 15 passed | 0 failed (30ms)
```

```
$ deno lint apps/gateway/rate-limiter.ts apps/gateway/rate-limiter_test.ts
Checked 2 files
(clean exit code 0, zero warnings)
```

## Assumptions made

None.
