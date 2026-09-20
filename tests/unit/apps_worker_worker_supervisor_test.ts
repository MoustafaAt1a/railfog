/**
 * Production Background Worker Supervisor Integration & Security Tests (T-0608).
 *
 * Spec references:
 * - PLAT-1: Control plane vs data plane separation.
 * - PLAT-2: Everything is Trigger -> Function (queues target Functions directly, no separate worker daemon service).
 * - PLAT-10: SLOs & error budget (queue at-least-once delivery guarantee, clean shutdown without hanging).
 * - Q-2: Queue API (send, sendBatch, receive, ack, message structure).
 * - Q-3: Redelivery model (visibility timeout, max_receives = 5, DLQ routing).
 * - Q-5: Retries & backoff (exponential backoff with decorrelated jitter, base = 100ms, cap = 20s).
 * - FN-2: Triggers targeting Functions (Queue triggers dispatch into Functions).
 * - FN-6: Isolation & warm-reuse rule (fresh context and bindings per invocation, zero state bleeding).
 * - tasks/milestone-0.6-public-beta/T-0608-production-worker-supervisor.md
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertGreaterOrEqual,
  assertNotEquals,
  assertNotStrictEquals,
} from "@std/assert";
import type {
  QueueWorkerTarget,
  WorkerSupervisor,
  WorkerSupervisorOptions,
} from "../../apps/worker/worker-supervisor.ts";
import { createWorkerSupervisor } from "../../apps/worker/worker-supervisor.ts";
import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";
import type {
  Artifact,
  ComputeProvider,
  ExecutionResult,
  InvocationRequest,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import { isValidUlid } from "../../packages/core/id/ulid.ts";

// ============================================================================
// Test Doubles & Utilities
// ============================================================================

/**
 * Mock QueueProvider supporting controllable queues, delays, errors, and call telemetry.
 * spec: contracts/queues.contract.md#Q-2, Q-3
 */
class MockQueueProvider implements QueueProvider {
  public messages: QueueMessage[] = [];
  public acks: string[] = [];
  public sentMessages: unknown[] = [];
  public receiveCalls: { visibilityTimeoutMs?: number; timestamp: number }[] =
    [];
  public receiveErrorFactory: (() => Error | null) | null = null;
  public receiveDelayMs = 0;

  constructor(initialMessages: QueueMessage[] = []) {
    this.messages = [...initialMessages];
  }

  enqueue(message: QueueMessage | unknown): void {
    if (
      message &&
      typeof message === "object" &&
      "id" in message &&
      "body" in message &&
      "attempts" in message
    ) {
      this.messages.push(message as QueueMessage);
    } else {
      this.messages.push({
        id: "msg-" + Math.random().toString(36).slice(2, 9),
        body: message,
        attempts: 1,
      });
    }
  }

  send(body: unknown, _opts?: { delay?: number }): Promise<{ id: string }> {
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

  async receive(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null> {
    this.receiveCalls.push({
      visibilityTimeoutMs: opts?.visibilityTimeoutMs,
      timestamp: Date.now(),
    });
    if (this.receiveDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.receiveDelayMs));
    }
    if (this.receiveErrorFactory) {
      const err = this.receiveErrorFactory();
      if (err) {
        throw err;
      }
    }
    return this.messages.shift() ?? null;
  }

  ack(id: string): Promise<void> {
    this.acks.push(id);
    return Promise.resolve();
  }
}

/**
 * Record of an invocation executed by MockComputeProvider.
 * spec: contracts/platform.contract.md#PLAT-4, FN-6
 */
interface RecordedInvocation {
  artifact: Artifact;
  limits: Limits;
  invocation?: InvocationRequest;
  timestamp: number;
}

/**
 * Mock ComputeProvider tracking execution calls, limits, and invocation requests.
 * spec: contracts/platform.contract.md#PLAT-4, PLAT-16, FN-6
 */
