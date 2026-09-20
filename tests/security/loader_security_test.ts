import {
  assertEquals,
  assertIsError,
  assertNotEquals,
  assertNotStrictEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { delay } from "@std/async/delay";
import { fromFileUrl } from "@std/path";
import {
  buildContext,
  type LoadedFunctionMeta,
  loadFunction,
} from "../../runtime/loader/function-loader.ts";
import { isValidUlid } from "../../packages/core/id/ulid.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import type {
  KVBinding,
  ResolvedBindings,
} from "../../packages/policy/permission-resolver.ts";

function createMockBindings(): ResolvedBindings {
  return {
    kv: {
      get: () => Promise.resolve("kv-original-val"),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve({ keys: [] }),
      atomic: () => ({} as unknown as ReturnType<KVBinding["atomic"]>),
    },
    objects: {
      put: () => Promise.resolve({ etag: "obj-original-etag" }),
      get: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
      head: () => Promise.resolve({ size: 10, etag: "head-etag" }),
      list: () => Promise.resolve({ keys: [] }),
      presign: () =>
        Promise.resolve({ url: "https://example.com", expiresAt: Date.now() }),
      createMultipartUpload: () =>
        Promise.resolve({ uploadId: "original-upload" }),
    },
    queues: {
      send: () => Promise.resolve({ id: "queue-original-id" }),
      sendBatch: () => Promise.resolve([]),
      receive: () => Promise.resolve(null),
      ack: () => Promise.resolve(),
    },
  };
}

const defaultMeta: LoadedFunctionMeta = {
  project: "adversarial-proj",
  function: "adversarial-fn",
  revision: "rev_01J8ZTEST0000000000000000",
  timeout_ms: 30000,
};

// ============================================================================
// 1. Warm-Isolate Reuse Rule (FN-6) Adversarial Checks
// ============================================================================

Deno.test("Adversarial FN-6: Binding mutation in Invocation 1 cannot bleed state into Invocation 2", async () => {
  const originalBindings = createMockBindings();

  // Invocation 1
  const ctx1 = buildContext(defaultMeta, originalBindings);

  // Attacker tampers with methods and properties in ctx1
  (ctx1 as unknown as Record<string, unknown>).taintedProperty =
    "stolen_secret_data";

  // Tamper with KV binding
  ctx1.kv.get = () => Promise.resolve("HIJACKED_KV_VALUE");
  (ctx1.kv as unknown as Record<string, unknown>).injectedKvProperty =
    "kv_backdoor";

  // Tamper with Objects binding
  ctx1.objects.put = () => Promise.resolve({ etag: "HIJACKED_ETAG" });
  (ctx1.objects as unknown as Record<string, unknown>).injectedObjectProperty =
    "objects_backdoor";

  // Tamper with Queues binding
  ctx1.queues.send = () => Promise.resolve({ id: "HIJACKED_QUEUE_ID" });
  (ctx1.queues as unknown as Record<string, unknown>).injectedQueueProperty =
    "queues_backdoor";

  // Tamper with Env binding
  ctx1.env.get = () => "HIJACKED_ENV_SECRET";
  (ctx1.env as unknown as Record<string, unknown>).injectedEnvProperty =
    "env_backdoor";

  // Verify ctx1 was indeed tampered
  assertEquals(await ctx1.kv.get(["test"]), "HIJACKED_KV_VALUE");
  assertEquals(ctx1.env.get("ANY"), "HIJACKED_ENV_SECRET");

  // Invocation 2 in the same warm isolate
  const ctx2 = buildContext(defaultMeta, originalBindings);

  // Assert complete state isolation
  assertNotStrictEquals(
    ctx1,
    ctx2,
    "Contexts must have different object identities",
  );
  assertEquals(
    (ctx2 as unknown as Record<string, unknown>).taintedProperty,
    undefined,
    "Root context property must not bleed",
  );

  // KV isolation
  assertNotStrictEquals(
    ctx1.kv,
    ctx2.kv,
    "KV binding instance must be fresh clone",
  );
  assertNotStrictEquals(
    ctx2.kv.get,
    ctx1.kv.get,
    "Tampered KV method must not bleed",
  );
  assertEquals(
    (ctx2.kv as unknown as Record<string, unknown>).injectedKvProperty,
    undefined,
    "Injected KV property must not bleed",
  );
  assertEquals(
    await ctx2.kv.get(["test"]),
    "kv-original-val",
    "KV get must invoke pristine binding",
  );

  // Objects isolation
  assertNotStrictEquals(
    ctx1.objects,
    ctx2.objects,
    "Objects binding instance must be fresh clone",
  );
  assertNotStrictEquals(
    ctx2.objects.put,
    ctx1.objects.put,
    "Tampered Objects method must not bleed",
  );
  assertEquals(
    (ctx2.objects as unknown as Record<string, unknown>).injectedObjectProperty,
    undefined,
    "Injected Objects property must not bleed",
  );
  const objRes = await ctx2.objects.put("key", new ArrayBuffer(0));
  assertEquals(
    objRes.etag,
    "obj-original-etag",
    "Objects put must invoke pristine binding",
  );

  // Queues isolation
  assertNotStrictEquals(
    ctx1.queues,
    ctx2.queues,
    "Queues binding instance must be fresh clone",
  );
  assertNotStrictEquals(
    ctx2.queues.send,
    ctx1.queues.send,
    "Tampered Queues method must not bleed",
  );
  assertEquals(
    (ctx2.queues as unknown as Record<string, unknown>).injectedQueueProperty,
    undefined,
    "Injected Queues property must not bleed",
  );
  const queueRes = await ctx2.queues.send({ test: true });
  assertEquals(
    queueRes.id,
    "queue-original-id",
    "Queues send must invoke pristine binding",
  );

  // Env isolation
  assertNotStrictEquals(
    ctx1.env,
    ctx2.env,
    "Env binding instance must be fresh clone",
  );
  assertNotStrictEquals(
    ctx2.env.get,
    ctx1.env.get,
    "Tampered Env method must not bleed",
  );
  assertEquals(
    (ctx2.env as unknown as Record<string, unknown>).injectedEnvProperty,
    undefined,
    "Injected Env property must not bleed",
  );
  assertEquals(
    ctx2.env.get("ANY"),
    undefined,
    "Env get must remain clean undefined",
  );
});

