/**
 * Tests for LocalIsolation provider with warm-isolate reuse manager.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-4: Isolation, defense in depth (abstracted IsolationProvider interface)
 * - docs/contracts/platform.contract.md#PLAT-17: Local/production parity ("Local: none (trusted dev machine)")
 * - docs/contracts/platform.contract.md#PLAT-12: Error model (exhaustive code table: TIMEOUT, RATE_LIMITED, CALL_DEPTH_EXCEEDED, VALIDATION_FAILED)
 * - docs/contracts/platform.contract.md#PLAT-14: ULID format for request_id (26 characters, Crockford Base32)
 * - docs/contracts/platform.contract.md#PLAT-15: Secrets (dynamic invocation-time resolution, never baked into artifact)
 * - docs/contracts/platform.contract.md#PLAT-7: Multi-tenancy & data isolation (scoping by org_id and project_id)
 * - docs/contracts/functions.contract.md#FN-1: Function definition (export default async function handler(req, ctx))
 * - docs/contracts/functions.contract.md#FN-4: RailFogContext (requestId, project, function, revision, deadline, timeRemaining, kv, objects, queues, env)
 * - docs/contracts/functions.contract.md#FN-5: Resource limits (timeout_ms, cpu_ms, kv 1,000 ops, objects 100 ops, queue 100 ops, call_depth_max 8)
 * - docs/contracts/functions.contract.md#FN-6: Isolation & warm-reuse rule (reuse ONLY within same Function + Revision; bindings re-injected on every invocation)
 * - docs/contracts/functions.contract.md#FN-7: Call-depth guard (X-RailFog-Call-Depth propagation & recursion prevention)
 * - docs/adr/0001-isolation-provider-invocation-protocol.md: IsolationProvider invocation protocol
 * - tasks/milestone-0.3-security/T-0310-local-isolation-provider.md: Acceptance criteria AC1 - AC4
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertNotEquals,
} from "@std/assert";
import { delay } from "@std/async/delay";
import type {
  Artifact,
  ExecutionResult,
  InvocationRequest,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import { LocalEncryptedSecretStore } from "../../packages/policy/secret-store.ts";
import { generateUlid, isValidUlid } from "../../packages/core/id/ulid.ts";
import {
  CallDepthExceededError,
  RateLimitedError,
  TimeoutError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import {
  CALL_DEPTH_HEADER,
  DEFAULT_MAX_CALL_DEPTH,
  DEFAULT_MAX_KV_OPS,
} from "../../runtime/limits/operation-counter.ts";
import {
  DEFAULT_CPU_MS,
  DEFAULT_HTTP_TIMEOUT_MS,
} from "../../runtime/limits/kill-enforcer.ts";

import {
  type LocalIsolationOptions,
  LocalIsolationProvider,
} from "../../runtime/sandbox/local-isolation.ts";

// ============================================================================
// Spec-anchored Constants
// ============================================================================

// spec: contracts/functions.contract.md#FN-5 — Default timeout_ms: 30,000 (HTTP)
const TEST_DEFAULT_TIMEOUT_MS = DEFAULT_HTTP_TIMEOUT_MS;

// spec: contracts/functions.contract.md#FN-5 — Default cpu_ms: 200
const TEST_DEFAULT_CPU_MS = DEFAULT_CPU_MS;

// spec: contracts/functions.contract.md#FN-5 — Memory ceiling default 128 MB
const TEST_DEFAULT_MEMORY_MB = 128;

const DEFAULT_LIMITS: Limits = {
  cpuMs: TEST_DEFAULT_CPU_MS,
  timeoutMs: TEST_DEFAULT_TIMEOUT_MS,
  memoryMb: TEST_DEFAULT_MEMORY_MB,
};

const MASTER_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ============================================================================
// Test Types & Fixture Helpers
// ============================================================================

interface TestArtifact extends Artifact {
  project?: string;
  function?: string;
  revision?: string;
}

/**
 * Creates a valid TestArtifact conforming to Artifact and OBJ-4 content addressing.
 */
function createTestArtifact(params: {
  project: string;
  function: string;
  revision: string;
  code: string | Uint8Array | ReadableStream<Uint8Array>;
  entrypoint?: string;
  id?: string;
  integrity?: string;
}): TestArtifact {
  const codeBytes = typeof params.code === "string"
    ? new TextEncoder().encode(params.code)
    : params.code;

  return {
    id: params.id ??
      `sha256:art-${params.project}-${params.function}-${params.revision}`,
    integrity: params.integrity ??
      "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    entrypoint: params.entrypoint ?? "index.ts",
    code: codeBytes,
    project: params.project,
    function: params.function,
    revision: params.revision,
  };
}

/**
 * Creates an InvocationRequest conforming to ADR-0001 with optional trace headers.
 */
function createTestInvocation(params?: {
  requestId?: string;
  project?: string;
  function?: string;
  revision?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}): InvocationRequest {
  const headers: Record<string, string> = { ...(params?.headers ?? {}) };
  if (params?.project) headers["x-railfog-project"] = params.project;
  if (params?.function) headers["x-railfog-function"] = params.function;
  if (params?.revision) headers["x-railfog-revision"] = params.revision;

  return {
    requestId: params?.requestId ?? generateUlid(),
    method: params?.method ?? "GET",
    url: params?.url ?? "https://example.com/api",
    headers,
    body: params?.body ?? new Uint8Array(0),
  };
}

/**
 * Parses JSON response body from ExecutionResult.
 */
function parseJsonResult<T = unknown>(result: ExecutionResult): T {
  const text = new TextDecoder().decode(result.body);
  return JSON.parse(text) as T;
}

// ============================================================================
// AC1: Warm Isolate Reuse (Same {project, function, revision})
// Spec: contracts/functions.contract.md#FN-6, tasks/T-0310
// ============================================================================

