// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: sdk/typescript
// spec: contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
// spec: contracts/functions.contract.md#FN-4 — RailFogContext structure and capability bindings
// spec: contracts/platform.contract.md#PLAT-11 — Routing specificity and URLPattern matching
// spec: contracts/platform.contract.md#PLAT-12 — Error model and canonical error responses
// spec: contracts/platform.contract.md#PLAT-15 — Capability-scoped secret access via c.env
// spec: tasks/milestone-0.8-developer-experience-ux/T-0810-ergonomic-function-handler-wrapper.md

import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertNotEquals,
} from "@std/assert";
import {
  api,
  type ApiRouteMap,
  handle,
  type HandlerContext,
  type HandlerFn,
  type HandlerResult,
} from "../../sdk/typescript/wrapper.ts";
import type {
  EnvBinding,
  FunctionHandler,
  KVAtomicOperation,
  KVBinding,
  ObjectBinding,
  QueueBinding,
  RailFogContext,
} from "../../sdk/typescript/types.ts";
import {
  CallDepthExceededError,
  ConflictError,
  InternalError,
  PayloadTooLargeError,
  PermissionDeniedError,
  RailFogError,
  RateLimitedError,
  ResourceNotFoundError,
  TimeoutError,
  UnavailableError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

/**
 * Creates a deterministic mock RailFogContext complying with FN-4, PLAT-6, and PLAT-15.
 */
function createMockRailFogContext(
  overrides?: Partial<RailFogContext>,
): RailFogContext {
  const deadline = overrides?.deadline ?? (Date.now() + 30000);
  const kvStore = new Map<string, unknown>();
  const secretStore = new Map<string, string>([
    ["STRIPE_KEY", "sk_test_12345"],
    ["DB_PASSWORD", "super_secret_pw"],
  ]);

  const mockKv: KVBinding = {
    get<T = unknown>(key: string[]): Promise<T | null> {
      const val = kvStore.get(key.join(":"));
      return Promise.resolve((val as T) ?? null);
    },
    set(key: string[], value: unknown): Promise<void> {
      kvStore.set(key.join(":"), value);
      return Promise.resolve();
    },
    delete(key: string[]): Promise<void> {
      kvStore.delete(key.join(":"));
      return Promise.resolve();
    },
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
      commit: () => Promise.resolve({ ok: true, version: 1 }),
    } as unknown as KVAtomicOperation),
  };

  const mockObjects: ObjectBinding = {
    put: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    head: () => Promise.resolve(null),
    list: () => Promise.resolve({ keys: [] }),
    createMultipartUpload: () =>
      Promise.resolve({ uploadId: "mock-upload-id" }),
    presign: (key: string) =>
      Promise.resolve({
        url: `https://storage.railfog.internal/bucket/${key}`,
        headers: {},
      }),
  };

  const mockQueues: QueueBinding = {
    send: () => Promise.resolve({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    sendBatch: () => Promise.resolve([{ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }]),
  };

  const mockEnv: EnvBinding = {
    get(key: string): string | undefined {
      return secretStore.get(key);
    },
    require(key: string): string {
      const val = secretStore.get(key);
      if (!val) {
        throw new Error(`Missing required secret: ${key}`);
      }
      return val;
    },
  };

  return {
    requestId: overrides?.requestId ?? "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    project: overrides?.project ?? "test-project",
    function: overrides?.function ?? "test-function",
    revision: overrides?.revision ?? "rev_01J8Z000000000000000000000",
    deadline,
    timeRemaining: () => Math.max(0, deadline - Date.now()),
    kv: overrides?.kv ?? mockKv,
    objects: overrides?.objects ?? mockObjects,
    queues: overrides?.queues ?? mockQueues,
    env: overrides?.env ?? mockEnv,
    ...overrides,
  };
}

// ===========================================================================
// Group 1: Auto-JSON serialization of returned values (AC1, FN-1)
// ===========================================================================

Deno.test("T-0810 / AC1 / FN-1: handle() auto-serializes returned plain object to JSON with status 200 and Content-Type application/json", async () => {
  const handler = handle(() => ({
    message: "hello railfog",
    count: 42,
    active: true,
  }));

  const req = new Request("https://example.railfog.internal/test");
  const ctx = createMockRailFogContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  const contentType = res.headers.get("content-type");
  assertExists(contentType);
  assert(
    contentType.includes("application/json"),
    `Expected application/json, got: ${contentType}`,
  );

  const data = await res.json();
  assertEquals(data, {
    message: "hello railfog",
    count: 42,
    active: true,
  });
});

Deno.test("T-0810 / AC1 / FN-1: handle() auto-serializes nested objects and empty objects", async () => {
  const nestedHandler = handle(() => ({
    user: { id: "u_1", profile: { theme: "dark" } },
    roles: ["admin", "developer"],
  }));

  const ctx = createMockRailFogContext();
  const res1 = await nestedHandler(
    new Request("https://example.railfog.internal/nested"),
    ctx,
  );
  assertEquals(res1.status, 200);
  assertEquals(await res1.json(), {
    user: { id: "u_1", profile: { theme: "dark" } },
    roles: ["admin", "developer"],
  });

  const emptyHandler = handle(() => ({}));
  const res2 = await emptyHandler(
    new Request("https://example.railfog.internal/empty"),
    ctx,
  );
  assertEquals(res2.status, 200);
  assertEquals(await res2.json(), {});
});

Deno.test("T-0810 / AC1 / FN-1: handle() auto-serializes returned arrays to JSON with status 200", async () => {
  const items = [
    { id: 1, name: "Alpha" },
    { id: 2, name: "Beta" },
    { id: 3, tags: ["prod", "edge"] },
  ];
  const handler = handle(() => items);

  const req = new Request("https://example.railfog.internal/items");
  const ctx = createMockRailFogContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  assert(res.headers.get("content-type")?.includes("application/json"));
  const data = await res.json();
  assertEquals(data, items);

  // Empty array
  const emptyArrHandler = handle(() => []);
  const resEmpty = await emptyArrHandler(req, ctx);
  assertEquals(resEmpty.status, 200);
  assertEquals(await resEmpty.json(), []);
});

Deno.test("T-0810 / AC1 / FN-1: handle() auto-serializes returned strings to JSON with status 200", async () => {
  const handler = handle(() => "simple string response");

  const req = new Request("https://example.railfog.internal/str");
  const ctx = createMockRailFogContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  assert(res.headers.get("content-type")?.includes("application/json"));
  const data = await res.json();
  assertEquals(data, "simple string response");

  // Empty string
  const emptyStrHandler = handle(() => "");
  const resEmpty = await emptyStrHandler(req, ctx);
  assertEquals(resEmpty.status, 200);
  assertEquals(await resEmpty.json(), "");
});

Deno.test("T-0810 / AC1 / FN-1: handle() auto-serializes returned numbers (integers, zero, negative floats) to JSON", async () => {
  const numbersToTest = [42, 0, -17, 3.14159, Number.MAX_SAFE_INTEGER];

  for (const num of numbersToTest) {
    const handler = handle(() => num);
    const req = new Request("https://example.railfog.internal/num");
    const ctx = createMockRailFogContext();
    const res = await handler(req, ctx);

    assertEquals(res.status, 200);
    assert(res.headers.get("content-type")?.includes("application/json"));
    const data = await res.json();
    assertEquals(data, num);
  }
});

Deno.test("T-0810 / AC1 / FN-1: handle() auto-serializes boolean values and null to JSON", async () => {
  const ctx = createMockRailFogContext();

  const boolTrueHandler = handle(() => true);
  const resTrue = await boolTrueHandler(
    new Request("https://example.railfog.internal/true"),
    ctx,
  );
  assertEquals(resTrue.status, 200);
  assertEquals(await resTrue.json(), true);

  const boolFalseHandler = handle(() => false);
  const resFalse = await boolFalseHandler(
    new Request("https://example.railfog.internal/false"),
    ctx,
  );
  assertEquals(resFalse.status, 200);
  assertEquals(await resFalse.json(), false);

  const nullHandler = handle(() => null);
  const resNull = await nullHandler(
    new Request("https://example.railfog.internal/null"),
    ctx,
  );
  assertEquals(resNull.status, 200);
  assertEquals(await resNull.json(), null);
});

Deno.test("T-0810 / AC1 / FN-1: handle() supports async Promise-returning handlers", async () => {
  const asyncHandler = handle(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { async: true, timestamp: 1234567890 };
  });

  const req = new Request("https://example.railfog.internal/async");
  const ctx = createMockRailFogContext();
  const res = await asyncHandler(req, ctx);

  assertEquals(res.status, 200);
  assert(res.headers.get("content-type")?.includes("application/json"));
  assertEquals(await res.json(), { async: true, timestamp: 1234567890 });
});

