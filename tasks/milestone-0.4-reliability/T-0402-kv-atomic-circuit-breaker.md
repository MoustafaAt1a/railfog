# T-0402 — KV atomic circuit breaker library

Status: Done
Milestone: 0.4 Reliability
Depends on: T-0102, T-0104
Blocks: T-0410, T-0412

## Spec references

`Q-6` `KV-3` `KV-5` `PLAT-10`

## Scope

**In scope** (be exact — file/module/interface level, not a feature area):
- `packages/policy/circuit-breaker.ts`: implement a circuit breaker library pattern built entirely on `kv.atomic()` optimistic concurrency (KV-3, KV-5) without introducing any background service or fifth primitive (Q-6).
- State transitions:
  - `Closed`: calls execute normally; consecutive failures increment on error; transitions to `Open` when `consecutiveFailures >= failureThreshold` (default 5).
  - `Open`: fast-fails immediately with `UnavailableError` (`UNAVAILABLE` per PLAT-12); transitions to `Half-Open` once `cooldownMs` (default 30,000 ms) has elapsed.
  - `Half-Open`: allows trial executions; successful trials increment `consecutiveSuccesses`; transitions to `Closed` when `consecutiveSuccesses >= halfOpenSuccessThreshold` (default 2); any failure immediately returns state to `Open`.
- State updates executed atomically via `kv.atomic()` CAS checks; if CAS conflicts, re-reads and retries state transition without corrupting counters.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Background polling daemon or separate stateful breaker service (banned per Q-6).
- Wrapping specific storage/compute providers (T-0410).
- In-memory rate limiting (T-0302).
- Non-atomic check-then-set state mutations (violates KV-3).

## Interface to implement

```typescript
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";

export type CircuitState = "Closed" | "Open" | "Half-Open";

export interface CircuitBreakerOptions {
  failureThreshold?: number; // default 5
  cooldownMs?: number; // default 30000
  halfOpenSuccessThreshold?: number; // default 2
  nowProvider?: () => number; // for deterministic testing
}

export interface CircuitBreakerStateRecord {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastStateChangeEpochMs: number;
  version: number;
}

export interface CircuitBreaker {
  execute<T>(operation: () => Promise<T>): Promise<T>;
  getState(): Promise<CircuitBreakerStateRecord>;
  reset(): Promise<void>;
}

export function createCircuitBreaker(
  kv: KVProvider,
  circuitKey: string[],
  options?: CircuitBreakerOptions,
): CircuitBreaker;
```

## Acceptance criteria (Given/When/Then)

1. Given a new circuit breaker in `Closed` state, when an operation succeeds, then the operation result is returned and `consecutiveFailures` remains 0.
2. Given a circuit breaker in `Closed` state with `failureThreshold = 5`, when 5 consecutive operations fail, then the state atomically transitions to `Open` via `kv.atomic()` CAS and subsequent calls reject immediately with `UnavailableError` without invoking the operation.
3. Given a circuit breaker in `Open` state, when less than `cooldownMs` has elapsed, then calls fail fast with `UnavailableError` (`UNAVAILABLE` code).
4. Given a circuit breaker in `Open` state, when `cooldownMs` has elapsed, then the next call transitions the state to `Half-Open` and allows the trial execution.
5. Given a circuit breaker in `Half-Open` state with `halfOpenSuccessThreshold = 2`, when 2 trial calls succeed, then the state transitions to `Closed` and reset counters.
6. Given a circuit breaker in `Half-Open` state, when a trial call fails, then the state immediately transitions back to `Open`.
7. Given concurrent processes updating breaker state, when a CAS mismatch occurs during `kv.atomic()`, then the breaker re-reads and reapplies state updates without dropping failure counts.

## Tests required

- [x] Unit — state transition rules (Closed -> Open -> Half-Open -> Closed and Half-Open -> Open)
- [x] Unit — fast-fail rejection when Open, throwing UnavailableError with PLAT-12 code
- [x] Unit — CAS optimistic concurrency retry when kv.atomic() returns conflict
- [x] Integration — simulated downstream failure trips breaker, cooldown elapses, trial probe restores service

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
$ deno check packages/policy/circuit-breaker.ts packages/policy/circuit-breaker_test.ts
EXIT: 0

$ deno test packages/policy/circuit-breaker_test.ts
running 19 tests from ./packages/policy/circuit-breaker_test.ts
AC1 (Unit): Initial breaker state defaults to Closed with zeroed counters (Q-6, KV-3) ... ok (1ms)
AC1: Given new circuit breaker in Closed state, when operation succeeds, then result returned and consecutiveFailures remains 0 ... ok (800µs)
AC1: Multiple consecutive successful operations return results and preserve consecutiveFailures = 0 ... ok (1ms)
AC1: Successful operation resets non-zero consecutiveFailures counter in Closed state ... ok (3ms)
AC2 (Unit): Given Closed state, 5 consecutive failures trip breaker to Open via kv.atomic() CAS ... ok (3ms)
AC2 (Unit): Custom failureThreshold trips breaker at configured count ... ok (2ms)
AC3 & Checklist (2): Calls fast-fail immediately with UnavailableError (PLAT-12 UNAVAILABLE) during cooldown ... ok (1ms)
AC3: Fast-fail rejections do not increment failure counters (Assumptions clause) ... ok (1ms)
AC4 (Unit): When cooldownMs has elapsed, next call transitions to Half-Open and allows trial execution ... ok (2ms)
AC5 (Unit): Given Half-Open state with halfOpenSuccessThreshold = 2, 2 successful trials transition state to Closed ... ok (2ms)
AC5 (Unit): Custom halfOpenSuccessThreshold requires configured consecutive successes ... ok (3ms)
AC6 (Unit): Given Half-Open state, trial call failure immediately reverts state to Open ... ok (1ms)
AC7 & Checklist (3): Given CAS mismatch during kv.atomic(), breaker retries and reapplies state updates without dropping failure counts ... ok (2ms)
AC7: Concurrent failing operations on same circuit breaker record all failures atomically ... ok (29ms)
Checklist (1): Full state transition cycle Closed -> Open -> Half-Open -> Closed ... ok (7ms)
Checklist (1): State transition cycle Closed -> Open -> Half-Open -> Open (trial failure) ... ok (2ms)
Checklist (4) & AC2/3/4/5 (Integration): Downstream outage trips breaker, cooldown elapses, trial probe restores service ... ok (4ms)
CircuitBreaker.reset(): Manually resets Open breaker to Closed with zeroed counters ... ok (2ms)
Key isolation: Breakers with different circuitKeys operate independently on same KV store ... ok (1ms)

ok | 19 passed | 0 failed (107ms)
EXIT: 0

$ deno lint packages/policy/circuit-breaker.ts packages/policy/circuit-breaker_test.ts
Checked 2 files
EXIT: 0

$ deno fmt --check packages/policy/circuit-breaker.ts packages/policy/circuit-breaker_test.ts
Checked 2 files
EXIT: 0
```

## Assumptions made

- Key for circuit breaker state is namespaced under the caller-supplied `circuitKey` string array (e.g. `["circuit_breaker", "vendor_api"]`).
- When `kv.get(circuitKey)` returns null, the breaker initializes in `Closed` state with version 0.
- Operations that reject with `UnavailableError` generated by the breaker itself do not increment failure counters.