Deno.test("AC1 (Unit): Two consecutive invocations for same {project, function, revision} reuse warm isolate and preserve global state", async () => {
  // spec: contracts/functions.contract.md#FN-6 — warm isolate reuse rule
  // Given two consecutive invocations for the same {project, function, revision},
  // when executed, then the warm isolate instance is reused without re-importing the code bundle.
  // Global module-level state is preserved across invocations, and getWarmCount() reflects the cached instance.
  const provider = new LocalIsolationProvider();

  const code = `
    let counter = 0;
    export default async function handler(req, ctx) {
      counter++;
      return Response.json({
        counter,
        requestId: ctx.requestId,
        project: ctx.project,
        function: ctx.function,
        revision: ctx.revision,
      });
    }
  `;

  const artifact = createTestArtifact({
    project: "project-alpha",
    function: "worker-counter",
    revision: "rev_01J8Z000000000000000000001",
    code,
  });

  const inv1 = createTestInvocation({
    project: "project-alpha",
    function: "worker-counter",
    revision: "rev_01J8Z000000000000000000001",
  });

  const inv2 = createTestInvocation({
    project: "project-alpha",
    function: "worker-counter",
    revision: "rev_01J8Z000000000000000000001",
  });

  const res1 = await provider.run(artifact, DEFAULT_LIMITS, inv1);
  assertEquals(res1.statusCode, 200);
  const data1 = parseJsonResult<{ counter: number; requestId: string }>(res1);
  assertEquals(data1.counter, 1);
  assertEquals(provider.getWarmCount(), 1);

  const res2 = await provider.run(artifact, DEFAULT_LIMITS, inv2);
  assertEquals(res2.statusCode, 200);
  const data2 = parseJsonResult<{ counter: number; requestId: string }>(res2);
  // Module-level global state must be preserved across invocations
  assertEquals(data2.counter, 2);
  // Cache count remains 1 because the same isolate instance is reused
  assertEquals(provider.getWarmCount(), 1);
  // Request IDs must differ across invocations per FN-4 and FN-6
  assertNotEquals(data1.requestId, data2.requestId);
});

// ============================================================================
// AC2: Revision Isolation (Different revisions of same function)
// Spec: contracts/functions.contract.md#FN-6, tasks/T-0310
// ============================================================================

Deno.test("AC2 (Security): Invocations for different revisions execute in separate isolates and never share state", async () => {
  // spec: contracts/functions.contract.md#FN-6 — isolate reuse is strictly forbidden across distinct revisions
  // Given two invocations for different revisions (rev_1 then rev_2) of the same function,
  // when executed, then they execute in separate isolates; rev_1's isolate is never reused for rev_2.
  const provider = new LocalIsolationProvider();

  const code = `
    let counter = 0;
    export default async function handler(req, ctx) {
      counter++;
      return Response.json({
        counter,
        revision: ctx.revision,
      });
    }
  `;

  const artifactRev1 = createTestArtifact({
    project: "project-alpha",
    function: "versioned-service",
    revision: "rev_01J8Z000000000000000000001",
    code,
  });

  const artifactRev2 = createTestArtifact({
    project: "project-alpha",
    function: "versioned-service",
    revision: "rev_01J8Z000000000000000000002",
    code,
  });

  const resRev1First = await provider.run(
    artifactRev1,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "project-alpha",
      function: "versioned-service",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );
  const dataRev1First = parseJsonResult<{ counter: number; revision: string }>(
    resRev1First,
  );
  assertEquals(dataRev1First.counter, 1);
  assertEquals(dataRev1First.revision, "rev_01J8Z000000000000000000001");
  assertEquals(provider.getWarmCount(), 1);

  // Invoke rev_2: must NOT reuse rev_1 isolate; global counter must start at 1
  const resRev2 = await provider.run(
    artifactRev2,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "project-alpha",
      function: "versioned-service",
      revision: "rev_01J8Z000000000000000000002",
    }),
  );
  const dataRev2 = parseJsonResult<{ counter: number; revision: string }>(
    resRev2,
  );
  assertEquals(
    dataRev2.counter,
    1,
    "rev_2 must not inherit rev_1 state (FN-6)",
  );
  assertEquals(dataRev2.revision, "rev_01J8Z000000000000000000002");
  assertEquals(provider.getWarmCount(), 2);

  // Invoke rev_1 again: should reuse rev_1 warm instance, continuing from counter 1 -> 2
  const resRev1Second = await provider.run(
    artifactRev1,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "project-alpha",
      function: "versioned-service",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );
  const dataRev1Second = parseJsonResult<{ counter: number }>(resRev1Second);
  assertEquals(
    dataRev1Second.counter,
    2,
    "rev_1 warm state preserved independently from rev_2",
  );
  assertEquals(provider.getWarmCount(), 2);
});

// ============================================================================
// AC3: Project and Function Isolation
// Spec: contracts/platform.contract.md#PLAT-4, contracts/functions.contract.md#FN-6
// ============================================================================

Deno.test("AC3 (Security): Invocations for different projects strictly reject isolate reuse and run in separate instances", async () => {
  // spec: contracts/functions.contract.md#FN-6 — isolate reuse rejected across different projects
  // spec: contracts/platform.contract.md#PLAT-7 — multi-tenancy & data isolation
  const provider = new LocalIsolationProvider();

  const code = `
    let tenantState = 0;
    export default async function handler(req, ctx) {
      tenantState++;
      return Response.json({
        tenantState,
        project: ctx.project,
      });
    }
  `;

  const artifactProjA = createTestArtifact({
    project: "project-aaa",
    function: "common-handler",
    revision: "rev_01J8Z000000000000000000001",
    code,
  });

  const artifactProjB = createTestArtifact({
    project: "project-bbb",
    function: "common-handler",
    revision: "rev_01J8Z000000000000000000001",
    code,
  });

  const resA = await provider.run(
    artifactProjA,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "project-aaa",
      function: "common-handler",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );
  const dataA = parseJsonResult<{ tenantState: number; project: string }>(resA);
  assertEquals(dataA.tenantState, 1);
  assertEquals(dataA.project, "project-aaa");
  assertEquals(provider.getWarmCount(), 1);

  const resB = await provider.run(
    artifactProjB,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "project-bbb",
      function: "common-handler",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );
  const dataB = parseJsonResult<{ tenantState: number; project: string }>(resB);
  assertEquals(
    dataB.tenantState,
    1,
    "Project B must instantiate a separate isolate with clean state",
  );
  assertEquals(dataB.project, "project-bbb");
  assertEquals(provider.getWarmCount(), 2);
});

