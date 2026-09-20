# T-0209 — Queue trigger consumer worker

Status: Done
Milestone: 0.2 Cloud Prototype
Depends on: T-0102, T-0108, T-0206
Blocks: T-0211

## Spec references

`FN-2` `FN-6` `Q-1` `Q-2` `Q-3` `Q-5` `PLAT-2`

## Scope

**In scope:**
- `apps/worker/queue-consumer.ts`: background worker dispatching queue triggers to Functions (`docs/contracts/functions.contract.md` FN-2, `platform.contract.md` PLAT-2).
- Continuous or polled receive from `QueueProvider` with visibility timeout (default 30,000 ms per `docs/contracts/queues.contract.md` Q-3).
- Context building and Function invocation passing `QueueMessage` (`id`, `body`, `attempts`) and `RailFogContext` (Q-2).
- Redelivery state machine enforcement per Q-3:
  - Success: acknowledge message via `queueProvider.ack(id)`.
  - Failure/exception: leave message unacknowledged to trigger redelivery upon visibility timeout expiry.
  - Exceeded threshold: if `attempts >= max_receives` (default 5), move to dead-letter queue (DLQ) and acknowledge from primary queue.
- Defensive immutability: defensively copy message primitives and freeze `QueueMessage` prior to function invocation to prevent tampering (FN-6, Q-3).

**Out of scope:**
- Composed application idempotency handling (application responsibility over KV per Q-4).
- Schedule / Cron triggers (Milestone 0.3).
- HTTP route triggers (handled by data-plane runtime router).

## Interface to implement

```typescript
import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";

export interface QueueConsumerOptions {
  queueName: string;
  targetFunctionName: string;
  visibilityTimeoutMs?: number; // default 30000 (Q-3)
  maxReceives?: number; // default 5 (Q-3)
  pollIntervalMs?: number;
  dlqProvider?: QueueProvider;
}

export class QueueConsumerWorker {
  constructor(
    queueProvider: QueueProvider,
    invokeFunction: (fnName: string, message: QueueMessage) => Promise<void>,
    options: QueueConsumerOptions,
  );
  start(): void;
  stop(): Promise<void>;
  processNext(): Promise<boolean>;
}
```

## Acceptance criteria

1. Given an available queue message, when `processNext` executes and the function invocation succeeds, then `queueProvider.ack` is invoked with the message ID (Q-3).
2. Given a message whose handler throws an error, when `processNext` executes, then `ack` is not called, and the message returns to visible state after the visibility timeout expires (Q-3).
3. Given a message where `attempts >= max_receives` (default 5), when processing fails, then the message is routed to the configured DLQ provider and acknowledged from the source queue (Q-3).
4. Given a consumed message, when invoked, then the function receives `QueueMessage` with `{ id, body, attempts }` as its first parameter and a valid `RailFogContext` as its second parameter (Q-2, FN-2).

## Tests required

- [x] Unit — message acknowledgment on handler success, unacked message retention on handler failure, DLQ routing when attempts reach `max_receives` threshold
- [x] Integration — consumer worker running against real `QueueProvider` executing sample consumer function fixture from `docs/contracts/worked-example.md`
- [x] Security — verify each message invocation receives a fresh, isolated `RailFogContext` without state bleeding across messages (FN-6)

## Definition of Done