class MockComputeProvider implements ComputeProvider {
  public runs: RecordedInvocation[] = [];
  public customHandler?: (
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ) => Promise<ExecutionResult> | ExecutionResult;

  run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult> {
    this.runs.push({
      artifact,
      limits,
      invocation,
      timestamp: Date.now(),
    });

    if (this.customHandler) {
      return Promise.resolve(this.customHandler(artifact, limits, invocation));
    }

    return Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: new Uint8Array(),
      cpuTimeMs: 1,
      wallClockMs: 2,
    });
  }
}

/**
 * Helper to poll predicate until truthy or timeout.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (await predicate()) {
    return;
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ============================================================================
// AC1: Multi-Worker Concurrency & Startup (PLAT-2, FN-2)
// ============================================================================

Deno.test("AC1: spawns dedicated worker loops matching declared concurrency per queue (PLAT-2, FN-2)", async () => {
  const ordersQueue = new MockQueueProvider();
  const emailsQueue = new MockQueueProvider();
  const defaultQueue = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();

  // Configure supervisor with multiple queue targets:
  // queue "orders" with concurrency: 2, queue "emails" with concurrency: 3.
  const queueTargets: QueueWorkerTarget[] = [
    {
      queueName: "orders",
      targetFunction: "processOrders",
      concurrency: 2,
      queueProvider: ordersQueue,
    },
    {
      queueName: "emails",
      targetFunction: "sendEmails",
      concurrency: 3,
      queueProvider: emailsQueue,
    },
  ];

  const options: WorkerSupervisorOptions = {
    projectId: "proj_ac1_startup",
    queues: queueTargets,
    queueProvider: defaultQueue,
    computeProvider,
  };

  const supervisor: WorkerSupervisor = createWorkerSupervisor(options);

  try {
    // Call supervisor.start()
    await supervisor.start();

    // Assert supervisor.getActiveWorkerCount() === 5 (2 + 3)
    assertEquals(supervisor.getActiveWorkerCount(), 5);

    // Calling start() again should be idempotent
    await supervisor.start();
    assertEquals(supervisor.getActiveWorkerCount(), 5);

    // Enqueue messages across both queues
    ordersQueue.enqueue({ id: "ord-1", body: { item: "book" }, attempts: 1 });
    ordersQueue.enqueue({ id: "ord-2", body: { item: "pen" }, attempts: 1 });
    emailsQueue.enqueue({
      id: "eml-1",
      body: { to: "alice@example.com" },
      attempts: 1,
    });
    emailsQueue.enqueue({
      id: "eml-2",
      body: { to: "bob@example.com" },
      attempts: 1,
    });

    // Wait for all messages across both queues to be processed and acknowledged
    await waitFor(
      () => ordersQueue.acks.length === 2 && emailsQueue.acks.length === 2,
      3000,
      20,
    );

    assertEquals(ordersQueue.acks, ["ord-1", "ord-2"]);
    assertEquals(emailsQueue.acks, ["eml-1", "eml-2"]);
    assertEquals(computeProvider.runs.length, 4);
  } finally {
    await supervisor.stop();
    assertEquals(supervisor.getActiveWorkerCount(), 0);
  }
});

Deno.test("AC1: Concurrent execution - verifies workers process queue messages concurrently across queues (PLAT-2, FN-2)", async () => {
  const ordersQueue = new MockQueueProvider();
  const emailsQueue = new MockQueueProvider();
  const defaultQueue = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();

  let currentConcurrency = 0;
  let maxObservedConcurrency = 0;

  // Custom handler that introduces non-zero duration to measure concurrency
  computeProvider.customHandler = async () => {
    currentConcurrency++;
    if (currentConcurrency > maxObservedConcurrency) {
      maxObservedConcurrency = currentConcurrency;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    currentConcurrency--;
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: new Uint8Array(),
      cpuTimeMs: 1,
      wallClockMs: 50,
    };
  };

  const supervisor = createWorkerSupervisor({
    projectId: "proj_ac1_concurrency",
    queues: [
      {
        queueName: "orders",
        targetFunction: "processOrders",
        concurrency: 2,
        queueProvider: ordersQueue,
      },
      {
        queueName: "emails",
        targetFunction: "sendEmails",
        concurrency: 2,
        queueProvider: emailsQueue,
      },
    ],
    queueProvider: defaultQueue,
    computeProvider,
  });

  try {
    // Pre-populate queues with 2 messages each
    ordersQueue.enqueue({ id: "ord-c1", body: { orderId: 101 }, attempts: 1 });
    ordersQueue.enqueue({ id: "ord-c2", body: { orderId: 102 }, attempts: 1 });
    emailsQueue.enqueue({ id: "eml-c1", body: { emailId: 201 }, attempts: 1 });
    emailsQueue.enqueue({ id: "eml-c2", body: { emailId: 202 }, attempts: 1 });

    await supervisor.start();
    assertEquals(supervisor.getActiveWorkerCount(), 4);

    // Wait for all 4 messages to complete
    await waitFor(
      () => ordersQueue.acks.length === 2 && emailsQueue.acks.length === 2,
      4000,
      25,
    );

    // Verify concurrent execution occurred (> 1 active execution concurrently)
    assertGreaterOrEqual(maxObservedConcurrency, 2);
  } finally {
    await supervisor.stop();
  }
});

// ============================================================================
// AC2: Crash Recovery & Exponential Backoff
// ============================================================================

Deno.test("AC2: Crash recovery - worker restarts automatically with backoff after fatal error without crashing supervisor", async () => {
  const faultyQueue = new MockQueueProvider();
  const defaultQueue = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();

  let receiveAttempts = 0;
  // Fail the first 2 receives with an unexpected fatal error
  faultyQueue.receiveErrorFactory = () => {
    receiveAttempts++;
    if (receiveAttempts <= 2) {
      return new Error("Unexpected network connection reset (EPIPE)");
    }
    return null;
  };

  const supervisor = createWorkerSupervisor({
    projectId: "proj_ac2_crash_recovery",
    queues: [
      {
        queueName: "critical-tasks",
        targetFunction: "handleTask",
        concurrency: 1,
        queueProvider: faultyQueue,
      },
    ],
    queueProvider: defaultQueue,
    computeProvider,
  });

  try {
    await supervisor.start();
    assertEquals(supervisor.getActiveWorkerCount(), 1);

    // Enqueue a message that should be processed once the worker recovers
    faultyQueue.enqueue({
      id: "recovered-msg-1",
      body: { task: "sync-data" },
      attempts: 1,
    });

    // Wait for supervisor to restart the crashed worker, survive the crash, and process the message
    await waitFor(() => faultyQueue.acks.length === 1, 4000, 30);

    assertEquals(faultyQueue.acks, ["recovered-msg-1"]);
    assertEquals(computeProvider.runs.length, 1);
    // Worker must still be active and polling
    assertEquals(supervisor.getActiveWorkerCount(), 1);
  } finally {
    await supervisor.stop();
    assertEquals(supervisor.getActiveWorkerCount(), 0);
  }
});

Deno.test("AC2: Crash recovery isolation - crashed worker does not interrupt or degrade peer active workers (PLAT-2, PLAT-10)", async () => {
  const stableQueue = new MockQueueProvider();
  const crashingQueue = new MockQueueProvider();
  const defaultQueue = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();

  // Crashing queue consistently throws fatal errors
  crashingQueue.receiveErrorFactory = () => {
    return new Error("Unrecoverable database partition fault");
  };

  const supervisor = createWorkerSupervisor({
    projectId: "proj_ac2_isolation",
    queues: [
      {
        queueName: "stable-queue",
        targetFunction: "handleStable",
        concurrency: 2,
        queueProvider: stableQueue,
      },
      {
        queueName: "crashing-queue",
        targetFunction: "handleCrashing",
        concurrency: 1,
        queueProvider: crashingQueue,
      },
    ],
    queueProvider: defaultQueue,
    computeProvider,
  });

  try {
    await supervisor.start();
    // Total 3 workers running: 2 stable, 1 crashing
    assertEquals(supervisor.getActiveWorkerCount(), 3);

    // Enqueue multiple messages into stableQueue
    stableQueue.enqueue({ id: "st-1", body: { step: 1 }, attempts: 1 });
    stableQueue.enqueue({ id: "st-2", body: { step: 2 }, attempts: 1 });
    stableQueue.enqueue({ id: "st-3", body: { step: 3 }, attempts: 1 });

    // Stable queue messages must process without interruption
    await waitFor(() => stableQueue.acks.length === 3, 3000, 25);

    assertEquals(stableQueue.acks, ["st-1", "st-2", "st-3"]);
    // Stable workers must remain operational
    assertGreaterOrEqual(supervisor.getActiveWorkerCount(), 2);
  } finally {
    await supervisor.stop();
    assertEquals(supervisor.getActiveWorkerCount(), 0);
  }
});

// ============================================================================
// AC3: Graceful Drain and Clean Shutdown (PLAT-10)
// ============================================================================

Deno.test("AC3: Graceful drain - completes in-flight tasks and acknowledges them before stopping (PLAT-10)", async () => {
  const drainQueue = new MockQueueProvider();
  const defaultQueue = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();

  let inFlightCount = 0;
  const inFlightResolvers: Array<() => void> = [];

  computeProvider.customHandler = () => {
    inFlightCount++;
    return new Promise((resolve) => {
      inFlightResolvers.push(() => {
        inFlightCount--;
        resolve({
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: new Uint8Array(),
          cpuTimeMs: 2,
          wallClockMs: 50,
        });
      });
    });
  };

  const supervisor = createWorkerSupervisor({
    projectId: "proj_ac3_drain",
    queues: [
      {
        queueName: "drain-queue",
        targetFunction: "processLongRunning",
        concurrency: 2,
        queueProvider: drainQueue,
      },
    ],
    queueProvider: defaultQueue,
    computeProvider,
  });

  await supervisor.start();
  assertEquals(supervisor.getActiveWorkerCount(), 2);

  // Enqueue 2 initial messages that start processing
  drainQueue.enqueue({ id: "flight-1", body: { n: 1 }, attempts: 1 });
  drainQueue.enqueue({ id: "flight-2", body: { n: 2 }, attempts: 1 });

  // Wait until both messages are actively in-flight
  await waitFor(() => inFlightCount === 2, 2000, 20);

  // While in-flight processing is active, trigger supervisor.stop()
  const stopPromise = supervisor.stop();

  // Enqueue a 3rd message AFTER stop() has been initiated
  drainQueue.enqueue({
    id: "flight-3-after-stop",
    body: { n: 3 },
    attempts: 1,
  });

  // Release the in-flight tasks so they complete
  for (const resolveTask of inFlightResolvers) {
    resolveTask();
  }

  // Await supervisor.stop() to finish draining
  await stopPromise;

  // Assert supervisor.getActiveWorkerCount() === 0
  assertEquals(supervisor.getActiveWorkerCount(), 0);

  // Assert in-flight messages completed successfully and were acknowledged
  assertEquals(drainQueue.acks.includes("flight-1"), true);
  assertEquals(drainQueue.acks.includes("flight-2"), true);

  // Assert that no new messages are received or acknowledged after stop() is called
  assertEquals(drainQueue.acks.includes("flight-3-after-stop"), false);
  assertEquals(drainQueue.messages.length, 1);
});

Deno.test("AC3: Graceful shutdown - AbortSignal triggers clean supervisor shutdown and drains workers (PLAT-10)", async () => {
  const queueProvider = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();
  const controller = new AbortController();

  let messageProcessingStarted = false;
  let finishProcessing: () => void = () => {};

  computeProvider.customHandler = () => {
    messageProcessingStarted = true;
    return new Promise((resolve) => {
      finishProcessing = () => {
        resolve({
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: new Uint8Array(),
          cpuTimeMs: 1,
          wallClockMs: 30,
        });
      };
    });
  };

  const supervisor = createWorkerSupervisor({
    projectId: "proj_ac3_abort_signal",
    queues: [
      {
        queueName: "signal-queue",
        targetFunction: "handleSignal",
        concurrency: 1,
        queueProvider,
      },
    ],
    queueProvider,
    computeProvider,
    signal: controller.signal,
  });

  await supervisor.start();
  assertEquals(supervisor.getActiveWorkerCount(), 1);

  // Enqueue message
  queueProvider.enqueue({
    id: "sig-msg-1",
    body: { step: "work" },
    attempts: 1,
  });

  // Wait for processing to begin
  await waitFor(() => messageProcessingStarted, 2000, 20);

  // Trigger AbortSignal
  controller.abort();

  // Complete the in-flight message
  finishProcessing();

  // Wait for supervisor to automatically shut down to 0 active workers
  await waitFor(() => supervisor.getActiveWorkerCount() === 0, 3000, 25);

  assertEquals(supervisor.getActiveWorkerCount(), 0);
  assertEquals(queueProvider.acks, ["sig-msg-1"]);
});

Deno.test("AC3: Shutdown idempotency - multiple stop() calls and stop() before start() resolve cleanly", async () => {
  const queueProvider = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();

  const supervisor = createWorkerSupervisor({
    projectId: "proj_ac3_idempotency",
    queues: [
      {
        queueName: "idem-queue",
        targetFunction: "handleIdem",
        concurrency: 2,
        queueProvider,
      },
    ],
    queueProvider,
    computeProvider,
  });

  // Calling stop() before start() must resolve without throwing
  await supervisor.stop();
  assertEquals(supervisor.getActiveWorkerCount(), 0);

  // Start supervisor
  await supervisor.start();
  assertEquals(supervisor.getActiveWorkerCount(), 2);

  // Concurrent stop() calls must both resolve cleanly
  await Promise.all([supervisor.stop(), supervisor.stop()]);
  assertEquals(supervisor.getActiveWorkerCount(), 0);

  // Stop when already stopped
  await supervisor.stop();
  assertEquals(supervisor.getActiveWorkerCount(), 0);
});

// ============================================================================
// AC4 & Security: Warm Isolate Context Freshness & Zero State Bleed (FN-6)
// ============================================================================

Deno.test("AC4 & Security: consecutive invocations receive fresh ULID requestId and distinct context without state bleeding (FN-6)", async () => {
  const queueProvider = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();

  const capturedInvocations: InvocationRequest[] = [];

  // Handler intentionally mutates incoming InvocationRequest headers to test zero state bleed
  computeProvider.customHandler = (_artifact, _limits, invocation) => {
    assertExists(
      invocation,
      "InvocationRequest must be passed to computeProvider.run",
    );
    capturedInvocations.push(invocation);

    // Deliberate mutation of invocation headers in invocation 1 to test potential state bleed across warm isolates
    if (invocation.headers && capturedInvocations.length === 1) {
      invocation.headers["x-tampered-leak"] = "dirty-session-token-999";
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: new Uint8Array(),
      cpuTimeMs: 1,
      wallClockMs: 2,
    };
  };

  const supervisor = createWorkerSupervisor({
    projectId: "proj_ac4_security_isolation",
    queues: [
      {
        queueName: "secure-queue",
        targetFunction: "processSecureJob",
        concurrency: 1, // Single worker processing jobs consecutively in the same isolate/loop
        queueProvider,
      },
    ],
    queueProvider,
    computeProvider,
  });

  try {
    await supervisor.start();

    // Enqueue 3 consecutive messages
    queueProvider.enqueue({
      id: "sec-1",
      body: { tenant: "tenant-A" },
      attempts: 1,
    });
    queueProvider.enqueue({
      id: "sec-2",
      body: { tenant: "tenant-B" },
      attempts: 1,
    });
    queueProvider.enqueue({
      id: "sec-3",
      body: { tenant: "tenant-C" },
      attempts: 1,
    });

    // Wait for all 3 messages to complete
    await waitFor(() => queueProvider.acks.length === 3, 3000, 20);

    assertEquals(capturedInvocations.length, 3);

    const [inv1, inv2, inv3] = capturedInvocations;

    // FN-6 & PLAT-14: Assert each invocation receives a valid Crockford Base32 ULID requestId
    assert(
      isValidUlid(inv1.requestId),
      `inv1 requestId must be valid ULID: ${inv1.requestId}`,
    );
    assert(
      isValidUlid(inv2.requestId),
      `inv2 requestId must be valid ULID: ${inv2.requestId}`,
    );
    assert(
      isValidUlid(inv3.requestId),
      `inv3 requestId must be valid ULID: ${inv3.requestId}`,
    );

    // FN-6: Assert all request IDs are distinct
    assertNotEquals(inv1.requestId, inv2.requestId);
    assertNotEquals(inv2.requestId, inv3.requestId);
    assertNotEquals(inv1.requestId, inv3.requestId);

    // FN-6: Assert distinct InvocationRequest object instances (no object reference reuse)
    assertNotStrictEquals(inv1, inv2);
    assertNotStrictEquals(inv2, inv3);
    assertNotStrictEquals(inv1, inv3);

    // FN-6 Security: Mutating headers in invocation 1 must NOT bleed into invocation 2 or 3
    assertEquals(
      inv2.headers?.["x-tampered-leak"],
      undefined,
      "Invocation 2 must not retain mutated headers from Invocation 1",
    );
    assertEquals(
      inv3.headers?.["x-tampered-leak"],
      undefined,
      "Invocation 3 must not retain mutated headers from Invocation 1",
    );
  } finally {
    await supervisor.stop();
  }
});

Deno.test("AC4: Invocation dispatch - passes queue message payload, target function, and request metadata into ComputeProvider (PLAT-2, FN-2)", async () => {
  const queueProvider = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();

  const supervisor = createWorkerSupervisor({
    projectId: "proj_ac4_dispatch",
    queues: [
      {
        queueName: "tasks",
        targetFunction: "orderDispatcher",
        concurrency: 1,
        queueProvider,
      },
    ],
    queueProvider,
    computeProvider,
  });

  try {
    await supervisor.start();

    const testPayload = { action: "dispatch", trackingId: "trk-7788" };
    queueProvider.enqueue({
      id: "dispatch-msg-1",
      body: testPayload,
      attempts: 1,
    });

    await waitFor(() => queueProvider.acks.length === 1, 3000, 20);

    assertEquals(computeProvider.runs.length, 1);
    const run = computeProvider.runs[0];

    // Target function must be reflected in artifact entrypoint or id
    assert(
      run.artifact.entrypoint.includes("orderDispatcher") ||
        run.artifact.id.includes("orderDispatcher"),
      "Compute execution must target the declared targetFunction",
    );

    // Invocation request must contain valid requestId and payload
    assertExists(run.invocation);
    assert(isValidUlid(run.invocation.requestId));

    if (run.invocation.body) {
      const decoded = new TextDecoder().decode(run.invocation.body);
      assert(
        decoded.includes("trk-7788"),
        "Invocation request body must carry the queue message payload",
      );
    }
  } finally {
    await supervisor.stop();
  }
});

// ============================================================================
// Multi-Queue and Default Concurrency
// ============================================================================

Deno.test("Config & Default Concurrency: queue target without explicit concurrency defaults to 1", async () => {
  const queueProvider = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();

  const supervisor = createWorkerSupervisor({
    projectId: "proj_default_concurrency",
    queues: [
      {
        queueName: "unspecified-concurrency-queue",
        targetFunction: "singleWorkerFn",
        // concurrency omitted -> must default to 1 per interface spec
      },
    ],
    queueProvider,
    computeProvider,
  });

  try {
    await supervisor.start();
    assertEquals(supervisor.getActiveWorkerCount(), 1);
  } finally {
    await supervisor.stop();
    assertEquals(supervisor.getActiveWorkerCount(), 0);
  }
});

Deno.test("Config & Default Concurrency: zero queues configuration starts cleanly with 0 workers", async () => {
  const queueProvider = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();

  const supervisor = createWorkerSupervisor({
    projectId: "proj_empty_queues",
    queues: [],
    queueProvider,
    computeProvider,
  });

  try {
    await supervisor.start();
    assertEquals(supervisor.getActiveWorkerCount(), 0);
  } finally {
    await supervisor.stop();
    assertEquals(supervisor.getActiveWorkerCount(), 0);
  }
});

Deno.test("Config: multiple queue targets with mixed concurrency configuration sum correctly", async () => {
  const queueProvider = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();

  const supervisor = createWorkerSupervisor({
    projectId: "proj_mixed_concurrency",
    queues: [
      { queueName: "q-a", targetFunction: "fnA", concurrency: 2 },
      { queueName: "q-b", targetFunction: "fnB" }, // defaults to 1
      { queueName: "q-c", targetFunction: "fnC", concurrency: 4 },
    ],
    queueProvider,
    computeProvider,
  });

  try {
    await supervisor.start();
    // Expected: 2 + 1 + 4 = 7
    assertEquals(supervisor.getActiveWorkerCount(), 7);
  } finally {
    await supervisor.stop();
    assertEquals(supervisor.getActiveWorkerCount(), 0);
  }
});

Deno.test("Config: fallback queueProvider - workers default to options.queueProvider when target does not specify one", async () => {
  const sharedQueue = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();

  const supervisor = createWorkerSupervisor({
    projectId: "proj_shared_queue",
    queues: [
      {
        queueName: "general",
        targetFunction: "handleGeneral",
        concurrency: 2,
      },
    ],
    queueProvider: sharedQueue,
    computeProvider,
  });

  try {
    await supervisor.start();
    assertEquals(supervisor.getActiveWorkerCount(), 2);

    sharedQueue.enqueue({ id: "gen-1", body: { text: "shared" }, attempts: 1 });
    await waitFor(() => sharedQueue.acks.length === 1, 3000, 20);

    assertEquals(sharedQueue.acks, ["gen-1"]);
    assertEquals(computeProvider.runs.length, 1);
  } finally {
    await supervisor.stop();
    assertEquals(supervisor.getActiveWorkerCount(), 0);
  }
});

// ============================================================================
// Integration & Error Handling (Q-3)
// ============================================================================

Deno.test("Integration & Q-3: Compute provider failure leaves message unacknowledged for redelivery when attempts < maxReceives", async () => {
  const queueProvider = new MockQueueProvider();
  const computeProvider = new MockComputeProvider();

  // Compute provider fails execution
  computeProvider.customHandler = () => {
    throw new Error("Compute container out of memory / execution failure");
  };

  const supervisor = createWorkerSupervisor({
    projectId: "proj_compute_failure",
    queues: [
      {
        queueName: "fail-queue",
        targetFunction: "failingFn",
        concurrency: 1,
        queueProvider,
      },
    ],
    queueProvider,
    computeProvider,
  });

  try {
    await supervisor.start();

    // Message with attempts = 1 (< default maxReceives 5)
    queueProvider.enqueue({
      id: "failing-msg-1",
      body: { task: "will-fail" },
      attempts: 1,
    });

    // Wait for at least one receive call to have happened
    await waitFor(() => queueProvider.receiveCalls.length >= 1, 2000, 20);

    // Q-3: Message must NOT be acknowledged so that visibility timeout can expire and redeliver
    assertEquals(queueProvider.acks.includes("failing-msg-1"), false);
    // Supervisor must remain operational despite execution failure
    assertEquals(supervisor.getActiveWorkerCount(), 1);
  } finally {
    await supervisor.stop();
    assertEquals(supervisor.getActiveWorkerCount(), 0);
  }
});