Deno.test("AC3: Invocations for different functions within same project instantiate separate isolates", async () => {
  const provider = new LocalIsolationProvider();

  const code = `
    let state = 0;
    export default async function handler(req, ctx) {
      state++;
      return Response.json({ state, function: ctx.function });
    }
  `;

  const artifactFn1 = createTestArtifact({
    project: "project-single",
    function: "function-one",
    revision: "rev_01J8Z000000000000000000001",
    code,
  });

  const artifactFn2 = createTestArtifact({
    project: "project-single",
    function: "function-two",
    revision: "rev_01J8Z000000000000000000001",
    code,
  });

  const res1 = await provider.run(
    artifactFn1,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "project-single",
      function: "function-one",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );
  const res2 = await provider.run(
    artifactFn2,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "project-single",
      function: "function-two",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );

  const data1 = parseJsonResult<{ state: number; function: string }>(res1);
  const data2 = parseJsonResult<{ state: number; function: string }>(res2);

  assertEquals(data1.state, 1);
  assertEquals(data2.state, 1);
  assertEquals(data1.function, "function-one");
  assertEquals(data2.function, "function-two");
  assertEquals(provider.getWarmCount(), 2);
});

// ============================================================================
// AC4: Context Freshness and Capability Re-injection on Warm Reuse
// Spec: contracts/functions.contract.md#FN-4, FN-6, contracts/platform.contract.md#PLAT-14, PLAT-15
// ============================================================================

Deno.test("AC4 (Unit): Warm isolate reuse injects fresh ULID requestId, fresh deadline, and re-injects bindings", async () => {
  // spec: contracts/functions.contract.md#FN-6 — bindings re-injected on every invocation
  // spec: contracts/platform.contract.md#PLAT-14 — ULID for request_id
  // Given a warm isolate reused for a second invocation, when ctx is inspected,
  // then ctx.requestId is a fresh ULID, operation counters are reset to zero, and bindings are freshly injected.
  const provider = new LocalIsolationProvider();

  const code = `
    let lastCtx = null;
    export default async function handler(req, ctx) {
      const isReusedIsolate = lastCtx !== null;
      const isSameCtxInstance = lastCtx === ctx;
      const isSameKvInstance = lastCtx && lastCtx.kv === ctx.kv;
      const prevRequestId = lastCtx ? lastCtx.requestId : null;
      lastCtx = ctx;

      return Response.json({
        isReusedIsolate,
        isSameCtxInstance,
        isSameKvInstance,
        requestId: ctx.requestId,
        prevRequestId,
        deadline: ctx.deadline,
        timeRemaining: ctx.timeRemaining(),
      });
    }
  `;

  const artifact = createTestArtifact({
    project: "project-freshness",
    function: "fresh-ctx-check",
    revision: "rev_01J8Z000000000000000000001",
    code,
  });

  const res1 = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "project-freshness",
      function: "fresh-ctx-check",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );
  const data1 = parseJsonResult<{
    isReusedIsolate: boolean;
    requestId: string;
    deadline: number;
    timeRemaining: number;
  }>(res1);

  assertEquals(data1.isReusedIsolate, false);
  assertEquals(isValidUlid(data1.requestId), true);
  assert(data1.timeRemaining > 0);

  // Small delay to ensure deadline timestamp increments
  await delay(20);

  const res2 = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "project-freshness",
      function: "fresh-ctx-check",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );
  const data2 = parseJsonResult<{
    isReusedIsolate: boolean;
    isSameCtxInstance: boolean;
    isSameKvInstance: boolean;
    requestId: string;
    prevRequestId: string;
    deadline: number;
    timeRemaining: number;
  }>(res2);

  assertEquals(data2.isReusedIsolate, true, "Should reuse the warm isolate");
  assertEquals(
    data2.isSameCtxInstance,
    false,
    "RailFogContext must NOT be the same object instance (FN-6)",
  );
  assertEquals(
    data2.isSameKvInstance,
    false,
    "Capability bindings must be re-injected fresh (FN-6)",
  );
  assertEquals(isValidUlid(data2.requestId), true);
  assertNotEquals(
    data1.requestId,
    data2.requestId,
    "requestId must be fresh on every invocation (FN-6, PLAT-14)",
  );
  assertEquals(data2.prevRequestId, data1.requestId);
  assert(
    data2.deadline >= data1.deadline,
    "Deadline must be recalculated for new invocation",
  );
});

