# T-0502 — TypeScript SDK Client Adapters and Reliability Helpers

Status: Done
Milestone: 0.5 Developer Experience
Depends on: T-0501
Blocks: T-0509, T-0510, T-0511

## Spec references

`FN-4`, `KV-2`, `KV-3`, `OBJ-2`, `OBJ-3`, `Q-2`, `Q-4`, `Q-5`, `Q-6`, `PLAT-6`, `PLAT-12`

## Scope

**In scope**:
- `sdk/typescript/client.ts`: Typed client wrapper utilities adapting raw runtime bindings (`KVBinding`, `ObjectBinding`, `QueueBinding`) to SDK caller semantics with standard error normalization (mapping platform codes from `packages/errors` to typed errors).
- `sdk/typescript/helpers.ts`: Export standard library utility helpers for composed reliability patterns: `withIdempotency()` helper wrapping `kv` CAS/TTL deduplication (Q-4, Q-6) and `withRetry()` helper implementing decorrelated jitter backoff for idempotent operations (Q-5, Q-6).
- `sdk/typescript/client_test.ts`: Unit tests verifying error normalization, idempotency wrapper behavior with TTL, and decorrelated jitter retry execution.

**Out of scope**:
- Direct runtime provider implementations (providers live under `providers/`).
- Core capability injection resolution (lives under `packages/policy/permission-resolver.ts`).

## Interface to implement

```typescript
// sdk/typescript/helpers.ts

export interface IdempotencyOptions {
  ttlSeconds?: number; // Default: 14 * 24 * 3600 (14 days, max retention per Q-3, Q-4)
}

export function withIdempotency<T>(
  kv: KVBinding,
  dedupeKey: string[],
  action: () => Promise<T>,
  options?: IdempotencyOptions,
): Promise<{ processed: boolean; result?: T }>;

export interface RetryOptions {
  baseMs?: number;    // Default: 100 ms per Q-5
  capMs?: number;     // Default: 20000 ms (20 s) per Q-5
  maxAttempts?: number; // Default: 5 per Q-5
}

export function withRetry<T>(
  action: () => Promise<T>,
  options?: RetryOptions,
): Promise<T>;
```

## Acceptance criteria (Given/When/Then)

1. Given a Function using `withIdempotency` per `Q-4`, when executed the first time for a given key, then it runs `action()`, writes the dedupe marker with `ttl` set to retention window, and returns `{ processed: true, result }`.
2. Given a Function using `withIdempotency` per `Q-4`, when executed a second time with the same dedupe key before TTL expiration, then `action()` is skipped and it returns `{ processed: false }`.
3. Given a dedupe key written by `withIdempotency`, when checking options, then omitting TTL defaults to 14 days (`14 * 24 * 3600`), preventing unbounded dedupe key growth (Audit Finding #5, `KV-2`, `Q-4`).
4. Given `withRetry` per `Q-5`, when an operation fails transiently, then it retries up to `maxAttempts` (default 5) with exponential backoff and decorrelated jitter (`sleep_n = min(cap, random_uniform(base, sleep_(n-1) * 3))`).
5. Given `withRetry` per `Q-5`, when `maxAttempts` is exhausted, then it throws the underlying normalized platform error (`PLAT-12`).

## Tests required

- [x] Unit — `sdk/typescript/client_test.ts`: Test `withIdempotency` first-run success, dedupe suppression on second run, mandatory TTL enforcement, and `withRetry` backoff delay limits and max attempt exhaustion.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`KV-2`, `KV-3`, `Q-4`, `Q-5`, `Q-6`, `PLAT-12`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

## Assumptions made

None.