Deno.test("T-0810 / AC1 / FN-1: handle() handles void / undefined returns gracefully", async () => {
  const voidHandler = handle(() => {
    // Returns undefined
  });

  const req = new Request("https://example.railfog.internal/void");
  const ctx = createMockRailFogContext();
  const res = await voidHandler(req, ctx);

  // Status should be 200 or 204
  assert(res.status === 200 || res.status === 204);
});

// ===========================================================================
// Group 2: Explicit Web API Response pass-through (AC2, FN-1)
// ===========================================================================

Deno.test("T-0810 / AC2 / FN-1: handle() passes explicit Web API Response instances through verbatim without re-serialization", async () => {
  const customResponse = new Response("custom plain text response", {
    status: 201,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-custom-header": "test-token-xyz",
      "cache-control": "no-cache, no-store",
    },
  });

  const handler = handle(() => customResponse);

  const req = new Request("https://example.railfog.internal/custom");
  const ctx = createMockRailFogContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 201);
  assertEquals(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assertEquals(res.headers.get("x-custom-header"), "test-token-xyz");
  assertEquals(res.headers.get("cache-control"), "no-cache, no-store");
  assertEquals(await res.text(), "custom plain text response");
});

Deno.test("T-0810 / AC2 / FN-1: handle() preserves Response created with Response.json() and custom status", async () => {
  const handler = handle(() => {
    return Response.json({ accepted: true, queueId: "q_42" }, {
      status: 202,
      headers: {
        "x-trace-id": "trace-101",
      },
    });
  });

  const req = new Request("https://example.railfog.internal/accepted");
  const ctx = createMockRailFogContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 202);
  assertEquals(res.headers.get("x-trace-id"), "trace-101");
  assertEquals(await res.json(), { accepted: true, queueId: "q_42" });
});

