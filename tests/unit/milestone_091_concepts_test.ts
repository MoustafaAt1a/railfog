// spec: docs/contracts/concepts.contract.md#CONCEPT-1 — Four Fundamental Concepts
// spec: docs/contracts/concepts.contract.md#CONCEPT-2 — Two-Layer Taxonomy
// spec: docs/contracts/concepts.contract.md#CONCEPT-3 — Four Fundamental Verbs
// spec: docs/contracts/concepts.contract.md#CONCEPT-4 — Composition-First Principle & Primitive Addition Test
// spec: docs/contracts/concepts.contract.md#CONCEPT-5 — Semantic Honesty & Provider Independence
// spec: docs/contracts/concepts.contract.md#CONCEPT-6 — Conceptual Capability Scoping
// spec: docs/contracts/concepts.contract.md#CONCEPT-7 — Data by Reference & Zero-Copy Flow
// spec: docs/contracts/concepts.contract.md#CONCEPT-8 — Anti-Framework Boundary
// spec: docs/contracts/platform.contract.md#PLAT-6 — Capability-based security model & mutual exclusivity
// spec: docs/contracts/platform.contract.md#PLAT-7 — Multi-tenant resource partitioning & path traversal prevention
// spec: tasks/milestone-0.9.1-unified-four-primitives/T-0917-milestone-091-composition-verification-suite.md

import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  consumer,
  handle,
  type HandlerContext,
} from "../../sdk/typescript/wrapper.ts";
import type {
  ComputeHandler,
  DataBinding,
  EnvBinding,
  FunctionHandler,
  KVBinding,
  ObjectBinding,
  QueueBinding,
  QueueConsumerHandler,
  QueueMessage,
  RailFogContext,
  SignalBinding,
  StateBinding,
} from "../../sdk/typescript/mod.ts";
import {
  type DeclaredPermissions,
  normalizeDeclaredCapabilities,
  resolvePermissions,
} from "../../packages/policy/permission-resolver.ts";
import { packageFunctionArtifact } from "../../packages/core/artifact/packager.ts";
import { checkProject, type ValidationIssue } from "../../cli/check.ts";
import {
  UnavailableError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type { QueueProvider } from "../../primitives/queues/queue-provider.ts";

/**
 * Creates dummy provider instances for unused capabilities in tests.
 */
function createDummyProviders(): {
  kv: KVProvider;
  objects: ObjectProvider;
  queues: QueueProvider;
} {
  return {
    kv: {} as unknown as KVProvider,
    objects: {} as unknown as ObjectProvider,
    queues: {} as unknown as QueueProvider,
  };
}

/**
 * Creates a deterministic mock RailFogContext wired with provided capability bindings.
 * Conforms to FN-4, PLAT-6, and CONCEPT-2.
 */
function createMockContext(
  bindings: {
    kv?: unknown;
    objects?: unknown;
    queues?: unknown;
    env?: EnvBinding;
  },
  overrides?: Partial<RailFogContext>,
): RailFogContext {
  const deadline = overrides?.deadline ?? (Date.now() + 30000);
  const dummyEnv: EnvBinding = {
    get: (_k: string) => undefined,
    require: (k: string) => {
      throw new Error(`Missing secret: ${k}`);
    },
  };

  return {
    requestId: overrides?.requestId ?? "01J9ZCONCEPT000000000000000",
    project: overrides?.project ?? "proj-concept-test",
    function: overrides?.function ?? "fn-concept-test",
    revision: overrides?.revision ?? "rev_01J9ZCONCEPT0000000000000",
    deadline,
    timeRemaining: () => Math.max(0, deadline - Date.now()),
    kv: bindings.kv as KVBinding,
    objects: bindings.objects as ObjectBinding,
    queues: bindings.queues as QueueBinding,
    env: bindings.env ?? dummyEnv,
    ...overrides,
  };
}

/**
 * Helper to scaffold temporary project directories for CLI verification.
 */
async function createTempProject(
  tomlContent: string,
  extraFiles: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "railfog_concepts_test_" });
  await Deno.writeTextFile(join(dir, "railfog.toml"), tomlContent);

  for (const [relPath, content] of Object.entries(extraFiles)) {
    const fullPath = join(dir, relPath);
    const lastSlash = Math.max(
      fullPath.lastIndexOf("/"),
      fullPath.lastIndexOf("\\"),
    );
    if (lastSlash > 0) {
      await Deno.mkdir(fullPath.slice(0, lastSlash), { recursive: true });
    }
    await Deno.writeTextFile(fullPath, content);
  }

  return dir;
}