Deno.test("AC4 (Integration): Warm isolate re-resolves rotated secrets from SecretStore per invocation", async () => {
  // spec: contracts/platform.contract.md#PLAT-15 — Secrets resolved at invocation time, rotation without redeploy
  // spec: contracts/functions.contract.md#FN-6 — Secrets re-injected on every invocation
  const secretStore = new LocalEncryptedSecretStore({
    masterKey: MASTER_KEY_HEX,
  });

  const orgId = "org-test";
  const projectId = "project-secrets";
  await secretStore.set(
    orgId,
    projectId,
    "DATABASE_URL",
    "postgres://v1:pass@db.internal:5432",
  );

  const options: LocalIsolationOptions = { secretStore };
  const provider = new LocalIsolationProvider(options);

  const code = `
    let invokeCount = 0;
    export default async function handler(req, ctx) {
      invokeCount++;
      const secret = ctx.env ? ctx.env.get("DATABASE_URL") : null;
      return Response.json({
        invokeCount,
        secret,
      });
    }
  `;

  const artifact = createTestArtifact({
    project: projectId,
    function: "db-worker",
    revision: "rev_01J8Z000000000000000000001",
    code,
  });

  const res1 = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: projectId,
      function: "db-worker",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );
  const data1 = parseJsonResult<{ invokeCount: number; secret: string | null }>(
    res1,
  );
  assertEquals(data1.invokeCount, 1);
  assertEquals(data1.secret, "postgres://v1:pass@db.internal:5432");

  // Rotate secret in store without modifying or redeploying the function
  await secretStore.set(
    orgId,
    projectId,
    "DATABASE_URL",
    "postgres://v2:rotated@db.internal:5432",
  );

  // Invocation 2: warm isolate is reused, but receives rotated secret immediately
  const res2 = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: projectId,
      function: "db-worker",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );
  const data2 = parseJsonResult<{ invokeCount: number; secret: string | null }>(
    res2,
  );
  assertEquals(data2.invokeCount, 2, "Warm isolate reused");
  assertEquals(
    data2.secret,
    "postgres://v2:rotated@db.internal:5432",
    "Secret must be freshly injected on warm reuse (PLAT-15, FN-6)",
  );
});

// ============================================================================
// Cache Lifecycle Management Tests
// Spec: tasks/T-0310 (getWarmCount, clearWarm, maxWarmInstances LRU eviction)
// ============================================================================

Deno.test("Cache Lifecycle: getWarmCount initially returns 0 and tracks warm isolates", async () => {
  const provider = new LocalIsolationProvider();
  assertEquals(provider.getWarmCount(), 0);

  const artifact = createTestArtifact({
    project: "proj-lifecycle",
    function: "fn-one",
    revision: "rev_01J8Z000000000000000000001",
    code:
      `export default async function handler() { return new Response("ok"); }`,
  });

  await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj-lifecycle",
      function: "fn-one",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );
  assertEquals(provider.getWarmCount(), 1);

  // Calling with the same tuple keeps count at 1
  await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj-lifecycle",
      function: "fn-one",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );
  assertEquals(provider.getWarmCount(), 1);
});

Deno.test("Cache Lifecycle: clearWarm flushes all cached warm isolates and resets module state", async () => {
  const provider = new LocalIsolationProvider();

  const code = `
    let counter = 0;
    export default async function handler() {
      counter++;
      return Response.json({ counter });
    }
  `;

  const artifact = createTestArtifact({
    project: "proj-clear",
    function: "fn-clear",
    revision: "rev_01J8Z000000000000000000001",
    code,
  });

  const res1 = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj-clear",
      function: "fn-clear",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );
  assertEquals(parseJsonResult<{ counter: number }>(res1).counter, 1);
  assertEquals(provider.getWarmCount(), 1);

  // Clear warm cache
  provider.clearWarm();
  assertEquals(provider.getWarmCount(), 0);

  // Next invocation should re-evaluate/re-instantiate the function; counter starts at 1 again
  const res2 = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj-clear",
      function: "fn-clear",
      revision: "rev_01J8Z000000000000000000001",
    }),
  );
  assertEquals(
    parseJsonResult<{ counter: number }>(res2).counter,
    1,
    "Module state must reset after clearWarm",
  );
  assertEquals(provider.getWarmCount(), 1);
});

Deno.test("Cache Lifecycle: maxWarmInstances evicts oldest isolate when capacity is exceeded", async () => {
  // Configure provider with capacity for 2 warm isolates
  const options: LocalIsolationOptions = { maxWarmInstances: 2 };
  const provider = new LocalIsolationProvider(options);

  const code = `
    let state = 0;
    export default async function handler() {
      state++;
      return Response.json({ state });
    }
  `;

  const art1 = createTestArtifact({
    project: "proj",
    function: "fn1",
    revision: "rev1",
    code,
  });
  const art2 = createTestArtifact({
    project: "proj",
    function: "fn2",
    revision: "rev1",
    code,
  });
  const art3 = createTestArtifact({
    project: "proj",
    function: "fn3",
    revision: "rev1",
    code,
  });

  // Warm up fn1 -> count 1
  await provider.run(
    art1,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj",
      function: "fn1",
      revision: "rev1",
    }),
  );
  assertEquals(provider.getWarmCount(), 1);

  // Warm up fn2 -> count 2
  await provider.run(
    art2,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj",
      function: "fn2",
      revision: "rev1",
    }),
  );
  assertEquals(provider.getWarmCount(), 2);

  // Warm up fn3 -> capacity exceeded! fn1 should be evicted
  await provider.run(
    art3,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj",
      function: "fn3",
      revision: "rev1",
    }),
  );
  assertEquals(
    provider.getWarmCount(),
    2,
    "Warm count should not exceed maxWarmInstances",
  );

  // fn2 should still be warm (state was 1, now becomes 2)
  const res2 = await provider.run(
    art2,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj",
      function: "fn2",
      revision: "rev1",
    }),
  );
  assertEquals(parseJsonResult<{ state: number }>(res2).state, 2);

  // fn1 was evicted, so re-invoking it re-initializes its state (state is 1, not 2)
  const res1 = await provider.run(
    art1,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj",
      function: "fn1",
      revision: "rev1",
    }),
  );
  assertEquals(
    parseJsonResult<{ state: number }>(res1).state,
    1,
    "Evicted isolate must re-initialize clean state",
  );
  assertEquals(provider.getWarmCount(), 2);
});

// ============================================================================
// Resource Limits Integration Tests
// Spec: contracts/functions.contract.md#FN-5, FN-7, contracts/platform.contract.md#PLAT-12
// ============================================================================

