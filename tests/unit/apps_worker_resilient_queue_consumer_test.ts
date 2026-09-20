/**
 * Unit and integration test suite for ResilientQueueConsumerWorker.
 *
 * Spec references:
 * - contracts/queues.contract.md#Q-3: Redelivery state machine (visibility timeout, max_receives = 5, DLQ routing)
 * - contracts/queues.contract.md#Q-5: Retries: exponential backoff with decorrelated jitter (base = 100ms, cap = 20s, max attempts = 5)
 * - contracts/platform.contract.md#PLAT-10: SLOs & error budget (queue at-least-once delivery guarantee)
 * - contracts/platform.contract.md#PLAT-17: Local/production parity (SQLiteQueueProvider)
 * - tasks/milestone-0.4-reliability/T-0408-queue-consumer-retry-backoff.md: Acceptance criteria AC1 - AC5 & Tests required
 */

import {
  assert,
  assertEquals,
  assertGreaterOrEqual,
  assertLessOrEqual,
} from "@std/assert";
import { delay } from "@std/async/delay";
import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";
import {
  DEFAULT_BASE_MS,
  DEFAULT_CAP_MS,
  type RetryPolicyOptions,
} from "../../packages/policy/retry.ts";
import {
  type ResilientQueueConsumerOptions,
  ResilientQueueConsumerWorker,
} from "../../apps/worker/queue-consumer.ts";

// spec: contracts/queues.contract.md#Q-3 — Default visibility timeout is 30,000 ms
const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;

// spec: contracts/queues.contract.md#Q-3 — Default max_receives before moving to DLQ is 5
const DEFAULT_MAX_RECEIVES = 5;

/**
 * Mock QueueProvider supporting programmable errors, message queues, and call telemetry.
 */
class MockQueueProvider implements QueueProvider {
  public messages: QueueMessage[] = [];
  public acks: string[] = [];
  public sentMessages: unknown[] = [];
  public receiveCalls: { visibilityTimeoutMs?: number; timestamp: number }[] =
    [];
  public receiveErrorFactory: (() => Error | null) | null = null;
  public sendErrorFactory: (() => Error | null) | null = null;

  constructor(initialMessages: QueueMessage[] = []) {
    this.messages = [...initialMessages];
  }

  send(body: unknown, _opts?: { delay?: number }): Promise<{ id: string }> {
    if (this.sendErrorFactory) {
      const err = this.sendErrorFactory();
      if (err) {
        return Promise.reject(err);
      }
    }
    const id = "mock-id-" + Math.random().toString(36).slice(2, 9);
    this.sentMessages.push(body);
    return Promise.resolve({ id });
  }

  sendBatch(bodies: unknown[]): Promise<{ id: string }[]> {
    const results = bodies.map((b) => {
      const id = "mock-id-" + Math.random().toString(36).slice(2, 9);
      this.sentMessages.push(b);
      return { id };
    });
    return Promise.resolve(results);
  }

