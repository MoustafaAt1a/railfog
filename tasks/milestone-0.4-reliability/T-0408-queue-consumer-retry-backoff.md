# T-0408 — Queue consumer retry and backoff integration

Status: Done
Milestone: 0.4 Reliability
Depends on: T-0209, T-0401
Blocks: T-0412

## Spec references

`Q-3` `Q-5` `PLAT-10`

## Scope

**In scope** (be exact — file/module/interface level, not a feature area):

- `apps/worker/queue-consumer.ts`: integrate decorrelated jitter retry engine
  (`packages/policy/retry.ts`, T-0401) into `QueueConsumerWorker`:
  - Worker polling backoff: when the queue is empty or provider polling throws
    errors, apply Q-5 decorrelated jitter backoff (`base = 100 ms`,
    `cap = 20 s`) instead of a fixed 100 ms sleep, avoiding CPU busy-spinning or
    provider quota burn (KV-5, Q-5).
  - Redelivery state machine (Q-3):
    - Handler error and `attempts < maxReceives` (default 5): message is left
      unacknowledged to return to visible state after `visibilityTimeoutMs`
      (default 30,000 ms).
    - Handler error and `attempts >= maxReceives`: routes message to DLQ (if
      configured) and acknowledges from primary queue (Q-3).
  - Strict bounded retries: max 5 attempts enforced before DLQ routing (Q-5,
    Audit Finding #6).
  - Clean shutdown: worker honors cancellation signal during backoff sleeps.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):

- Fixed (non-jittered) exponential backoff or unbounded retries (strictly banned
  per Q-5).
- Retrying non-idempotent HTTP requests (Q-5).
- Storage provider circuit breakers (T-0410).

## Interface to implement

```typescript
import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";
import type { RetryPolicyOptions } from "../../packages/policy/retry.ts";

export interface ResilientQueueConsumerOptions {
  queueName: string;
  targetFunctionName: string;
  visibilityTimeoutMs?: number; // default 30000 (Q-3)
  maxReceives?: number; // default 5 (Q-3)
  retryPolicy?: RetryPolicyOptions; // default base 100ms, cap 20s (Q-5)
  dlqProvider?: QueueProvider;
}

export class ResilientQueueConsumerWorker {
  constructor(
    queueProvider: QueueProvider,
    invokeFunction: (fnName: string, message: QueueMessage) => Promise<void>,
    options: ResilientQueueConsumerOptions,
  );

  start(): void;
  stop(): Promise<void>;
  processNext(): Promise<boolean>;
  getConsecutiveEmptyPolls(): number;
}
```

## Acceptance criteria (Given/When/Then)

1. Given an empty queue, when `processNext` finds no messages, then the polling
   loop sleeps for an interval calculated via Q-5 decorrelated jitter and
   increments consecutive empty poll counter.
2. Given a message that causes the target Function to throw, when
   `message.attempts < 5`, then the worker does not acknowledge the message and
   it remains in the primary queue.
3. Given a message where `message.attempts >= 5` fails, when `processNext`
   handles the failure, then the message body is routed to `dlqProvider` and
   acknowledged from the primary queue.
4. Given repeated consecutive polling errors, when the backoff delay is
   calculated, then the sleep duration increases using decorrelated jitter and
   never exceeds `capMs` (20,000 ms).
5. Given a worker waiting during a jitter backoff sleep, when `stop()` is
   called, then the sleep timer cancels immediately and the worker stops cleanly
   without hanging.

## Tests required

- [x] Unit — polling backoff calculation scales with consecutive empty polls
      using decorrelated jitter
- [x] Unit — message with attempts < 5 is left unacked for redelivery
- [x] Unit — message with attempts >= 5 routes to DLQ and acks primary queue
- [x] Integration — worker recovers gracefully from transient queue provider
      errors with jittered backoff

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

### Verified Tool Outputs

#### `deno check`

```
$ deno check apps/worker/queue-consumer.ts apps/worker/resilient-queue-consumer_test.ts apps/worker/queue-consumer_test.ts
Check apps/worker/queue-consumer.ts
Check apps/worker/resilient-queue-consumer_test.ts
Check apps/worker/queue-consumer_test.ts
```

#### `deno test` (ResilientQueueConsumerWorker test suite)

