# T-0106 — QueueProvider interface + local SQLite implementation

Status: Done
Milestone: 0.1 Runtime Prototype
Depends on: T-0101, T-0102, T-0103
Blocks: T-0107, T-0111

## Spec references

`Q-1` `Q-2` `Q-3` `PLAT-16` `PLAT-17`

## Scope

**In scope:**
- `primitives/queues/queue-provider.ts`: `QueueProvider` interface
  (PLAT-16 shape: `send`, `sendBatch`, `receive`, `ack`).
- `providers/queues/sqlite-queue-provider.ts`: local implementation
  including the full redelivery state machine from Q-3 (visibility timeout,
  max_receives, DLQ) — this is not optional "polish," it's the contract.
- `delay` support on `send` (Q-2), capped at 900s; reject longer delays with
  `VALIDATION_FAILED` and a message pointing at using a schedule trigger
  instead (functions.contract.md FN-2) — don't silently clamp the value.

**Out of scope:**
- Any remote provider (`CloudflareQueuesProvider` — 0.2).
- The idempotent-consumer pattern (Q-4) — that's Function-author code written
  on top of KV, not part of the provider itself; do not bake dedupe logic
  into the queue provider.
- Backoff/jitter retry timing (Q-5) — that governs *caller* retry behavior
  around calling the platform API, not the provider's internal redelivery
  clock, which uses the fixed defaults in Q-3.

## Interface to implement

```typescript
interface QueueMessage { id: string; body: unknown; attempts: number; }
interface QueueProvider {
  send(body: unknown, opts?: { delay?: number }): Promise<{ id: string }>;
  sendBatch(bodies: unknown[]): Promise<{ id: string }[]>;
  receive(opts?: { visibilityTimeoutMs?: number }): Promise<QueueMessage | null>;
  ack(id: string): Promise<void>;
}
```

## Acceptance criteria

1. Given a message received but not acked, when `visibility_timeout_ms`
   (default 30000) elapses, then it becomes receivable again with
   `attempts` incremented (Q-3).
2. Given a message that reaches `max_receives` (default 5) without being
   acked, when received again, then it is routed to the dead-letter queue
   instead of redelivered (Q-3) — verify via a real DLQ inspection API, not
   an assumption.
3. Given `send(body, { delay: 901 })`, when called, then it throws
   `VALIDATION_FAILED` (Q-2's 900s cap).
4. Given a payload over 128 KB, when sent, then it throws
   `PAYLOAD_TOO_LARGE` (Q-2).

## Tests required

- [x] Unit — delay cap validation, payload size validation
- [x] Integration — full redelivery cycle against real SQLite with real
      elapsed time for the visibility timeout (short test-only timeout value
      is fine; a mocked clock is not — `docs/ANTIHALLUCINATION.md` Rule 5)
- [ ] Security — n/a this task

## Definition of Done

- [x] Redelivery state machine matches Q-3's diagram exactly, including the
      DLQ branch — this is the highest audit-finding-density contract clause
      in the spec; treat it as such
- [x] No idempotency/dedupe logic inside the provider (Q-4 boundary honored)
- [x] `deno check` / `deno test` / `deno lint` clean, real output attached

```
$ deno check **/*.ts
Check cli/main.ts
Check packages/core/crypto/content-address.ts
Check packages/core/crypto/content-address_test.ts
Check packages/core/id/ulid.ts
Check packages/core/id/ulid_test.ts
Check packages/errors/mod.ts
Check packages/errors/mod_test.ts
Check primitives/kv/kv-provider.ts
Check primitives/objects/object-provider.ts
Check primitives/queues/queue-provider.ts
Check providers/kv/sqlite-provider.ts
Check providers/kv/sqlite-provider_test.ts
Check providers/objects/local-fs-provider.ts
Check providers/objects/local-fs-provider_test.ts
Check providers/queues/sqlite-queue-provider.ts
Check providers/queues/sqlite-queue-provider_test.ts
EXIT:0

$ deno task test
Task test deno test --allow-read --allow-write --allow-net
running 2 tests from ./packages/core/crypto/content-address_test.ts
... (2 passed)
running 5 tests from ./packages/core/id/ulid_test.ts
... (5 passed)
running 3 tests from ./packages/errors/mod_test.ts
... (3 passed)
running 5 tests from ./providers/kv/sqlite-provider_test.ts
... (5 passed)
running 8 tests from ./providers/objects/local-fs-provider_test.ts
... (8 passed)
running 7 tests from ./providers/queues/sqlite-queue-provider_test.ts
SQLiteQueueProvider - basic send/receive/ack flow ... ok (3ms)
SQLiteQueueProvider - sendBatch sends multiple messages ... ok (2ms)
SQLiteQueueProvider - delay support (Q-2) ... ok (1s)
SQLiteQueueProvider - validation fails for delay > 900s ... ok (1ms)
SQLiteQueueProvider - validation fails for payload > 128KB ... ok (1ms)
SQLiteQueueProvider - redelivery state machine & visibility timeout ... ok (418ms)
SQLiteQueueProvider - dead-letter queue routing on max_receives ... ok (784ms)

ok | 30 passed | 0 failed (6s)
EXIT:0

$ deno lint
Checked 16 files
EXIT:0

$ deno fmt --check
Checked 17 files
EXIT:0
```

## Assumptions made

DLQ is modeled as a second logical queue reachable via the same provider
instance (`provider.deadLetter.receive(...)`), rather than a separate
top-level primitive — consistent with PLAT-20's ban on a fifth primitive; not
itself a spec-stated shape, since the LTS doc names the DLQ mechanism but not
its exact API surface.

