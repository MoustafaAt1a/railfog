# T-0401 — Decorrelated jitter retry engine

Status: Done
Milestone: 0.4 Reliability
Depends on: T-0102
Blocks: T-0408, T-0410, T-0412

## Spec references

`Q-5` `Q-4` `KV-3`

## Scope

**In scope** (be exact — file/module/interface level, not a feature area):
- `packages/policy/retry.ts`: implement exponential backoff with decorrelated jitter calculation per Q-5:
  - `sleep_0 = base`
  - `sleep_n = min(cap, random_uniform(base, sleep_(n-1) * 3))`
  - Default settings from Q-5 table: `base = 100 ms`, `cap = 20 s` (20,000 ms), `max_attempts = 5`.
- Function `isIdempotentRetryAllowed(method, headers)`: enforces the Q-5 idempotency rule:
  - Safe methods `GET` and `HEAD` are retry-eligible.
  - `PUT` requests carrying an `Idempotency-Key` header are retry-eligible.
  - Bare `POST` requests without an `Idempotency-Key` header are strictly rejected from automatic retries (Audit Finding #4, Q-5 banned pattern).
- Function `withRetry<T>(operation, options)`: drives retry execution loop up to `maxAttempts`, sleep calculation, and error rethrowing upon attempt exhaustion.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Queue consumer worker integration or visibility timeout coordination (T-0408).
- Provider-level error classification and wrapping (T-0410).
- Circuit breaker state tracking (T-0402).
- Fixed exponential backoff without jitter or infinite retry loops (strictly banned per Q-5).

## Interface to implement

```typescript
export interface RetryPolicyOptions {
  baseMs?: number; // default 100 (Q-5)
  capMs?: number; // default 20000 (Q-5)
  maxAttempts?: number; // default 5 (Q-5)
  randomUniform?: (min: number, max: number) => number; // injected RNG for deterministic tests
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export interface RetryState {
  attempt: number;
  lastSleepMs: number;
}

export function calculateNextSleep(
  state: RetryState,
  options?: RetryPolicyOptions,
): number;

export function isIdempotentRetryAllowed(
  method: string,
  headers?: Headers | Record<string, string>,
): boolean;

export function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options?: RetryPolicyOptions,
): Promise<T>;
```

## Acceptance criteria (Given/When/Then)

1. Given attempt 0, when `calculateNextSleep` is called with default options, then it returns exactly `100` ms (`sleep_0 = base`).
2. Given attempt `n > 0` with `lastSleepMs = 300`, when `calculateNextSleep` is evaluated with `randomUniform` returning 0.5, then the sleep duration equals `min(20000, 100 + 0.5 * (900 - 100)) = 500` ms, strictly within `[base, lastSleepMs * 3]`.
3. Given sleep calculations where `lastSleepMs * 3` exceeds 20,000 ms, when `calculateNextSleep` is evaluated, then the output never exceeds `capMs` (20,000 ms).
4. Given an HTTP request method `POST` without an `Idempotency-Key` header, when `isIdempotentRetryAllowed` is evaluated, then it returns `false`.
5. Given an HTTP request method `GET`, `HEAD`, or `PUT` with `Idempotency-Key`, when `isIdempotentRetryAllowed` is evaluated, then it returns `true`.
6. Given an operation that fails 5 consecutive times, when executed with `withRetry`, then it attempts exactly 5 times and throws the final error without infinite looping.

## Tests required

- [x] Unit — calculateNextSleep math verification across attempts 0 through 5, cap boundary enforcement, and deterministic RNG bounds
- [x] Unit — isIdempotentRetryAllowed verification for GET, HEAD, PUT with and without Idempotency-Key, and bare POST rejection
- [x] Unit — withRetry attempt counting, cancellation on non-retryable error, and final error surfacing after 5 attempts
- [x] Integration — withRetry async delay timing with fake timers

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
$ deno check packages/policy/retry.ts packages/policy/retry_test.ts
EXIT: 0

$ deno test packages/policy/retry_test.ts
running 21 tests from ./packages/policy/retry_test.ts
AC1 (Q-5): Given attempt 0, calculateNextSleep returns base (100ms default) ... ok (974µs)
AC2 (Q-5): Given attempt n > 0 with lastSleepMs = 300 and randomUniform 0.5, returns 500 ms ... ok (138µs)
AC3 (Q-5): Given lastSleepMs * 3 exceeding capMs, calculateNextSleep never exceeds capMs ... ok (93µs)
Tests Required 1: calculateNextSleep math verification across attempts 0 through 5 with deterministic RNG ... ok (347µs)
Tests Required 1: calculateNextSleep stochastic bounds with default Math.random generator ... ok (1ms)
calculateNextSleep: Handles edge cases where lastSleepMs is smaller than baseMs ... ok (399µs)
AC4 (Q-5): Given HTTP POST without Idempotency-Key, isIdempotentRetryAllowed returns false ... ok (3ms)
AC5 (Q-5): Given HTTP GET, HEAD, or PUT with Idempotency-Key, isIdempotentRetryAllowed returns true ... ok (414µs)
Tests Required 2: isIdempotentRetryAllowed PUT verification with and without Idempotency-Key ... ok (341µs)
Tests Required 2: isIdempotentRetryAllowed POST with Idempotency-Key is allowed ... ok (176µs)
isIdempotentRetryAllowed: Case-insensitive header lookup for Headers and plain Record ... ok (658µs)
isIdempotentRetryAllowed: Empty or whitespace-only Idempotency-Key is rejected ... ok (99µs)
isIdempotentRetryAllowed: Non-idempotent methods (PATCH, DELETE) without key return false ... ok (82µs)
withRetry: Returns value immediately on first successful attempt ... ok (238µs)
withRetry: Resolves after transient failures within maxAttempts ... ok (39ms)
AC6 (Q-5): Given operation failing 5 consecutive times, attempts exactly 5 times and throws final error ... ok (63ms)
Tests Required 3: withRetry custom maxAttempts boundary enforcement ... ok (31ms)
Tests Required 3: withRetry cancellation on shouldRetry returning false ... ok (15ms)
withRetry: Preserves error identity, custom properties, and async rejections ... ok (14ms)
Tests Required 4: withRetry async delay timing with fake/mock timers ... ok (46ms)
Integration (ANTIHALLUCINATION Rule 5): withRetry real elapsed time verification ... ok (27ms)

ok | 21 passed | 0 failed (268ms)
EXIT: 0

$ deno lint packages/policy/retry.ts packages/policy/retry_test.ts
Checked 2 files
EXIT: 0

$ deno fmt --check packages/policy/retry.ts packages/policy/retry_test.ts
Checked 2 files
EXIT: 0
```

## Assumptions made

- `Headers` Web API instance and plain `Record<string, string>` are both accepted by `isIdempotentRetryAllowed` to support standard Request objects as well as raw config headers.
- Header lookup is case-insensitive per HTTP specifications (`idempotency-key` vs `Idempotency-Key`).
- When `randomUniform` is not provided, defaults to `Math.random() * (max - min) + min`.