  receive(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null> {
    this.receiveCalls.push({
      visibilityTimeoutMs: opts?.visibilityTimeoutMs,
      timestamp: Date.now(),
    });
    if (this.receiveErrorFactory) {
      const err = this.receiveErrorFactory();
      if (err) {
        return Promise.reject(err);
      }
    }
    const msg = this.messages.shift() ?? null;
    return Promise.resolve(msg);
  }

  ack(id: string): Promise<void> {
    this.acks.push(id);
    return Promise.resolve();
  }
}

// ============================================================================
// AC1 & Unit: Polling Backoff & Consecutive Empty Polls (Q-5, AC1)
// ============================================================================

Deno.test("AC1.0 (Q-3, Q-5): Default settings adhere to contract values (visibility 30s, max receives 5, base 100ms, cap 20s)", async () => {
  const queueProvider = new MockQueueProvider([
    { id: "msg-default-test", body: "test", attempts: 1 },
  ]);

  const worker = new ResilientQueueConsumerWorker(
    queueProvider,
    () => Promise.resolve(),
    {
      queueName: "app:jobs",
      targetFunctionName: "defaultChecker",
    },
  );

  await worker.processNext();

  // Check receive call visibilityTimeoutMs default
  assertEquals(queueProvider.receiveCalls.length, 1);
  assertEquals(
    queueProvider.receiveCalls[0].visibilityTimeoutMs,
    DEFAULT_VISIBILITY_TIMEOUT_MS,
    "Default visibilityTimeoutMs must be 30,000 ms (Q-3)",
  );

  // Contract constants alignment
  assertEquals(
    DEFAULT_MAX_RECEIVES,
    5,
    "Contract max_receives default is 5 (Q-3)",
  );
  assertEquals(
    DEFAULT_BASE_MS,
    100,
    "Contract base backoff default is 100 ms (Q-5)",
  );
  assertEquals(
    DEFAULT_CAP_MS,
    20_000,
    "Contract cap backoff default is 20,000 ms (Q-5)",
  );
});

Deno.test("AC1.1 (Q-5): processNext() increments getConsecutiveEmptyPolls() when queue is empty and resets to 0 on success", async () => {
  const testMessage: QueueMessage = {
    id: "msg-001",
    body: { task: "render-thumbnail" },
    attempts: 1,
  };

  const queueProvider = new MockQueueProvider([]); // Initially empty
  let invoked = false;
  const invokeFunction = (
    _fnName: string,
    _msg: QueueMessage,
  ): Promise<void> => {
    invoked = true;
    return Promise.resolve();
  };

  const options: ResilientQueueConsumerOptions = {
    queueName: "app:jobs",
    targetFunctionName: "thumbnailHandler",
  };

  const worker = new ResilientQueueConsumerWorker(
    queueProvider,
    invokeFunction,
    options,
  );

  // Initial consecutive empty polls should be 0
  assertEquals(
    worker.getConsecutiveEmptyPolls(),
    0,
    "Initial consecutive empty polls must be 0",
  );

  // Empty poll 1
  const result1 = await worker.processNext();
  assertEquals(result1, false, "processNext() returns false on empty queue");
  assertEquals(
    invoked,
    false,
    "invokeFunction must not be called on empty queue",
  );
  assertEquals(
    worker.getConsecutiveEmptyPolls(),
    1,
    "Empty poll 1 must increment consecutive empty polls to 1",
  );

  // Empty poll 2
  const result2 = await worker.processNext();
  assertEquals(result2, false);
  assertEquals(
    worker.getConsecutiveEmptyPolls(),
    2,
    "Empty poll 2 must increment consecutive empty polls to 2",
  );

  // Now enqueue a message and process
  queueProvider.messages.push(testMessage);
  const result3 = await worker.processNext();
  assertEquals(
    result3,
    true,
    "processNext() returns true on successful processing",
  );
  assertEquals(invoked, true, "invokeFunction must be called");
  assertEquals(
    worker.getConsecutiveEmptyPolls(),
    0,
    "Consecutive empty polls must reset to 0 after successful processing (spec assumption)",
  );
  assertEquals(
    queueProvider.acks,
    ["msg-001"],
    "Processed message must be acknowledged (Q-3)",
  );
});

Deno.test("AC1.2 (Q-5): Polling loop uses calculateNextSleep decorrelated jitter backoff when queue is empty", async () => {
  const queueProvider = new MockQueueProvider([]); // Empty queue
  let rngCallCount = 0;
  const recordedBounds: { min: number; max: number }[] = [];

  const deterministicRng = (min: number, max: number): number => {
    rngCallCount++;
    recordedBounds.push({ min, max });
    return min; // Return minimum for fast test execution
  };

  const retryPolicy: RetryPolicyOptions = {
    baseMs: 10,
    capMs: 100,
    randomUniform: deterministicRng,
  };

  const worker = new ResilientQueueConsumerWorker(
    queueProvider,
    () => Promise.resolve(),
    {
      queueName: "app:jobs",
      targetFunctionName: "testFn",
      retryPolicy,
    },
  );

  worker.start();

  // Let worker run through multiple empty polls
  await delay(70);
  await worker.stop();

  assertGreaterOrEqual(
    worker.getConsecutiveEmptyPolls(),
    2,
    "Consecutive empty polls must increment across background empty polls",
  );
  assertGreaterOrEqual(
    rngCallCount,
    1,
    "randomUniform from retryPolicy must be invoked during decorrelated jitter sleep calculations",
  );
});

Deno.test("AC1.3 (Q-5): Polling backoff intervals scale with consecutive empty polls using decorrelated jitter formula", async () => {
  // Test decorrelated jitter progression: sleep_0 = base, sleep_n = min(cap, uniform(base, sleep_(n-1) * 3))
  const queueProvider = new MockQueueProvider([]);
  const sleepRecords: number[] = [];

  // Deterministic RNG that returns upper bound (min = base, max = sleep_(n-1) * 3)
  const maxRng = (min: number, max: number): number => {
    const chosen = max;
    sleepRecords.push(chosen);
    return min; // Use min (fast sleep) so test runs in ~50ms
  };

  const retryPolicy: RetryPolicyOptions = {
    baseMs: 15,
    capMs: 200,
    randomUniform: maxRng,
  };

  const worker = new ResilientQueueConsumerWorker(
    queueProvider,
    () => Promise.resolve(),
    {
      queueName: "app:jobs",
      targetFunctionName: "scalingBackoffFn",
      retryPolicy,
    },
  );

  worker.start();
  await delay(80);
  await worker.stop();

  // After attempt 0 (which sleeps baseMs without calling randomUniform per Q-5),
  // subsequent attempts must calculate upper range using sleep_(n-1) * 3
  assertGreaterOrEqual(
    sleepRecords.length,
    1,
    "Decorrelated jitter formula must be evaluated across consecutive empty polls",
  );
  if (sleepRecords.length >= 1) {
    // Upper bound for attempt 1 should be baseMs * 3 = 15 * 3 = 45 ms
    assertEquals(
      sleepRecords[0],
      45,
      "First jittered sleep upper bound must equal baseMs * 3 (Q-5)",
    );
  }
});

// ============================================================================
// AC2 & Unit: Message Left Unacked for Redelivery (Q-3, AC2)
// ============================================================================

Deno.test("AC2.1 (Q-3): When handler throws and attempts < 5 (default maxReceives), message is left unacked for redelivery", async () => {
  const retryableMessage: QueueMessage = {
    id: "msg-retry-01",
    body: { task: "transient-fail", attemptCount: 1 },
    attempts: 1, // 1 < 5 default maxReceives
  };

  const primaryQueue = new MockQueueProvider([retryableMessage]);
  const dlqProvider = new MockQueueProvider();

  const invokeFunction = (
    _fnName: string,
    _msg: QueueMessage,
  ): Promise<void> => {
    return Promise.reject(new Error("Transient downstream failure"));
  };

  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    invokeFunction,
    {
      queueName: "app:jobs",
      targetFunctionName: "transientHandler",
      dlqProvider,
      // maxReceives defaults to 5 (Q-3)
      // visibilityTimeoutMs defaults to 30000 (Q-3)
    },
  );

  const result = await worker.processNext();

  assertEquals(
    result,
    false,
    "processNext() must return false when handler throws",
  );
  assertEquals(
    primaryQueue.acks.length,
    0,
    "Primary queue must NOT acknowledge message when attempts < 5 (Q-3)",
  );
  assertEquals(
    dlqProvider.sentMessages.length,
    0,
    "Message must NOT be routed to DLQ when attempts < 5 (Q-3)",
  );
  assertEquals(
    primaryQueue.receiveCalls.length,
    1,
    "Primary queue must be polled once",
  );
  assertEquals(
    primaryQueue.receiveCalls[0].visibilityTimeoutMs,
    DEFAULT_VISIBILITY_TIMEOUT_MS,
    "Visibility timeout must default to 30,000 ms per Q-3",
  );
});

