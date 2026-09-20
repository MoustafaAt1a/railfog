# T-0302 — Token bucket rate limiter

Status: Done
Milestone: 0.3 Security
Depends on: T-0102
Blocks: T-0313

## Spec references

`PLAT-9` `FN-5` `PLAT-12`

## Scope

**In scope:**
- `packages/policy/rate-limiter.ts`: implement token bucket rate limiting algorithm:
  - `tokens(t) = min(burst, tokens(t-1) + rate * Δt)`
  - Allow request iff `tokens >= 1`, then `tokens -= 1`
  - `Retry-After = ceil((1 - tokens) / rate)`
- Enforce the three scopes from PLAT-9:
  - Anonymous / IP: 10 req/s, burst 20
  - Identity (API token): 50 req/s, burst 100
  - Project: 200 req/s, burst 400
- Concurrency limit tracking per Function (`limits.concurrency`, default 50 per FN-5).
- Rejection handling: format rejection with machine-readable error code `RATE_LIMITED` (`429 RATE_LIMITED` per PLAT-12) and computed `Retry-After` header value.

**Out of scope:**
- Distributed multi-region or remote Redis rate limit synchronization (PLAT-8, PLAT-9 — local in-memory data-plane rate limiter for 1.0.0).
- Egress proxy network connection rate limiting (T-0304).
- Per-invocation storage operation counting (T-0307).

## Interface to implement

```typescript
export type RateLimitScope = "ip" | "identity" | "project";

export interface RateLimitTierConfig {
  rate: number;
  burst: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

export interface ConcurrencyResult {
  allowed: boolean;
  active: number;
}

export interface TokenBucketLimiter {
  consume(key: string, scope: RateLimitScope): RateLimitResult;
  acquireConcurrency(fnKey: string, maxConcurrency: number): ConcurrencyResult;
  releaseConcurrency(fnKey: string): void;
}
```

## Acceptance criteria (Given/When/Then)

1. Given a burst of 21 requests from the same IP within 1 second, when evaluated by the IP scope (rate: 10, burst: 20), then the first 20 requests are allowed and the 21st request is rejected with `allowed: false` and a non-zero `retryAfterSeconds`.
2. Given a rejected request with remaining tokens `< 1`, when `retryAfterSeconds` is calculated, then it strictly equals `Math.ceil((1 - tokens) / rate)`.
3. Given depleted tokens for a key, when elapsed time `Δt` passes, then tokens replenish according to `min(burst, tokens(t-1) + rate * Δt)`.
4. Given a Function with concurrency limit 50, when 50 concurrent calls are active and a 51st arrives, then `acquireConcurrency` returns `allowed: false`.
5. Given an active concurrent execution that completes, when `releaseConcurrency` is called, then the active concurrency count decrements and subsequent requests are permitted.

## Tests required

- [x] Unit — verify token replenishment math, burst boundary limits, fractional token accumulation, and ceiling calculation for `retryAfterSeconds` across IP, identity, and project tiers
- [x] Integration — verify concurrency acquire and release tracking under concurrent execution workflows

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

```
$ deno check packages/policy/rate-limiter.ts packages/policy/rate-limiter_test.ts
Check packages/policy/rate-limiter.ts
Check packages/policy/rate-limiter_test.ts
EXIT:0

$ deno test packages/policy/rate-limiter_test.ts
running 17 tests from ./packages/policy/rate-limiter_test.ts
PLAT-9: RATE_LIMIT_TIERS matches spec definitions exactly and adheres to tier interface ... ok (656µs)
AC1 (Unit): Burst of 21 requests from same IP evaluated by IP scope allows 20 and rejects 21st ... ok (418µs)
PLAT-9 (Unit): Identity scope burst boundary (rate: 50, burst: 100) ... ok (261µs)
PLAT-9 (Unit): Project scope burst boundary (rate: 200, burst: 400) ... ok (944µs)
AC2 (Unit): retryAfterSeconds strictly equals Math.ceil((1 - tokens) / rate) ... ok (494µs)
AC3 (Unit): Token replenishment formula tokens(t) = min(burst, tokens(t-1) + rate * Δt) ... ok (206µs)
AC3 (Unit): Fractional token accumulation requires >= 1 full token to allow request ... ok (163µs)
AC3 (Unit): Burst boundary limit caps replenishment at burst capacity ... ok (238µs)
PLAT-9 (Unit): Replenishment math across Identity and Project tiers ... ok (1ms)
PLAT-9 (Unit): Key and scope isolation ... ok (452µs)
AC4 (Unit): Concurrency limit 50 allows 50 active calls and rejects 51st ... ok (625µs)
AC5 (Unit): releaseConcurrency decrements active count and permits subsequent acquires ... ok (194µs)
FN-5 (Unit): Concurrency tracking underflow protection and function isolation ... ok (105µs)
FN-5 (Integration): Concurrency acquire/release tracking under concurrent execution workflows ... ok (25ms)
PLAT-12 / PLAT-9 (Unit): formatRateLimitRejection returns HTTP 429 Response with Retry-After header and RATE_LIMITED error code ... ok (13ms)
PLAT-12 / PLAT-9 (Unit): formatRateLimitRejection includes request_id when provided ... ok (688µs)
TokenBucketLimiter defaults to Date.now() when nowProvider is omitted ... ok (358µs)

ok | 17 passed | 0 failed (59ms)
EXIT:0

$ deno task test
ok | 320 passed | 0 failed (47s)
EXIT:0

$ deno task check
Task check deno check **/*.ts
...
Checked 63 files
EXIT:0

$ deno lint
Checked 63 files
EXIT:0

$ deno fmt --check
Checked 64 files
EXIT:0
```

## Assumptions made

- In-memory token bucket map with timestamp tracking per key (`${scope}:${key}`). Buckets initialize at burst capacity on first access.
- Concurrency tracking map stores active counts per `fnKey` and removes keys when active count decrements to 0 to prevent memory leak.
- Underflow is guarded (`releaseConcurrency` does not decrement below 0).
- Clock defaults to `Date.now` with optional `nowProvider` injection for deterministic testing.
