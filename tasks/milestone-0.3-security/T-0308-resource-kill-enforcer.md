# T-0308 — Resource kill enforcer and payload limits

Status: Done
Milestone: 0.3 Security
Depends on: T-0102, T-0108
Blocks: T-0310, T-0311, T-0313

## Spec references

`FN-5` `PLAT-12`

## Scope

**In scope:**
- `runtime/limits/kill-enforcer.ts`:
  - Hard wall-clock timeout enforcement: abort execution and hard kill at `deadline` (default 30,000ms for HTTP, 900,000ms for queue and schedule triggers per FN-5) with `TimeoutError` (`504 TIMEOUT` per PLAT-12).
  - CPU time limit enforcement: trigger hard kill when consumed CPU time >= `cpu_ms` (default 200ms per FN-5), independent of wall clock.
  - Request body size limit: max 10MB; reject with `PayloadTooLargeError` (`413 PAYLOAD_TOO_LARGE` per PLAT-12).
  - Response body size limit: max 10MB buffered; streamed responses exempt from full buffering but capped at 512MB total emitted bytes; abort with `PayloadTooLargeError` (`413 PAYLOAD_TOO_LARGE`).

**Out of scope:**
- Token bucket rate limiting (T-0302).
- Per-invocation storage and log counters (T-0307).
- OS cgroup setup and Linux kernel namespaces (T-0311, T-0312).

## Interface to implement

```typescript
export interface ResourceKillOptions {
  timeoutMs: number; // default 30,000 (HTTP) or 900,000 (Queue/Schedule)
  cpuMs: number; // default 200
  maxRequestBodyBytes?: number; // default 10 * 1024 * 1024 (10MB)
  maxResponseBodyBytes?: number; // default 10 * 1024 * 1024 (10MB)
  maxStreamedBytes?: number; // default 512 * 1024 * 1024 (512MB)
}

export interface KillEnforcer {
  createAbortController(): { signal: AbortSignal; cleanup(): void };
  validateRequestBody(
    contentLength?: number,
    bodyStream?: ReadableStream<Uint8Array>,
  ): Promise<Uint8Array>;
  wrapResponseStream(
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<Uint8Array>;
  checkCpuLimit(cpuTimeMs: number): void; // throws TimeoutError if cpuTimeMs >= limit
}

export function createKillEnforcer(options: ResourceKillOptions): KillEnforcer;
```

## Acceptance criteria (Given/When/Then)

1. Given an HTTP invocation that executes past its deadline (30,000ms default), when the timer expires, then the execution signal is aborted and a `TimeoutError` (`504 TIMEOUT`) is emitted.
2. Given a request body exceeding 10 MB (e.g. 10.5 MB), when validated, then it is rejected immediately with `PayloadTooLargeError` (`413 PAYLOAD_TOO_LARGE`).
3. Given a streamed response emitting more than 512 MB, when the 512 MB ceiling is reached, then the stream is aborted with `PayloadTooLargeError`.
4. Given a measured CPU time >= `limits.cpuMs` (200ms), when checked, then it triggers a hard kill with `TimeoutError` independent of wall-clock duration.

## Tests required

- [x] Unit — timer cancellation, signal propagation, byte-counting transform streams, and CPU threshold evaluation
- [x] Integration — end-to-end payload size rejection on HTTP requests and streaming responses

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass not triggered (FN-5/PLAT-12 in scope; PLAT-4/5/6/7/15, FN-6/7 untouched)
- [x] Nothing outside "In scope" touched

## Assumptions made

Consumed CPU time is measured via isolate execution metrics or process user/system time reporting.
For streaming responses, wrapping via a ReadableStream pull/cancel delegate ensures upstream source stream cancellation executes cleanly and synchronously upon byte limit violation without relying on microtask resolution delays.