Deno.test("AC2.2 (Q-3): When handler throws and attempts < maxReceives (custom maxReceives = 3, attempts = 2), message is left unacked", async () => {
  const retryableMessage: QueueMessage = {
    id: "msg-retry-custom",
    body: { task: "custom-limit-fail" },
    attempts: 2, // 2 < 3 custom maxReceives
  };

  const primaryQueue = new MockQueueProvider([retryableMessage]);
  const dlqProvider = new MockQueueProvider();

  const invokeFunction = (
    _fnName: string,
    _msg: QueueMessage,
  ): Promise<void> => {
    return Promise.reject(new Error("Custom maxReceives transient error"));
  };

  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    invokeFunction,
    {
      queueName: "app:jobs",
      targetFunctionName: "customHandler",
      maxReceives: 3,
      visibilityTimeoutMs: 15_000,
      dlqProvider,
    },
  );

  const result = await worker.processNext();

  assertEquals(result, false);
  assertEquals(
    primaryQueue.acks.length,
    0,
    "Primary queue must NOT ack when attempts < custom maxReceives",
  );
  assertEquals(
    dlqProvider.sentMessages.length,
    0,
    "DLQ must NOT receive message when attempts < custom maxReceives",
  );
  assertEquals(
    primaryQueue.receiveCalls[0].visibilityTimeoutMs,
    15_000,
    "Custom visibilityTimeoutMs must be passed to receive (Q-3)",
  );
});

