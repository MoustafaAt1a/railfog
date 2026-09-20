# T-0307 — Per-invocation operation counters and call-depth guard

Status: Done
Milestone: 0.3 Security
Depends on: T-0102, T-0108
Blocks: T-0310, T-0311, T-0313

## Spec references

`FN-5` `FN-7` `PLAT-12`

## Scope

**In scope:**
- `runtime/limits/operation-counter.ts`:
  - Per-invocation operation counters matching the FN-5 limits table:
    - `kv` ops: max 1,000 ops per invocation. 1,001st op rejected with `RateLimitedError` (`429 RATE_LIMITED`).
    - `objects` ops: max 100 ops per invocation. 101st op rejected with `RateLimitedError` (`429 RATE_LIMITED`).
    - `queue` ops: max 100 ops per invocation. 101st op rejected with `RateLimitedError` (`429 RATE_LIMITED`).
    - `logs.bytes_per_invocation`: max 64,000 bytes. Truncate output exceeding 64,000 bytes and append `LOG_TRUNCATED` marker.
  - Call-depth guard per FN-7:
    - Parse, increment, and propagate `X-RailFog-Call-Depth` header on internal Function-to-Function invocations.
    - Reject requests exceeding `call_depth_max` (default 8) with `CallDepthExceededError` (`429 CALL_DEPTH_EXCEEDED` per PLAT-12).

**Out of scope:**
- Wall-clock timeout and payload size enforcement (T-0308).
- Request-level token bucket rate limiting (T-0302).
- Egress proxy connection concurrency limiting (T-0304).

## Interface to implement

```typescript
export interface InvocationOperationLimits {
  maxKvOps?: number; // default 1,000 (FN-5)
  maxObjectOps?: number; // default 100 (FN-5)
  maxQueueOps?: number; // default 100 (FN-5)
  maxLogBytes?: number; // default 64,000 (FN-5)
  maxCallDepth?: number; // default 8 (FN-5, FN-7)
}

export interface InvocationTracker {
  recordKvOp(): void; // throws RateLimitedError when > 1,000
  recordObjectOp(): void; // throws RateLimitedError when > 100
  recordQueueOp(): void; // throws RateLimitedError when > 100
  appendLog(chunk: string): { output: string; truncated: boolean };
  checkCallDepth(currentDepthHeader?: string): number; // throws CallDepthExceededError when > 8
}

export function createInvocationTracker(
  limits?: InvocationOperationLimits,
): InvocationTracker;
```

## Acceptance criteria (Given/When/Then)

1. Given an invocation executing KV operations, when the 1,001st KV operation is attempted, then it throws `RateLimitedError` (`429 RATE_LIMITED`) within that invocation.
2. Given an invocation executing Object or Queue operations, when the 101st operation is attempted, then it throws `RateLimitedError` (`429 RATE_LIMITED`).
3. Given a function emitting logs exceeding 64,000 bytes, when excess logs are emitted, then the output is truncated and suffixed with the `LOG_TRUNCATED` marker.
4. Given a request with header `X-RailFog-Call-Depth: 8`, when forwarded to the next internal hop (depth 9), then it is rejected with `CallDepthExceededError` (`429 CALL_DEPTH_EXCEEDED`).

## Tests required

- [x] Unit — counter threshold enforcement, exception throwing on limit breaches, log truncation at 64,000 bytes with `LOG_TRUNCATED` marker, call-depth parsing and incrementation
- [x] Integration — wrapping context bindings with invocation trackers under sequential operations
- [x] Security — recursion denial-of-wallet prevention via call-depth check; operation flood prevention rejecting unbounded storage operations (FN-5, FN-7)

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches FN-5, FN-7)
- [x] Nothing outside "In scope" touched

## Assumptions made

1. Counters reset per invocation and are never shared across invocations (FN-6).
2. Log truncation at the byte boundary preserves complete UTF-8 code points without splitting surrogate pairs or multi-byte sequences, appending `LOG_TRUNCATED_MARKER` immediately after the valid prefix.
3. `X-RailFog-Call-Depth` is strictly validated to non-negative decimal digits `/^\d+$/`, throwing `ValidationFailedError` on any non-integer or malformed formatting before depth comparison.