const DEFAULT_HANDLER_CODE = `
export default async function handler(_req: Request): Promise<Response> {
  await Promise.resolve();
  return new Response("OK");
}
`;

// ============================================================================
// Group 1: Six Canonical Composition Pathways (CONCEPT-4, CONCEPT-3)
// ============================================================================

Deno.test("Milestone 0.9.1 - Composition: Compute -> State", async () => {
  // spec: contracts/concepts.contract.md#CONCEPT-3 — Compute (transform) -> State (remember)
  // spec: contracts/concepts.contract.md#CONCEPT-4 — Counter/Session composed without fifth primitive
  // spec: contracts/kv.contract.md#KV-3 — Atomic operations with CAS commit
  const kvProvider = new SQLiteKVProvider(":memory:");
  const dummy = createDummyProviders();
  const resolved = resolvePermissions(
    { state: ["balances"] },
    "org-test",
    "proj-test",
    { kv: kvProvider, objects: dummy.objects, queues: dummy.queues },
  );

  const handler: ComputeHandler = handle(async (c: HandlerContext) => {
    const { userId, delta } = (await c.body()) as {
      userId: string;
      delta: number;
    };

    // Read current state (remember)
    const existing = (await c.state.get<number>(["user", userId])) ?? 0;
    const nextValue = existing + delta;

    // Mutate state atomically (CAS commit)
    const atomic = c.state.atomic();
    atomic.set(["user", userId], nextValue);
    const commitResult = await atomic.commit();

    return {
      userId,
      previous: existing,
      current: nextValue,
      ok: commitResult.ok,
    };
  });

  const ctx = createMockContext({ kv: resolved.kv });
  const req = new Request("https://example.internal/deposit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "usr_42", delta: 150 }),
  });

  const res = await handler(req, ctx);
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data, {
    userId: "usr_42",
    previous: 0,
    current: 150,
    ok: true,
  });

  // Verify second invocation remembers persisted state
  const req2 = new Request("https://example.internal/deposit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: "usr_42", delta: 50 }),
  });
  const res2 = await handler(req2, ctx);
  assertEquals(res2.status, 200);
  const data2 = await res2.json();
  assertEquals(data2, {
    userId: "usr_42",
    previous: 150,
    current: 200,
    ok: true,
  });
});