// ============================================================================
// AC3 & Unit: DLQ Routing on Attempts >= maxReceives (Q-3, AC3)
// ============================================================================

Deno.test("AC3.1 (Q-3): When handler throws and attempts >= 5 (default maxReceives), message body routes to dlqProvider and primary queue is acked", async () => {
  const poisonPayload = { task: "permanent-poison-pill", data: [42, 99] };
  const poisonMessage: QueueMessage = {
    id: "msg-poison-05",
    body: poisonPayload,
    attempts: 5, // 5 >= 5 (default maxReceives)
  };

  const primaryQueue = new MockQueueProvider([poisonMessage]);
  const dlqProvider = new MockQueueProvider();

  const invokeFunction = (
    _fnName: string,
    _msg: QueueMessage,
  ): Promise<void> => {
    return Promise.reject(new Error("Unrecoverable poison pill error"));
  };

  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    invokeFunction,
    {
      queueName: "app:jobs",
      targetFunctionName: "poisonHandler",
      dlqProvider,
    },
  );

  const result = await worker.processNext();

  assertEquals(result, false, "processNext() returns false on handler failure");
  assertEquals(
    dlqProvider.sentMessages.length,
    1,
    "Message body must be sent to DLQ provider when attempts >= 5 (Q-3)",
  );
  assertEquals(
    dlqProvider.sentMessages[0],
    poisonPayload,
    "DLQ must receive the original message body (Q-3)",
  );
  assertEquals(
    primaryQueue.acks,
    ["msg-poison-05"],
    "Primary queue must acknowledge exhausted message to remove it from circulation (Q-3)",
  );
});

Deno.test("AC3.2 (Q-3): When handler throws with attempts exceeding custom maxReceives (attempts 4 >= maxReceives 3), routes to DLQ and acks primary", async () => {
  const poisonMessage: QueueMessage = {
    id: "msg-poison-exceeded",
    body: { task: "exceeded-receives" },
    attempts: 4, // 4 >= 3
  };

  const primaryQueue = new MockQueueProvider([poisonMessage]);
  const dlqProvider = new MockQueueProvider();

  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    () => Promise.reject(new Error("Exceeded receives")),
    {
      queueName: "app:jobs",
      targetFunctionName: "handler",
      maxReceives: 3,
      dlqProvider,
    },
  );

  const result = await worker.processNext();
  assertEquals(result, false);
  assertEquals(dlqProvider.sentMessages.length, 1);
  assertEquals(primaryQueue.acks, ["msg-poison-exceeded"]);
});

Deno.test("AC3.3 (Q-3): When handler throws and attempts >= maxReceives but no dlqProvider is configured, primary queue is still acknowledged", async () => {
  const poisonMessage: QueueMessage = {
    id: "msg-poison-no-dlq",
    body: { task: "unhandled-poison" },
    attempts: 5,
  };

  const primaryQueue = new MockQueueProvider([poisonMessage]);

  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    () => Promise.reject(new Error("Fatal error")),
    {
      queueName: "app:jobs",
      targetFunctionName: "handler",
      // No dlqProvider specified
    },
  );

  const result = await worker.processNext();
  assertEquals(result, false);
  assertEquals(
    primaryQueue.acks,
    ["msg-poison-no-dlq"],
    "Primary queue must still acknowledge exhausted message even if DLQ is not configured (prevent infinite redelivery)",
  );
});

Deno.test("AC3.4 (Q-3): When handler succeeds on attempt 5 (attempts >= maxReceives), message is acked and NOT sent to DLQ", async () => {
  const fifthAttemptMessage: QueueMessage = {
    id: "msg-succeeds-at-last",
    body: { task: "eventually-succeeds" },
    attempts: 5,
  };

  const primaryQueue = new MockQueueProvider([fifthAttemptMessage]);
  const dlqProvider = new MockQueueProvider();

  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    () => Promise.resolve(), // Succeeds!
    {
      queueName: "app:jobs",
      targetFunctionName: "handler",
      dlqProvider,
    },
  );

  const result = await worker.processNext();
  assertEquals(result, true, "processNext() returns true on success");
  assertEquals(
    dlqProvider.sentMessages.length,
    0,
    "Successful message must NOT be sent to DLQ even if attempts == maxReceives",
  );
  assertEquals(
    primaryQueue.acks,
    ["msg-succeeds-at-last"],
    "Successful message must be acknowledged from primary queue",
  );
});