Deno.test("Resource Limits (FN-5): Wall-clock timeout (timeoutMs) aborts long-running execution and returns 504 TIMEOUT", async () => {
  // spec: contracts/functions.contract.md#FN-5 — timeout_ms kill at deadline
  // spec: contracts/platform.contract.md#PLAT-12 — TIMEOUT code
  const provider = new LocalIsolationProvider();

  const code = `
    export default async function handler(req, ctx) {
      // Simulate long-running work exceeding timeout
      await new Promise((resolve) => setTimeout(resolve, 300));
      return new Response("finished");
    }
  `;

  const artifact = createTestArtifact({
    project: "proj-limits",
    function: "fn-slow",
    revision: "rev1",
    code,
  });

  const tightLimits: Limits = {
    cpuMs: 200,
    timeoutMs: 50, // 50ms deadline
    memoryMb: 128,
  };

  try {
    const res = await provider.run(
      artifact,
      tightLimits,
      createTestInvocation(),
    );
    assertEquals(
      res.statusCode,
      504,
      "Must return HTTP 504 on deadline timeout",
    );
    const body = parseJsonResult<{ error?: { code: string }; code?: string }>(
      res,
    );
    assertEquals(body?.error?.code ?? body?.code, "TIMEOUT");
  } catch (err) {
    // If the provider chooses to reject with TimeoutError
    assertInstanceOf(err, TimeoutError);
    assertEquals((err as TimeoutError).code, "TIMEOUT");
  }
});

Deno.test("Resource Limits (FN-5): Operation quota resets per invocation on warm isolate reuse", async () => {
  // spec: contracts/functions.contract.md#FN-5 — kv ops per invocation: 1,000, reject further with 429
  // spec: contracts/functions.contract.md#FN-6 — operation counters reset to zero on reused isolate
  const provider = new LocalIsolationProvider();

  const code = `
    export default async function handler(req, ctx) {
      const url = new URL(req.url);
      const ops = parseInt(url.searchParams.get("ops") || "10", 10);
      let performed = 0;

      for (let i = 0; i < ops; i++) {
        if (ctx.kv && typeof ctx.kv.get === "function") {
          await ctx.kv.get(["test", String(i)]);
        }
        performed++;
      }

      return Response.json({ performed });
    }
  `;

  const artifact = createTestArtifact({
    project: "proj-quota",
    function: "fn-quota",
    revision: "rev1",
    code,
  });

  // Invocation 1 performs 500 KV operations
  const inv1 = createTestInvocation({
    url: "https://example.com/api?ops=500",
    project: "proj-quota",
    function: "fn-quota",
    revision: "rev1",
  });
  const res1 = await provider.run(artifact, DEFAULT_LIMITS, inv1);
  assertEquals(res1.statusCode, 200);
  assertEquals(parseJsonResult<{ performed: number }>(res1).performed, 500);

  // Invocation 2 on the same warm isolate performs 800 KV operations
  // If counters were not reset, 500 + 800 = 1300 > 1000 would exceed the quota!
  // Because counters reset per invocation (FN-6), this must succeed!
  const inv2 = createTestInvocation({
    url: "https://example.com/api?ops=800",
    project: "proj-quota",
    function: "fn-quota",
    revision: "rev1",
  });
  const res2 = await provider.run(artifact, DEFAULT_LIMITS, inv2);
  assertEquals(res2.statusCode, 200);
  assertEquals(parseJsonResult<{ performed: number }>(res2).performed, 800);
});

Deno.test("Resource Limits (FN-5): Exceeding per-invocation KV ops limit (1,000) rejects with 429 RATE_LIMITED", async () => {
  // spec: contracts/functions.contract.md#FN-5 — KV ops max 1,000 per invocation
  const provider = new LocalIsolationProvider();

  const code = `
    export default async function handler(req, ctx) {
      for (let i = 0; i < ${DEFAULT_MAX_KV_OPS + 1}; i++) {
        await ctx.kv.get(["counter", String(i)]);
      }
      return new Response("ok");
    }
  `;

  const artifact = createTestArtifact({
    project: "proj-quota",
    function: "fn-kv-exceed",
    revision: "rev1",
    code,
  });

  try {
    const res = await provider.run(
      artifact,
      DEFAULT_LIMITS,
      createTestInvocation({
        project: "proj-quota",
        function: "fn-kv-exceed",
        revision: "rev1",
      }),
    );
    assertEquals(res.statusCode, 429);
    const body = parseJsonResult<{ error?: { code: string }; code?: string }>(
      res,
    );
    assertEquals(body?.error?.code ?? body?.code, "RATE_LIMITED");
  } catch (err) {
    assertInstanceOf(err, RateLimitedError);
    assertEquals((err as RateLimitedError).code, "RATE_LIMITED");
  }
});

Deno.test("Resource Limits (FN-7): Call-depth guard increments on hop and rejects depth exceeding call_depth_max (8)", async () => {
  // spec: contracts/functions.contract.md#FN-7 — Call-depth guard default max 8; reject with 429 CALL_DEPTH_EXCEEDED
  const provider = new LocalIsolationProvider();

  const code = `
    export default async function handler(req, ctx) {
      return new Response("hop-ok");
    }
  `;

  const artifact = createTestArtifact({
    project: "proj-depth",
    function: "fn-depth",
    revision: "rev1",
    code,
  });

  // Call depth of 7 incrementing to 8 is permitted
  const invValid = createTestInvocation({
    headers: { [CALL_DEPTH_HEADER]: String(DEFAULT_MAX_CALL_DEPTH - 1) },
    project: "proj-depth",
    function: "fn-depth",
    revision: "rev1",
  });
  const resValid = await provider.run(artifact, DEFAULT_LIMITS, invValid);
  assertEquals(resValid.statusCode, 200);

  // Call depth of 8 incrementing to 9 exceeds max (8) -> must reject with 429 CALL_DEPTH_EXCEEDED
  const invExceeded = createTestInvocation({
    headers: { [CALL_DEPTH_HEADER]: String(DEFAULT_MAX_CALL_DEPTH) },
    project: "proj-depth",
    function: "fn-depth",
    revision: "rev1",
  });

  try {
    const resExceeded = await provider.run(
      artifact,
      DEFAULT_LIMITS,
      invExceeded,
    );
    assertEquals(resExceeded.statusCode, 429);
    const body = parseJsonResult<{ error?: { code: string }; code?: string }>(
      resExceeded,
    );
    assertEquals(body?.error?.code ?? body?.code, "CALL_DEPTH_EXCEEDED");
  } catch (err) {
    assertInstanceOf(err, CallDepthExceededError);
    assertEquals((err as CallDepthExceededError).code, "CALL_DEPTH_EXCEEDED");
  }

  // Non-numeric call depth header value must be rejected with VALIDATION_FAILED
  const invInvalid = createTestInvocation({
    headers: { [CALL_DEPTH_HEADER]: "invalid-hop" },
    project: "proj-depth",
    function: "fn-depth",
    revision: "rev1",
  });

  try {
    const resInvalid = await provider.run(artifact, DEFAULT_LIMITS, invInvalid);
    assertEquals(resInvalid.statusCode, 400);
    const body = parseJsonResult<{ error?: { code: string }; code?: string }>(
      resInvalid,
    );
    assertEquals(body?.error?.code ?? body?.code, "VALIDATION_FAILED");
  } catch (err) {
    assertInstanceOf(err, ValidationFailedError);
    assertEquals((err as ValidationFailedError).code, "VALIDATION_FAILED");
  }
});

