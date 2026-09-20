import {
  assert,
  assertEquals,
  assertNotEquals,
  assertNotStrictEquals,
} from "@std/assert";
import { delay } from "@std/async/delay";
import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";
import {
  buildContext,
  type LoadedFunctionMeta,
  type RailFogContext,
} from "../../runtime/loader/context-builder.ts";
import { isValidUlid } from "../../packages/core/id/ulid.ts";
import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
  ResolvedBindings,
} from "../../packages/policy/permission-resolver.ts";
import {
  type QueueConsumerOptions,
  QueueConsumerWorker,
} from "../../apps/worker/queue-consumer.ts";

/**
 * In-memory mock QueueProvider for precise unit testing of calls, parameters, and return values.
 */
class MockQueueProvider implements QueueProvider {
  public messages: QueueMessage[] = [];
  public acks: string[] = [];
  public sentMessages: unknown[] = [];
  public receiveCalls: { visibilityTimeoutMs?: number }[] = [];

  constructor(initialMessages: QueueMessage[] = []) {
    this.messages = [...initialMessages];
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

  receive(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null> {
    this.receiveCalls.push(opts || {});
    const msg = this.messages.shift() ?? null;
    return Promise.resolve(msg);
  }

  ack(id: string): Promise<void> {
    this.acks.push(id);
    return Promise.resolve();
  }
}

// ============================================================================
// Unit Tests: Acceptance Criteria AC1 - AC6
// ============================================================================

Deno.test("AC1: Given an available queue message, when processNext() executes and invokeFunction succeeds, then queueProvider.ack(message.id) is called and processNext() returns true", async () => {
  const testMessage: QueueMessage = {
    id: "msg-001",
    body: { task: "render-thumbnail", fileId: "f-123" },
    attempts: 1,
  };

  const queueProvider = new MockQueueProvider([testMessage]);
  let invokedFnName = "";
  let invokedMessage: QueueMessage | null = null;

  const invokeFunction = (
    fnName: string,
    message: QueueMessage,
  ): Promise<void> => {
    invokedFnName = fnName;
    invokedMessage = message;
    return Promise.resolve();
  };

  const options: QueueConsumerOptions = {
    queueName: "app:jobs",
    targetFunctionName: "imageProcessor",
  };

  const worker = new QueueConsumerWorker(
    queueProvider,
    invokeFunction,
    options,
  );
  const result = await worker.processNext();

  assertEquals(
    result,
    true,
    "processNext() must return true on successful processing",
  );
  assertEquals(
    invokedFnName,
    "imageProcessor",
    "targetFunctionName must be passed to invokeFunction",
  );
  assertEquals(
    invokedMessage,
    testMessage,
    "QueueMessage must be passed to invokeFunction",
  );
  assertEquals(
    queueProvider.acks,
    ["msg-001"],
    "queueProvider.ack must be called with message ID on success (Q-3)",
  );
});

Deno.test("AC2: Given a message where invokeFunction throws/rejects, when processNext() executes, then ack is NOT called, error is handled gracefully, and processNext() returns false", async () => {
  const testMessage: QueueMessage = {
    id: "msg-err-001",
    body: { task: "failing-job" },
    attempts: 1,
  };

  const queueProvider = new MockQueueProvider([testMessage]);

  const invokeFunction = (
    _fnName: string,
    _message: QueueMessage,
  ): Promise<void> => {
    return Promise.reject(
      new Error("Downstream processing failed unexpectedly"),
    );
  };

  const options: QueueConsumerOptions = {
    queueName: "app:jobs",
    targetFunctionName: "failingFunction",
    maxReceives: 5,
  };

  const worker = new QueueConsumerWorker(
    queueProvider,
    invokeFunction,
    options,
  );
  const result = await worker.processNext();

  assertEquals(
    result,
    false,
    "processNext() must return false when processing fails",
  );
  assertEquals(
    queueProvider.acks.length,
    0,
    "queueProvider.ack must NOT be called on failure when attempts < maxReceives (Q-3)",
  );
});

Deno.test("AC3: Given a message where attempts >= maxReceives, when processing fails, then routed to dlqProvider.send and acknowledged from source queue", async () => {
  // Subcase 1: Default maxReceives = 5, attempts = 5, dlqProvider configured
  {
    const poisonMessage: QueueMessage = {
      id: "msg-poison-005",
      body: { task: "poison-payload", data: [1, 2, 3] },
      attempts: 5,
    };

    const primaryQueue = new MockQueueProvider([poisonMessage]);
    const dlqProvider = new MockQueueProvider();

    const invokeFunction = (
      _fnName: string,
      _message: QueueMessage,
    ): Promise<void> => {
      return Promise.reject(new Error("Poison pill crash"));
    };

    const options: QueueConsumerOptions = {
      queueName: "app:jobs",
      targetFunctionName: "poisonHandler",
      dlqProvider,
      // maxReceives defaults to 5 per Q-3
    };

    const worker = new QueueConsumerWorker(
      primaryQueue,
      invokeFunction,
      options,
    );
    const result = await worker.processNext();

    assertEquals(
      result,
      false,
      "processNext() returns false when message processing failed",
    );
    assertEquals(
      dlqProvider.sentMessages.length,
      1,
      "Poison message body must be sent to DLQ (Q-3)",
    );
    assertEquals(
      dlqProvider.sentMessages[0],
      poisonMessage.body,
      "DLQ must receive the original message body",
    );
    assertEquals(
      primaryQueue.acks,
      ["msg-poison-005"],
      "Message must be acknowledged from source queue after moving to DLQ (Q-3)",
    );
  }

  // Subcase 2: Custom maxReceives = 3, attempts = 3, dlqProvider configured
  {
    const poisonMessage: QueueMessage = {
      id: "msg-poison-custom",
      body: { task: "custom-threshold" },
      attempts: 3,
    };

    const primaryQueue = new MockQueueProvider([poisonMessage]);
    const dlqProvider = new MockQueueProvider();

    const invokeFunction = (
      _fnName: string,
      _message: QueueMessage,
    ): Promise<void> => {
      return Promise.reject(new Error("Custom maxReceives exceeded"));
    };

    const options: QueueConsumerOptions = {
      queueName: "app:jobs",
      targetFunctionName: "customHandler",
      maxReceives: 3,
      dlqProvider,
    };

    const worker = new QueueConsumerWorker(
      primaryQueue,
      invokeFunction,
      options,
    );
    const result = await worker.processNext();

    assertEquals(result, false);
    assertEquals(
      dlqProvider.sentMessages.length,
      1,
      "DLQ must receive message when custom maxReceives threshold reached",
    );
    assertEquals(
      primaryQueue.acks,
      ["msg-poison-custom"],
      "Source queue must ack after moving to DLQ",
    );
  }

  // Subcase 3: attempts < maxReceives must NOT route to DLQ
  {
    const retryableMessage: QueueMessage = {
      id: "msg-retryable",
      body: { task: "temporary-glitch" },
      attempts: 4, // 4 < 5 default
    };

    const primaryQueue = new MockQueueProvider([retryableMessage]);
    const dlqProvider = new MockQueueProvider();

    const invokeFunction = (
      _fnName: string,
      _message: QueueMessage,
    ): Promise<void> => {
      return Promise.reject(new Error("Transient glitch"));
    };

    const options: QueueConsumerOptions = {
      queueName: "app:jobs",
      targetFunctionName: "retryHandler",
      dlqProvider,
    };

    const worker = new QueueConsumerWorker(
      primaryQueue,
      invokeFunction,
      options,
    );
    const result = await worker.processNext();

    assertEquals(result, false);
    assertEquals(
      dlqProvider.sentMessages.length,
      0,
      "DLQ must NOT receive message when attempts < maxReceives",
    );
    assertEquals(
      primaryQueue.acks.length,
      0,
      "Source queue must NOT ack when attempts < maxReceives (allowing redelivery)",
    );
  }

  // Subcase 4: attempts >= maxReceives but function SUCCEEDS: must NOT route to DLQ
  {
    const fifthAttemptMessage: QueueMessage = {
      id: "msg-success-on-fifth",
      body: { task: "finally-succeeds" },
      attempts: 5,
    };

    const primaryQueue = new MockQueueProvider([fifthAttemptMessage]);
    const dlqProvider = new MockQueueProvider();

    const invokeFunction = (
      _fnName: string,
      _message: QueueMessage,
    ): Promise<void> => {
      return Promise.resolve();
    };

    const options: QueueConsumerOptions = {
      queueName: "app:jobs",
      targetFunctionName: "retryHandler",
      dlqProvider,
    };

    const worker = new QueueConsumerWorker(
      primaryQueue,
      invokeFunction,
      options,
    );
    const result = await worker.processNext();

    assertEquals(
      result,
      true,
      "processNext() must return true when processing succeeds on fifth attempt",
    );
    assertEquals(
      dlqProvider.sentMessages.length,
      0,
      "DLQ must NOT be called when invocation succeeds",
    );
    assertEquals(
      primaryQueue.acks,
      ["msg-success-on-fifth"],
      "Message must be acked normally on success",
    );
  }

  // Subcase 5: attempts >= maxReceives, fails, but NO dlqProvider configured: source queue is still acknowledged
  {
    const poisonMessage: QueueMessage = {
      id: "msg-poison-no-dlq",
      body: { task: "poison-without-dlq" },
      attempts: 5,
    };

    const primaryQueue = new MockQueueProvider([poisonMessage]);

    const invokeFunction = (
      _fnName: string,
      _message: QueueMessage,
    ): Promise<void> => {
      return Promise.reject(new Error("Exceeded maxReceives with no DLQ"));
    };

    const options: QueueConsumerOptions = {
      queueName: "app:jobs",
      targetFunctionName: "noDlqHandler",
    };

    const worker = new QueueConsumerWorker(
      primaryQueue,
      invokeFunction,
      options,
    );
    const result = await worker.processNext();

    assertEquals(result, false);
    assertEquals(
      primaryQueue.acks,
      ["msg-poison-no-dlq"],
      "Source queue must ack exhausted message even if dlqProvider is not configured",
    );
  }
});

Deno.test("AC4: When queue is empty (receive() returns null), processNext() returns false and invokeFunction is not called", async () => {
  const queueProvider = new MockQueueProvider([]); // Empty queue
  let invokeCalled = false;

  const invokeFunction = (
    _fnName: string,
    _message: QueueMessage,
  ): Promise<void> => {
    invokeCalled = true;
    return Promise.resolve();
  };

  const options: QueueConsumerOptions = {
    queueName: "app:jobs",
    targetFunctionName: "someFunction",
  };

  const worker = new QueueConsumerWorker(
    queueProvider,
    invokeFunction,
    options,
  );
  const result = await worker.processNext();

  assertEquals(
    result,
    false,
    "processNext() must return false when queue is empty",
  );
  assertEquals(
    invokeCalled,
    false,
    "invokeFunction must not be called when queue is empty",
  );
  assertEquals(
    queueProvider.acks.length,
    0,
    "No ack should be issued on empty queue",
  );
});

Deno.test("AC5: Lifecycle start() continuously polls in background; stop() halts polling and awaits in-flight processing cleanly", async () => {
  // 1. start() continuously polls and consumes messages
  const queueProvider = new MockQueueProvider([
    { id: "bg-1", body: "first", attempts: 1 },
    { id: "bg-2", body: "second", attempts: 1 },
  ]);

  const processed: string[] = [];
  let inFlightDelayMs = 0;

  const invokeFunction = async (
    _fnName: string,
    message: QueueMessage,
  ): Promise<void> => {
    if (inFlightDelayMs > 0) {
      await delay(inFlightDelayMs);
    }
    processed.push(message.id);
  };

  const options: QueueConsumerOptions = {
    queueName: "app:jobs",
    targetFunctionName: "bgWorker",
    pollIntervalMs: 10,
  };

  const worker = new QueueConsumerWorker(
    queueProvider,
    invokeFunction,
    options,
  );
  worker.start();

  // Wait for background polling to process existing messages
  await delay(80);

  assertEquals(
    processed,
    ["bg-1", "bg-2"],
    "Worker start() should continuously poll and process messages",
  );
  assertEquals(
    queueProvider.acks,
    ["bg-1", "bg-2"],
    "All processed messages should be acknowledged",
  );

  // 2. stop() awaits in-flight processing cleanly
  inFlightDelayMs = 60;
  queueProvider.messages.push({
    id: "bg-3-inflight",
    body: "third",
    attempts: 1,
  });

  // Wait for worker to pick up bg-3-inflight
  await delay(20);

  // Issue stop() while bg-3-inflight is in flight
  const stopPromise = worker.stop();

  // Await stop completion
  await stopPromise;

  assert(
    processed.includes("bg-3-inflight"),
    "In-flight message must finish processing before stop() resolves",
  );
  assert(
    queueProvider.acks.includes("bg-3-inflight"),
    "In-flight message must be acknowledged before stop() resolves",
  );

  // 3. Verify polling has halted: subsequent messages remain in queue
  queueProvider.messages.push({
    id: "bg-4-after-stop",
    body: "fourth",
    attempts: 1,
  });
  await delay(50);

  assertEquals(
    processed.includes("bg-4-after-stop"),
    false,
    "Polling must halt after stop(): new messages must not be processed",
  );
  assertEquals(
    queueProvider.acks.includes("bg-4-after-stop"),
    false,
    "Halted worker must not ack new messages",
  );

  // 4. Idempotent stop() and multiple start() calls
  await worker.stop(); // Calling stop() again should be a clean no-op
});

Deno.test("AC6: Default options: visibilityTimeoutMs defaults to 30,000 ms, maxReceives defaults to 5 per Q-3", async () => {
  // Test visibilityTimeoutMs default
  const defaultQueueProvider = new MockQueueProvider([
    { id: "msg-def", body: "test", attempts: 1 },
  ]);

  const defaultWorker = new QueueConsumerWorker(
    defaultQueueProvider,
    () => Promise.resolve(),
    { queueName: "app:jobs", targetFunctionName: "testFn" },
  );

  await defaultWorker.processNext();

  assertEquals(defaultQueueProvider.receiveCalls.length, 1);
  assertEquals(
    defaultQueueProvider.receiveCalls[0].visibilityTimeoutMs,
    30000,
    "visibilityTimeoutMs must default to 30,000 ms per Q-3",
  );

  // Test custom visibilityTimeoutMs
  const customQueueProvider = new MockQueueProvider([
    { id: "msg-custom", body: "test", attempts: 1 },
  ]);

  const customWorker = new QueueConsumerWorker(
    customQueueProvider,
    () => Promise.resolve(),
    {
      queueName: "app:jobs",
      targetFunctionName: "testFn",
      visibilityTimeoutMs: 15000,
    },
  );

  await customWorker.processNext();

  assertEquals(customQueueProvider.receiveCalls.length, 1);
  assertEquals(
    customQueueProvider.receiveCalls[0].visibilityTimeoutMs,
    15000,
    "custom visibilityTimeoutMs must be passed to receive()",
  );
});

// ============================================================================
// Integration Tests: Real SQLiteQueueProvider & Canonical Worked Example
// ============================================================================

Deno.test("Integration: consumer worker running against real SQLiteQueueProvider executing sample consumer function fixture from docs/contracts/worked-example.md", async () => {
  // Real SQLiteQueueProvider for primary queue and DLQ (PLAT-17, Q-3)
  const mainQueue = new SQLiteQueueProvider(":memory:");
  const dlq = new SQLiteQueueProvider(":memory:");

  // In-memory KV state for app:files and app:jobs dedupe (Q-4)
  const kvStore = new Map<string, unknown>();
  const kvBinding: KVBinding = {
    get: (key: string[]) => Promise.resolve(kvStore.get(key.join("/")) ?? null),
    set: (key: string[], value: unknown, _opts?: { ttl?: number }) => {
      kvStore.set(key.join("/"), value);
      return Promise.resolve();
    },
    delete: (key: string[]) => {
      kvStore.delete(key.join("/"));
      return Promise.resolve();
    },
    list: () => Promise.resolve({ keys: [] }),
    atomic: () => {
      throw new Error("atomic not used in this test");
    },
  };

  // Mock Objects binding returning a stream for the key
  const uploadedFiles = new Map<string, Uint8Array>();
  uploadedFiles.set(
    "uploads/doc-canonical-42.pdf",
    new Uint8Array([1, 2, 3, 4]),
  );

  const objectsBinding: ObjectBinding = {
    get: (key: string) => {
      const data = uploadedFiles.get(key);
      if (!data) return Promise.resolve(null);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
      return Promise.resolve(stream);
    },
    put: () => Promise.resolve({ etag: "mock-etag" }),
    delete: () => Promise.resolve(),
    head: () => Promise.resolve({ size: 4, etag: "mock-etag" }),
    list: () => Promise.resolve({ keys: [] }),
    presign: () =>
      Promise.resolve({
        url: "https://example.com",
        expiresAt: Date.now() + 3600,
      }),
    createMultipartUpload: () => Promise.resolve({ uploadId: "mock-mpu" }),
  };

  const queueBinding: QueueBinding = {
    send: (b, o) => mainQueue.send(b, o),
    sendBatch: (b) => mainQueue.sendBatch(b),
    receive: (o) => mainQueue.receive(o),
    ack: (id) => mainQueue.ack(id),
  };

  const bindings: ResolvedBindings = {
    kv: kvBinding,
    objects: objectsBinding,
    queues: queueBinding,
  };

  const fnMeta: LoadedFunctionMeta = {
    project: "upload-demo",
    function: "processor",
    revision: "rev-001",
    timeout_ms: 30000,
  };

  // Canonical worked-example consumer implementation (docs/contracts/worked-example.md lines 42-55)
  const canonicalWorkedExampleConsumer = async (
    message: QueueMessage,
    ctx: RailFogContext,
  ) => {
    const { key } = message.body as { key: string };
    const dedupeKey = ["processed", key]; // Q-4

    if (await ctx.kv.get(dedupeKey)) return;

    const stream = await ctx.objects.get(key); // OBJ-2
    if (!stream) return; // object not yet uploaded — safe no-op, will redeliver (Q-3)

    await ctx.kv.set(["files", key], { status: "processed" }); // KV-2
    await ctx.kv.set(dedupeKey, true, { ttl: 14 * 24 * 3600 }); // Q-4, ttl matches retention_days
  };

  // Wire invokeFunction to context building and canonical handler (FN-2, Q-2)
  const invokeFunction = async (
    _fnName: string,
    message: QueueMessage,
  ): Promise<void> => {
    const ctx = buildContext(fnMeta, bindings);
    await canonicalWorkedExampleConsumer(message, ctx);
  };

  // Enqueue message into real SQLiteQueueProvider
  const fileKey = "uploads/doc-canonical-42.pdf";
  const { id: messageId } = await mainQueue.send({ key: fileKey });
  assert(messageId, "Message must be enqueued into real SQLite provider");

  const worker = new QueueConsumerWorker(mainQueue, invokeFunction, {
    queueName: "app:jobs",
    targetFunctionName: "processor",
    dlqProvider: dlq,
  });

  // Execute processNext()
  const processed = await worker.processNext();
  assertEquals(
    processed,
    true,
    "processNext() must succeed for worked-example message",
  );

  // Verify KV side effects from worked example
  const fileStatus = await kvBinding.get(["files", fileKey]);
  assertEquals(
    fileStatus,
    { status: "processed" },
    "KV status must be updated to processed per worked-example",
  );

  const dedupeStatus = await kvBinding.get(["processed", fileKey]);
  assertEquals(
    dedupeStatus,
    true,
    "Dedupe key must be marked processed per Q-4",
  );

  // Verify real SQLite queue message was acknowledged (cannot be received again)
  const nextMsg = await mainQueue.receive();
  assertEquals(
    nextMsg,
    null,
    "Message must be acknowledged and removed from real SQLite queue",
  );
});

Deno.test("Integration: real SQLiteQueueProvider routes poison message to DLQ after reaching max_receives", async () => {
  const mainQueue = new SQLiteQueueProvider(":memory:");
  const dlq = new SQLiteQueueProvider(":memory:");

  const { id: poisonId } = await mainQueue.send({
    task: "poison-database-job",
  });
  assert(poisonId, "Poison message ID must be generated");

  let attemptsObserved = 0;
  const failingInvoke = (
    _fnName: string,
    message: QueueMessage,
  ): Promise<void> => {
    attemptsObserved = message.attempts;
    return Promise.reject(new Error("Database write error: " + message.id));
  };

  const worker = new QueueConsumerWorker(mainQueue, failingInvoke, {
    queueName: "app:jobs",
    targetFunctionName: "failingWorker",
    visibilityTimeoutMs: 50,
    maxReceives: 2,
    dlqProvider: dlq,
  });

  // Attempt 1: should fail, NOT sent to DLQ yet (attempts: 1 < maxReceives: 2)
  const res1 = await worker.processNext();
  assertEquals(res1, false, "Attempt 1 must return false on error");
  assertEquals(attemptsObserved, 1);
  assertEquals(
    await dlq.receive(),
    null,
    "DLQ must not have message after attempt 1",
  );

  // Wait for visibility timeout or simulate next receive
  // In SQLiteQueueProvider, receive increments attempts. To simulate immediate redelivery:
  // We can call mainQueue.receive directly or wait; since SQLiteQueueProvider uses visibility_after,
  // let's verify by receiving after visibility timeout. For fast tests, use visibilityTimeoutMs: 50.
  const fastWorker = new QueueConsumerWorker(mainQueue, failingInvoke, {
    queueName: "app:jobs",
    targetFunctionName: "failingWorker",
    visibilityTimeoutMs: 50,
    maxReceives: 2,
    dlqProvider: dlq,
  });

  // Wait 60ms for visibility timeout to elapse
  await delay(60);

  // Attempt 2: attempts will now be 2 (>= maxReceives: 2). Failing should route to DLQ and ack from mainQueue
  const res2 = await fastWorker.processNext();
  assertEquals(res2, false, "Attempt 2 must return false on error");
  assertEquals(attemptsObserved, 2, "Message should be on attempt 2");

  // Main queue must now be empty (acked)
  assertEquals(
    await mainQueue.receive(),
    null,
    "Main queue must have acked and deleted the poison message",
  );

  // DLQ must now contain the poison message body
  const dlqMsg = await dlq.receive();
  assert(dlqMsg !== null, "Message must now be present in the DLQ");
  assertEquals(dlqMsg.body, { task: "poison-database-job" });
});

// ============================================================================
// Security Tests: Isolation & Warm-Reuse Rule (FN-6)
// ============================================================================

Deno.test("Security (FN-6): Sequential message invocations receive fresh, isolated RailFogContext without state bleeding", async () => {
  const queueProvider = new MockQueueProvider([
    { id: "sec-msg-1", body: { tenant: "tenant-alpha" }, attempts: 1 },
    { id: "sec-msg-2", body: { tenant: "tenant-beta" }, attempts: 1 },
  ]);

  const bindings: ResolvedBindings = {
    kv: {
      get: () => Promise.resolve("original-kv-data"),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve({ keys: [] }),
      atomic: () => {
        throw new Error();
      },
    },
    objects: {
      put: () => Promise.resolve({ etag: "mock-etag" }),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      head: () => Promise.resolve(null),
      list: () => Promise.resolve({ keys: [] }),
      presign: () =>
        Promise.resolve({ url: "https://example.com", expiresAt: Date.now() }),
      createMultipartUpload: () => Promise.resolve({ uploadId: "mock-upload" }),
    },
    queues: {
      send: () => Promise.resolve({ id: "mock-send" }),
      sendBatch: () => Promise.resolve([]),
      receive: () => Promise.resolve(null),
      ack: () => Promise.resolve(),
    },
  };

  const meta: LoadedFunctionMeta = {
    project: "multi-tenant-project",
    function: "tenantJobProcessor",
    revision: "rev-sec-01",
    timeout_ms: 30000,
  };

  const capturedContexts: RailFogContext[] = [];
  let invocationIndex = 0;

  const invokeFunction = (
    _fnName: string,
    _message: QueueMessage,
  ): Promise<void> => {
    // Re-inject fresh context on every invocation (FN-6)
    const ctx = buildContext(meta, bindings);
    capturedContexts.push(ctx);
    invocationIndex++;

    if (invocationIndex === 1) {
      // Adversarial attack inside Invocation 1: tamper with context and bindings
      (ctx as unknown as Record<string, unknown>).leakedSecret =
        "ALPHA_PRIVATE_TOKEN";
      (ctx.kv as unknown as Record<string, unknown>).injectedKvProp =
        "MALICIOUS_KV";
      ctx.kv.get = () => Promise.resolve("HIJACKED_ALPHA_KV");
      (ctx.env as unknown as Record<string, unknown>).injectedEnvProp =
        "ALPHA_ENV_LEAK";
    }

    return Promise.resolve();
  };

  const worker = new QueueConsumerWorker(queueProvider, invokeFunction, {
    queueName: "app:jobs",
    targetFunctionName: "tenantJobProcessor",
  });

  // Process message 1 (Tenant Alpha)
  const res1 = await worker.processNext();
  assertEquals(res1, true);

  // Process message 2 (Tenant Beta)
  const res2 = await worker.processNext();
  assertEquals(res2, true);

  assertEquals(
    capturedContexts.length,
    2,
    "Both messages must have been invoked",
  );

  const [ctx1, ctx2] = capturedContexts;

  // 1. Context identities must be strictly different
  assertNotStrictEquals(
    ctx1,
    ctx2,
    "Context instances must be unique across invocations (FN-6)",
  );

  // 2. Both request IDs must be valid Crockford Base32 ULIDs
  assert(isValidUlid(ctx1.requestId), "ctx1 requestId must be valid ULID");
  assert(isValidUlid(ctx2.requestId), "ctx2 requestId must be valid ULID");

  // 3. Request IDs must be unique (distinct per invocation)
  assertNotEquals(
    ctx1.requestId,
    ctx2.requestId,
    "ctx1 and ctx2 must have different requestIds (FN-4, FN-6)",
  );

  // 4. Root context pollution must NOT bleed from Message 1 to Message 2
  assertEquals(
    (ctx2 as unknown as Record<string, unknown>).leakedSecret,
    undefined,
    "Tainted context property from Message 1 must NOT bleed into Message 2 (FN-6)",
  );

  // 5. Scoped bindings must NOT bleed state
  assertNotStrictEquals(
    ctx1.kv,
    ctx2.kv,
    "KV binding must be a fresh clone per invocation (FN-6)",
  );
  assertNotStrictEquals(
    ctx1.kv.get,
    ctx2.kv.get,
    "Tampered KV method must NOT bleed into Message 2 (FN-6)",
  );
  assertEquals(
    (ctx2.kv as unknown as Record<string, unknown>).injectedKvProp,
    undefined,
    "Injected KV property must NOT bleed into Message 2 (FN-6)",
  );
  assertEquals(
    await ctx2.kv.get(["test"]),
    "original-kv-data",
    "Message 2 KV binding must return pristine data, not hijacked value",
  );

  // 6. Env binding must NOT bleed state
  assertNotStrictEquals(
    ctx1.env,
    ctx2.env,
    "Env binding must be isolated per invocation (FN-6)",
  );
  assertEquals(
    (ctx2.env as unknown as Record<string, unknown>).injectedEnvProp,
    undefined,
    "Injected Env property must NOT bleed into Message 2 (FN-6)",
  );

  // 7. Deadline & timeRemaining are freshly calculated
  assert(
    ctx2.timeRemaining() > 29000,
    "Message 2 must have full fresh timeout budget (FN-5, FN-6)",
  );
});