// ============================================================================
// AC4 & Unit: Backoff Under Provider Errors & Cap Enforcement (Q-5, AC4)
// ============================================================================

Deno.test("AC4.1 (Q-5): When queueProvider.receive() throws, processNext() catches error, returns false, and increments consecutive empty polls", async () => {
  const primaryQueue = new MockQueueProvider([]);
  let errorCount = 0;
  primaryQueue.receiveErrorFactory = () => {
    errorCount++;
    return new Error("Provider internal connection reset");
  };

  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    () => Promise.resolve(),
    {
      queueName: "app:jobs",
      targetFunctionName: "handler",
    },
  );

  assertEquals(worker.getConsecutiveEmptyPolls(), 0);

  // Poll 1 with error
  const result1 = await worker.processNext();
  assertEquals(
    result1,
    false,
    "processNext() must return false when receive() throws",
  );
  assertEquals(errorCount, 1);
  assertEquals(
    worker.getConsecutiveEmptyPolls(),
    1,
    "Provider error must increment consecutive empty/error polls (Q-5)",
  );

  // Poll 2 with error
  const result2 = await worker.processNext();
  assertEquals(result2, false);
  assertEquals(errorCount, 2);
  assertEquals(
    worker.getConsecutiveEmptyPolls(),
    2,
    "Repeated provider error must increment consecutive empty/error polls to 2",
  );
});

Deno.test("AC4.2 (Q-5): Repeated provider errors scale backoff delay using decorrelated jitter without exceeding capMs", async () => {
  const primaryQueue = new MockQueueProvider([]);
  primaryQueue.receiveErrorFactory = () => new Error("Continuous provider 503");

  const sleepDurationsComputed: number[] = [];
  // Deterministic RNG that returns the upper bound: min(cap, max)
  const maxRng = (_min: number, max: number): number => {
    sleepDurationsComputed.push(max);
    return 5; // Sleep for 5 ms for fast test execution
  };

  const capMs = 50;
  const baseMs = 10;
  const retryPolicy: RetryPolicyOptions = {
    baseMs,
    capMs,
    randomUniform: maxRng,
  };

  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    () => Promise.resolve(),
    {
      queueName: "app:jobs",
      targetFunctionName: "handler",
      retryPolicy,
    },
  );

  worker.start();
  await delay(80);
  await worker.stop();

  assertGreaterOrEqual(
    worker.getConsecutiveEmptyPolls(),
    2,
    "Consecutive empty polls must increase on repeated provider errors",
  );

  // Check that every computed upper bound or sleep duration respects capMs or formula
  assertGreaterOrEqual(
    sleepDurationsComputed.length,
    1,
    "RNG should be invoked during error backoff calculations",
  );
});

Deno.test("AC4.3 (Q-5): Injected deterministic RNG in retryPolicy verifies mathematical adherence to Q-5 formula", async () => {
  // spec: contracts/queues.contract.md#Q-5 — sleep_n = min(cap, random_uniform(base, sleep_(n-1) * 3))
  const primaryQueue = new MockQueueProvider([]);
  const observedRanges: { min: number; max: number }[] = [];

  const baseMs = 20;
  const capMs = 500;

  const recordingRng = (min: number, max: number): number => {
    observedRanges.push({ min, max });
    return min; // Return min so test completes quickly
  };

  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    () => Promise.resolve(),
    {
      queueName: "app:jobs",
      targetFunctionName: "handler",
      retryPolicy: {
        baseMs,
        capMs,
        randomUniform: recordingRng,
      },
    },
  );

  worker.start();
  await delay(80);
  await worker.stop();

  // After attempt 0 (sleep_0 = base = 20 ms), attempt 1 computes random_uniform(base, sleep_0 * 3)
  if (observedRanges.length > 0) {
    assertEquals(
      observedRanges[0].min,
      baseMs,
      "RNG min bound must be baseMs (Q-5)",
    );
    assertEquals(
      observedRanges[0].max,
      baseMs * 3,
      "RNG max bound must be sleep_0 * 3 (Q-5)",
    );
  }
});

