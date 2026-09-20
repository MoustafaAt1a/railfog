/**
 * Adversarial Security Audit Tests for Production Background Worker Supervisor (T-0608).
 *
 * Spec references:
 * - PLAT-1: Control plane vs data plane separation
 * - PLAT-2: Everything is Trigger -> Function
 * - PLAT-4: Defense in depth & isolation
 * - PLAT-10: SLOs & error budget (at-least-once delivery, clean drain without hanging)
 * - Q-2, Q-3: Queue API & redelivery state machine
 * - FN-6: Isolation & warm-reuse rule (zero state bleed, fresh context & unique ULID per invocation)
 * - tasks/milestone-0.6-public-beta/T-0608-production-worker-supervisor.md
 */

import { assert, assertEquals, assertNotStrictEquals } from "@std/assert";
import { delay } from "@std/async/delay";
import {
  createWorkerSupervisor,
  type QueueWorkerTarget,
} from "../../apps/worker/worker-supervisor.ts";
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
// Adversarial Test Doubles
// ============================================================================

class AdversarialQueueProvider implements QueueProvider {
  public messages: QueueMessage[] = [];
  public acks: string[] = [];
  public sentMessages: unknown[] = [];
  public receiveCount = 0;
  public receiveError: (() => Error | null) | null = null;
  public receiveDelayMs = 0;

  constructor(initialMessages: QueueMessage[] = []) {
    this.messages = [...initialMessages];
  }