```
$ deno test --allow-read --allow-write --allow-net --allow-run apps/worker/resilient-queue-consumer_test.ts
running 18 tests from ./apps/worker/resilient-queue-consumer_test.ts
AC1.0 (Q-3, Q-5): Default settings adhere to contract values (visibility 30s, max receives 5, base 100ms, cap 20s) ... ok (962µs)
AC1.1 (Q-5): processNext() increments getConsecutiveEmptyPolls() when queue is empty and resets to 0 on success ... ok (397µs)
AC1.2 (Q-5): Polling loop uses calculateNextSleep decorrelated jitter backoff when queue is empty ... ok (82ms)
AC1.3 (Q-5): Polling backoff intervals scale with consecutive empty polls using decorrelated jitter formula ... ok (94ms)
AC2.1 (Q-3): When handler throws and attempts < 5 (default maxReceives), message is left unacked for redelivery ... ok (705µs)
AC2.2 (Q-3): When handler throws and attempts < maxReceives (custom maxReceives = 3, attempts = 2), message is left unacked ... ok (305µs)
AC3.1 (Q-3): When handler throws and attempts >= 5 (default maxReceives), message body routes to dlqProvider and primary queue is acked ... ok (476µs)
AC3.2 (Q-3): When handler throws with attempts exceeding custom maxReceives (attempts 4 >= maxReceives 3), routes to DLQ and acks primary ... ok (481µs)
AC3.3 (Q-3): When handler throws and attempts >= maxReceives but no dlqProvider is configured, primary queue is still acknowledged ... ok (413µs)
AC3.4 (Q-3): When handler succeeds on attempt 5 (attempts >= maxReceives), message is acked and NOT sent to DLQ ... ok (348µs)
AC4.1 (Q-5): When queueProvider.receive() throws, processNext() catches error, returns false, and increments consecutive empty polls ... ok (814µs)
AC4.2 (Q-5): Repeated provider errors scale backoff delay using decorrelated jitter without exceeding capMs ... ok (91ms)
AC4.3 (Q-5): Injected deterministic RNG in retryPolicy verifies mathematical adherence to Q-5 formula ... ok (92ms)
AC5.1 (PLAT-10, Q-5): Calling stop() during backoff sleep cancels sleep timer immediately and halts worker without hanging ... ok (110ms)
AC5.2: stop() is idempotent and handles multiple concurrent or sequential calls cleanly ... ok (31ms)
Integration (PLAT-10, Q-5): Worker recovers gracefully from transient queue provider errors with jittered backoff ... ok (126ms)
Integration (PLAT-17, Q-3): Real SQLiteQueueProvider end-to-end redelivery, empty poll backoff, and DLQ routing ... ok (64ms)
AC7.1 (Q-3): When dlqProvider.send() throws, worker does not crash and completes error handling cleanly ... ok (365µs)

ok | 18 passed | 0 failed (710ms)
```

#### `deno test` (QueueConsumerWorker backwards compatibility)

```
$ deno test --allow-read --allow-write --allow-net --allow-run apps/worker/queue-consumer_test.ts
running 9 tests from ./apps/worker/queue-consumer_test.ts
AC1: Given an available queue message, when processNext() executes and invokeFunction succeeds, then queueProvider.ack(message.id) is called and processNext() returns true ... ok (872µs)
AC2: Given a message where invokeFunction throws/rejects, when processNext() executes, then ack is NOT called, error is handled gracefully, and processNext() returns false ... ok (267µs)
AC3: Given a message where attempts >= maxReceives, when processing fails, then routed to dlqProvider.send and acknowledged from source queue ... ok (583µs)
AC4: When queue is empty (receive() returns null), processNext() returns false and invokeFunction is not called ... ok (141µs)
AC5: Lifecycle start() continuously polls in background; stop() halts polling and awaits in-flight processing cleanly ... ok (223ms)
AC6: Default options: visibilityTimeoutMs defaults to 30,000 ms, maxReceives defaults to 5 per Q-3 ... ok (875µs)
Integration: consumer worker running against real SQLiteQueueProvider executing sample consumer function fixture from docs/contracts/worked-example.md ... ok (9ms)
Integration: real SQLiteQueueProvider routes poison message to DLQ after reaching max_receives ... ok (67ms)
Security (FN-6): Sequential message invocations receive fresh, isolated RailFogContext without state bleeding ... ok (675µs)

ok | 9 passed | 0 failed (313ms)
```

#### `deno lint`

```
$ deno lint apps/worker/queue-consumer.ts apps/worker/resilient-queue-consumer_test.ts
Checked 2 files
```

## Assumptions made

- [Implementation choice] `ResilientQueueConsumerWorker` reuses `QueueMessage` and `QueueProvider`
  interfaces without modifying existing provider contracts.
- [Implementation choice] Consecutive empty polls reset to 0 as soon as a message is successfully
  received and processed.
- [Implementation choice] In background daemon execution (`worker.start()`), once all available messages
  are processed, subsequent polling loops on the empty queue correctly increment
  `consecutiveEmptyPolls`.