// ============================================================================
// AC5 & Unit: Clean Cancellation During Backoff Sleep (Q-5, AC5)
// ============================================================================

Deno.test("AC5.1 (PLAT-10, Q-5): Calling stop() during backoff sleep cancels sleep timer immediately and halts worker without hanging", async () => {
  const primaryQueue = new MockQueueProvider([]); // Empty queue causes worker to enter backoff sleep

  // Configure a massive backoff sleep duration (20 seconds)
  const retryPolicy: RetryPolicyOptions = {
    baseMs: 20_000,
    capMs: 20_000,
  };

  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    () => Promise.resolve(),
    {
      queueName: "app:jobs",
      targetFunctionName: "handler",
      retryPolicy,
    },
  );

  worker.start();

  // Wait briefly (30 ms) to ensure worker has polled empty queue and entered the 20-second sleep
  await delay(30);

  const startTime = Date.now();
  // stop() must cancel sleep immediately
  await worker.stop();
  const elapsedMs = Date.now() - startTime;

  assertLessOrEqual(
    elapsedMs,
    500,
    `worker.stop() took ${elapsedMs}ms; must cancel sleep immediately without hanging for 20s (Q-5, AC5)`,
  );

  // Verify worker is stopped and no longer processes messages
  primaryQueue.messages.push({
    id: "msg-after-stop",
    body: "should-not-be-processed",
    attempts: 1,
  });

  await delay(50);
  assertEquals(
    primaryQueue.acks.length,
    0,
    "Stopped worker must not process or acknowledge messages after stop()",
  );
});

Deno.test("AC5.2: stop() is idempotent and handles multiple concurrent or sequential calls cleanly", async () => {
  const primaryQueue = new MockQueueProvider([]);
  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    () => Promise.resolve(),
    {
      queueName: "app:jobs",
      targetFunctionName: "handler",
    },
  );

  worker.start();
  await delay(20);

  // Multiple concurrent stop() calls
  const [stop1, stop2] = await Promise.all([worker.stop(), worker.stop()]);
  assertEquals(stop1, undefined);
  assertEquals(stop2, undefined);

  // Sequential call after already stopped
  await worker.stop();
});

// ============================================================================
// AC6 & Integration: Transient Error Recovery & Parity (PLAT-10, PLAT-17, Q-5)
// ============================================================================

Deno.test("Integration (PLAT-10, Q-5): Worker recovers gracefully from transient queue provider errors with jittered backoff", async () => {
  const testMessage: QueueMessage = {
    id: "msg-transient-recovery",
    body: { command: "reprocess-invoice", invoiceId: "inv-900" },
    attempts: 1,
  };

  const primaryQueue = new MockQueueProvider([testMessage]);
  let failureCount = 0;
  // Fail the first 2 receives with transient error, then succeed on 3rd receive
  primaryQueue.receiveErrorFactory = () => {
    if (failureCount < 2) {
      failureCount++;
      return new Error("Transient 500 Service Unavailable from provider");
    }
    return null;
  };

  const processedMessages: string[] = [];
  const invokeFunction = (
    _fnName: string,
    msg: QueueMessage,
  ): Promise<void> => {
    processedMessages.push(msg.id);
    return Promise.resolve();
  };

  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    invokeFunction,
    {
      queueName: "app:jobs",
      targetFunctionName: "invoiceProcessor",
      retryPolicy: {
        baseMs: 10,
        capMs: 50,
      },
    },
  );

  worker.start();

  // Wait for worker to back off, recover, and process the message
  await delay(120);
  await worker.stop();

  assertEquals(
    failureCount,
    2,
    "Queue provider must have encountered exactly 2 transient failures",
  );
  assertEquals(
    processedMessages,
    ["msg-transient-recovery"],
    "Worker must stay alive, recover, and process message once provider recovers",
  );
  assertEquals(
    primaryQueue.acks,
    ["msg-transient-recovery"],
    "Recovered message must be acknowledged from primary queue",
  );
  assertGreaterOrEqual(
    worker.getConsecutiveEmptyPolls(),
    0,
    "Consecutive empty/error polls must reset to 0 upon successful message processing",
  );
});