Deno.test("Milestone 0.9.1 - Composition: Compute -> Data", async () => {
  // spec: contracts/concepts.contract.md#CONCEPT-4 — File/Media processing: Data + Compute
  // spec: contracts/concepts.contract.md#CONCEPT-7 — Data by reference and presigned URLs (OBJ-3)
  const tempDir = await Deno.makeTempDir({ prefix: "obj_data_test_" });
  try {
    const objProvider = new LocalFSProvider(tempDir);
    const dummy = createDummyProviders();
    const resolved = resolvePermissions(
      { data: ["reports"] },
      "org-test",
      "proj-test",
      { kv: dummy.kv, objects: objProvider, queues: dummy.queues },
    );

    const handler: ComputeHandler = handle(async (c: HandlerContext) => {
      const reportBytes = new TextEncoder().encode(
        "Year,Revenue\n2025,1000000\n2026,2500000\n",
      );

      // Compute persists bulk data
      await c.data.put("financials/2026.csv", reportBytes);

      // Compute generates presigned download reference without memory buffering (CONCEPT-7)
      const presigned = await c.data.presign("financials/2026.csv", {
        method: "GET",
        expiresIn: 3600,
      });

      return {
        key: "financials/2026.csv",
        downloadUrl: presigned.url,
      };
    });

    const ctx = createMockContext({ objects: resolved.objects });
    const req = new Request("https://example.internal/generate-report");
    const res = await handler(req, ctx);

    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.key, "financials/2026.csv");
    assert(data.downloadUrl.includes("financials/2026.csv"));

    // Verify object actually exists on disk
    const stored = await resolved.objects!.get("financials/2026.csv");
    assertExists(stored);
    const text = await new Response(stored).text();
    assert(text.includes("2026,2500000"));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Milestone 0.9.1 - Composition: Compute -> Signal", async () => {
  // spec: contracts/concepts.contract.md#CONCEPT-3 — Compute (transform) -> Signal (communicate)
  // spec: contracts/concepts.contract.md#CONCEPT-4 — Job / Background task dispatch
  // spec: contracts/queues.contract.md#Q-1 — Queue asynchronous communication
  const queueProvider = new SQLiteQueueProvider(":memory:");
  const dummy = createDummyProviders();
  const resolved = resolvePermissions(
    { signal: ["jobs"] },
    "org-test",
    "proj-test",
    { kv: dummy.kv, objects: dummy.objects, queues: queueProvider },
  );

  const handler: ComputeHandler = handle(async (c: HandlerContext) => {
    const body = (await c.body()) as { taskId: string; payload: unknown };

    // Emit asynchronous signal
    const sendResult = await c.signal.send({
      taskId: body.taskId,
      payload: body.payload,
      dispatchedAt: Date.now(),
    });

    return {
      accepted: true,
      messageId: sendResult.id,
    };
  });

  const ctx = createMockContext({ queues: resolved.queues });
  const req = new Request("https://example.internal/enqueue", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId: "task-001", payload: { count: 10 } }),
  });

  const res = await handler(req, ctx);
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.accepted, true);
  assertExists(data.messageId);
  assertEquals(data.messageId.length, 26); // ULID format

  // Verify internal provider received message in queue
  const received = await queueProvider.receive();
  assertExists(received);
  assertEquals(received.id, data.messageId);
  const body = received.body as { taskId: string };
  assertEquals(body.taskId, "task-001");
});

Deno.test("Milestone 0.9.1 - Composition: Signal -> Compute", async () => {
  // spec: contracts/concepts.contract.md#CONCEPT-4 — Signal + Compute event processing
  // spec: contracts/functions.contract.md#FN-2 — Queue trigger consumer handler
  // spec: contracts/queues.contract.md#Q-4 — Idempotent consumer execution
  const kvProvider = new SQLiteKVProvider(":memory:");
  const dummy = createDummyProviders();
  const resolvedState = resolvePermissions(
    { state: ["audit"] },
    "org-test",
    "proj-test",
    { kv: kvProvider, objects: dummy.objects, queues: dummy.queues },
  );

  const processedMessages: string[] = [];

  const consumerHandler: QueueConsumerHandler<
    { orderId: string; amount: number }
  > = consumer(
    async (
      message: QueueMessage<{ orderId: string; amount: number }>,
      ctx: RailFogContext,
    ) => {
      // Signal triggers compute execution
      processedMessages.push(message.id);

      // Compute updates state in response to signal
      await ctx.kv.set(["orders", message.body.orderId], {
        status: "COMPLETED",
        amount: message.body.amount,
        processedAt: Date.now(),
      });
    },
  );

  const ctx = createMockContext({ kv: resolvedState.kv });
  const msg: QueueMessage<{ orderId: string; amount: number }> = {
    id: "01J9ZMESSAGE0000000000001",
    body: { orderId: "ord_999", amount: 299.95 },
    timestamp: Date.now(),
    attempts: 1,
  };

  await consumerHandler(msg, ctx);

  assertEquals(processedMessages.length, 1);
  assertEquals(processedMessages[0], "01J9ZMESSAGE0000000000001");

  // Verify state mutation resulting from signal-driven compute
  const saved = await resolvedState.kv!.get(["orders", "ord_999"]) as {
    status: string;
    amount: number;
  };
  assertExists(saved);
  assertEquals(saved.status, "COMPLETED");
  assertEquals(saved.amount, 299.95);
});