Deno.test("Adversarial FN-6: Request ID, deadline and timeRemaining are distinct and fresh per invocation", async () => {
  const bindings = createMockBindings();
  const shortTimeoutMeta: LoadedFunctionMeta = {
    ...defaultMeta,
    timeout_ms: 200,
  };

  const ctx1 = buildContext(shortTimeoutMeta, bindings);
  assertEquals(
    isValidUlid(ctx1.requestId),
    true,
    "ctx1.requestId must be valid ULID",
  );

  // Wait 250ms for ctx1 deadline to expire
  await delay(250);

  assertEquals(
    ctx1.timeRemaining(),
    0,
    "ctx1 must be expired after 250ms (timeout was 200ms)",
  );

  // New invocation arrives in the same isolate
  const ctx2 = buildContext(defaultMeta, bindings);
  assertEquals(
    isValidUlid(ctx2.requestId),
    true,
    "ctx2.requestId must be valid ULID",
  );
  assertNotEquals(
    ctx1.requestId,
    ctx2.requestId,
    "requestId must be globally unique per invocation",
  );
  assertNotEquals(
    ctx1.deadline,
    ctx2.deadline,
    "ctx2 must have its own fresh deadline",
  );

  // ctx2 must have full remaining time (~30000ms), NOT 0
  const remaining2 = ctx2.timeRemaining();
  assertEquals(
    remaining2 > 29000,
    true,
    "ctx2 must have fresh timeout budget, not expired ctx1 state",
  );
});

Deno.test("Adversarial FN-6: Function loader caches ONLY handler and never bindings or context", async () => {
  const fixturePath = fromFileUrl(
    new URL(
      "../fixtures/functions/valid_function.ts",
      import.meta.url,
    ),
  );

  const loaded1 = await loadFunction(fixturePath, "revA");
  const loaded2 = await loadFunction(fixturePath, "revB");
  assertNotStrictEquals(
    loaded1,
    loaded2,
    "Different revisions must have distinct cache entries",
  );

  // Verify structure of LoadedFunction
  const keys = Object.keys(loaded1);
  assertEquals(keys, ["handler"], "LoadedFunction must contain ONLY 'handler'");
  assertEquals(typeof loaded1.handler, "function");

  // Same revision returns cached handler
  const loaded1Again = await loadFunction(fixturePath, "revA");
  assertStrictEquals(
    loaded1.handler,
    loaded1Again.handler,
    "Same revision reuses compiled handler",
  );

  // LoadedFunction must not have any context or binding references attached
  const loadedUnknown = loaded1 as unknown as Record<string, unknown>;
  assertEquals(loadedUnknown.ctx, undefined);
  assertEquals(loadedUnknown.bindings, undefined);
  assertEquals(loadedUnknown.env, undefined);
});

// ============================================================================
// 2. Secrets Isolation (PLAT-15) Adversarial Checks
// ============================================================================