// ============================================================================
// ExecutionResult Structure Tests
// Spec: primitives/compute/compute-provider.ts, contracts/functions.contract.md#FN-5
// ============================================================================

Deno.test("ExecutionResult: Returns correct statusCode, headers, body as Uint8Array, cpuTimeMs, and wallClockMs", async () => {
  const provider = new LocalIsolationProvider();

  const code = `
    export default async function handler(req, ctx) {
      return new Response(JSON.stringify({ message: "hello railfog" }), {
        status: 201,
        headers: {
          "content-type": "application/json",
          "x-custom-header": "test-val",
        },
      });
    }
  `;

  const artifact = createTestArtifact({
    project: "proj-result",
    function: "fn-result",
    revision: "rev1",
    code,
  });

  const startTime = Date.now();
  const res = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation(),
  );
  const elapsed = Date.now() - startTime;

  assertEquals(res.statusCode, 201);
  assertEquals(res.headers["content-type"], "application/json");
  assertEquals(res.headers["x-custom-header"], "test-val");
  assertInstanceOf(res.body, Uint8Array);

  const parsedBody = JSON.parse(new TextDecoder().decode(res.body));
  assertEquals(parsedBody.message, "hello railfog");

  // Metrics validation per FN-5
  assert(
    typeof res.cpuTimeMs === "number" && res.cpuTimeMs >= 0,
    "cpuTimeMs must be non-negative number",
  );
  assert(
    typeof res.wallClockMs === "number" && res.wallClockMs >= 0,
    "wallClockMs must be non-negative number",
  );
  assert(
    res.wallClockMs <= elapsed + 100,
    "wallClockMs should be reasonably bounded by actual execution duration",
  );
});

Deno.test("ExecutionResult: Supports 204 No Content with empty Uint8Array body", async () => {
  const provider = new LocalIsolationProvider();

  const code = `
    export default async function handler() {
      return new Response(null, { status: 204 });
    }
  `;

  const artifact = createTestArtifact({
    project: "proj-result",
    function: "fn-204",
    revision: "rev1",
    code,
  });

  const res = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation(),
  );
  assertEquals(res.statusCode, 204);
  assertInstanceOf(res.body, Uint8Array);
  assertEquals(res.body.byteLength, 0);
});

// ============================================================================
// Artifact Shapes Tests
// Spec: primitives/compute/compute-provider.ts, tasks/T-0310
// ============================================================================

Deno.test("Artifact Shapes: Handles artifact.code as Uint8Array", async () => {
  const provider = new LocalIsolationProvider();
  const codeString =
    `export default async function handler() { return new Response("uint8-ok"); }`;
  const codeBytes = new TextEncoder().encode(codeString);

  const artifact: Artifact = {
    id: "sha256:bytes-test",
    integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    entrypoint: "index.ts",
    code: codeBytes,
  };

  const res = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj-shapes",
      function: "fn-bytes",
      revision: "rev1",
    }),
  );
  assertEquals(res.statusCode, 200);
  assertEquals(new TextDecoder().decode(res.body), "uint8-ok");
});

Deno.test("Artifact Shapes: Handles artifact.code as ReadableStream<Uint8Array>", async () => {
  const provider = new LocalIsolationProvider();
  const codeString =
    `export default async function handler() { return new Response("stream-ok"); }`;
  const chunk1 = new TextEncoder().encode(codeString.slice(0, 20));
  const chunk2 = new TextEncoder().encode(codeString.slice(20));

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk1);
      controller.enqueue(chunk2);
      controller.close();
    },
  });

  const artifact: Artifact = {
    id: "sha256:stream-test",
    integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    entrypoint: "index.ts",
    code: stream,
  };

  const res = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj-shapes",
      function: "fn-stream",
      revision: "rev1",
    }),
  );
  assertEquals(res.statusCode, 200);
  assertEquals(new TextDecoder().decode(res.body), "stream-ok");
});

Deno.test("Artifact Shapes: Handles artifact pointing to an existing file path", async () => {
  const provider = new LocalIsolationProvider();
  const tempFile = await Deno.makeTempFile({ suffix: ".ts" });

  try {
    await Deno.writeTextFile(
      tempFile,
      `export default async function handler() { return new Response("file-path-ok"); }`,
    );

    const artifact: Artifact = {
      id: "sha256:file-test",
      integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
      entrypoint: tempFile,
      code: new Uint8Array(0),
    };

    const res = await provider.run(
      artifact,
      DEFAULT_LIMITS,
      createTestInvocation({
        project: "proj-shapes",
        function: "fn-filepath",
        revision: "rev1",
      }),
    );
    assertEquals(res.statusCode, 200);
    assertEquals(new TextDecoder().decode(res.body), "file-path-ok");
  } finally {
    try {
      await Deno.remove(tempFile);
    } catch {
      // Ignore cleanup error
    }
  }
});

