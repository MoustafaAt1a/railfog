// Spec references: FN-6 (Context & binding isolation), Q-3 (Redelivery state machine, poison-pill loop prevention), PLAT-2
// Task: T-0209 (Queue trigger consumer worker) adversarial security audit

import {
  assertEquals,
  assertNotEquals,
  assertNotStrictEquals,
} from "@std/assert";
import { delay } from "@std/async/delay";
import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";
import {
  type QueueConsumerOptions,
  QueueConsumerWorker,
} from "../../apps/worker/queue-consumer.ts";
import {
  buildContext,
  type LoadedFunctionMeta,
  type RailFogContext,
} from "../../runtime/loader/context-builder.ts";
import type { ResolvedBindings } from "../../packages/policy/permission-resolver.ts";

/**
 * Controllable MockQueueProvider for fault injection and state verification.
 */
class AdversarialMockQueueProvider implements QueueProvider {
  public messages: QueueMessage[] = [];
  public acks: string[] = [];
  public sentMessages: unknown[] = [];
  public receiveCalls: { visibilityTimeoutMs?: number }[] = [];
  public shouldFailSend = false;
  public shouldFailAck = false;

  constructor(initialMessages: QueueMessage[] = []) {
    this.messages = [...initialMessages];
  }

  send(body: unknown, _opts?: { delay?: number }): Promise<{ id: string }> {
    if (this.shouldFailSend) {
      return Promise.reject(new Error("DLQ infrastructure outage"));
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
    this.receiveCalls.push(opts || {});
    const msg = this.messages.shift() ?? null;
    return Promise.resolve(msg);
  }

  ack(id: string): Promise<void> {
    if (this.shouldFailAck) {
      return Promise.reject(new Error("Primary queue ACK timeout"));
    }
    this.acks.push(id);
    return Promise.resolve();
  }
}

// ===========================================================================
// ATTACK VECTOR 1: FN-6 (Context & Binding Isolation, Handler Mutation)
// ===========================================================================

Deno.test("Adversarial FN-6: handler mutations on message object cannot tamper with state machine or leak across invocations", async () => {
  const queue = new AdversarialMockQueueProvider([
    { id: "msg-01", body: { sensitive: "tenant-A" }, attempts: 5 },
    { id: "msg-02", body: { sensitive: "tenant-B" }, attempts: 1 },
  ]);
  const dlq = new AdversarialMockQueueProvider();

  let firstInvocationReceivedMessage: QueueMessage | null = null;

  const invokeFunction = async (
    _fn: string,
    msg: QueueMessage,
  ): Promise<void> => {
    if (!firstInvocationReceivedMessage) {
      firstInvocationReceivedMessage = msg;
      // Adversarial mutation attempt: try to tamper with attempts and id
      try {
        msg.attempts = 1;
      } catch {
        // TypeError expected if frozen
      }
      try {
        (msg as unknown as Record<string, unknown>).id = "tampered-id";
      } catch {
        // TypeError expected if frozen
      }
      throw new Error("Failure in message 1");
    }
    await delay(1);
  };

  const worker = new QueueConsumerWorker(queue, invokeFunction, {
    queueName: "tenant-queue",
    targetFunctionName: "tenantHandler",
    maxReceives: 5,
    dlqProvider: dlq,
  });

  // Process message 1: even though mutation was attempted, DLQ and ACK must use pristine values
  const res1 = await worker.processNext();
  assertEquals(res1, false);
  assertEquals(dlq.sentMessages.length, 1, "Poison message must reach DLQ");
  assertEquals(queue.acks, ["msg-01"], "Primary queue must ack original ID");

  // Process message 2: must succeed cleanly with its own message
  const res2 = await worker.processNext();
  assertEquals(res2, true);
  assertEquals(queue.acks, ["msg-01", "msg-02"], "Both messages cleanly acked");
});

Deno.test("Adversarial FN-6: multi-tenant context pollution does not bleed across consecutive queue messages", async () => {
  const queue = new AdversarialMockQueueProvider([
    { id: "tenant-1", body: { tenant: "alpha" }, attempts: 1 },
    { id: "tenant-2", body: { tenant: "beta" }, attempts: 1 },
  ]);

  const bindings: ResolvedBindings = {
    kv: {
      get: () => Promise.resolve("pristine-kv"),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve({ keys: [] }),
      atomic: () => {
        throw new Error();
      },
    },
    objects: {
      put: () => Promise.resolve({ etag: "mock" }),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      head: () => Promise.resolve(null),
      list: () => Promise.resolve({ keys: [] }),
      presign: () =>
        Promise.resolve({ url: "https://example.com", expiresAt: 0 }),
      createMultipartUpload: () => Promise.resolve({ uploadId: "mock" }),
    },
    queues: {
      send: () => Promise.resolve({ id: "mock" }),
      sendBatch: () => Promise.resolve([]),
      receive: () => Promise.resolve(null),
      ack: () => Promise.resolve(),
    },
  };

  const meta: LoadedFunctionMeta = {
    project: "shared-tenant",
    function: "consumer",
    revision: "v1",
  };

  const contexts: RailFogContext[] = [];
  let step = 0;

  const invokeFunction = async (
    _fn: string,
    _msg: QueueMessage,
  ): Promise<void> => {
    const ctx = buildContext(meta, bindings);
    contexts.push(ctx);
    step++;

    if (step === 1) {
      // Adversarial pollution in tenant 1
      (ctx as unknown as Record<string, unknown>).leakedSecret =
        "SECRET_TOKEN_ALPHA";
      ctx.kv.get = () => Promise.resolve("POLLUTED_KV");
      (ctx.env as unknown as Record<string, unknown>).leakedEnv = "LEAKED_ENV";
    }
    await delay(1);
  };

  const worker = new QueueConsumerWorker(queue, invokeFunction, {
    queueName: "q",
    targetFunctionName: "fn",
  });

  await worker.processNext();
  await worker.processNext();

  assertEquals(contexts.length, 2);
  const [c1, c2] = contexts;

  assertNotStrictEquals(c1, c2, "Contexts must have unique identities");
  assertNotEquals(
    c1.requestId,
    c2.requestId,
    "Request IDs must be unique ULIDs",
  );
  assertEquals(
    (c2 as unknown as Record<string, unknown>).leakedSecret,
    undefined,
    "Root context pollution must not bleed",
  );
  assertEquals(
    await c2.kv.get(["test"]),
    "pristine-kv",
    "Binding methods must be fresh and unpolluted",
  );
  assertEquals(
    (c2.env as unknown as Record<string, unknown>).leakedEnv,
    undefined,
    "Env binding must be isolated",
  );
});

// ===========================================================================
// ATTACK VECTOR 2: Q-3 (Poison Pill, Denial of Service, Error Resilience)
// ===========================================================================

Deno.test("Adversarial Q-3: attempts reset attack cannot bypass DLQ routing or cause infinite retry loop", async () => {
  const poisonMsg: QueueMessage = {
    id: "poison-bypass-01",
    body: { task: "poison-job" },
    attempts: 5,
  };

  const primaryQueue = new AdversarialMockQueueProvider([poisonMsg]);
  const dlq = new AdversarialMockQueueProvider();

  const invokeFunction = (
    _fn: string,
    message: QueueMessage,
  ): Promise<void> => {
    // Adversary attempts to reset attempts counter to keep job cycling forever
    try {
      message.attempts = 1;
    } catch {
      // Frozen
    }
    return Promise.reject(new Error("Poison crash"));
  };

  const worker = new QueueConsumerWorker(primaryQueue, invokeFunction, {
    queueName: "work-queue",
    targetFunctionName: "workHandler",
    maxReceives: 5,
    dlqProvider: dlq,
  });

  const res = await worker.processNext();
  assertEquals(res, false, "Failed invocation returns false");
  assertEquals(
    dlq.sentMessages.length,
    1,
    "Poison message MUST route to DLQ (Q-3)",
  );
  assertEquals(
    dlq.sentMessages[0],
    poisonMsg.body,
    "DLQ receives exact payload",
  );
  assertEquals(
    primaryQueue.acks,
    ["poison-bypass-01"],
    "Source queue must ack exhausted poison message",
  );
});

Deno.test("Adversarial Q-3: message ID corruption attack cannot prevent source queue ACK or spam DLQ", async () => {
  const poisonMsg: QueueMessage = {
    id: "real-poison-id",
    body: { data: "corrupt-id-attack" },
    attempts: 5,
  };

  const primaryQueue = new AdversarialMockQueueProvider([poisonMsg]);
  const dlq = new AdversarialMockQueueProvider();

  const invokeFunction = (
    _fn: string,
    message: QueueMessage,
  ): Promise<void> => {
    try {
      (message as unknown as Record<string, unknown>).id = "fake-forged-id";
    } catch {
      // Frozen
    }
    return Promise.reject(new Error("Downstream exception"));
  };

  const worker = new QueueConsumerWorker(primaryQueue, invokeFunction, {
    queueName: "work-queue",
    targetFunctionName: "workHandler",
    maxReceives: 5,
    dlqProvider: dlq,
  });

  await worker.processNext();

  // Source queue MUST ack the real ID
  assertEquals(
    primaryQueue.acks,
    ["real-poison-id"],
    "Primary queue ACK must use authentic message ID, not corrupted ID",
  );
});

Deno.test("Adversarial Q-3: throwing property getters on message do not crash processNext or background loop (DoS)", async () => {
  const bombMsg: QueueMessage = {
    id: "getter-bomb-msg",
    body: { payload: "exploding" },
    attempts: 1,
  };

  const primaryQueue = new AdversarialMockQueueProvider([
    bombMsg,
    { id: "subsequent-msg", body: "valid", attempts: 1 },
  ]);

  const invokeFunction = (
    _fn: string,
    message: QueueMessage,
  ): Promise<void> => {
    try {
      Object.defineProperty(message, "attempts", {
        get() {
          throw new Error("BOOM: Getter bomb");
        },
      });
    } catch {
      // Frozen
    }
    return Promise.reject(new Error("Handler fail"));
  };

  const worker = new QueueConsumerWorker(primaryQueue, invokeFunction, {
    queueName: "work-queue",
    targetFunctionName: "workHandler",
  });

  let uncaught: unknown = null;
  try {
    await worker.processNext();
  } catch (e) {
    uncaught = e;
  }

  assertEquals(
    uncaught,
    null,
    "processNext must catch all internal errors gracefully",
  );
});

Deno.test("Adversarial Q-3: non-Error throws (string, null, undefined, number, symbol) never crash worker", async () => {
  const nonErrorPayloads = [
    "string rejection",
    null,
    undefined,
    12345,
    Symbol("error-symbol"),
    { error: "plain-object" },
  ];

  for (const payload of nonErrorPayloads) {
    const queue = new AdversarialMockQueueProvider([
      { id: `non-err-${String(payload)}`, body: "test", attempts: 1 },
    ]);

    const invokeFunction = (): Promise<void> => {
      return Promise.reject(payload);
    };

    const worker = new QueueConsumerWorker(queue, invokeFunction, {
      queueName: "q",
      targetFunctionName: "fn",
    });

    const res = await worker.processNext();
    assertEquals(
      res,
      false,
      `Worker must handle non-Error throw: ${String(payload)}`,
    );
    assertEquals(
      queue.acks.length,
      0,
      "Non-error failure must not ack (attempts < maxReceives)",
    );
  }
});

Deno.test("Adversarial Q-3: DLQ failure does not block primary queue ACK, preventing infinite spin loop", async () => {
  const poisonMsg: QueueMessage = {
    id: "poison-dlq-fail",
    body: "poison-body",
    attempts: 5,
  };

  const primaryQueue = new AdversarialMockQueueProvider([poisonMsg]);
  const brokenDlq = new AdversarialMockQueueProvider();
  brokenDlq.shouldFailSend = true; // DLQ provider throws exception on send

  const invokeFunction = (): Promise<void> => {
    return Promise.reject(new Error("Poison processing failure"));
  };

  const options: QueueConsumerOptions = {
    queueName: "q",
    targetFunctionName: "fn",
    maxReceives: 5,
    dlqProvider: brokenDlq,
  };

  const worker = new QueueConsumerWorker(primaryQueue, invokeFunction, options);
  const res = await worker.processNext();

  assertEquals(res, false);
  assertEquals(
    primaryQueue.acks,
    ["poison-dlq-fail"],
    "Primary queue MUST acknowledge exhausted message even when DLQ provider throws",
  );
});

// ===========================================================================
// ATTACK VECTOR 3: Concurrency & Graceful Shutdown
// ===========================================================================

Deno.test("Adversarial Concurrency: in-flight invocation during stop() completes cleanly without dropped or double-acked messages", async () => {
  const queue = new AdversarialMockQueueProvider([
    { id: "in-flight-01", body: "work-in-progress", attempts: 1 },
    { id: "remaining-02", body: "unprocessed", attempts: 1 },
  ]);

  let inFlightStarted = false;
  let inFlightDone = false;

  const invokeFunction = async (
    _fn: string,
    msg: QueueMessage,
  ): Promise<void> => {
    if (msg.id === "in-flight-01") {
      inFlightStarted = true;
      await delay(60);
      inFlightDone = true;
    }
  };

  const worker = new QueueConsumerWorker(queue, invokeFunction, {
    queueName: "q",
    targetFunctionName: "fn",
    pollIntervalMs: 10,
  });

  worker.start();

  while (!inFlightStarted) {
    await delay(5);
  }

  // Issue stop while in-flight-01 is actively processing
  const stopPromise = worker.stop();

  await stopPromise;

  assertEquals(
    inFlightDone,
    true,
    "In-flight invocation must be allowed to complete",
  );
  assertEquals(
    queue.acks,
    ["in-flight-01"],
    "In-flight message must be acknowledged exactly once",
  );
  assertEquals(
    queue.messages.length,
    1,
    "Subsequent message must remain in queue untouched",
  );
  assertEquals(
    queue.messages[0].id,
    "remaining-02",
    "Subsequent message was not dropped",
  );
});

Deno.test("Adversarial Concurrency: multiple concurrent stop() calls are idempotent and thread-safe", async () => {
  const queue = new AdversarialMockQueueProvider([
    { id: "m-1", body: "data", attempts: 1 },
  ]);

  const worker = new QueueConsumerWorker(queue, () => delay(20), {
    queueName: "q",
    targetFunctionName: "fn",
    pollIntervalMs: 10,
  });

  worker.start();
  await delay(5);

  // Trigger multiple concurrent stops
  const stops = Array.from({ length: 10 }, () => worker.stop());
  await Promise.all(stops);

  // Calling stop again after completion is safe
  await worker.stop();
});