Deno.test("T-0810 / AC2 / FN-1: handle() passes empty 204 No Content Response through verbatim", async () => {
  const handler = handle(() => new Response(null, { status: 204 }));

  const req = new Request("https://example.railfog.internal/empty");
  const ctx = createMockRailFogContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 204);
  assertEquals(await res.text(), "");
});

Deno.test("T-0810 / AC2 / FN-1: handle() passes binary octet-stream Response without JSON corruption", async () => {
  const binaryPayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const handler = handle(() =>
    new Response(binaryPayload, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })
  );

  const req = new Request("https://example.railfog.internal/bin");
  const ctx = createMockRailFogContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/octet-stream");
  const arrayBuffer = await res.arrayBuffer();
  assertEquals(new Uint8Array(arrayBuffer), binaryPayload);
});

// ===========================================================================
// Group 3: Parameter destructuring & HandlerContext helpers (FN-1, FN-4, PLAT-15)
// ===========================================================================

Deno.test("T-0810 / FN-4: handle() provides destructured access to c.req", async () => {
  let capturedMethod = "";
  let capturedHeader = "";
  let capturedUrl = "";

  const handler = handle(({ req }) => {
    capturedMethod = req.method;
    capturedHeader = req.headers.get("x-client-ver") ?? "";
    capturedUrl = req.url;
    return { ok: true };
  });

  const request = new Request("https://example.railfog.internal/api/ping", {
    method: "PUT",
    headers: { "x-client-ver": "2.4.0" },
  });
  const ctx = createMockRailFogContext();
  const res = await handler(request, ctx);

  assertEquals(res.status, 200);
  assertEquals(capturedMethod, "PUT");
  assertEquals(capturedHeader, "2.4.0");
  assertEquals(capturedUrl, "https://example.railfog.internal/api/ping");
});