// ============================================================================
// Security Tests: State Bleeding & Leaked Capabilities (PLAT-4, FN-6)
// Spec: contracts/platform.contract.md#PLAT-4, contracts/functions.contract.md#FN-6
// ============================================================================

Deno.test("Security (PLAT-4, FN-6): Module-level global mutations cannot leak data or references across distinct functions", async () => {
  // spec: contracts/functions.contract.md#FN-6 — Any surviving module-level state in a warm isolate is a best-effort cache, never a security boundary
  // Verifies that a function attempting to store sensitive state on globalThis or module globals cannot be read by another function
  const provider = new LocalIsolationProvider();

  const maliciousCode = `
    export default async function handler(req, ctx) {
      (globalThis as any).__shared_leak = "stolen_data";
      return new Response("injected");
    }
  `;

  const victimCode = `
    export default async function handler(req, ctx) {
      const leak = (globalThis as any).__shared_leak;
      return Response.json({ leak: leak ?? null });
    }
  `;

  const artMalicious = createTestArtifact({
    project: "tenant-attacker",
    function: "exploit-leak",
    revision: "rev1",
    code: maliciousCode,
  });

  const artVictim = createTestArtifact({
    project: "tenant-victim",
    function: "isolated-func",
    revision: "rev1",
    code: victimCode,
  });

  await provider.run(
    artMalicious,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "tenant-attacker",
      function: "exploit-leak",
      revision: "rev1",
    }),
  );

  const victimRes = await provider.run(
    artVictim,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "tenant-victim",
      function: "isolated-func",
      revision: "rev1",
    }),
  );

  const data = parseJsonResult<{ leak: string | null }>(victimRes);
  assertEquals(
    data.leak,
    null,
    "Global scope leakage must not cross function/tenant boundaries (PLAT-4, FN-6)",
  );
});

Deno.test("Security (FN-6): Stored context references across invocations cannot be reused with stale authorization", async () => {
  // spec: contracts/functions.contract.md#FN-6 — Never write code that persists a scoped binding or credential in module scope and reuses it across invocations without re-injection
  const provider = new LocalIsolationProvider();

  const code = `
    let savedCtx = null;
    export default async function handler(req, ctx) {
      const hadStaleCtx = savedCtx !== null;
      const staleRemaining = savedCtx ? savedCtx.timeRemaining() : null;
      const staleId = savedCtx ? savedCtx.requestId : null;
      savedCtx = ctx;

      return Response.json({
        hadStaleCtx,
        staleRemaining,
        staleId,
        currentId: ctx.requestId,
      });
    }
  `;

  const artifact = createTestArtifact({
    project: "proj-sec",
    function: "fn-stale-ref",
    revision: "rev1",
    code,
  });

  const res1 = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj-sec",
      function: "fn-stale-ref",
      revision: "rev1",
    }),
  );
  const data1 = parseJsonResult<{ hadStaleCtx: boolean; currentId: string }>(
    res1,
  );
  assertEquals(data1.hadStaleCtx, false);

  await delay(20);

  const res2 = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj-sec",
      function: "fn-stale-ref",
      revision: "rev1",
    }),
  );
  const data2 = parseJsonResult<{
    hadStaleCtx: boolean;
    staleId: string;
    currentId: string;
  }>(res2);

  assertEquals(data2.hadStaleCtx, true);
  assertEquals(data2.staleId, data1.currentId);
  assertNotEquals(
    data2.currentId,
    data2.staleId,
    "Current invocation must run with fresh credentials and ID",
  );
});

Deno.test("Security (PLAT-15): Secret values are strictly tenant-isolated and cannot be probed across projects", async () => {
  // spec: contracts/platform.contract.md#PLAT-15 — Tenant-scoped secret access
  // spec: contracts/platform.contract.md#PLAT-7 — Multi-tenancy & data isolation
  const secretStore = new LocalEncryptedSecretStore({
    masterKey: MASTER_KEY_HEX,
  });

  await secretStore.set(
    "org-sec",
    "proj-a",
    "STRIPE_KEY",
    "sk_live_proj_a_secret",
  );
  await secretStore.set(
    "org-sec",
    "proj-b",
    "STRIPE_KEY",
    "sk_live_proj_b_secret",
  );

  const provider = new LocalIsolationProvider({ secretStore });

  const code = `
    export default async function handler(req, ctx) {
      const stripeKey = ctx.env ? ctx.env.get("STRIPE_KEY") : null;
      return Response.json({ stripeKey });
    }
  `;

  const artA = createTestArtifact({
    project: "proj-a",
    function: "billing",
    revision: "rev1",
    code,
  });
  const artB = createTestArtifact({
    project: "proj-b",
    function: "billing",
    revision: "rev1",
    code,
  });

  const resA = await provider.run(
    artA,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj-a",
      function: "billing",
      revision: "rev1",
    }),
  );
  const resB = await provider.run(
    artB,
    DEFAULT_LIMITS,
    createTestInvocation({
      project: "proj-b",
      function: "billing",
      revision: "rev1",
    }),
  );

  const dataA = parseJsonResult<{ stripeKey: string }>(resA);
  const dataB = parseJsonResult<{ stripeKey: string }>(resB);

  assertEquals(dataA.stripeKey, "sk_live_proj_a_secret");
  assertEquals(dataB.stripeKey, "sk_live_proj_b_secret");
  assertNotEquals(dataA.stripeKey, dataB.stripeKey);
});