Deno.test("Milestone 0.9.1 - Composition: Data -> Compute", async () => {
  // spec: contracts/concepts.contract.md#CONCEPT-4 — Data + Compute streaming transformation
  // spec: contracts/concepts.contract.md#CONCEPT-7 — Zero-copy streaming without full buffer memory footprint
  const tempDir = await Deno.makeTempDir({ prefix: "data_compute_test_" });
  try {
    const objProvider = new LocalFSProvider(tempDir);
    const dummy = createDummyProviders();
    const resolved = resolvePermissions(
      { data: ["logs"] },
      "org-test",
      "proj-test",
      { kv: dummy.kv, objects: objProvider, queues: dummy.queues },
    );

    // Seed test log stream
    const lines = ["line1: start", "line2: processing", "line3: finished"].join(
      "\n",
    );
    await resolved.objects!.put(
      "app.log",
      new TextEncoder().encode(lines).buffer,
    );

    const handler: ComputeHandler = handle(async (c: HandlerContext) => {
      // Stream bulk data directly into compute
      const stream = await c.data.get("app.log");
      if (!stream) {
        c.notFound("Log not found");
      }

      // Stream transform line by line without buffering entire object in memory (CONCEPT-7)
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let totalBytes = 0;
      let lineCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        const text = decoder.decode(value, { stream: true });
        lineCount += (text.match(/\n/g) || []).length;
      }

      return {
        fileName: "app.log",
        totalBytes,
        lineCount: lineCount + 1,
      };
    });

    const ctx = createMockContext({ objects: resolved.objects });
    const req = new Request("https://example.internal/process-log");
    const res = await handler(req, ctx);

    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.fileName, "app.log");
    assertEquals(data.lineCount, 3);
    assert(data.totalBytes > 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Milestone 0.9.1 - Composition: State -> Compute", async () => {
  // spec: contracts/concepts.contract.md#CONCEPT-4 — State + Compute branching (e.g. circuit breaker / feature flag)
  // spec: contracts/concepts.contract.md#CONCEPT-8 — Anti-framework: composed control flow without workflow DSL
  const kvProvider = new SQLiteKVProvider(":memory:");
  const dummy = createDummyProviders();
  const resolved = resolvePermissions(
    { state: ["system_flags"] },
    "org-test",
    "proj-test",
    { kv: kvProvider, objects: dummy.objects, queues: dummy.queues },
  );

  const handler: ComputeHandler = handle(async (c: HandlerContext) => {
    // Read state to determine compute execution branch
    const circuitState = await c.state.get<string>(["circuit", "payment_gw"]);

    if (circuitState === "OPEN") {
      throw new UnavailableError(
        "Payment gateway circuit is OPEN; requests throttled",
        c.requestId,
      );
    }

    return {
      status: "SUCCESS",
      processed: true,
    };
  });

  const ctx = createMockContext({ kv: resolved.kv });

  // 1. Initial execution when state is unset (circuit closed)
  const req1 = new Request("https://example.internal/checkout");
  const res1 = await handler(req1, ctx);
  assertEquals(res1.status, 200);
  const data1 = await res1.json();
  assertEquals(data1.status, "SUCCESS");

  // 2. Trip the circuit by mutating state
  await resolved.kv!.set(["circuit", "payment_gw"], "OPEN");

  // 3. Execution immediately branches to 503 Unavailable
  const req2 = new Request("https://example.internal/checkout");
  const res2 = await handler(req2, ctx);
  assertEquals(res2.status, 503);
  const data2 = await res2.json();
  assertEquals(data2.error.code, "UNAVAILABLE");
  assert(data2.error.message.includes("circuit is OPEN"));
});