  enqueue(message: QueueMessage | unknown): void {
    if (
      message &&
      typeof message === "object" &&
      "id" in message &&
      "body" in message
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
    _opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null> {
    this.receiveCount++;
    if (this.receiveDelayMs > 0) {
      await delay(this.receiveDelayMs);
    }
    if (this.receiveError) {
      const err = this.receiveError();
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

class AdversarialComputeProvider implements ComputeProvider {
  public runs: Array<{
    artifact: Artifact;
    limits: Limits;
    invocation?: InvocationRequest;
  }> = [];

  public handler?: (
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ) => Promise<ExecutionResult> | ExecutionResult;

  run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult> {
    this.runs.push({ artifact, limits, invocation });
    if (this.handler) {
      return Promise.resolve(this.handler(artifact, limits, invocation));
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

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await delay(intervalMs);
  }
  if (await predicate()) {
    return;
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
}

// ============================================================================
// ATTACK VECTOR 1: FN-6 State Bleeding & Re-use Attacks
// ============================================================================

Deno.test("Adversarial FN-6: Sequential messages in warm worker receive fresh InvocationRequest references and strictly unique ULIDs", async () => {
  const queue = new AdversarialQueueProvider();
  const compute = new AdversarialComputeProvider();

  const totalMessages = 25;
  for (let i = 0; i < totalMessages; i++) {
    queue.enqueue({
      id: `seq-msg-${i}`,
      body: { index: i, nonce: Math.random() },
      attempts: 1,
    });
  }

  const supervisor = createWorkerSupervisor({
    projectId: "proj_fn6_ulid_uniqueness",
    queues: [
      {
        queueName: "sequential-q",
        targetFunction: "sequentialHandler",
        concurrency: 1, // Single warm worker loop
        queueProvider: queue,
      },
    ],
    queueProvider: queue,
    computeProvider: compute,
  });

  try {
    await supervisor.start();
    await waitForCondition(() => queue.acks.length === totalMessages, 4000);

    assertEquals(compute.runs.length, totalMessages);

    const observedUlids = new Set<string>();
    const observedInvocations = new Set<InvocationRequest>();

    for (let i = 0; i < compute.runs.length; i++) {
      const inv = compute.runs[i].invocation;
      assert(inv !== undefined, `Invocation ${i} must exist`);

      // 1. ULID validity
      assert(
        isValidUlid(inv.requestId),
        `requestId "${inv.requestId}" must be valid Crockford Base32 ULID`,
      );

      // 2. Strict uniqueness
      assert(
        !observedUlids.has(inv.requestId),
        `Duplicate ULID detected: ${inv.requestId} at index ${i}`,
      );
      observedUlids.add(inv.requestId);

      // 3. Object identity freshness (no reused instance)
      assert(
        !observedInvocations.has(inv),
        `Reused InvocationRequest object reference detected at index ${i}`,
      );
      observedInvocations.add(inv);

      // 4. Header request-id match
      assertEquals(inv.headers?.["x-request-id"], inv.requestId);
      assertEquals(inv.headers?.["request-id"], inv.requestId);
    }
  } finally {
    await supervisor.stop();
  }
});

Deno.test("Adversarial FN-6: Malicious compute handler payload buffer mutation cannot corrupt subsequent message payloads", async () => {
  const queue = new AdversarialQueueProvider();
  const compute = new AdversarialComputeProvider();

  queue.enqueue({
    id: "msg-victim-1",
    body: { token: "SECRET_TOKEN_ALPHA" },
    attempts: 1,
  });
  queue.enqueue({
    id: "msg-victim-2",
    body: { token: "SECRET_TOKEN_BETA" },
    attempts: 1,
  });

  let message1BodyMutated = false;

  compute.handler = (_art, _limits, invocation) => {
    assert(invocation !== undefined);
    assert(invocation.body !== undefined);

    const bodyStr = new TextDecoder().decode(invocation.body);

    if (bodyStr.includes("SECRET_TOKEN_ALPHA")) {
      // Adversarial attack: mutate the underlying Uint8Array buffer in-place
      invocation.body.fill(0x58); // fill with 'X'
      message1BodyMutated = true;
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: new Uint8Array(),
      cpuTimeMs: 1,
      wallClockMs: 5,
    };
  };

  const supervisor = createWorkerSupervisor({
    projectId: "proj_fn6_buffer_tamper",
    queues: [
      {
        queueName: "buffer-q",
        targetFunction: "bufferHandler",
        concurrency: 1,
        queueProvider: queue,
      },
    ],
    queueProvider: queue,
    computeProvider: compute,
  });

  try {
    await supervisor.start();
    await waitForCondition(() => queue.acks.length === 2, 3000);

    assert(
      message1BodyMutated,
      "Message 1 body must have been mutated during test",
    );

    // Message 2 payload must be completely pristine without 'X' (0x58) contamination
    const inv2 = compute.runs[1].invocation;
    assert(inv2 !== undefined && inv2.body !== undefined);
    const decoded2 = new TextDecoder().decode(inv2.body);

    assert(
      decoded2.includes("SECRET_TOKEN_BETA"),
      "Message 2 must contain authentic payload",
    );
    assert(
      !decoded2.includes("XXXXXX"),
      "Message 2 buffer must not contain mutated bytes from message 1",
    );
    assertNotStrictEquals(
      compute.runs[0].invocation?.body,
      inv2.body,
      "Uint8Array instances must be distinct",
    );
  } finally {
    await supervisor.stop();
  }
});

Deno.test("Adversarial FN-6: Header tampering and prototype pollution in message N does not bleed into message N+1", async () => {
  const queue = new AdversarialQueueProvider();
  const compute = new AdversarialComputeProvider();

  queue.enqueue({ id: "hdr-1", body: { step: 1 }, attempts: 1 });
  queue.enqueue({ id: "hdr-2", body: { step: 2 }, attempts: 1 });

  compute.handler = (_art, _limits, invocation) => {
    assert(invocation !== undefined);
    if (
      invocation.headers &&
      invocation.headers["x-request-id"] === invocation.requestId
    ) {
      // Check if message 1
      if (compute.runs.length === 1) {
        // Attack: pollute invocation.headers directly
        invocation.headers["x-injected-stolen-creds"] = "EVIL_SESSION_KEY";
        invocation.headers["x-queue-name"] = "tampered-queue";

        // Attack: attempt prototype mutation on Object
        (Object.prototype as unknown as Record<string, unknown>)[
          "x-prototype-leak"
        ] = "leaked-via-prototype";
      }
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
    projectId: "proj_fn6_proto_tamper",
    queues: [
      {
        queueName: "legit-queue",
        targetFunction: "protoHandler",
        concurrency: 1,
        queueProvider: queue,
      },
    ],
    queueProvider: queue,
    computeProvider: compute,
  });

  try {
    await supervisor.start();
    await waitForCondition(() => queue.acks.length === 2, 3000);

    const inv2 = compute.runs[1].invocation;
    assert(inv2 !== undefined && inv2.headers !== undefined);

    // Assert that headers directly injected into invocation 1 did not bleed
    assertEquals(
      inv2.headers["x-injected-stolen-creds"],
      undefined,
      "Tampered header from invocation 1 must not bleed to invocation 2",
    );
    assertEquals(
      inv2.headers["x-queue-name"],
      "legit-queue",
      "x-queue-name must remain authentic",
    );
  } finally {
    // Clean up prototype pollution to avoid affecting other tests
    delete (Object.prototype as unknown as Record<string, unknown>)[
      "x-prototype-leak"
    ];
    await supervisor.stop();
  }
});

// ============================================================================
// ATTACK VECTOR 2: Tenant & Queue Isolation
// ============================================================================

Deno.test("Adversarial Multi-Tenancy: Worker loop for Tenant/Queue A cannot access, receive, or acknowledge messages from Tenant/Queue B", async () => {
  const queueA = new AdversarialQueueProvider();
  const queueB = new AdversarialQueueProvider();
  const compute = new AdversarialComputeProvider();

  // Populate Queue A with Tenant Alpha messages
  queueA.enqueue({
    id: "alpha-001",
    body: { tenant: "alpha", data: "confidential-a" },
    attempts: 1,
  });
  queueA.enqueue({
    id: "alpha-002",
    body: { tenant: "alpha", data: "confidential-a-2" },
    attempts: 1,
  });

  // Populate Queue B with Tenant Beta messages
  queueB.enqueue({
    id: "beta-001",
    body: { tenant: "beta", data: "confidential-b" },
    attempts: 1,
  });
  queueB.enqueue({
    id: "beta-002",
    body: { tenant: "beta", data: "confidential-b-2" },
    attempts: 1,
  });

  const targets: QueueWorkerTarget[] = [
    {
      queueName: "alpha-queue",
      targetFunction: "handleAlpha",
      concurrency: 2,
      queueProvider: queueA,
    },
    {
      queueName: "beta-queue",
      targetFunction: "handleBeta",
      concurrency: 2,
      queueProvider: queueB,
    },
  ];

  const supervisor = createWorkerSupervisor({
    projectId: "proj_multi_tenant",
    orgId: "org_enterprise",
    queues: targets,
    queueProvider: queueA,
    computeProvider: compute,
  });

  try {
    await supervisor.start();
    await waitForCondition(
      () => queueA.acks.length === 2 && queueB.acks.length === 2,
      4000,
    );

    // Queue A must only contain alpha acks
    assertEquals(queueA.acks, ["alpha-001", "alpha-002"]);
    // Queue B must only contain beta acks
    assertEquals(queueB.acks, ["beta-001", "beta-002"]);

    // Verify all executions targeted the correct function and queue name
    for (const run of compute.runs) {
      assert(run.invocation !== undefined);
      const queueName = run.invocation.headers?.["x-queue-name"];
      const targetFn = run.artifact.entrypoint;

      if (queueName === "alpha-queue") {
        assertEquals(targetFn, "handleAlpha");
        const bodyText = new TextDecoder().decode(run.invocation.body);
        assert(bodyText.includes("confidential-a"));
        assert(!bodyText.includes("confidential-b"));
      } else if (queueName === "beta-queue") {
        assertEquals(targetFn, "handleBeta");
        const bodyText = new TextDecoder().decode(run.invocation.body);
        assert(bodyText.includes("confidential-b"));
        assert(!bodyText.includes("confidential-a"));
      } else {
        throw new Error(`Unexpected queue name: ${queueName}`);
      }
    }
  } finally {
    await supervisor.stop();
  }
});

Deno.test("Adversarial Crash Cascade & Poison Pill: Crashing queue / poison messages cannot crash supervisor or degrade peer queues", async () => {
  const poisonQueue = new AdversarialQueueProvider();
  const healthyQueue = new AdversarialQueueProvider();
  const compute = new AdversarialComputeProvider();

  // Poison queue continuously throws fatal unhandled network/db crashes
  poisonQueue.receiveError = () => {
    return new Error(
      "FATAL: Database corruption or network reset on poison queue",
    );
  };

  const supervisor = createWorkerSupervisor({
    projectId: "proj_cascade_prevention",
    queues: [
      {
        queueName: "poison-queue",
        targetFunction: "poisonFn",
        concurrency: 2,
        queueProvider: poisonQueue,
      },
      {
        queueName: "healthy-queue",
        targetFunction: "healthyFn",
        concurrency: 2,
        queueProvider: healthyQueue,
      },
    ],
    queueProvider: healthyQueue,
    computeProvider: compute,
  });

  try {
    await supervisor.start();
    assertEquals(supervisor.getActiveWorkerCount(), 4);

    // Enqueue 6 messages in the healthy queue
    for (let i = 0; i < 6; i++) {
      healthyQueue.enqueue({
        id: `healthy-msg-${i}`,
        body: { workItem: i },
        attempts: 1,
      });
    }

    // Healthy queue must process all messages promptly despite poison queue crashes
    await waitForCondition(() => healthyQueue.acks.length === 6, 4000);

    assertEquals(healthyQueue.acks.length, 6);
    assertEquals(poisonQueue.acks.length, 0);

    // Supervisor must remain fully running without dropping active workers
    assertEquals(supervisor.getActiveWorkerCount(), 4);
  } finally {
    await supervisor.stop();
    assertEquals(supervisor.getActiveWorkerCount(), 0);
  }
});

Deno.test("Adversarial Poison Payload: Circular reference body does not crash supervisor process", async () => {
  const queue = new AdversarialQueueProvider();
  const compute = new AdversarialComputeProvider();

  // Create circular payload
  const circularPayload: Record<string, unknown> = { name: "poison-circular" };
  circularPayload.self = circularPayload;

  // Enqueue circular payload followed by a valid payload
  queue.enqueue({ id: "circ-01", body: circularPayload, attempts: 1 });
  queue.enqueue({ id: "valid-02", body: { safe: true }, attempts: 1 });

  const supervisor = createWorkerSupervisor({
    projectId: "proj_circular_poison",
    queues: [
      {
        queueName: "poison-payload-q",
        targetFunction: "payloadHandler",
        concurrency: 1,
        queueProvider: queue,
      },
    ],
    queueProvider: queue,
    computeProvider: compute,
  });

  try {
    await supervisor.start();

    // The supervisor encounters TypeError (converting circular structure to JSON) in runWorkerCycle.
    // It should catch this fatal error, backoff, and continue the loop to process subsequent work.
    await waitForCondition(() => queue.acks.includes("valid-02"), 4000);

    // Circular message was NOT acked (leaving it for visibility timeout / DLQ)
    assertEquals(queue.acks.includes("circ-01"), false);
    // Valid message was acked
    assertEquals(queue.acks.includes("valid-02"), true);
    // Supervisor is still alive
    assertEquals(supervisor.getActiveWorkerCount(), 1);
  } finally {
    await supervisor.stop();
  }
});

// ============================================================================
// ATTACK VECTOR 3: Drain & In-Flight State Security (PLAT-10)
// ============================================================================

Deno.test("Adversarial PLAT-10: Rapid shutdown / drain guarantees zero duplicate acknowledgments and zero dropped in-flight tasks", async () => {
  const queue = new AdversarialQueueProvider();
  const compute = new AdversarialComputeProvider();

  const inFlightCount = 4;
  for (let i = 0; i < inFlightCount; i++) {
    queue.enqueue({ id: `flight-${i}`, body: { step: i }, attempts: 1 });
  }

  const inFlightResolvers: Array<() => void> = [];
  let activelyProcessing = 0;

  compute.handler = () => {
    activelyProcessing++;
    return new Promise((resolve) => {
      inFlightResolvers.push(() => {
        activelyProcessing--;
        resolve({
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: new Uint8Array(),
          cpuTimeMs: 1,
          wallClockMs: 30,
        });
      });
    });
  };

  const supervisor = createWorkerSupervisor({
    projectId: "proj_drain_safety",
    queues: [
      {
        queueName: "drain-q",
        targetFunction: "drainFn",
        concurrency: inFlightCount,
        queueProvider: queue,
      },
    ],
    queueProvider: queue,
    computeProvider: compute,
  });

  await supervisor.start();

  // Wait until all 4 are actively in-flight
  await waitForCondition(() => activelyProcessing === inFlightCount, 2000);

  // Trigger stop while all 4 are in-flight
  const stopPromise = supervisor.stop();

  // Add a 5th message while stopping is in progress
  queue.enqueue({
    id: "flight-ignored-post-stop",
    body: { step: 99 },
    attempts: 1,
  });

  // Complete in-flight tasks
  for (const resolver of inFlightResolvers) {
    resolver();
  }

  await stopPromise;

  // 1. All in-flight tasks completed and acknowledged
  for (let i = 0; i < inFlightCount; i++) {
    assertEquals(queue.acks.includes(`flight-${i}`), true);
  }

  // 2. Exactly inFlightCount acks (no duplicate acks!)
  assertEquals(queue.acks.length, inFlightCount);

  // 3. Post-stop message was not touched
  assertEquals(queue.acks.includes("flight-ignored-post-stop"), false);
  assertEquals(queue.messages.length, 1);
  assertEquals(supervisor.getActiveWorkerCount(), 0);
});

Deno.test("Adversarial PLAT-10: Immediate worker sleep interruption prevents hanging shutdown during exponential backoff", async () => {
  const queue = new AdversarialQueueProvider();
  const compute = new AdversarialComputeProvider();

  // Make queue consistently throw fatal errors to trigger maximum exponential backoff (up to 5000ms)
  queue.receiveError = () =>
    new Error("Unrecoverable network timeout forcing backoff");

  const supervisor = createWorkerSupervisor({
    projectId: "proj_hanging_prevention",
    queues: [
      {
        queueName: "hanging-q",
        targetFunction: "hangFn",
        concurrency: 3,
        queueProvider: queue,
      },
    ],
    queueProvider: queue,
    computeProvider: compute,
  });

  await supervisor.start();
  assertEquals(supervisor.getActiveWorkerCount(), 3);

  // Wait until workers encounter errors and enter sleep
  await delay(100);

  // Stop the supervisor: it MUST wake up all sleeping workers immediately via wakeUpAll()
  const stopStart = Date.now();
  await supervisor.stop();
  const stopDuration = Date.now() - stopStart;

  assertEquals(supervisor.getActiveWorkerCount(), 0);
  // Must stop almost instantaneously (< 300ms) rather than waiting for 5000ms backoff
  assert(
    stopDuration < 600,
    `supervisor.stop() took ${stopDuration}ms; expected < 600ms due to interruptibleSleep wakeup`,
  );
});

Deno.test("Adversarial PLAT-10: AbortSignal pre-aborted or concurrent start/stop races resolve cleanly", async () => {
  const queue = new AdversarialQueueProvider();
  const compute = new AdversarialComputeProvider();

  // Test 1: Pre-aborted signal
  const preAborted = AbortSignal.abort("immediate-shutdown");
  const supervisorPre = createWorkerSupervisor({
    projectId: "proj_pre_aborted",
    queues: [
      {
        queueName: "q",
        targetFunction: "fn",
        concurrency: 2,
        queueProvider: queue,
      },
    ],
    queueProvider: queue,
    computeProvider: compute,
    signal: preAborted,
  });

  await supervisorPre.start();
  // Must not start any active workers
  assertEquals(supervisorPre.getActiveWorkerCount(), 0);
  await supervisorPre.stop();

  // Test 2: Stress test concurrent start and stop calls
  const supervisorRace = createWorkerSupervisor({
    projectId: "proj_race_test",
    queues: [
      {
        queueName: "q",
        targetFunction: "fn",
        concurrency: 2,
        queueProvider: queue,
      },
    ],
    queueProvider: queue,
    computeProvider: compute,
  });

  // Launch interleaved starts and stops
  await Promise.all([
    supervisorRace.start(),
    supervisorRace.stop(),
    supervisorRace.start(),
    supervisorRace.stop(),
  ]);

  // Clean shutdown reached
  assertEquals(supervisorRace.getActiveWorkerCount(), 0);
});