Deno.test("T-0810 / FN-1: handle() provides c.body() to parse incoming JSON request body", async () => {
  interface CreateUserPayload {
    username: string;
    email: string;
    roles: string[];
  }

  const handler = handle(async ({ body }) => {
    const payload = await body<CreateUserPayload>();
    return {
      created: true,
      user: payload.username,
      roleCount: payload.roles.length,
    };
  });

  const requestPayload: CreateUserPayload = {
    username: "ada_lovelace",
    email: "ada@analytical.org",
    roles: ["pioneer", "admin"],
  };

  const req = new Request("https://example.railfog.internal/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestPayload),
  });

  const ctx = createMockRailFogContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    created: true,
    user: "ada_lovelace",
    roleCount: 2,
  });
});

Deno.test("T-0810 / Interface: handle() provides c.json(data, status) helper", async () => {
  const handler = handle(({ json }) => {
    return json({ error: "custom unauthorized", status: 401 }, 401);
  });

  const req = new Request("https://example.railfog.internal/status-check");
  const ctx = createMockRailFogContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 401);
  assert(res.headers.get("content-type")?.includes("application/json"));
  assertEquals(await res.json(), {
    error: "custom unauthorized",
    status: 401,
  });
});

Deno.test("T-0810 / Interface: handle() provides c.text(str, status) helper", async () => {
  const handler = handle(({ text }) => {
    return text("Resource created successfully", 201);
  });

  const req = new Request("https://example.railfog.internal/text-helper");
  const ctx = createMockRailFogContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 201);
  assert(res.headers.get("content-type")?.includes("text/plain"));
  assertEquals(await res.text(), "Resource created successfully");
});

Deno.test("T-0810 / AC1 / FN-4: handle() provides destructured access to c.kv with auto-JSON response", async () => {
  const ctx = createMockRailFogContext();
  // Pre-populate KV
  await ctx.kv.set(["users", "1"], { name: "Alice", active: true });

  const handler = handle(async ({ kv }) => {
    return await kv.get(["users", "1"]);
  });

  const req = new Request("https://example.railfog.internal/user/1");
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  assert(res.headers.get("content-type")?.includes("application/json"));
  assertEquals(await res.json(), { name: "Alice", active: true });
});

Deno.test("T-0810 / FN-4 / PLAT-6: handle() provides destructured access to c.objects, c.queues, c.env", async () => {
  const handler = handle(async ({ objects, queues, env }) => {
    assertExists(objects.presign);
    assertExists(queues.send);
    assertExists(env.get);

    const presigned = await objects.presign("avatar.png", { method: "GET" });
    const queueMsg = await queues.send({ job: "process_image" });
    const secretVal = env.get("STRIPE_KEY");

    return {
      presignedUrl: presigned.url,
      queueId: queueMsg.id,
      hasSecret: secretVal !== undefined,
    };
  });

  const req = new Request("https://example.railfog.internal/capabilities");
  const ctx = createMockRailFogContext();
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    presignedUrl: "https://storage.railfog.internal/bucket/avatar.png",
    queueId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    hasSecret: true,
  });
});