// ============================================================================
// Group 2: Policy Normalization & Declared Conceptual Aliases (T-0914, PLAT-6)
// ============================================================================

Deno.test("Milestone 0.9.1 - Policy: Declared conceptual aliases normalized correctly", () => {
  // spec: contracts/concepts.contract.md#CONCEPT-6 — Conceptual capability scoping
  // spec: contracts/platform.contract.md#PLAT-6 — Capability injection
  const declared: DeclaredPermissions = {
    state: ["app_sessions"],
    data: ["app_media"],
    signal: ["app_events"],
  };

  const normalized = normalizeDeclaredCapabilities(declared);
  assertEquals(normalized, {
    kv: ["app_sessions"],
    objects: ["app_media"],
    queues: ["app_events"],
  });

  // Zero ambient privilege test: undeclared capabilities result in undefined
  const partialDeclared: DeclaredPermissions = {
    state: ["user_data"],
  };
  const dummy = createDummyProviders();
  const resolved = resolvePermissions(
    partialDeclared,
    "org-test",
    "proj-test",
    {
      kv: new SQLiteKVProvider(":memory:"),
      objects: dummy.objects,
      queues: dummy.queues,
    },
  );

  assertExists(
    resolved.kv,
    "Declared 'state' must resolve to scoped kv binding",
  );
  assertEquals(
    resolved.objects,
    undefined,
    "Undeclared 'data' must be undefined",
  );
  assertEquals(
    resolved.queues,
    undefined,
    "Undeclared 'signal' must be undefined",
  );
});

// ============================================================================
// Group 3: SDK Context Ergonomics, Getters & Type Re-exports (T-0915, T-0916)
// ============================================================================

Deno.test("Milestone 0.9.1 - SDK: Context getters provide non-breaking access", async () => {
  // spec: contracts/concepts.contract.md#CONCEPT-2 — Two-layer taxonomy (c.state, c.data, c.signal)
  // spec: contracts/functions.contract.md#FN-4 — RailFogContext structure
  // spec: contracts/functions.contract.md#FN-5 — WHATWG AbortSignal decoupling from c.signal
  const kvProvider = new SQLiteKVProvider(":memory:");
  const queueProvider = new SQLiteQueueProvider(":memory:");
  const dummy = createDummyProviders();
  const resolved = resolvePermissions(
    { state: ["test_kv"], signal: ["test_queue"] },
    "org-test",
    "proj-test",
    { kv: kvProvider, objects: dummy.objects, queues: queueProvider },
  );

  let verifiedGetters = false;
  let signalSentWhileReqAborted = false;

  const handler: ComputeHandler = handle(async (c: HandlerContext) => {
    // 1. Verify conceptual getters reference underlying primitive bindings identically
    assertEquals(c.state, c.kv);
    assertEquals(c.signal, c.queues);
    verifiedGetters = true;

    // 2. Verify AbortSignal decoupling: aborting c.req.signal does NOT break c.signal (SignalBinding)
    assert(c.req.signal.aborted, "Incoming request signal must be aborted");
    const sendRes = await c.signal.send({ test: "decoupled_signal" });
    assertExists(sendRes.id);
    signalSentWhileReqAborted = true;

    return { ok: true, msgId: sendRes.id };
  });

  const abortController = new AbortController();
  const req = new Request("https://example.internal/test", {
    signal: abortController.signal,
  });
  abortController.abort(); // Pre-abort request signal

  const ctx = createMockContext({ kv: resolved.kv, queues: resolved.queues });
  const res = await handler(req, ctx);

  assertEquals(res.status, 200);
  assert(verifiedGetters, "Conceptual context getters must be verified");
  assert(
    signalSentWhileReqAborted,
    "c.signal must function normally even when c.req.signal is aborted",
  );

  // 3. Type-level compatibility test (CONCEPT-2)
  const _stateTypeCheck: StateBinding = resolved.kv as unknown as StateBinding;
  const _dataTypeCheck: DataBinding = {} as unknown as DataBinding;
  const _signalTypeCheck: SignalBinding = resolved
    .queues as unknown as SignalBinding;
  const _computeTypeCheck: ComputeHandler = handler as FunctionHandler;
  assertExists(_stateTypeCheck);
  assertExists(_dataTypeCheck);
  assertExists(_signalTypeCheck);
  assertExists(_computeTypeCheck);
});