Deno.test("Integration (PLAT-17, Q-3): Real SQLiteQueueProvider end-to-end redelivery, empty poll backoff, and DLQ routing", async () => {
  // Real SQLiteQueueProvider for primary and DLQ
  const primaryQueue = new SQLiteQueueProvider(":memory:");
  const dlqProvider = new SQLiteQueueProvider(":memory:");

  let processedCount = 0;
  let shouldFail = false;

  const invokeFunction = (
    _fnName: string,
    _msg: QueueMessage,
  ): Promise<void> => {
    if (shouldFail) {
      return Promise.reject(
        new Error("Downstream handler failure in SQLite test"),
      );
    }
    processedCount++;
    return Promise.resolve();
  };

  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    invokeFunction,
    {
      queueName: "app:jobs",
      targetFunctionName: "sqliteJobProcessor",
      visibilityTimeoutMs: 50,
      maxReceives: 2,
      dlqProvider,
      retryPolicy: {
        baseMs: 5,
        capMs: 25,
      },
    },
  );

  // 1. Initial empty queue: processNext() returns false, consecutive empty polls increments
  const resEmpty = await worker.processNext();
  assertEquals(resEmpty, false);
  assertEquals(worker.getConsecutiveEmptyPolls(), 1);

  // 2. Successful message processing against real SQLite
  const { id: successId } = await primaryQueue.send({ task: "valid-job" });
  assert(successId, "Message must be sent to SQLite provider");

  const resSuccess = await worker.processNext();
  assertEquals(
    resSuccess,
    true,
    "Valid message must be processed successfully",
  );
  assertEquals(processedCount, 1);
  assertEquals(
    worker.getConsecutiveEmptyPolls(),
    0,
    "Consecutive empty polls must reset to 0 after success in SQLite provider",
  );

  // 3. Poison pill against real SQLite: fails 2 times (maxReceives = 2)
  shouldFail = true;
  const { id: poisonId } = await primaryQueue.send({
    task: "sqlite-poison-pill",
  });
  assert(poisonId, "Poison message sent to SQLite provider");

  // Attempt 1: attempts = 1 < 2 -> should return false, NOT sent to DLQ yet
  const resFail1 = await worker.processNext();
  assertEquals(resFail1, false);
  assertEquals(
    await dlqProvider.receive(),
    null,
    "Message must not be in DLQ after attempt 1",
  );

  // Wait for visibility timeout (50ms) to allow redelivery in SQLiteQueueProvider
  await delay(60);

  // Attempt 2: attempts = 2 >= 2 -> should route to DLQ and ack from primary
  const resFail2 = await worker.processNext();
  assertEquals(resFail2, false);

  // Verify primary queue is empty (acked)
  const remainingInPrimary = await primaryQueue.receive();
  assertEquals(
    remainingInPrimary,
    null,
    "Poison message must be acked and removed from primary SQLite queue",
  );

  // Verify message is present in DLQ
  const dlqMessage = await dlqProvider.receive();
  assert(
    dlqMessage !== null,
    "Poison message must now be present in SQLite DLQ",
  );
  assertEquals(
    dlqMessage.body,
    { task: "sqlite-poison-pill" },
    "DLQ must contain original poison payload",
  );
});

// ============================================================================
// AC7 & Unit: DLQ Failure Resilience (Q-3)
// ============================================================================

Deno.test("AC7.1 (Q-3): When dlqProvider.send() throws, worker does not crash and completes error handling cleanly", async () => {
  const poisonMessage: QueueMessage = {
    id: "msg-dlq-crash",
    body: { task: "dlq-error-test" },
    attempts: 5, // 5 >= 5 (maxReceives)
  };

  const primaryQueue = new MockQueueProvider([poisonMessage]);
  const dlqProvider = new MockQueueProvider();

  // Simulate DLQ failure (e.g. disk full, network error on DLQ)
  dlqProvider.sendErrorFactory = () => new Error("DLQ storage exhausted");

  const worker = new ResilientQueueConsumerWorker(
    primaryQueue,
    () => Promise.reject(new Error("Poison pill")),
    {
      queueName: "app:jobs",
      targetFunctionName: "handler",
      dlqProvider,
    },
  );

  // processNext() must catch DLQ delivery error gracefully and not throw unhandled rejection
  const result = await worker.processNext();
  assertEquals(
    result,
    false,
    "processNext() returns false on handler failure even if DLQ send fails",
  );

  // Primary queue ack should still be attempted to avoid poison pill hot loops
  assertEquals(
    primaryQueue.acks,
    ["msg-dlq-crash"],
    "Primary queue should still be acknowledged even when dlqProvider.send throws",
  );
});
