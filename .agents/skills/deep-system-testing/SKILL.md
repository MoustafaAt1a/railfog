---
name: deep-system-testing
description: Use when designing, executing, or automating exhaustive tests across unit, integration, contract, security, load, and e2e boundaries in RailFog. Enforces case-by-case boundary analysis, race condition detection, fault injection, leak detection, and deterministic verification without flaky mocks.
---

# Deep System Testing

Comprehensive testing methodology for the RailFog platform. Enforces rigorous,
line-by-line, case-by-case testing across all four primitives (Functions, KV,
Objects, Queues), runtime sandbox, control plane, CLI, and SDK.

Every test must exercise real behavior and verify contract guarantees directly
against `docs/contracts/*.md`.

## Testing Matrix & Boundary Checklist

### 1. Contract & Boundary Limits (Line-by-Line)
- [ ] **KV limits**: verify 512-byte key max and 32 segment max (`KV-4`),
      256 KB value max (`KV-1`), linearizable CAS versioning (`KV-3`), mandatory
      TTL on idempotency dedupe keys (`KV-2`, `Q-4`, Audit Finding #5).
- [ ] **Objects limits**: verify 100 MB single object max (`OBJ-1`), streaming
      body uploads without buffering in memory, ETag format (`sha256-...`),
      content-type preservation, and range requests (`OBJ-2`).
- [ ] **Queues limits**: verify 64 KB payload max (`Q-1`), at-least-once delivery,
      visibility timeout with dead-letter queue routing (`Q-3`), exponential backoff
      with decorrelated jitter (`Q-5`, Audit Finding #4), and deduplication (`Q-4`).
- [ ] **Functions limits**: verify 15-minute maximum execution timeout (`FN-2`),
      call depth limit capped at 10 (`FN-7`), scoped capability injection
      without global leak (`FN-4`, `PLAT-6`), and cold vs warm isolate
      isolation (`FN-6`).
- [ ] **Routing specificity**: verify PLAT-11 specificity scoring algorithm
      (exact > parameterized > wildcard) under duplicate or overlapping route tables.
- [ ] **Error taxonomy**: verify PLAT-12 error normalization across all 10 error
      codes (`RESOURCE_NOT_FOUND`, `PERMISSION_DENIED`, `VALIDATION_FAILED`,
      `RATE_LIMITED`, `TIMEOUT`, `PAYLOAD_TOO_LARGE`, `CONFLICT`, `UNAVAILABLE`,
      `INTERNAL`, `CALL_DEPTH_EXCEEDED`), ensuring `x-request-id` is returned in
      both header and JSON body with valid ULID format (`PLAT-14`).

### 2. Concurrency, Race Conditions & State
- [ ] **Optimistic concurrency**: test parallel CAS mutations on the same KV key
      to ensure exactly one succeeds and the other receives `CONFLICT` (`KV-3`).
- [ ] **Worker concurrency**: verify concurrent queue consumers process distinct
      messages without duplicate execution or race conditions under high throughput.
- [ ] **Idempotency locks**: verify simultaneous concurrent executions with the
      same idempotency key only execute once (`Q-4`).
- [ ] **Database connection pools**: verify SQLite WAL mode and Postgres connection
      pool handling under peak concurrent request load.

### 3. Security, Leakage & Defense in Depth
- [ ] **Zero credential leakage**: verify authorization tokens, database URLs,
      and secrets are never printed to console, logs, error responses, or test traces
      (`PLAT-15`).
- [ ] **Capability containment**: verify functions cannot access undeclared
      resources or environment variables (`PLAT-5`, `PLAT-6`).
- [ ] **Network policy**: verify SSRF blocking on loopback, link-local, and internal
      metadata IP addresses (`PLAT-5`).
- [ ] **Tenant isolation**: verify multi-tenant prefixes `{org_id}/{project_id}`
      cannot be escaped or traversed (`PLAT-7`, `KV-4`, `OBJ-4`).

### 4. Resource Lifecycle & Leak Detection
- [ ] **File descriptors & connections**: verify all opened SQLite databases,
      TCP sockets, and HTTP servers close cleanly during test teardown.
- [ ] **Subprocess cleanup**: verify child processes spawned during CLI or
      sandbox tests are killed and reaped deterministically.
- [ ] **Memory & heap stability**: verify tests with large payload iterations
      do not accumulate unbounded memory in buffers or caches.

## Non-goals

- Writing production runtime code (owned by `implementer`).
- Modifying architecture or changing spec contracts (owned by `architect`).
- Speculative test assertions that do not map to `docs/contracts/*.md`.