// ============================================================================
// Group 4: Security: Cross-Tenant Isolation with Conceptual Aliases (PLAT-7)
// ============================================================================

Deno.test("Milestone 0.9.1 - Security: Cross-tenant isolation with conceptual aliases (PLAT-7)", async () => {
  // spec: contracts/platform.contract.md#PLAT-7 — Physical key prefixing: {org_id}/{project_id}/{resource_name}/{caller_key}
  // spec: contracts/concepts.contract.md#CONCEPT-6 — Identical conceptual names across distinct tenants remain partitioned
  const sharedKV = new SQLiteKVProvider(":memory:");
  const tempDir = await Deno.makeTempDir({ prefix: "tenant_isolation_test_" });

  try {
    const sharedObjects = new LocalFSProvider(tempDir);
    const sharedQueues = new SQLiteQueueProvider(":memory:");

    const providers = {
      kv: sharedKV,
      objects: sharedObjects,
      queues: sharedQueues,
    };

    // Tenant Alpha and Tenant Beta declare identical conceptual resources
    const alphaBindings = resolvePermissions(
      {
        state: ["sessions"],
        data: ["assets"],
        signal: ["notifications"],
      },
      "tenant-alpha",
      "project-core",
      providers,
    );

    const betaBindings = resolvePermissions(
      {
        state: ["sessions"],
        data: ["assets"],
        signal: ["notifications"],
      },
      "tenant-beta",
      "project-core",
      providers,
    );

    // 1. State Isolation: Alpha write cannot be read or overwritten by Beta
    await alphaBindings.kv!.set(["auth", "session_token"], "alpha-secret-999");
    const betaStateRead = await betaBindings.kv!.get(["auth", "session_token"]);
    assertEquals(
      betaStateRead,
      null,
      "Tenant Beta must not read Tenant Alpha's state despite identical conceptual name",
    );

    await betaBindings.kv!.set(["auth", "session_token"], "beta-secret-111");
    const alphaStateVerify = await alphaBindings.kv!.get([
      "auth",
      "session_token",
    ]);
    assertEquals(
      alphaStateVerify,
      "alpha-secret-999",
      "Tenant Alpha's state must remain unchanged after Tenant Beta writes to same logical key",
    );

    // 2. Data Isolation: Alpha put cannot be accessed by Beta
    const alphaData = new TextEncoder().encode("CONFIDENTIAL_ALPHA_DATA");
    await alphaBindings.objects!.put("report.pdf", alphaData.buffer);

    const betaObjRead = await betaBindings.objects!.get("report.pdf");
    assertEquals(
      betaObjRead,
      null,
      "Tenant Beta must not access Tenant Alpha's data objects",
    );

    // 3. Path Traversal Attacks: Disallow parent directory traversal or null byte injection (PLAT-7)
    const dangerousNames = [
      "../escaped_namespace",
      "../../etc/passwd",
      "foo/bar",
      "foo\\bar",
      "app\0state",
    ];

    for (const bad of dangerousNames) {
      assertThrows(
        () =>
          resolvePermissions(
            { state: [bad] },
            "tenant-alpha",
            "project-core",
            providers,
          ),
        ValidationFailedError,
        "PLAT-7",
      );
      assertThrows(
        () =>
          resolvePermissions(
            { data: [bad] },
            "tenant-alpha",
            "project-core",
            providers,
          ),
        ValidationFailedError,
        "PLAT-7",
      );
      assertThrows(
        () =>
          resolvePermissions(
            { signal: [bad] },
            "tenant-alpha",
            "project-core",
            providers,
          ),
        ValidationFailedError,
        "PLAT-7",
      );
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Group 5: Security: Mutual Exclusivity Rejection Across Entire Pipeline (PLAT-6)
// ============================================================================

interface SchemaConstraintRule {
  not?: {
    required?: string[];
  };
}

Deno.test("Milestone 0.9.1 - Security: Mutual exclusivity rejects dual declaration across pipeline (PLAT-6)", async () => {
  // spec: contracts/platform.contract.md#PLAT-6 — Dual capability declarations are structurally prohibited across:
  // 1. Schema (schemas/railfog.schema.json allOf rules)
  // 2. Policy resolver (packages/policy/permission-resolver.ts)
  // 3. Artifact packager (packages/core/artifact/packager.ts)
  // 4. CLI check (cli/check.ts)

  // 1. Schema Verification (schemas/railfog.schema.json)
  const schemaPath = join(Deno.cwd(), "schemas", "railfog.schema.json");
  const schema = JSON.parse(await Deno.readTextFile(schemaPath));
  const permissionsRules = schema.properties.functions.additionalProperties
    .properties.permissions.allOf as SchemaConstraintRule[];
  assertExists(
    permissionsRules,
    "Schema must enforce mutual exclusivity in allOf",
  );

  const forbiddenPairs = permissionsRules
    .filter((r: SchemaConstraintRule) => r.not && Array.isArray(r.not.required))
    .map((r: SchemaConstraintRule) =>
      r.not!.required!.slice().sort().join(",")
    );

  assert(forbiddenPairs.includes(["kv", "state"].sort().join(",")));
  assert(forbiddenPairs.includes(["data", "objects"].sort().join(",")));
  assert(forbiddenPairs.includes(["queues", "signal"].sort().join(",")));

  // 2. Policy Resolver Verification (packages/policy/permission-resolver.ts)
  assertThrows(
    () => normalizeDeclaredCapabilities({ kv: ["s1"], state: ["s2"] }),
    ValidationFailedError,
    "PLAT-6",
  );
  assertThrows(
    () => normalizeDeclaredCapabilities({ objects: ["b1"], data: ["b2"] }),
    ValidationFailedError,
    "PLAT-6",
  );
  assertThrows(
    () => normalizeDeclaredCapabilities({ queues: ["q1"], signal: ["q2"] }),
    ValidationFailedError,
    "PLAT-6",
  );

  // 3. Artifact Packager Verification (packages/core/artifact/packager.ts)
  const code = new TextEncoder().encode(
    "export default () => new Response('OK');",
  );
  await assertRejects(
    async () => {
      await packageFunctionArtifact("api.ts", code, {
        permissions: { kv: ["store"], state: ["store"] },
      });
    },
    ValidationFailedError,
    "PLAT-6",
  );
  await assertRejects(
    async () => {
      await packageFunctionArtifact("api.ts", code, {
        permissions: { objects: ["bucket"], data: ["bucket"] },
      });
    },
    ValidationFailedError,
    "PLAT-6",
  );
  await assertRejects(
    async () => {
      await packageFunctionArtifact("api.ts", code, {
        permissions: { queues: ["queue"], signal: ["queue"] },
      });
    },
    ValidationFailedError,
    "PLAT-6",
  );

  // 4. CLI Check Verification (cli/check.ts)
  const conflictingToml = `
name = "conflict-pipeline-app"

[functions.api]
entry = "api.ts"
route = "/api/*"

[functions.api.permissions]
kv = ["sessions"]
state = ["sessions"]
`;

  const projectDir = await createTempProject(conflictingToml, {
    "api.ts": DEFAULT_HANDLER_CODE,
  });

  try {
    const result = await checkProject(projectDir);
    assertEquals(result.valid, false);
    const err = result.errors.find(
      (e: ValidationIssue) =>
        e.code === "PLAT-6" &&
        e.message.includes("cannot declare both 'kv' and 'state'"),
    );
    assertExists(
      err,
      "CLI check must fail with PLAT-6 error on dual capability declaration",
    );
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});
