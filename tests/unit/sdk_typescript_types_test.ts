// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: sdk/typescript
// spec: contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
// spec: contracts/functions.contract.md#FN-2 — Trigger model (HTTP, Queue, Schedule)
// spec: contracts/functions.contract.md#FN-4 — RailFogContext structure and scoped capability bindings
// spec: contracts/kv.contract.md#KV-2 — KV binding API and atomic transaction builder
// spec: contracts/objects.contract.md#OBJ-2 — Objects binding API and SigV4 presigning
// spec: contracts/queues.contract.md#Q-2 — Queue binding API and message structure
// spec: contracts/platform.contract.md#PLAT-12 — Error model and ValidationFailedError
// spec: contracts/platform.contract.md#PLAT-15 — Secret access via capability-scoped EnvBinding

import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { ValidationFailedError } from "../../packages/errors/mod.ts";

// Public SDK entrypoint import per PLAT-19 and task T-0501
import "../../sdk/typescript/mod.ts";
import type {
  AtomicOperation,
  EnvBinding,
  FunctionHandler,
  KVAtomicOperation,
  KVBinding,
  ListOptions,
  ObjectBinding,
  PresignOptions,
  QueueBinding,
  QueueConsumerHandler,
  QueueMessage,
  RailFogContext,
} from "../../sdk/typescript/mod.ts";

// Type utilities for compile-time assertion
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends
  (<T>() => T extends Y ? 1 : 2) ? true
  : false;
type NotAssignable<T, U> = [T] extends [U] ? false : true;

// ---------------------------------------------------------------------------
// 1. HTTP FunctionHandler (FN-1)
// ---------------------------------------------------------------------------

