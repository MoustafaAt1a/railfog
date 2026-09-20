import {
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { delay } from "@std/async/delay";
import { fromFileUrl } from "@std/path";
import {
  buildContext,
  DEFAULT_TIMEOUT_MS,
  loadFunction,
} from "../../runtime/loader/function-loader.ts";
import { isValidUlid } from "../../packages/core/id/ulid.ts";

import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
  ResolvedBindings,
} from "../../packages/policy/permission-resolver.ts";
import type { LoadedFunctionMeta } from "../../runtime/loader/context-builder.ts";

const dummyKV: KVBinding = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  list: () => Promise.resolve({ keys: [] }),
  atomic: () => ({} as unknown as ReturnType<KVBinding["atomic"]>),
};

const dummyObjects: ObjectBinding = {
  put: () => Promise.resolve({ etag: "dummy-etag" }),
  get: () => Promise.resolve(null),
  delete: () => Promise.resolve(),
  head: () => Promise.resolve(null),
  list: () => Promise.resolve({ keys: [] }),
  presign: () =>
    Promise.resolve({ url: "https://example.com", expiresAt: Date.now() }),
  createMultipartUpload: () => Promise.resolve({ uploadId: "dummy-upload" }),
};

const dummyQueues: QueueBinding = {
  send: () => Promise.resolve({ id: "dummy-id" }),
  sendBatch: () => Promise.resolve([]),
  receive: () => Promise.resolve(null),
  ack: () => Promise.resolve(),
};

const dummyBindings: ResolvedBindings = {
  kv: dummyKV,
  objects: dummyObjects,
  queues: dummyQueues,
};

const dummyMeta: LoadedFunctionMeta = {
  project: "proj1",
  function: "func1",
  revision: "rev1",
  timeout_ms: 30000,
};

Deno.test("buildContext: returns valid ULID for requestId", () => {
  const ctx = buildContext(dummyMeta, dummyBindings);
  assertEquals(
    isValidUlid(ctx.requestId),
    true,
    "requestId must be a valid ULID",
  );
});

Deno.test("buildContext: deadline math and timeRemaining", async () => {
  const start = Date.now();
  const ctx = buildContext(dummyMeta, dummyBindings);

  assertAlmostEquals(
    ctx.deadline,
    start + 30000,
    50,
    "deadline should be current time + timeout_ms",
  );

  await delay(100);

  const elapsed = Date.now() - start;
  const remaining = ctx.timeRemaining();
  assertAlmostEquals(
    remaining,
    30000 - elapsed,
    50,
    "timeRemaining should use real elapsed time",
  );
  assertAlmostEquals(
    remaining,
    29900,
    200,
    "timeRemaining should return approximately 29900 after ~100ms delay",
  );
});

Deno.test("buildContext: default timeout uses DEFAULT_TIMEOUT_MS if omitted", () => {
  assertEquals(
    DEFAULT_TIMEOUT_MS,
    30_000,
    "DEFAULT_TIMEOUT_MS must be 30,000 per FN-5",
  );
  const noTimeoutMeta = { ...dummyMeta };
  delete noTimeoutMeta.timeout_ms;
  const start = Date.now();
  const ctx = buildContext(noTimeoutMeta, dummyBindings);
  assertAlmostEquals(
    ctx.deadline,
    start + DEFAULT_TIMEOUT_MS,
    50,
    "default timeout should be DEFAULT_TIMEOUT_MS (30000ms)",
  );
});

Deno.test("buildContext: env binding is empty and does not expose Deno.env", () => {
  const ctx = buildContext(dummyMeta, dummyBindings);
  assertEquals(
    ctx.env.get("TEST_SECRET"),
    undefined,
    "env binding must not expose Deno.env",
  );
});

Deno.test("buildContext: project, function, revision match meta", () => {
  const ctx = buildContext(dummyMeta, dummyBindings);
  assertEquals(ctx.project, "proj1");
  assertEquals(ctx.function, "func1");
  assertEquals(ctx.revision, "rev1");
});

Deno.test("Warm-reuse rule (FN-6): buildContext returns separate contexts and bindings per invocation", () => {
  const ctx1 = buildContext(dummyMeta, dummyBindings);
  const ctx2 = buildContext(dummyMeta, dummyBindings);

  assertNotStrictEquals(ctx1, ctx2, "Contexts must not be the same instance");
  assertNotEquals(ctx1.requestId, ctx2.requestId, "Request IDs must differ");

  // Verify that binding objects on the context are fresh shallow clones, not identical instances
  assertNotStrictEquals(
    ctx1.kv,
    ctx2.kv,
    "KV bindings must not be the same instance across invocations",
  );
  assertNotStrictEquals(
    ctx1.kv,
    dummyBindings.kv,
    "Context KV binding must not be identical reference to injected binding",
  );

  assertNotStrictEquals(
    ctx1.objects,
    ctx2.objects,
    "Object bindings must not be the same instance across invocations",
  );
  assertNotStrictEquals(
    ctx1.objects,
    dummyBindings.objects,
    "Context Object binding must not be identical reference to injected binding",
  );

  assertNotStrictEquals(
    ctx1.queues,
    ctx2.queues,
    "Queue bindings must not be the same instance across invocations",
  );
  assertNotStrictEquals(
    ctx1.queues,
    dummyBindings.queues,
    "Context Queue binding must not be identical reference to injected binding",
  );

  assertNotStrictEquals(
    ctx1.env,
    ctx2.env,
    "Env bindings must not be the same instance across invocations",
  );
});

Deno.test("loadFunction: successfully loads a valid function and caches it", async () => {
  const fixturePath = fromFileUrl(
    new URL(
      "../../tests/fixtures/functions/valid_function.ts",
      import.meta.url,
    ),
  );

  const res1 = await loadFunction(fixturePath);
  assertEquals(typeof res1.handler, "function");

  const res2 = await loadFunction(fixturePath);
  assertStrictEquals(
    res1.handler,
    res2.handler,
    "Function handler should be cached across loads",
  );
});

Deno.test("loadFunction: throws ValidationFailedError if file missing", async () => {
  await assertRejects(
    () => loadFunction("../fixtures/functions/does_not_exist.ts"),
    Error,
    "VALIDATION_FAILED",
  );
});

Deno.test("loadFunction: throws ValidationFailedError if no default export", async () => {
  const fixturePath = fromFileUrl(
    new URL(
      "../../tests/fixtures/functions/invalid_no_export.ts",
      import.meta.url,
    ),
  );
  await assertRejects(
    () => loadFunction(fixturePath),
    Error,
    "VALIDATION_FAILED",
  );
});

Deno.test("loadFunction: throws ValidationFailedError if default export is not a function", async () => {
  const fixturePath = fromFileUrl(
    new URL(
      "../../tests/fixtures/functions/invalid_wrong_type.ts",
      import.meta.url,
    ),
  );
  await assertRejects(
    () => loadFunction(fixturePath),
    Error,
    "VALIDATION_FAILED",
  );
});