Deno.test("Adversarial PLAT-15: ctx.env does not leak host Deno.env process environment", async () => {
  const secretKey = "RAILFOG_INTERNAL_TEST_SECRET";
  const secretVal = "super_classified_token_987654321";

  // If env permission is available, test with a real env variable planted
  const envPerm = await Deno.permissions.query({ name: "env" });
  if (envPerm.state === "granted") {
    Deno.env.set(secretKey, secretVal);
  }

  try {
    const ctx = buildContext(defaultMeta, createMockBindings());

    // Adversary attempts to read process environment variables through ctx.env
    assertEquals(
      ctx.env.get(secretKey),
      undefined,
      "ctx.env.get must NEVER return process environment variables",
    );

    // Adversary attempts to read standard system environment variables
    // In a restricted isolate, calling Deno.env.get would throw PermissionDenied,
    // but ctx.env.get must safely return undefined without any host env leakage.
    assertEquals(ctx.env.get("PATH"), undefined, "ctx.env must not leak PATH");
    assertEquals(ctx.env.get("USER"), undefined, "ctx.env must not leak USER");
    assertEquals(ctx.env.get("HOME"), undefined, "ctx.env must not leak HOME");
    assertEquals(
      ctx.env.get("DENO_DIR"),
      undefined,
      "ctx.env must not leak DENO_DIR",
    );
  } finally {
    if (envPerm.state === "granted") {
      Deno.env.delete(secretKey);
    }
  }
});

Deno.test("Adversarial PLAT-15: ctx.env rejects prototype pollution and property traversal", () => {
  const ctx = buildContext(defaultMeta, createMockBindings());

  // Probing prototype and constructor keys
  assertEquals(ctx.env.get("__proto__"), undefined);
  assertEquals(ctx.env.get("constructor"), undefined);
  assertEquals(ctx.env.get("toString"), undefined);
  assertEquals(ctx.env.get("valueOf"), undefined);

  // Ensure ctx.env does not expose Deno.env API methods
  const envUnknown = ctx.env as unknown as Record<string, unknown>;
  assertEquals(envUnknown.toObject, undefined);
  assertEquals(envUnknown.set, undefined);
  assertEquals(envUnknown.delete, undefined);
  assertEquals(envUnknown.has, undefined);

  // Ensure JSON serialization of ctx.env produces empty object with no hidden state
  assertEquals(JSON.stringify(ctx.env), "{}");
  // Only the 'get' method should exist on ctx.env - no credentials or hidden fields
  assertEquals(Object.keys(ctx.env), ["get"]);
});

// ============================================================================
// 3. Module Loading & Validation Resilience Adversarial Checks
// ============================================================================

Deno.test("Adversarial Validation: Path traversal to non-existent file throws VALIDATION_FAILED", async () => {
  const maliciousPath = "../../some/fake/path/../../etc/passwd";
  await assertRejects(
    () => loadFunction(maliciousPath),
    ValidationFailedError,
    "VALIDATION_FAILED",
  );
});

Deno.test("Adversarial Validation: Module with no default export throws VALIDATION_FAILED", async () => {
  const fixturePath = fromFileUrl(
    new URL(
      "../fixtures/functions/invalid_no_export.ts",
      import.meta.url,
    ),
  );
  const error = await assertRejects(
    () => loadFunction(fixturePath),
    ValidationFailedError,
    "VALIDATION_FAILED",
  );
  assertIsError(error, ValidationFailedError);
  assertEquals(error.code, "VALIDATION_FAILED");
});

Deno.test("Adversarial Validation: Module with string default export throws VALIDATION_FAILED", async () => {
  const fixturePath = fromFileUrl(
    new URL(
      "../fixtures/functions/invalid_wrong_type.ts",
      import.meta.url,
    ),
  );
  const error = await assertRejects(
    () => loadFunction(fixturePath),
    ValidationFailedError,
    "VALIDATION_FAILED",
  );
  assertIsError(error, ValidationFailedError);
  assertEquals(error.code, "VALIDATION_FAILED");
});

Deno.test("Adversarial Validation: Module with object default export throws VALIDATION_FAILED", async () => {
  const fixturePath = fromFileUrl(
    new URL(
      "../fixtures/functions/invalid_object_export.ts",
      import.meta.url,
    ),
  );
  const error = await assertRejects(
    () => loadFunction(fixturePath),
    ValidationFailedError,
    "VALIDATION_FAILED",
  );
  assertIsError(error, ValidationFailedError);
  assertEquals(error.code, "VALIDATION_FAILED");
});

Deno.test("Adversarial Validation: Module with null default export throws VALIDATION_FAILED", async () => {
  const fixturePath = fromFileUrl(
    new URL(
      "../fixtures/functions/invalid_null_export.ts",
      import.meta.url,
    ),
  );
  const error = await assertRejects(
    () => loadFunction(fixturePath),
    ValidationFailedError,
    "VALIDATION_FAILED",
  );
  assertIsError(error, ValidationFailedError);
  assertEquals(error.code, "VALIDATION_FAILED");
});