- [x] Implementation matches cited clause IDs (`FN-2`, `FN-6`, `Q-1`, `Q-2`, `Q-3`, `Q-5`, `PLAT-2`)
- [x] Consumer logic strictly enforces visibility timeout, max-receive count, and DLQ trigger (Audit Finding #6 banned pattern check)
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing (18/18 task + adversarial tests; 221/221 repo tests)
- [x] `deno lint` run, real output attached, zero warnings
- [x] `deno fmt --check` run, real output attached, formatted
- [x] Independent reviewer pass completed and approved
- [x] Security auditor pass completed and approved (`FN-6`, `Q-3`, `PLAT-2`)
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched

### Verified Tool Outputs

#### `deno check`
```
$ deno check apps/worker/queue-consumer.ts apps/worker/queue-consumer_test.ts tests/security/queue_consumer_adversarial_test.ts
Check apps/worker/queue-consumer.ts
Check apps/worker/queue-consumer_test.ts
Check tests/security/queue_consumer_adversarial_test.ts
```

#### `deno test`
```
$ deno test --allow-read --allow-write apps/worker/queue-consumer_test.ts tests/security/queue_consumer_adversarial_test.ts
Check apps/worker/queue-consumer_test.ts
Check tests/security/queue_consumer_adversarial_test.ts
running 9 tests from ./apps/worker/queue-consumer_test.ts
AC1: Given an available queue message, when processNext() executes and invokeFunction succeeds, then queueProvider.ack(message.id) is called and processNext() returns true ... ok (934µs)
AC2: Given a message where invokeFunction throws/rejects, when processNext() executes, then ack is NOT called, error is handled gracefully, and processNext() returns false ... ok (331µs)
AC3: Given a message where attempts >= maxReceives, when processing fails, then routed to dlqProvider.send and acknowledged from source queue ... ok (833µs)
AC4: When queue is empty (receive() returns null), processNext() returns false and invokeFunction is not called ... ok (324µs)
AC5: Lifecycle start() continuously polls in background; stop() halts polling and awaits in-flight processing cleanly ... ok (230ms)
AC6: Default options: visibilityTimeoutMs defaults to 30,000 ms, maxReceives defaults to 5 per Q-3 ... ok (360µs)
Integration: consumer worker running against real SQLiteQueueProvider executing sample consumer function fixture from docs/contracts/worked-example.md ... ok (8ms)
Integration: real SQLiteQueueProvider routes poison message to DLQ after reaching max_receives ... ok (68ms)
Security (FN-6): Sequential message invocations receive fresh, isolated RailFogContext without state bleeding ... ok (571µs)
running 9 tests from ./tests/security/queue_consumer_adversarial_test.ts
Adversarial FN-6: handler mutations on message object cannot tamper with state machine or leak across invocations ... ok (40ms)
Adversarial FN-6: multi-tenant context pollution does not bleed across consecutive queue messages ... ok (31ms)
Adversarial Q-3: attempts reset attack cannot bypass DLQ routing or cause infinite retry loop ... ok (738µs)
Adversarial Q-3: message ID corruption attack cannot prevent source queue ACK or spam DLQ ... ok (303µs)
Adversarial Q-3: throwing property getters on message do not crash processNext or background loop (DoS) ... ok (320µs)
Adversarial Q-3: non-Error throws (string, null, undefined, number, symbol) never crash worker ... ok (313µs)
Adversarial Q-3: DLQ failure does not block primary queue ACK, preventing infinite spin loop ... ok (346µs)
Adversarial Concurrency: in-flight invocation during stop() completes cleanly without dropped or double-acked messages ... ok (75ms)
Adversarial Concurrency: multiple concurrent stop() calls are idempotent and thread-safe ... ok (31ms)

ok | 18 passed | 0 failed (520ms)
```

#### `deno lint`
```
$ deno lint apps/worker/queue-consumer.ts apps/worker/queue-consumer_test.ts tests/security/queue_consumer_adversarial_test.ts
Checked 3 files
```

#### `deno fmt --check`
```
$ deno fmt --check apps/worker/queue-consumer.ts apps/worker/queue-consumer_test.ts tests/security/queue_consumer_adversarial_test.ts
Checked 3 files
```

## Assumptions made

- `DEFAULT_POLL_INTERVAL_MS` defaults to 100 ms per `queues.contract.md` Q-5 base backoff interval.
- `QueueMessage` is defensively shallow-frozen (`Object.freeze`) and its primitive attributes (`id`, `attempts`, `body`) are locally copied before invocation to prevent handler tampering from disrupting the Q-3 redelivery/DLQ state machine.