Deno.test("Security Adversarial (FN-6): Cache key prevents colon delimiter collision", async () => {
  // Finding 1: Structured JSON keying prevents cross-tenant isolate hijacking
  // when project/function names contain delimiter characters like colons.
  const provider = new LocalIsolationProvider();

  const code1 = `
    let count = 0;
    export default async function handler(req, ctx) {
      count++;
      return Response.json({ count, source: "target_1" });
    }
  `;
  const code2 = `
    let count = 0;
    export default async function handler(req, ctx) {
      count++;
      return Response.json({ count, source: "target_2" });
    }
  `;

  // Target 1: project "tenant_a:func", function "handler"
  const art1 = createTestArtifact({
    project: "tenant_a:func",
    function: "handler",
    revision: "rev1",
    code: code1,
  });

  // Target 2: project "tenant_a", function "func:handler"
  const art2 = createTestArtifact({
    project: "tenant_a",
    function: "func:handler",
    revision: "rev1",
    code: code2,
  });

  const res1 = await provider.run(art1, DEFAULT_LIMITS);
  const res2 = await provider.run(art2, DEFAULT_LIMITS);

  const data1 = parseJsonResult<{ count: number; source: string }>(res1);
  const data2 = parseJsonResult<{ count: number; source: string }>(res2);

  assertEquals(data1.source, "target_1");
  assertEquals(data2.source, "target_2");
  assertEquals(data1.count, 1);
  assertEquals(data2.count, 1);
  assertEquals(provider.getWarmCount(), 2);
});

Deno.test("Security Adversarial (PLAT-7, PLAT-15): Cross-tenant secret isolation when orgs share project names", async () => {
  // Finding 2: Two distinct orgs share the same project name "billing".
  // Provider must strictly resolve only the specified tenant org's secrets.
  const secretStore = new LocalEncryptedSecretStore({
    masterKey: MASTER_KEY_HEX,
  });

  await secretStore.set(
    "org_alpha",
    "billing",
    "API_KEY",
    "alpha_secret_value",
  );
  await secretStore.set(
    "org_beta",
    "billing",
    "API_KEY",
    "beta_secret_value",
  );

  const provider = new LocalIsolationProvider({ secretStore });

  const code = `
    export default async function handler(req, ctx) {
      return Response.json({ apiKey: ctx.env ? ctx.env.get("API_KEY") : null });
    }
  `;

  const artAlpha = createTestArtifact({
    project: "billing",
    function: "charge",
    revision: "rev1",
    code,
  });
  (artAlpha as unknown as Record<string, unknown>).orgId = "org_alpha";

  const artBeta = createTestArtifact({
    project: "billing",
    function: "charge",
    revision: "rev1",
    code,
  });
  (artBeta as unknown as Record<string, unknown>).orgId = "org_beta";

  const resAlpha = await provider.run(artAlpha, DEFAULT_LIMITS);
  const resBeta = await provider.run(
    artBeta,
    DEFAULT_LIMITS,
    createTestInvocation({
      headers: { "x-railfog-org": "org_beta" },
    }),
  );

  const dataAlpha = parseJsonResult<{ apiKey: string }>(resAlpha);
  const dataBeta = parseJsonResult<{ apiKey: string }>(resBeta);

  assertEquals(dataAlpha.apiKey, "alpha_secret_value");
  assertEquals(dataBeta.apiKey, "beta_secret_value");
});

Deno.test("Security Adversarial (PLAT-4, FN-6): Prototype pollution on Object.prototype is cleansed after invocation", async () => {
  // Finding 3: Handler pollutes Object.prototype; cleanup must remove polluted properties.
  const provider = new LocalIsolationProvider();

  const maliciousCode = `
    export default async function handler(req, ctx) {
      (Object.prototype as any).railfogBackdoor = "compromised";
      return Response.json({ ok: true });
    }
  `;

  const victimCode = `
    export default async function handler(req, ctx) {
      const backdoor = ({} as any).railfogBackdoor;
      return Response.json({ hasBackdoor: backdoor !== undefined });
    }
  `;

  const artMalicious = createTestArtifact({
    project: "attacker",
    function: "exploit",
    revision: "rev1",
    code: maliciousCode,
  });

  const artVictim = createTestArtifact({
    project: "victim",
    function: "service",
    revision: "rev1",
    code: victimCode,
  });

  await provider.run(artMalicious, DEFAULT_LIMITS);

  // Check from outside that prototype pollution was cleaned up
  assertEquals(
    "railfogBackdoor" in Object.prototype,
    false,
    "Object.prototype was not cleansed",
  );

  const victimRes = await provider.run(artVictim, DEFAULT_LIMITS);
  const victimData = parseJsonResult<{ hasBackdoor: boolean }>(victimRes);
  assertEquals(victimData.hasBackdoor, false);
});

Deno.test("Security Adversarial (PLAT-15): Stored ctx.env from past invocation is deactivated and wipes secrets", async () => {
  // Finding 4: Persisted ctx.env in global scope cannot read stale or unrotated secrets after invocation ends.
  const secretStore = new LocalEncryptedSecretStore({
    masterKey: MASTER_KEY_HEX,
  });

  await secretStore.set(
    "org_leak",
    "proj_leak",
    "ROTATING_SECRET",
    "initial_secret_v1",
  );

  const provider = new LocalIsolationProvider({
    secretStore,
    orgId: "org_leak",
  });

  const captureCode = `
    export default async function handler(req, ctx) {
      (globalThis as any).leakedEnv = ctx.env;
      return Response.json({ val: ctx.env ? ctx.env.get("ROTATING_SECRET") : null });
    }
  `;

  const art = createTestArtifact({
    project: "proj_leak",
    function: "handler",
    revision: "rev1",
    code: captureCode,
  });

  const res1 = await provider.run(art, DEFAULT_LIMITS);
  const data1 = parseJsonResult<{ val: string }>(res1);
  assertEquals(data1.val, "initial_secret_v1");

  // Verify leakedEnv outside invocation returns undefined (deactivated)
  const leakedEnv = (globalThis as unknown as Record<
    string,
    { get(k: string): string | undefined }
  >).leakedEnv;
  if (leakedEnv) {
    assertEquals(leakedEnv.get("ROTATING_SECRET"), undefined);
  }
});