Deno.test("FN-1: FunctionHandler accepts (req: Request, ctx: RailFogContext) and returns Promise<Response> | Response", async () => {
  // Static type check: parameter list must be [Request, RailFogContext]
  type HandlerParams = Parameters<FunctionHandler>;
  const _paramCountValid: Equal<HandlerParams["length"], 2> = true;
  const _param0Valid: Equal<HandlerParams[0], Request> = true;
  const _param1Valid: Equal<HandlerParams[1], RailFogContext> = true;
  assertEquals(_paramCountValid && _param0Valid && _param1Valid, true);

  // Static type check: return type must allow Promise<Response> | Response
  type HandlerReturn = ReturnType<FunctionHandler>;
  const _returnValid: Equal<HandlerReturn, Promise<Response> | Response> = true;
  assertEquals(_returnValid, true);

  // Static type check: reject invalid return types
  const _rejectStringReturn: NotAssignable<() => string, FunctionHandler> =
    true;
  const _rejectVoidReturn: NotAssignable<() => void, FunctionHandler> = true;
  const _rejectPromiseVoidReturn: NotAssignable<
    () => Promise<void>,
    FunctionHandler
  > = true;
  assertEquals(
    _rejectStringReturn && _rejectVoidReturn && _rejectPromiseVoidReturn,
    true,
  );

  // Runtime test: async handler returning Promise<Response>
  const asyncHandler: FunctionHandler = async (
    req: Request,
    ctx: RailFogContext,
  ): Promise<Response> => {
    await Promise.resolve();
    return new Response(
      JSON.stringify({
        echoUrl: req.url,
        reqId: ctx.requestId,
        remaining: ctx.timeRemaining(),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  // Runtime test: synchronous handler returning Response
  const syncHandler: FunctionHandler = (
    _req: Request,
    ctx: RailFogContext,
  ): Response => {
    return new Response("sync-ok", {
      status: 200,
      headers: { "x-request-id": ctx.requestId },
    });
  };

  const mockCtx = createMockContext();
  const request = new Request("https://app.railfog.local/api/test");

  const asyncRes = await asyncHandler(request, mockCtx);
  assertEquals(asyncRes.status, 200);
  const asyncBody = await asyncRes.json();
  assertEquals(asyncBody.echoUrl, "https://app.railfog.local/api/test");
  assertEquals(asyncBody.reqId, "req_01J8Z000000000000000000000");

  const syncRes = syncHandler(request, mockCtx);
  assertEquals(syncRes instanceof Response, true);
  if (syncRes instanceof Response) {
    assertEquals(syncRes.status, 200);
    assertEquals(
      syncRes.headers.get("x-request-id"),
      "req_01J8Z000000000000000000000",
    );
    assertEquals(await syncRes.text(), "sync-ok");
  }
});

// ---------------------------------------------------------------------------
// 2. QueueConsumerHandler (FN-2, Q-2)
// ---------------------------------------------------------------------------

Deno.test("FN-2 & Q-2: QueueConsumerHandler accepts (message: QueueMessage, ctx: RailFogContext) and returns Promise<void> | void", async () => {
  // Static type check: QueueConsumerHandler parameters
  type ConsumerParams = Parameters<QueueConsumerHandler>;
  const _paramCountValid: Equal<ConsumerParams["length"], 2> = true;
  const _param0Valid: Equal<ConsumerParams[0], QueueMessage<unknown>> = true;
  const _param1Valid: Equal<ConsumerParams[1], RailFogContext> = true;
  assertEquals(_paramCountValid && _param0Valid && _param1Valid, true);

  // Static type check: QueueConsumerHandler return type
  type ConsumerReturn = ReturnType<QueueConsumerHandler>;
  const _returnValid: Equal<ConsumerReturn, Promise<void> | void> = true;
  assertEquals(_returnValid, true);

  // Static type check: QueueMessage structure (id, body, attempts, timestamp)
  const sampleMessage: QueueMessage<{ event: string }> = {
    id: "msg_01J8Z1234567890ABCDEF",
    body: { event: "order_created" },
    attempts: 1,
    timestamp: 1700000000000,
  };
  assertEquals(sampleMessage.id, "msg_01J8Z1234567890ABCDEF");
  assertEquals(sampleMessage.body.event, "order_created");
  assertEquals(sampleMessage.attempts, 1);
  assertEquals(sampleMessage.timestamp, 1700000000000);

  // Generic specialization test
  interface OrderEvent {
    orderId: string;
    amount: number;
  }
  let processedOrderId = "";

  const typedAsyncConsumer: QueueConsumerHandler<OrderEvent> = async (
    msg: QueueMessage<OrderEvent>,
    ctx: RailFogContext,
  ): Promise<void> => {
    await Promise.resolve();
    assertEquals(ctx.requestId, "req_01J8Z000000000000000000000");
    processedOrderId = msg.body.orderId;
  };

  const typedSyncConsumer: QueueConsumerHandler<OrderEvent> = (
    msg: QueueMessage<OrderEvent>,
    ctx: RailFogContext,
  ): void => {
    assertEquals(ctx.project, "demo-project");
    processedOrderId = msg.body.orderId + "-sync";
  };

  const mockCtx = createMockContext();
  const orderMessage: QueueMessage<OrderEvent> = {
    id: "msg_001",
    body: { orderId: "ord_999", amount: 49.99 },
    attempts: 1,
    timestamp: Date.now(),
  };

  await typedAsyncConsumer(orderMessage, mockCtx);
  assertEquals(processedOrderId, "ord_999");

  typedSyncConsumer(orderMessage, mockCtx);
  assertEquals(processedOrderId, "ord_999-sync");
});

// ---------------------------------------------------------------------------
// 3. KVBinding and KVAtomicOperation shape (KV-2)
// ---------------------------------------------------------------------------

Deno.test("KV-2: KVBinding shape and KVAtomicOperation method chaining", async () => {
  // Static type check: AtomicOperation is an alias or identical to KVAtomicOperation
  const _atomicAliasValid: Equal<AtomicOperation, KVAtomicOperation> = true;
  assertEquals(_atomicAliasValid, true);

  // Verify KVAtomicOperation fluent interface
  let checkCalled = false;
  let setCalled = false;
  let deleteCalled = false;
  let commitCalled = false;

  const mockAtomic: KVAtomicOperation = {
    check(key: string[], expectedVersion: number): KVAtomicOperation {
      assertEquals(key, ["sessions", "sess_1"]);
      assertEquals(expectedVersion, 1);
      checkCalled = true;
      return this;
    },
    set(
      key: string[],
      value: unknown,
      options?: { ttl?: number },
    ): KVAtomicOperation {
      assertEquals(key, ["sessions", "sess_1"]);
      assertEquals(value, { active: true });
      assertEquals(options?.ttl, 3600);
      setCalled = true;
      return this;
    },
    delete(key: string[]): KVAtomicOperation {
      assertEquals(key, ["sessions", "sess_old"]);
      deleteCalled = true;
      return this;
    },
    commit(): Promise<{ ok: boolean; version?: number }> {
      commitCalled = true;
      return Promise.resolve({ ok: true, version: 2 });
    },
  };

  // Fluent chaining execution
  const commitResult = await mockAtomic
    .check(["sessions", "sess_1"], 1)
    .set(["sessions", "sess_1"], { active: true }, { ttl: 3600 })
    .delete(["sessions", "sess_old"])
    .commit();

  assertEquals(checkCalled, true);
  assertEquals(setCalled, true);
  assertEquals(deleteCalled, true);
  assertEquals(commitCalled, true);
  assertEquals(commitResult, { ok: true, version: 2 });

  // Verify KVBinding interface implementation
  const mockKv: KVBinding = {
    get<T = unknown>(key: string[]): Promise<T | null> {
      return Promise.resolve(
        key[0] === "exists" ? ("val" as unknown as T) : null,
      );
    },
    set(
      key: string[],
      value: unknown,
      options?: { ttl?: number },
    ): Promise<void> {
      assertEquals(key.length > 0, true);
      assertEquals(value !== undefined, true);
      if (options?.ttl !== undefined) {
        assertEquals(options.ttl > 0, true);
      }
      return Promise.resolve();
    },
    delete(_key: string[]): Promise<void> {
      return Promise.resolve();
    },
    list<T = unknown>(
      prefix: string[],
      options?: ListOptions,
    ): Promise<
      {
        entries: Array<{ key: string[]; value: T; version: number }>;
        cursor?: string;
      }
    > {
      return Promise.resolve({
        entries: [{
          key: [...prefix, "k1"],
          value: "v1" as unknown as T,
          version: 1,
        }],
        cursor: options?.cursor ?? "next_cursor",
      });
    },
    atomic(): KVAtomicOperation {
      return mockAtomic;
    },
  };

  assertEquals(await mockKv.get<string>(["exists"]), "val");
  assertEquals(await mockKv.get<string>(["missing"]), null);
  await mockKv.set(["config", "theme"], "dark", { ttl: 300 });
  await mockKv.delete(["config", "theme"]);

  const listRes = await mockKv.list<string>(["config"], { limit: 10 });
  assertEquals(listRes.entries.length, 1);
  assertEquals(listRes.entries[0].key, ["config", "k1"]);
  assertEquals(listRes.entries[0].value, "v1");
  assertEquals(listRes.entries[0].version, 1);
  assertEquals(listRes.cursor, "next_cursor");

  const chainedFromBinding = await mockKv.atomic()
    .check(["sessions", "sess_1"], 1)
    .commit();
  assertEquals(chainedFromBinding.ok, true);
});

// ---------------------------------------------------------------------------
// 4. ObjectBinding and PresignOptions (OBJ-2)
// ---------------------------------------------------------------------------

Deno.test("OBJ-2: ObjectBinding methods and presign() option constraints", async () => {
  // Static type check: PresignOptions methods can only be "GET" | "PUT"
  const _validGetMethod: PresignOptions["method"] = "GET";
  const _validPutMethod: PresignOptions["method"] = "PUT";
  assertEquals(_validGetMethod, "GET");
  assertEquals(_validPutMethod, "PUT");

  // Reject methods other than GET and PUT
  const _rejectPostMethod: NotAssignable<"POST", PresignOptions["method"]> =
    true;
  const _rejectDeleteMethod: NotAssignable<"DELETE", PresignOptions["method"]> =
    true;
  const _rejectPatchMethod: NotAssignable<"PATCH", PresignOptions["method"]> =
    true;
  assertEquals(
    _rejectPostMethod && _rejectDeleteMethod && _rejectPatchMethod,
    true,
  );

  // Verify ObjectBinding interface implementation
  const mockObjects: ObjectBinding = {
    put(
      key: string,
      data: Uint8Array | ReadableStream<Uint8Array>,
    ): Promise<void> {
      assertEquals(key, "uploads/avatar.png");
      assertExists(data);
      return Promise.resolve();
    },
    get(key: string): Promise<ReadableStream<Uint8Array> | null> {
      if (key === "uploads/avatar.png") {
        return Promise.resolve(new ReadableStream<Uint8Array>());
      }
      return Promise.resolve(null);
    },
    delete(key: string): Promise<void> {
      assertEquals(key, "uploads/temp.txt");
      return Promise.resolve();
    },
    head(
      key: string,
    ): Promise<
      { sizeBytes: number; sha256: string; integrity: string } | null
    > {
      if (key === "uploads/avatar.png") {
        return Promise.resolve({
          sizeBytes: 1024,
          sha256:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
        });
      }
      return Promise.resolve(null);
    },
    list(
      prefix: string,
      options?: ListOptions,
    ): Promise<
      {
        keys: Array<{ key: string; sizeBytes: number; sha256: string }>;
        cursor?: string;
      }
    > {
      return Promise.resolve({
        keys: [{
          key: `${prefix}avatar.png`,
          sizeBytes: 1024,
          sha256:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        }],
        cursor: options?.cursor,
      });
    },
    createMultipartUpload(key: string): Promise<{ uploadId: string }> {
      assertEquals(key, "large/video.mp4");
      return Promise.resolve({ uploadId: "upload_01J8ZMPU" });
    },
    presign(
      key: string,
      options: PresignOptions,
    ): Promise<{ url: string; headers: Record<string, string> }> {
      assertEquals(key, "uploads/document.pdf");
      assertEquals(options.method, "PUT");
      assertEquals(options.expiresIn, 900);
      return Promise.resolve({
        url:
          "https://storage.railfog.local/presigned/uploads/document.pdf?sig=test",
        headers: { "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
      });
    },
  };

  await mockObjects.put("uploads/avatar.png", new Uint8Array([1, 2, 3]));
  const stream = await mockObjects.get("uploads/avatar.png");
  assertExists(stream);
  assertEquals(await mockObjects.get("missing.bin"), null);

  const headInfo = await mockObjects.head("uploads/avatar.png");
  assertExists(headInfo);
  assertEquals(headInfo.sizeBytes, 1024);
  assertEquals(headInfo.sha256.startsWith("e3b0"), true);
  assertEquals(headInfo.integrity.startsWith("sha256-"), true);

  const listRes = await mockObjects.list("uploads/", { limit: 5 });
  assertEquals(listRes.keys.length, 1);
  assertEquals(listRes.keys[0].key, "uploads/avatar.png");

  const mpu = await mockObjects.createMultipartUpload("large/video.mp4");
  assertEquals(mpu.uploadId, "upload_01J8ZMPU");

  const presignRes = await mockObjects.presign("uploads/document.pdf", {
    method: "PUT",
    expiresIn: 900,
    maxExpiresIn: 86400,
  });
  assertEquals(presignRes.url.includes("uploads/document.pdf"), true);
  assertEquals(presignRes.headers["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
});

// ---------------------------------------------------------------------------
// 5. EnvBinding (FN-4, PLAT-15, PLAT-12)
// ---------------------------------------------------------------------------

Deno.test("FN-4 & PLAT-15: EnvBinding get() returns string | undefined and require() returns string or throws ValidationFailedError", () => {
  const secretStore: Record<string, string> = {
    STRIPE_KEY: "sk_test_123456789",
    API_URL: "https://api.example.com",
  };

  const mockEnv: EnvBinding = {
    get(key: string): string | undefined {
      return secretStore[key];
    },
    require(key: string): string {
      const value = this.get(key);
      if (value === undefined) {
        throw new ValidationFailedError(
          `Missing required environment secret: ${key}`,
        );
      }
      return value;
    },
  };

  // get() returns string for existing key and undefined for missing
  assertEquals(mockEnv.get("STRIPE_KEY"), "sk_test_123456789");
  assertEquals(mockEnv.get("MISSING_SECRET"), undefined);

  // require() returns string for existing key
  assertEquals(mockEnv.require("STRIPE_KEY"), "sk_test_123456789");
  assertEquals(mockEnv.require("API_URL"), "https://api.example.com");

  // require() throws ValidationFailedError (from packages/errors per PLAT-12) for missing key
  assertThrows(
    () => mockEnv.require("MISSING_SECRET"),
    ValidationFailedError,
    "Missing required environment secret: MISSING_SECRET",
  );
});

// ---------------------------------------------------------------------------
// 6. QueueBinding shape (Q-2)
// ---------------------------------------------------------------------------

Deno.test("Q-2: QueueBinding shape supports send() and sendBatch()", async () => {
  const sentMessages: Array<{ body: unknown; delay?: number }> = [];

  const mockQueue: QueueBinding = {
    send<T = unknown>(
      message: T,
      options?: { delay?: number },
    ): Promise<{ id: string }> {
      sentMessages.push({ body: message, delay: options?.delay });
      return Promise.resolve({ id: `msg_${sentMessages.length}` });
    },
    sendBatch<T = unknown>(messages: T[]): Promise<Array<{ id: string }>> {
      const results: Array<{ id: string }> = [];
      for (const msg of messages) {
        sentMessages.push({ body: msg });
        results.push({ id: `msg_${sentMessages.length}` });
      }
      return Promise.resolve(results);
    },
  };

  // Single send
  const sendRes = await mockQueue.send({ task: "resize_image", width: 800 }, {
    delay: 60,
  });
  assertEquals(sendRes.id, "msg_1");
  assertEquals(sentMessages[0].delay, 60);

  // Batch send
  const batchRes = await mockQueue.sendBatch([
    { event: "signup", user: "u1" },
    { event: "signup", user: "u2" },
  ]);
  assertEquals(batchRes.length, 2);
  assertEquals(batchRes[0].id, "msg_2");
  assertEquals(batchRes[1].id, "msg_3");
  assertEquals(sentMessages.length, 3);
});

// ---------------------------------------------------------------------------
// 7. RailFogContext shape (FN-4)
// ---------------------------------------------------------------------------

Deno.test("FN-4: RailFogContext exposes requestId, project, function, revision, deadline, timeRemaining(), kv, objects, queues, env", () => {
  const ctx = createMockContext();

  assertEquals(ctx.requestId, "req_01J8Z000000000000000000000");
  assertEquals(ctx.project, "demo-project");
  assertEquals(ctx.function, "checkout");
  assertEquals(ctx.revision, "rev_01J8Z1234567890ABCDEF");
  assertEquals(typeof ctx.deadline, "number");
  assertEquals(ctx.deadline > 0, true);

  const remaining = ctx.timeRemaining();
  assertEquals(typeof remaining, "number");
  assertEquals(remaining > 0, true);

  assertExists(ctx.kv);
  assertExists(ctx.objects);
  assertExists(ctx.queues);
  assertExists(ctx.env);

  assertEquals(typeof ctx.kv.get, "function");
  assertEquals(typeof ctx.kv.atomic, "function");
  assertEquals(typeof ctx.objects.put, "function");
  assertEquals(typeof ctx.objects.presign, "function");
  assertEquals(typeof ctx.queues.send, "function");
  assertEquals(typeof ctx.env.get, "function");
  assertEquals(typeof ctx.env.require, "function");
});

// ---------------------------------------------------------------------------
// 8. Adversarial & Isolation Assertions (PLAT-4, PLAT-6, PLAT-15)
// ---------------------------------------------------------------------------

Deno.test("PLAT-4 & PLAT-6: RailFogContext strictly bounds execution and exposes no ambient host handles", () => {
  type DisallowedAmbientKeys =
    | "pid"
    | "process"
    | "fs"
    | "cwd"
    | "shell"
    | "token"
    | "credentials"
    | "socket"
    | "tenant"
    | "tenantId"
    | "orgId";

  // Non-distributive check: evaluates to true only if NO keys in K exist in keyof T.
  // Wrapping in tuple [Extract<...>] avoids union distribution bypass where (never | true) => true.
  type AssertNoDisallowed<T, K extends string> = [Extract<keyof T, K>] extends
    [never] ? true : false;

  const _contextSafe: AssertNoDisallowed<
    RailFogContext,
    DisallowedAmbientKeys
  > = true;
  const _envSafe: AssertNoDisallowed<EnvBinding, DisallowedAmbientKeys> = true;
  const _kvSafe: AssertNoDisallowed<KVBinding, DisallowedAmbientKeys> = true;
  const _objectsSafe: AssertNoDisallowed<ObjectBinding, DisallowedAmbientKeys> =
    true;
  const _queuesSafe: AssertNoDisallowed<QueueBinding, DisallowedAmbientKeys> =
    true;

  // Adversarial verification: prove that AssertNoDisallowed strictly rejects compromised types
  type CompromisedContext = RailFogContext & { fs: unknown; process: unknown };
  const _rejectCompromisedContext: NotAssignable<
    true,
    AssertNoDisallowed<CompromisedContext, DisallowedAmbientKeys>
  > = true;

  // Secret leakage prevention: EnvBinding must NOT expose enumeration methods (keys, list, all, getAll)
  type DisallowedEnvEnumeration =
    | "keys"
    | "values"
    | "entries"
    | "list"
    | "all"
    | "getAll";
  const _envNoEnumeration: AssertNoDisallowed<
    EnvBinding,
    DisallowedEnvEnumeration
  > = true;
  type CompromisedEnv = EnvBinding & { keys(): string[] };
  const _rejectCompromisedEnv: NotAssignable<
    true,
    AssertNoDisallowed<CompromisedEnv, DisallowedEnvEnumeration>
  > = true;

  // Capability injection prevention: PresignOptions and ListOptions must NOT accept bucket/table/tenant override
  type DisallowedPresignKeys = "bucket" | "projectId" | "orgId" | "endpoint";
  const _presignSafe: AssertNoDisallowed<
    PresignOptions,
    DisallowedPresignKeys
  > = true;

  type DisallowedListOptionsKeys =
    | "bucket"
    | "table"
    | "tenant"
    | "projectId"
    | "orgId";
  const _listOptionsSafe: AssertNoDisallowed<
    ListOptions,
    DisallowedListOptionsKeys
  > = true;

  assertEquals(
    _contextSafe &&
      _envSafe &&
      _kvSafe &&
      _objectsSafe &&
      _queuesSafe &&
      _rejectCompromisedContext &&
      _envNoEnumeration &&
      _rejectCompromisedEnv &&
      _presignSafe &&
      _listOptionsSafe,
    true,
  );
});

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function createMockContext(): RailFogContext {
  const deadline = Date.now() + 30000;
  return {
    requestId: "req_01J8Z000000000000000000000",
    project: "demo-project",
    function: "checkout",
    revision: "rev_01J8Z1234567890ABCDEF",
    deadline,
    timeRemaining(): number {
      return Math.max(0, deadline - Date.now());
    },
    kv: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve({ entries: [] }),
      atomic: () => ({
        check: function () {
          return this;
        },
        set: function () {
          return this;
        },
        delete: function () {
          return this;
        },
        commit: () => Promise.resolve({ ok: true }),
      }),
    },
    objects: {
      put: () => Promise.resolve(),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      head: () => Promise.resolve(null),
      list: () => Promise.resolve({ keys: [] }),
      createMultipartUpload: () => Promise.resolve({ uploadId: "mock_mpu" }),
      presign: () =>
        Promise.resolve({ url: "https://mock.presigned.url", headers: {} }),
    },
    queues: {
      send: () => Promise.resolve({ id: "mock_msg" }),
      sendBatch: () => Promise.resolve([{ id: "mock_msg" }]),
    },
    env: {
      get: () => undefined,
      require: () => {
        throw new ValidationFailedError("Missing secret");
      },
    },
  };
}
