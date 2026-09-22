/**
 * Tests for ProcessIsolation provider with restricted Deno subprocess and stdio IPC.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-4: Isolation, defense in depth (OS sandbox & subprocess boundary)
 * - docs/contracts/platform.contract.md#PLAT-5: Network policy (mandatory egress constraint, SSRF mitigation)
 * - docs/contracts/platform.contract.md#PLAT-12: Error model (TIMEOUT, INTERNAL, VALIDATION_FAILED)
 * - docs/contracts/platform.contract.md#PLAT-14: ULID format for request_id (26 characters, Crockford Base32)
 * - docs/contracts/platform.contract.md#PLAT-17: Local/production parity
 * - docs/contracts/functions.contract.md#FN-5: Resource limits (timeout_ms, cpu_ms, memory_mb)
 * - docs/contracts/functions.contract.md#FN-6: Isolation & warm-reuse rule (reuse ONLY within same Function + Revision)
 * - docs/contracts/functions.contract.md#FN-7: Call-depth guard
 * - docs/adr/0001-isolation-provider-invocation-protocol.md: ADR-0001 (stdio JSON-RPC IPC, InvocationRequest)
 * - tasks/milestone-0.3-security/T-0311-process-isolation-provider.md: Acceptance criteria AC1 - AC4
 * - .agents/skills/security-adversarial-review/SKILL.md: Adversarial proof bar
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type {
  Artifact,
  ExecutionResult,
  InvocationRequest,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import { generateUlid, isValidUlid } from "../../packages/core/id/ulid.ts";
import {
  DEFAULT_CPU_MS,
  DEFAULT_HTTP_TIMEOUT_MS,
} from "../../runtime/limits/kill-enforcer.ts";

import {
  buildDenoArgs,
  type ProcessIsolationOptions,
  ProcessIsolationProvider,
} from "../../runtime/sandbox/process-isolation.ts";

// ============================================================================
// Spec-anchored Constants
// ============================================================================

// spec: contracts/functions.contract.md#FN-5 — Default timeout_ms: 30,000 (HTTP)
const TEST_DEFAULT_TIMEOUT_MS = DEFAULT_HTTP_TIMEOUT_MS;

// spec: contracts/functions.contract.md#FN-5 — Default cpu_ms: 200
const TEST_DEFAULT_CPU_MS = DEFAULT_CPU_MS;

// spec: contracts/functions.contract.md#FN-5 — Default memory ceiling: 128 MB
const TEST_DEFAULT_MEMORY_MB = 128;

const DEFAULT_LIMITS: Limits = {
  cpuMs: TEST_DEFAULT_CPU_MS,
  timeoutMs: TEST_DEFAULT_TIMEOUT_MS,
  memoryMb: TEST_DEFAULT_MEMORY_MB,
};

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
  code: string | Uint8Array;
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
// Unit Tests: Command Argument Generation
// Spec: contracts/platform.contract.md#PLAT-4, PLAT-5, tasks/T-0311
// ============================================================================

Deno.test("Unit: buildDenoArgs generates mandatory security deny flags by default", () => {
  // spec: contracts/platform.contract.md#PLAT-4 — strict isolation flags
  // spec: tasks/T-0311 — CLI argument generation: --no-prompt, --deny-read, --deny-write, --deny-run, --deny-sys, --deny-env
  const args = buildDenoArgs();

  assert(args.includes("--no-prompt"), "Must include --no-prompt");
  assert(args.includes("--deny-read"), "Must include --deny-read");
  assert(args.includes("--deny-write"), "Must include --deny-write");
  assert(args.includes("--deny-run"), "Must include --deny-run");
  assert(args.includes("--deny-sys"), "Must include --deny-sys");
  assert(args.includes("--deny-env"), "Must include --deny-env");

  // When egressProxyPort is omitted, network access is completely denied
  assert(
    args.includes("--deny-net"),
    "Must include --deny-net when egressProxyPort is omitted",
  );

  // Rejection of permissive flags
  assert(!args.includes("--allow-all"), "Must not include --allow-all");
  assert(!args.includes("-A"), "Must not include -A");
  assert(!args.includes("--allow-read"), "Must not include --allow-read");
  assert(!args.includes("--allow-write"), "Must not include --allow-write");
  assert(!args.includes("--allow-run"), "Must not include --allow-run");
  assert(!args.includes("--allow-sys"), "Must not include --allow-sys");
  assert(!args.includes("--allow-env"), "Must not include --allow-env");
});

Deno.test("Unit: buildDenoArgs with egressProxyPort constrains network to local proxy port only", () => {
  // spec: contracts/platform.contract.md#PLAT-5 — network constrained exclusively to local egress proxy
  const proxyPort = 9876;
  const options: ProcessIsolationOptions = { egressProxyPort: proxyPort };
  const args = buildDenoArgs(options);

  assert(
    args.includes(`--allow-net=127.0.0.1:${proxyPort}`) ||
      args.includes(`--allow-net=localhost:${proxyPort}`),
    "Must include --allow-net targeted strictly to egress proxy",
  );
  assert(
    !args.includes("--deny-net"),
    "Must not include --deny-net when proxy port is set",
  );
  assert(
    !args.includes("--allow-net"),
    "Must not include unrestricted --allow-net flag",
  );
});

// ============================================================================
// AC1: Filesystem Sandbox Enforcement
// Spec: contracts/platform.contract.md#PLAT-4, tasks/T-0311
// ============================================================================

Deno.test("AC1 (Security): Customer code attempting Deno.readTextFile fails with permission error", async () => {
  // spec: contracts/platform.contract.md#PLAT-4 — Filesystem access must be rejected by OS sandbox
  const provider = new ProcessIsolationProvider();

  try {
    const code = `
      export default async function handler(req, ctx) {
        try {
          await Deno.readTextFile("/etc/passwd");
          return new Response("read_success", { status: 200 });
        } catch (err) {
          return Response.json({
            errorName: err.name,
            errorMessage: err.message,
          }, { status: 500 });
        }
      }
    `;

    const artifact = createTestArtifact({
      project: "sec-fs",
      function: "read-exploit",
      revision: "rev1",
      code,
    });

    const res = await provider.run(
      artifact,
      DEFAULT_LIMITS,
      createTestInvocation(),
    );
    const data = parseJsonResult<{ errorName: string; errorMessage: string }>(
      res,
    );

    assert(
      data.errorName === "PermissionDenied" ||
        data.errorName === "NotCapable" ||
        data.errorMessage.includes("Requires read access") ||
        data.errorMessage.includes("denied"),
      `Expected read permission denial, got error: ${data.errorName} (${data.errorMessage})`,
    );
  } finally {
    await provider.shutdown();
  }
});

Deno.test("AC1 (Security): Customer code attempting Deno.writeTextFile fails with permission error", async () => {
  // spec: contracts/platform.contract.md#PLAT-4 — Filesystem write must be rejected by OS sandbox
  const provider = new ProcessIsolationProvider();

  try {
    const code = `
      export default async function handler(req, ctx) {
        try {
          await Deno.writeTextFile("./escaped.txt", "untrusted data");
          return new Response("write_success", { status: 200 });
        } catch (err) {
          return Response.json({
            errorName: err.name,
            errorMessage: err.message,
          }, { status: 500 });
        }
      }
    `;

    const artifact = createTestArtifact({
      project: "sec-fs",
      function: "write-exploit",
      revision: "rev1",
      code,
    });

    const res = await provider.run(
      artifact,
      DEFAULT_LIMITS,
      createTestInvocation(),
    );
    const data = parseJsonResult<{ errorName: string; errorMessage: string }>(
      res,
    );

    assert(
      data.errorName === "PermissionDenied" ||
        data.errorName === "NotCapable" ||
        data.errorMessage.includes("Requires write access") ||
        data.errorMessage.includes("denied"),
      `Expected write permission denial, got error: ${data.errorName} (${data.errorMessage})`,
    );
  } finally {
    await provider.shutdown();
  }
});

// ============================================================================
// AC2: Network Sandbox Enforcement
// Spec: contracts/platform.contract.md#PLAT-5, tasks/T-0311
// ============================================================================

Deno.test("AC2 (Security): When egressProxyPort is omitted, outbound fetch fails with network permission error", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — --deny-net enforced when proxy is omitted
  const provider = new ProcessIsolationProvider();

  try {
    const code = `
      export default async function handler(req, ctx) {
        try {
          await fetch("https://example.com");
          return new Response("fetch_success", { status: 200 });
        } catch (err) {
          return Response.json({
            errorName: err.name,
            errorMessage: err.message,
          }, { status: 500 });
        }
      }
    `;

    const artifact = createTestArtifact({
      project: "sec-net",
      function: "direct-fetch",
      revision: "rev1",
      code,
    });

    const res = await provider.run(
      artifact,
      DEFAULT_LIMITS,
      createTestInvocation(),
    );
    const data = parseJsonResult<{ errorName: string; errorMessage: string }>(
      res,
    );

    assert(
      data.errorName === "PermissionDenied" ||
        data.errorName === "NotCapable" ||
        data.errorMessage.includes("Requires net access") ||
        data.errorMessage.includes("denied"),
      `Expected network permission denial, got: ${data.errorName} (${data.errorMessage})`,
    );
  } finally {
    await provider.shutdown();
  }
});

Deno.test("AC2 (Security): When egressProxyPort is configured, direct access to cloud metadata (169.254.169.254) is blocked by Deno sandbox", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — SSRF mandatory block; traffic must not bypass egress proxy
  const proxyPort = 18080;
  const provider = new ProcessIsolationProvider({ egressProxyPort: proxyPort });

  try {
    const code = `
      export default async function handler(req, ctx) {
        try {
          await fetch("http://169.254.169.254/latest/meta-data");
          return new Response("metadata_reached", { status: 200 });
        } catch (err) {
          return Response.json({
            errorName: err.name,
            errorMessage: err.message,
          }, { status: 500 });
        }
      }
    `;

    const artifact = createTestArtifact({
      project: "sec-net",
      function: "metadata-exploit",
      revision: "rev1",
      code,
    });

    const res = await provider.run(
      artifact,
      DEFAULT_LIMITS,
      createTestInvocation(),
    );
    const data = parseJsonResult<{ errorName: string; errorMessage: string }>(
      res,
    );

    // Deno --allow-net=127.0.0.1:18080 must reject connect to 169.254.169.254 at the permission boundary
    assert(
      data.errorName === "PermissionDenied" ||
        data.errorName === "NotCapable" ||
        data.errorMessage.includes("Requires net access") ||
        data.errorMessage.includes("denied"),
      `Direct metadata fetch must be rejected by net permissions, got: ${data.errorName} (${data.errorMessage})`,
    );
  } finally {
    await provider.shutdown();
  }
});

// ============================================================================
// AC3: Stdio IPC Communication & Round-Trip Fidelity
// Spec: docs/adr/0001-isolation-provider-invocation-protocol.md, tasks/T-0311
// ============================================================================

Deno.test("AC3 (Integration): InvocationRequest transmitted over stdin and ExecutionResult received via stdout", async () => {
  // spec: docs/adr/0001-isolation-provider-invocation-protocol.md — stdio JSON-RPC IPC
  const provider = new ProcessIsolationProvider();

  try {
    const code = `
      export default async function handler(req, ctx) {
        const bodyText = await req.text();
        const customHeader = req.headers.get("x-custom-req");

        return new Response(JSON.stringify({
          echoMethod: req.method,
          echoUrl: req.url,
          echoHeader: customHeader,
          echoBody: bodyText,
          requestId: ctx.requestId,
        }), {
          status: 201,
          headers: {
            "content-type": "application/json",
            "x-custom-res": "received-" + customHeader,
          },
        });
      }
    `;

    const artifact = createTestArtifact({
      project: "ipc-test",
      function: "echo-service",
      revision: "rev1",
      code,
    });

    const inputPayload = "Hello from host process via stdin!";
    const invocation = createTestInvocation({
      method: "POST",
      url: "https://api.railfog.internal/v1/echo?filter=all",
      headers: { "x-custom-req": "secret-value-123" },
      body: new TextEncoder().encode(inputPayload),
    });

    const startTime = Date.now();
    const result = await provider.run(artifact, DEFAULT_LIMITS, invocation);
    const elapsed = Date.now() - startTime;

    assertEquals(result.statusCode, 201);
    assertEquals(result.headers["content-type"], "application/json");
    assertEquals(result.headers["x-custom-res"], "received-secret-value-123");

    const responseData = parseJsonResult<{
      echoMethod: string;
      echoUrl: string;
      echoHeader: string;
      echoBody: string;
      requestId: string;
    }>(result);

    assertEquals(responseData.echoMethod, "POST");
    assertEquals(
      responseData.echoUrl,
      "https://api.railfog.internal/v1/echo?filter=all",
    );
    assertEquals(responseData.echoHeader, "secret-value-123");
    assertEquals(responseData.echoBody, inputPayload);
    assertEquals(responseData.requestId, invocation.requestId);

    // Metrics validation per FN-5
    assert(result.cpuTimeMs >= 0, "cpuTimeMs must be non-negative");
    assert(result.wallClockMs >= 0, "wallClockMs must be non-negative");
    assert(
      result.wallClockMs <= elapsed + 100,
      "wallClockMs must not exceed total elapsed time",
    );
  } finally {
    await provider.shutdown();
  }
});

Deno.test("AC3 (Integration): Binary payloads and 204 No Content round-trip accurately across stdio IPC", async () => {
  const provider = new ProcessIsolationProvider();

  try {
    const code = `
      export default async function handler(req, ctx) {
        if (req.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        const buf = await req.arrayBuffer();
        const inputBytes = new Uint8Array(buf);
        const inverted = new Uint8Array(inputBytes.length);
        for (let i = 0; i < inputBytes.length; i++) {
          inverted[i] = 255 - inputBytes[i];
        }
        return new Response(inverted, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
    `;

    const artifact = createTestArtifact({
      project: "ipc-binary",
      function: "byte-inverter",
      revision: "rev1",
      code,
    });

    // Test 1: Binary data round-trip
    const testBytes = new Uint8Array([0, 10, 50, 100, 200, 255]);
    const resBinary = await provider.run(
      artifact,
      DEFAULT_LIMITS,
      createTestInvocation({
        method: "POST",
        body: testBytes,
      }),
    );

    assertEquals(resBinary.statusCode, 200);
    assertEquals(resBinary.headers["content-type"], "application/octet-stream");
    const expectedBytes = new Uint8Array([255, 245, 205, 155, 55, 0]);
    assertEquals(resBinary.body, expectedBytes);

    // Test 2: 204 No Content
    const resEmpty = await provider.run(
      artifact,
      DEFAULT_LIMITS,
      createTestInvocation({ method: "DELETE" }),
    );
    assertEquals(resEmpty.statusCode, 204);
    assertEquals(resEmpty.body.byteLength, 0);
  } finally {
    await provider.shutdown();
  }
});

// ============================================================================
// AC4: Timeout and Crash Handling
// Spec: contracts/functions.contract.md#FN-5, contracts/platform.contract.md#PLAT-12, tasks/T-0311
// ============================================================================

Deno.test("AC4 (Resilience): Function hanging on infinite loop/promise is killed at timeoutMs and returns 504 TIMEOUT", async () => {
  // spec: contracts/functions.contract.md#FN-5 — Kill on deadline
  // spec: contracts/platform.contract.md#PLAT-12 — 504 TIMEOUT
  const provider = new ProcessIsolationProvider();

  try {
    const code = `
      export default async function handler(req, ctx) {
        // Infinite promise that never resolves
        await new Promise(() => {});
        return new Response("should_never_reach");
      }
    `;

    const artifact = createTestArtifact({
      project: "resilience",
      function: "hanging-func",
      revision: "rev1",
      code,
    });

    const tightLimits: Limits = {
      cpuMs: 200,
      timeoutMs: 150, // 150ms timeout
      memoryMb: 128,
    };

    const startTime = Date.now();
    const res = await provider.run(
      artifact,
      tightLimits,
      createTestInvocation(),
    );
    const duration = Date.now() - startTime;

    assertEquals(
      res.statusCode,
      504,
      "Must return HTTP 504 TIMEOUT on deadline exceeded",
    );
    const body = parseJsonResult<{ error?: { code: string }; code?: string }>(
      res,
    );
    assertEquals(body?.error?.code ?? body?.code, "TIMEOUT");

    // Must not hang indefinitely
    assert(
      duration < 5000,
      `Execution took ${duration}ms, expected timeout termination near 150ms`,
    );
  } finally {
    await provider.shutdown();
  }
});

Deno.test("AC4 (Resilience): Subprocess unexpected exit (Deno.exit) or unhandled throw returns error result without crashing host", async () => {
  // spec: contracts/platform.contract.md#PLAT-12 — INTERNAL
  const provider = new ProcessIsolationProvider();

  try {
    // 1. Subprocess sudden exit test
    const codeExit = `
      export default async function handler(req, ctx) {
        Deno.exit(1);
      }
    `;

    const artifactExit = createTestArtifact({
      project: "resilience",
      function: "crashing-func",
      revision: "rev1",
      code: codeExit,
    });

    const resExit = await provider.run(
      artifactExit,
      DEFAULT_LIMITS,
      createTestInvocation(),
    );
    assertEquals(
      resExit.statusCode >= 500,
      true,
      "Must return 5xx status on worker crash",
    );
    const bodyExit = parseJsonResult<
      { error?: { code: string }; code?: string }
    >(resExit);
    assert(
      bodyExit?.error?.code || bodyExit?.code,
      "Error code must be present in response",
    );

    // 2. Host remains fully operational for subsequent valid requests
    const codeValid = `
      export default async function handler() {
        return new Response("recovered_ok", { status: 200 });
      }
    `;
    const artifactValid = createTestArtifact({
      project: "resilience",
      function: "recovered-func",
      revision: "rev1",
      code: codeValid,
    });

    const resValid = await provider.run(
      artifactValid,
      DEFAULT_LIMITS,
      createTestInvocation(),
    );
    assertEquals(resValid.statusCode, 200);
    assertEquals(new TextDecoder().decode(resValid.body), "recovered_ok");
  } finally {
    await provider.shutdown();
  }
});

// ============================================================================
// Warm-Process Reuse (FN-6)
// Spec: contracts/functions.contract.md#FN-6, contracts/platform.contract.md#PLAT-4
// ============================================================================

Deno.test("Warm-Reuse (FN-6): Consecutive invocations for identical {project, function, revision} reuse warm subprocess", async () => {
  // spec: contracts/functions.contract.md#FN-6 — warm reuse within same function and revision
  const provider = new ProcessIsolationProvider();

  try {
    const code = `
      let callCount = 0;
      export default async function handler(req, ctx) {
        callCount++;
        return Response.json({
          callCount,
          requestId: ctx.requestId,
          revision: ctx.revision,
        });
      }
    `;

    const artifact = createTestArtifact({
      project: "proj-warm",
      function: "stateful-worker",
      revision: "rev_01J8Z000000000000000000001",
      code,
    });

    const inv1 = createTestInvocation({
      project: "proj-warm",
      function: "stateful-worker",
      revision: "rev_01J8Z000000000000000000001",
    });

    const inv2 = createTestInvocation({
      project: "proj-warm",
      function: "stateful-worker",
      revision: "rev_01J8Z000000000000000000001",
    });

    const res1 = await provider.run(artifact, DEFAULT_LIMITS, inv1);
    const data1 = parseJsonResult<{ callCount: number; requestId: string }>(
      res1,
    );
    assertEquals(data1.callCount, 1);
    assertEquals(isValidUlid(data1.requestId), true);

    const res2 = await provider.run(artifact, DEFAULT_LIMITS, inv2);
    const data2 = parseJsonResult<{ callCount: number; requestId: string }>(
      res2,
    );
    // Preserves in-process state in reused worker
    assertEquals(
      data2.callCount,
      2,
      "Warm process must preserve module-level global state",
    );
    // Context is re-injected on each invocation: fresh ULID
    assertEquals(isValidUlid(data2.requestId), true);
    assertNotEquals(
      data1.requestId,
      data2.requestId,
      "ctx.requestId must be fresh per invocation (FN-6)",
    );
  } finally {
    await provider.shutdown();
  }
});

Deno.test("Warm-Reuse (FN-6): Different revisions execute in separate subprocesses and never share state", async () => {
  // spec: contracts/functions.contract.md#FN-6 — reuse strictly rejected across revisions
  const provider = new ProcessIsolationProvider();

  try {
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
      project: "proj-ver",
      function: "svc",
      revision: "rev1",
      code,
    });

    const artifactRev2 = createTestArtifact({
      project: "proj-ver",
      function: "svc",
      revision: "rev2",
      code,
    });

    const resRev1 = await provider.run(
      artifactRev1,
      DEFAULT_LIMITS,
      createTestInvocation({
        project: "proj-ver",
        function: "svc",
        revision: "rev1",
      }),
    );
    const dataRev1 = parseJsonResult<{ counter: number; revision: string }>(
      resRev1,
    );
    assertEquals(dataRev1.counter, 1);
    assertEquals(dataRev1.revision, "rev1");

    // Invoking rev2 must start clean in a separate subprocess
    const resRev2 = await provider.run(
      artifactRev2,
      DEFAULT_LIMITS,
      createTestInvocation({
        project: "proj-ver",
        function: "svc",
        revision: "rev2",
      }),
    );
    const dataRev2 = parseJsonResult<{ counter: number; revision: string }>(
      resRev2,
    );
    assertEquals(
      dataRev2.counter,
      1,
      "rev2 must not share warm state with rev1",
    );
    assertEquals(dataRev2.revision, "rev2");

    // Re-invoking rev1 reuses rev1 warm worker
    const resRev1Again = await provider.run(
      artifactRev1,
      DEFAULT_LIMITS,
      createTestInvocation({
        project: "proj-ver",
        function: "svc",
        revision: "rev1",
      }),
    );
    const dataRev1Again = parseJsonResult<{ counter: number }>(resRev1Again);
    assertEquals(
      dataRev1Again.counter,
      2,
      "rev1 warm worker state preserved independently",
    );
  } finally {
    await provider.shutdown();
  }
});

// ============================================================================
// Lifecycle & Shutdown
// Spec: tasks/T-0311
// ============================================================================

Deno.test("Lifecycle: shutdown terminates pooled worker subprocesses and cleans up resources", async () => {
  const provider = new ProcessIsolationProvider();

  const code =
    `export default async function handler() { return new Response("active"); }`;
  const artifact = createTestArtifact({
    project: "lifecycle",
    function: "fn-term",
    revision: "rev1",
    code,
  });

  // Run invocation to spin up worker
  const res = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    createTestInvocation(),
  );
  assertEquals(res.statusCode, 200);

  // Shutdown must terminate subprocesses cleanly without hanging
  await provider.shutdown();
});

// ============================================================================
// Security Adversarial Review: Sandbox Escape Attempts
// Spec: contracts/platform.contract.md#PLAT-4, PLAT-5, .agents/skills/security-adversarial-review/SKILL.md
// ============================================================================

Deno.test("Security Adversarial (PLAT-4): Attempt to spawn child processes via Deno.Command fails with permission error", async () => {
  // spec: contracts/platform.contract.md#PLAT-4 — --deny-run prevents child process spawning
  const provider = new ProcessIsolationProvider();

  try {
    const code = `
      export default async function handler(req, ctx) {
        try {
          const bin = Deno.execPath();
          const cmd = new Deno.Command(bin, { args: ["eval", "1"] });
          await cmd.output();
          return new Response("run_success", { status: 200 });
        } catch (err) {
          return Response.json({
            errorName: err.name,
            errorMessage: err.message,
          }, { status: 500 });
        }
      }
    `;

    const artifact = createTestArtifact({
      project: "adv-run",
      function: "spawn-exploit",
      revision: "rev1",
      code,
    });

    const res = await provider.run(
      artifact,
      DEFAULT_LIMITS,
      createTestInvocation(),
    );
    const data = parseJsonResult<{ errorName: string; errorMessage: string }>(
      res,
    );

    assert(
      data.errorName === "PermissionDenied" ||
        data.errorName === "NotCapable" ||
        data.errorMessage.includes("Requires run access") ||
        data.errorMessage.includes("denied"),
      `Spawning child process must be denied, got: ${data.errorName} (${data.errorMessage})`,
    );
  } finally {
    await provider.shutdown();
  }
});

Deno.test("Security Adversarial (PLAT-4): Attempt to inspect host system info (Deno.systemMemoryInfo) fails with permission error", async () => {
  // spec: contracts/platform.contract.md#PLAT-4 — --deny-sys prevents host system inspection
  const provider = new ProcessIsolationProvider();

  try {
    const code = `
      export default async function handler(req, ctx) {
        try {
          // deno-lint-ignore no-deprecated-deno-api
          const mem = Deno.systemMemoryInfo();
          return Response.json({ mem }, { status: 200 });
        } catch (err) {
          return Response.json({
            errorName: err.name,
            errorMessage: err.message,
          }, { status: 500 });
        }
      }
    `;

    const artifact = createTestArtifact({
      project: "adv-sys",
      function: "sys-exploit",
      revision: "rev1",
      code,
    });

    const res = await provider.run(
      artifact,
      DEFAULT_LIMITS,
      createTestInvocation(),
    );
    const data = parseJsonResult<{ errorName: string; errorMessage: string }>(
      res,
    );

    assert(
      data.errorName === "PermissionDenied" ||
        data.errorName === "NotCapable" ||
        data.errorMessage.includes("Requires sys access") ||
        data.errorMessage.includes("denied"),
      `Reading system info must be denied, got: ${data.errorName} (${data.errorMessage})`,
    );
  } finally {
    await provider.shutdown();
  }
});

Deno.test("Security Adversarial (PLAT-4): Attempt to read host environment variables (Deno.env.get) fails with permission error", async () => {
  // spec: contracts/platform.contract.md#PLAT-4 — --deny-env prevents ambient host credential inspection
  const provider = new ProcessIsolationProvider();

  try {
    const code = `
      export default async function handler(req, ctx) {
        try {
          const val = Deno.env.get("PATH");
          return Response.json({ val }, { status: 200 });
        } catch (err) {
          return Response.json({
            errorName: err.name,
            errorMessage: err.message,
          }, { status: 500 });
        }
      }
    `;

    const artifact = createTestArtifact({
      project: "adv-env",
      function: "env-exploit",
      revision: "rev1",
      code,
    });

    const res = await provider.run(
      artifact,
      DEFAULT_LIMITS,
      createTestInvocation(),
    );
    const data = parseJsonResult<{ errorName: string; errorMessage: string }>(
      res,
    );

    assert(
      data.errorName === "PermissionDenied" ||
        data.errorName === "NotCapable" ||
        data.errorMessage.includes("Requires env access") ||
        data.errorMessage.includes("denied"),
      `Reading host env must be denied, got: ${data.errorName} (${data.errorMessage})`,
    );
  } finally {
    await provider.shutdown();
  }
});

Deno.test("Security Adversarial (FN-6, PLAT-7): Separate tenants with identical project and function names execute in separate subprocesses", async () => {
  // Finding 1: Two distinct tenants (org_alpha vs org_beta) deploy identical project and function names.
  // Process pool must not share warm subprocess across tenants.
  const provider = new ProcessIsolationProvider();

  try {
    const code = `
      let tenantOwner = null;
      export default async function handler(req, ctx) {
        if (!tenantOwner) {
          tenantOwner = ctx.project + ":" + (req.headers.get("x-railfog-org") ?? "none");
        }
        return Response.json({
          owner: tenantOwner,
          requestId: ctx.requestId,
        });
      }
    `;

    const artAlpha = createTestArtifact({
      project: "billing",
      function: "service",
      revision: "rev1",
      code,
    });
    (artAlpha as unknown as Record<string, unknown>).orgId = "org_alpha";

    const artBeta = createTestArtifact({
      project: "billing",
      function: "service",
      revision: "rev1",
      code,
    });
    (artBeta as unknown as Record<string, unknown>).orgId = "org_beta";

    const resAlpha = await provider.run(
      artAlpha,
      DEFAULT_LIMITS,
      createTestInvocation({
        headers: { "x-railfog-org": "org_alpha" },
      }),
    );
    const dataAlpha = parseJsonResult<{ owner: string }>(resAlpha);
    assertEquals(dataAlpha.owner, "billing:org_alpha");

    // Invoking for org_beta must run in a separate subprocess, not reusing org_alpha's instance
    const resBeta = await provider.run(
      artBeta,
      DEFAULT_LIMITS,
      createTestInvocation({
        headers: { "x-railfog-org": "org_beta" },
      }),
    );
    const dataBeta = parseJsonResult<{ owner: string }>(resBeta);
    assertEquals(
      dataBeta.owner,
      "billing:org_beta",
      "Tenant Beta must not execute in Tenant Alpha subprocess",
    );
  } finally {
    await provider.shutdown();
  }
});

Deno.test("Security Adversarial (ADR-0001, PLAT-4): Untrusted handler writing directly to Deno.stdout cannot forge IPC response", async () => {
  // Finding 2: Untrusted handler attempts to spoof an NDJSON response on Deno.stdout.
  // Standard I/O redirection to stderr and message ID matching must reject the attack.
  const provider = new ProcessIsolationProvider();

  try {
    const code = `
      export default async function handler(req, ctx) {
        // Attempt to spoof IPC response frame by writing to stdout
        try {
          const forged = JSON.stringify({
            id: "forged_id",
            statusCode: 418,
            headers: { "x-spoofed": "true" },
            bodyBase64: btoa("spoofed teapot response"),
            cpuTimeMs: 0,
            wallClockMs: 0,
          }) + "\\n";
          await Deno.stdout.write(new TextEncoder().encode(forged));
        } catch {
          // stdout write redirected or denied
        }

        return Response.json({ genuine: true }, { status: 200 });
      }
    `;

    const artifact = createTestArtifact({
      project: "adv-ipc",
      function: "spoof-handler",
      revision: "rev1",
      code,
    });

    const res = await provider.run(
      artifact,
      DEFAULT_LIMITS,
      createTestInvocation(),
    );
    assertEquals(
      res.statusCode,
      200,
      "Must return genuine 200 response, not forged 418",
    );
    const data = parseJsonResult<{ genuine: boolean }>(res);
    assertEquals(data.genuine, true);
  } finally {
    await provider.shutdown();
  }
});