Deno.test("T-0810 / FN-4: handle() preserves RailFogContext metadata (requestId, project, function, revision, deadline, timeRemaining)", async () => {
  let capturedRequestId = "";
  let capturedProject = "";
  let capturedFunction = "";
  let capturedRevision = "";
  let capturedDeadline = 0;
  let capturedTimeRemaining = -1;

  const handler = handle((c) => {
    capturedRequestId = c.requestId;
    capturedProject = c.project;
    capturedFunction = c.function;
    capturedRevision = c.revision;
    capturedDeadline = c.deadline;
    capturedTimeRemaining = c.timeRemaining();
    return { ok: true };
  });

  const ctx = createMockRailFogContext({
    requestId: "01J8ZTESTREQUESTID000000000",
    project: "my-service",
    function: "worker-api",
    revision: "rev_01J8Z000000000000000000001",
  });

  const req = new Request("https://example.railfog.internal/meta");
  await handler(req, ctx);

  assertEquals(capturedRequestId, "01J8ZTESTREQUESTID000000000");
  assertEquals(capturedProject, "my-service");
  assertEquals(capturedFunction, "worker-api");
  assertEquals(capturedRevision, "rev_01J8Z000000000000000000001");
  assert(capturedDeadline > 0);
  assert(capturedTimeRemaining >= 0);
});

// ===========================================================================
// Group 4: Error normalization to canonical platform error format (AC3, PLAT-12)
// ===========================================================================

