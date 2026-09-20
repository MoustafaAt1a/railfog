# T-0410 — Provider resilient adapter and error normalizer

Status: Done
Milestone: 0.4 Reliability
Depends on: T-0104, T-0105, T-0106, T-0309, T-0401, T-0402
Blocks: T-0412

## Spec references

`PLAT-10` `PLAT-12` `PLAT-15` `PLAT-16` `Q-5`

## Scope

**In scope** (be exact — file/module/interface level, not a feature area):
- `providers/resilient/resilient-provider.ts`: implement provider decorator wrappers for `KVProvider`, `ObjectProvider`, and `QueueProvider` per PLAT-16 and `docs/CONSTITUTION.md` Boundary Rule:
  - Resilient retry wrapping: applies Q-5 decorrelated jitter retry (T-0401) to safe, idempotent provider operations (`kv.get`, `kv.list`, `objects.get`, `objects.head`, `objects.list`, `queue.receive`).
  - Circuit breaker integration: wraps provider operations with KV atomic circuit breaker (T-0402) to fast-fail when backing vendor error rate crosses threshold, protecting data-plane 99.95% SLO (PLAT-10).
  - Error normalization: intercepts arbitrary provider-specific network exceptions, HTTP status codes, and connection drops, mapping them strictly to canonical PLAT-12 error types:
    - 503 / network drops -> `UnavailableError` (`UNAVAILABLE`)
    - 429 / rate limits -> `RateLimitedError` (`RATE_LIMITED`)
    - 408 / socket timeouts -> `TimeoutError` (`TIMEOUT`)
    - 404 / missing keys -> `ResourceNotFoundError` (`RESOURCE_NOT_FOUND`)
    - CAS version mismatches -> `ConflictError` (`CONFLICT`)
    - Unclassified crashes -> `InternalError` (`INTERNAL`)
  - Secret redaction (PLAT-15): ensures normalized errors, retry logs, and diagnostic traces never contain authorization tokens, connection strings, or secret keys.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Retrying non-idempotent operations without explicit idempotency tokens (banned per Q-5).
- Introducing error codes outside the PLAT-12 table without an ADR.
- Bypassing the tenant prefix guard (T-0309).

## Interface to implement

```typescript
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type { QueueProvider } from "../../primitives/queues/queue-provider.ts";
import type { CircuitBreaker } from "../../packages/policy/circuit-breaker.ts";
import type { RetryPolicyOptions } from "../../packages/policy/retry.ts";

export interface ResilientProviderOptions {
  retryPolicy?: RetryPolicyOptions;
  circuitBreaker?: CircuitBreaker;
  sensitivePatterns?: RegExp[]; // additional secret patterns to redact (PLAT-15)
}

export function wrapResilientKv(
  provider: KVProvider,
  options?: ResilientProviderOptions,
): KVProvider;

export function wrapResilientObjects(
  provider: ObjectProvider,
  options?: ResilientProviderOptions,
): ObjectProvider;

export function wrapResilientQueues(
  provider: QueueProvider,
  options?: ResilientProviderOptions,
): QueueProvider;

export function normalizeProviderError(
  error: unknown,
  sensitivePatterns?: RegExp[],
): Error;
```

## Acceptance criteria (Given/When/Then)

1. Given a transient network glitch where `objects.get` fails twice with connection reset and succeeds on the 3rd attempt, when executed through `wrapResilientObjects`, then it retries using Q-5 decorrelated jitter and returns the object successfully.
2. Given a downstream provider returning HTTP 503 Service Unavailable, when intercepted by `normalizeProviderError`, then it produces a typed `UnavailableError` with code `UNAVAILABLE` per PLAT-12.
3. Given a vendor error containing `Bearer super-secret-key-12345`, when processed by `normalizeProviderError`, then the sensitive credential string is redacted to `[REDACTED]` and never surfaces in message or stack (PLAT-15).
4. Given repeated downstream provider failures exceeding the breaker threshold, when `wrapResilientKv` executes further calls, then the circuit breaker trips and subsequent calls fail fast with `UnavailableError`.
5. Given a non-idempotent operation that throws an error, when executed without an idempotency key, then it is not automatically retried and the normalized error is thrown immediately.

## Tests required

- [x] Unit — error normalization mapping for HTTP 404, 408, 429, 503, and network socket exceptions to PLAT-12 error classes
- [x] Unit — decorrelated jitter retry loop on idempotent provider read operations
- [x] Integration — circuit breaker tripping under provider outage and fast-failing subsequent calls
- [x] Security — verify error normalization and retry logs strictly auto-redact credentials, bearer tokens, and provider secrets (PLAT-15)

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches PLAT-15, PLAT-10, PLAT-16, Q-5)
- [x] Nothing outside "In scope" touched

## Assumptions made

- Error normalizer recursively sanitizes `Error.cause` chains, message strings, stack traces, and custom properties to prevent credential leakage (PLAT-15) while preserving causal error graphs and handling circular references via WeakSet.
- Default redaction covers standard token patterns (`Bearer ...`, `AWS4-HMAC-SHA256 ...`, `AKIA...`, `railfog_sec_...`, connection strings with credentials, and basic auth URLs).
- Idempotent provider read operations (`kv.get`, `kv.list`, `objects.get`, `objects.head`, `objects.list`, `queue.receive`) retry on transient errors (`UnavailableError`, `TimeoutError`) using Q-5 decorrelated jitter, while non-idempotent operations fail fast without automatic retries.