Deno.test("T-0810 / AC3 / PLAT-12: handle() normalizes thrown RailFogError instances with mapped status codes", async () => {
  const errorCases: Array<{
    error: RailFogError;
    expectedCode: string;
    expectedStatus: number;
  }> = [
    {
      error: new ResourceNotFoundError("User 999 not found"),
      expectedCode: "RESOURCE_NOT_FOUND",
      expectedStatus: 404,
    },
    {
      error: new ValidationFailedError("Field 'email' is required"),
      expectedCode: "VALIDATION_FAILED",
      expectedStatus: 400,
    },
    {
      error: new PermissionDeniedError("Unauthorized KV write access"),
      expectedCode: "PERMISSION_DENIED",
      expectedStatus: 403,
    },
    {
      error: new RateLimitedError("Too many invocations"),
      expectedCode: "RATE_LIMITED",
      expectedStatus: 429,
    },
    {
      error: new CallDepthExceededError("Exceeded maximum recursion depth 8"),
      expectedCode: "CALL_DEPTH_EXCEEDED",
      expectedStatus: 429,
    },
    {
      error: new TimeoutError("Execution exceeded 30000ms"),
      expectedCode: "TIMEOUT",
      expectedStatus: 504,
    },
    {
      error: new PayloadTooLargeError("Request body exceeded 10MB"),
      expectedCode: "PAYLOAD_TOO_LARGE",
      expectedStatus: 413,
    },
    {
      error: new ConflictError("KV check-and-set version conflict"),
      expectedCode: "CONFLICT",
      expectedStatus: 409,
    },
    {
      error: new UnavailableError(
        "Downstream provider temporarily unavailable",
      ),
      expectedCode: "UNAVAILABLE",
      expectedStatus: 503,
    },
    {
      error: new InternalError("Runtime sandbox internal failure"),
      expectedCode: "INTERNAL",
      expectedStatus: 500,
    },
  ];

  for (const tc of errorCases) {
    const handler = handle(() => {
      throw tc.error;
    });

    const ctx = createMockRailFogContext({
      requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    const req = new Request("https://example.railfog.internal/error-test");
    const res = await handler(req, ctx);

    assertEquals(
      res.status,
      tc.expectedStatus,
      `Expected status ${tc.expectedStatus} for error ${tc.expectedCode}, got ${res.status}`,
    );

    assert(
      res.headers.get("content-type")?.includes("application/json"),
      "Error response must have Content-Type application/json per PLAT-12",
    );

    const body = await res.json();
    assertExists(
      body.error,
      "Response body must contain 'error' property per PLAT-12",
    );
    assertEquals(body.error.code, tc.expectedCode);
    assertEquals(body.error.message, tc.error.message);
    assertEquals(
      body.error.request_id ?? res.headers.get("x-request-id") ??
        res.headers.get("request-id"),
      ctx.requestId,
      "Error response must correlate with context requestId per PLAT-12",
    );
  }
});

Deno.test("T-0810 / AC3 / PLAT-12: handle() normalizes unhandled generic Error to status 500 and INTERNAL code", async () => {
  const handler = handle(() => {
    throw new Error("Unexpected database connection drop");
  });

  const ctx = createMockRailFogContext({
    requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  const req = new Request("https://example.railfog.internal/unhandled-error");
  const res = await handler(req, ctx);

  assertEquals(res.status, 500);
  assert(res.headers.get("content-type")?.includes("application/json"));

  const body = await res.json();
  assertExists(body.error);
  assertEquals(body.error.code, "INTERNAL");
  assertEquals(body.error.message, "Unexpected database connection drop");
});

Deno.test("T-0810 / AC3 / PLAT-12: handle() normalizes thrown non-Error primitives (string, number) to status 500 INTERNAL", async () => {
  const stringThrowHandler = handle(() => {
    throw "string exception thrown directly";
  });

  const ctx = createMockRailFogContext({
    requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  const req = new Request("https://example.railfog.internal/primitive-error");
  const res = await stringThrowHandler(req, ctx);

  assertEquals(res.status, 500);
  assert(res.headers.get("content-type")?.includes("application/json"));

  const body = await res.json();
  assertExists(body.error);
  assertEquals(body.error.code, "INTERNAL");
  assert(body.error.message.includes("string exception thrown directly"));
});

Deno.test("T-0810 / AC3 / PLAT-12: handle() preserves pre-assigned requestId on error if already present", async () => {
  const errorWithCustomReqId = new ResourceNotFoundError(
    "Item not found",
    "req_custom_001",
  );
  const handler = handle(() => {
    throw errorWithCustomReqId;
  });

  const ctx = createMockRailFogContext({ requestId: "req_default_fallback" });
  const req = new Request("https://example.railfog.internal/req-id-check");
  const res = await handler(req, ctx);

  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error.request_id, "req_custom_001");
});

// ===========================================================================
// Group 5: api() micro-router pattern matching & route resolution (AC4, FN-1, PLAT-11)
// ===========================================================================

Deno.test("T-0810 / AC4 / FN-1: api() executes matching handler for GET and POST route patterns", async () => {
  const router = api({
    "GET /items": () => [
      { id: "1", title: "Item 1" },
      { id: "2", title: "Item 2" },
    ],
    "POST /items": async ({ body }) => {
      const payload = await body<{ title: string }>();
      return { id: "3", title: payload.title, created: true };
    },
  });

  const ctx = createMockRailFogContext();

  // Test GET /items
  const getReq = new Request("https://example.railfog.internal/items", {
    method: "GET",
  });
  const getRes = await router(getReq, ctx);
  assertEquals(getRes.status, 200);
  assert(getRes.headers.get("content-type")?.includes("application/json"));
  const getBody = await getRes.json();
  assertEquals(getBody, [
    { id: "1", title: "Item 1" },
    { id: "2", title: "Item 2" },
  ]);

  // Test POST /items
  const postReq = new Request("https://example.railfog.internal/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "New Item 3" }),
  });
  const postRes = await router(postReq, ctx);
  assertEquals(postRes.status, 200);
  assert(postRes.headers.get("content-type")?.includes("application/json"));
  const postBody = await postRes.json();
  assertEquals(postBody, { id: "3", title: "New Item 3", created: true });
});

Deno.test("T-0810 / AC4 / PLAT-12: api() returns 404 NOT_FOUND canonical JSON error when no route matches path", async () => {
  const router = api({
    "GET /users": () => [{ id: "u_1" }],
    "POST /users": () => ({ created: true }),
  });

  const ctx = createMockRailFogContext({
    requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  const req = new Request("https://example.railfog.internal/products", {
    method: "GET",
  });
  const res = await router(req, ctx);

  assertEquals(res.status, 404);
  assert(
    res.headers.get("content-type")?.includes("application/json"),
    "404 error must have Content-Type application/json per PLAT-12",
  );

  const body = await res.json();
  assertExists(body.error);
  assertEquals(body.error.code, "RESOURCE_NOT_FOUND");
});

Deno.test("T-0810 / AC4 / PLAT-12: api() returns 404 when path matches but method does not match declared routes", async () => {
  const router = api({
    "GET /items": () => [{ id: "1" }],
  });

  const ctx = createMockRailFogContext();
  const deleteReq = new Request("https://example.railfog.internal/items", {
    method: "DELETE",
  });
  const res = await router(deleteReq, ctx);

  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error.code, "RESOURCE_NOT_FOUND");
});

Deno.test("T-0810 / AC4 / PLAT-11: api() supports parameterized route paths (e.g. GET /items/:id)", async () => {
  const router = api({
    "GET /items": () => ["all_items"],
    "GET /items/:id": ({ req }) => {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);
      const id = parts[parts.length - 1];
      return { itemId: id };
    },
  });

  const ctx = createMockRailFogContext();

  const specificReq = new Request(
    "https://example.railfog.internal/items/item_abc123",
    {
      method: "GET",
    },
  );
  const res = await router(specificReq, ctx);

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { itemId: "item_abc123" });
});

Deno.test("T-0810 / AC4: api() correctly matches routes when query strings or hash fragments are present", async () => {
  const router = api({
    "GET /search": ({ req }) => {
      const url = new URL(req.url);
      return { query: url.searchParams.get("q") };
    },
  });

  const ctx = createMockRailFogContext();
  const req = new Request(
    "https://example.railfog.internal/search?q=deno+serverless#results",
    { method: "GET" },
  );
  const res = await router(req, ctx);

  assertEquals(res.status, 200);
  assertEquals(await res.json(), { query: "deno serverless" });
});

Deno.test("T-0810 / AC4: api() route handlers inherit full handle() ergonomics (explicit Response, error normalization)", async () => {
  const router = api({
    "GET /custom-response": () => {
      return new Response("verbatim text", {
        status: 206,
        headers: { "content-type": "text/plain" },
      });
    },
    "GET /error": () => {
      throw new ValidationFailedError("Validation failure in route handler");
    },
  });

  const ctx = createMockRailFogContext({
    requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });

  // Explicit Response passthrough
  const res1 = await router(
    new Request("https://example.railfog.internal/custom-response"),
    ctx,
  );
  assertEquals(res1.status, 206);
  assertEquals(await res1.text(), "verbatim text");

  // Error normalization
  const res2 = await router(
    new Request("https://example.railfog.internal/error"),
    ctx,
  );
  assertEquals(res2.status, 400);
  const body2 = await res2.json();
  assertEquals(body2.error.code, "VALIDATION_FAILED");
  assertEquals(body2.error.message, "Validation failure in route handler");
});

Deno.test("T-0810 / AC4: api() with empty route map returns 404 for any incoming request", async () => {
  const emptyRouter = api({});
  const ctx = createMockRailFogContext();
  const res = await emptyRouter(
    new Request("https://example.railfog.internal/"),
    ctx,
  );

  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error.code, "RESOURCE_NOT_FOUND");
});

Deno.test("T-0810 / AC4: api() handles HTTP methods case-insensitively in route keys", async () => {
  const router = api({
    "get /status": () => ({ status: "operational" }),
  });

  const ctx = createMockRailFogContext();
  const req = new Request("https://example.railfog.internal/status", {
    method: "GET",
  });
  const res = await router(req, ctx);

  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "operational" });
});

// ===========================================================================
// Group 6: Adversarial security tests (PLAT-15, PLAT-6, PLAT-12)
// ===========================================================================

Deno.test("PLAT-15 / Security: c.env does not leak undeclared secrets", async () => {
  let accessedUndeclared: string | undefined = "sentinel";

  const handler = handle(({ env }) => {
    accessedUndeclared = env.get("AWS_SECRET_ACCESS_KEY");
    return { ok: true };
  });

  const ctx = createMockRailFogContext();
  const req = new Request("https://example.railfog.internal/secret-check");
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  assertEquals(
    accessedUndeclared,
    undefined,
    "c.env.get() must return undefined for undeclared secrets",
  );
});

Deno.test("PLAT-15 / Security: c.env.require() throws on undeclared secrets and normalizes to PLAT-12 500 error", async () => {
  const handler = handle(({ env }) => {
    env.require("MISSING_KEY");
    return { ok: true };
  });

  const ctx = createMockRailFogContext();
  const req = new Request("https://example.railfog.internal/require-check");
  const res = await handler(req, ctx);

  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error.code, "INTERNAL");
  assert(body.error.message.includes("Missing required secret"));
});

Deno.test("PLAT-12 / Security: Normalization protects error response structure from arbitrary prototype pollution", async () => {
  const maliciousError = new Error("Injection payload");
  (maliciousError as unknown as Record<string, unknown>).__proto__ = {
    polluted: true,
  };

  const handler = handle(() => {
    throw maliciousError;
  });

  const ctx = createMockRailFogContext();
  const req = new Request("https://example.railfog.internal/prototype-check");
  const res = await handler(req, ctx);

  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error.code, "INTERNAL");
  assertEquals(typeof body.error, "object");
  assertEquals(Object.prototype.hasOwnProperty.call(body.error, "code"), true);
});

Deno.test("T-0810 / Types: HandlerContext, HandlerFn, HandlerResult, ApiRouteMap, and FunctionHandler contract typing", () => {
  const sampleMap: ApiRouteMap = {
    "GET /test": (_c: HandlerContext): HandlerResult => "ok",
  };
  const fn: HandlerFn = (_c: HandlerContext): HandlerResult => ({ ok: true });
  const handler: FunctionHandler = handle(fn);

  assertExists(sampleMap);
  assertExists(handler);
  assertFalse(false);
  assertNotEquals(sampleMap, null);
});

Deno.test("T-0810 / Ergonomics: api() provides c.params containing URLPattern route parameter groups", async () => {
  const router = api({
    "GET /users/:userId/posts/:postId": (c) => {
      return {
        userId: c.params?.userId,
        postId: c.params?.postId,
      };
    },
  });

  const ctx = createMockRailFogContext();
  const req = new Request(
    "https://example.railfog.internal/users/usr_100/posts/pst_200",
  );
  const res = await router(req, ctx);

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data, { userId: "usr_100", postId: "pst_200" });
});

Deno.test("T-0810 / Ergonomics: c.stream() emits chunked byte stream", async () => {
  const handler = handle((c) => {
    return c.stream(async (writer) => {
      await writer.write("chunk-1;");
      await writer.write("chunk-2;");
      await writer.close();
    });
  });

  const ctx = createMockRailFogContext();
  const req = new Request("https://example.railfog.internal/stream");
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/octet-stream");
  const bodyText = await res.text();
  assertEquals(bodyText, "chunk-1;chunk-2;");
});

Deno.test("T-0810 / Ergonomics: c.sse() emits formatted text/event-stream events", async () => {
  const handler = handle((c) => {
    return c.sse(async (sse) => {
      await sse.send({ event: "message", data: { text: "hello" }, id: "1" });
      await sse.send({ data: "world" });
      await sse.close();
    });
  });

  const ctx = createMockRailFogContext();
  const req = new Request("https://example.railfog.internal/events");
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  const bodyText = await res.text();
  assert(bodyText.includes("id: 1\n"));
  assert(bodyText.includes("event: message\n"));
  assert(bodyText.includes('data: {"text":"hello"}\n'));
  assert(bodyText.includes("data: world\n"));
});
