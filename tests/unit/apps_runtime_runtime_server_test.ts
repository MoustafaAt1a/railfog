/**
 * Standalone Runtime Data Plane Daemon Server Integration & Security Tests (T-0606).
 *
 * Spec references:
 * - PLAT-1: Control plane vs data plane separation (runtime daemon serves live traffic).
 * - PLAT-4: Isolation & defense in depth (IsolationProvider execution boundary).
 * - PLAT-8: Fail-static control/data plane split (local cached snapshot, ~5s background poll, outage resilience).
 * - PLAT-10: SLOs & error budget (99.95% data plane availability via in-memory cached routing).
 * - PLAT-11: Routing specificity algorithm (score = literal_segments * 2 + wildcard_or_named_segments * 1).
 * - PLAT-12: Error model (exhaustive code taxonomy, RESOURCE_NOT_FOUND, INTERNAL, request_id propagation).
 * - PLAT-14: ULID 128-bit Crockford Base32 monotonic identifiers for request_id.
 * - FN-1: Function definition and execution interface.
 * - FN-6: Isolation & warm-reuse rule (fresh context and bindings per invocation, zero state bleeding).
 * - FN-8: Request lifecycle (route -> cached snapshot -> isolate -> fresh ctx -> response + request_id).
 * - tasks/milestone-0.6-public-beta/T-0606-runtime-data-plane-server.md
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { join } from "@std/path";
import type {
  RuntimeServer,
  RuntimeServerOptions,
} from "../../apps/runtime/runtime-server.ts";
import { startRuntimeServer } from "../../apps/runtime/runtime-server.ts";
import type {
  Artifact,
  ExecutionResult,
  InvocationRequest,
  IsolationProvider,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import { isValidUlid } from "../../packages/core/id/ulid.ts";
import type {
  FunctionSnapshot,
  RoutingSnapshot,
} from "../../packages/protocol/snapshot.ts";

// ============================================================================
// Constants & Test Fixtures
// ============================================================================

// spec: contracts/platform.contract.md#PLAT-1 — Daemon service identifier
const RUNTIME_SERVICE_NAME = "railfog-runtime";

// spec: contracts/platform.contract.md#PLAT-12 — Canonical HTTP status codes
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_INTERNAL = 500;

// spec: contracts/platform.contract.md#PLAT-12 — Canonical error codes
const ERROR_RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND";
const ERROR_INTERNAL = "INTERNAL";

// spec: contracts/platform.contract.md#PLAT-14 — 26-character Crockford Base32 ULID regex
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Recorded invocation information captured by MockIsolationProvider.
 * spec: contracts/platform.contract.md#PLAT-4, FN-6
 */
interface RecordedRun {
  artifact: Artifact;
  limits: Limits;
  invocation?: InvocationRequest;
  timestamp: number;
}

/**
 * Mock isolation provider tracking executions and inspecting invocation request contexts.
 * spec: contracts/platform.contract.md#PLAT-4, PLAT-16, FN-6
 */
class MockIsolationProvider implements IsolationProvider {
  public runs: RecordedRun[] = [];
  public customHandler?: (
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ) => Promise<ExecutionResult> | ExecutionResult;

  run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult> {
    const record: RecordedRun = {
      artifact,
      limits,
      invocation: invocation
        ? {
          requestId: invocation.requestId,
          method: invocation.method,
          url: invocation.url,
          headers: invocation.headers ? { ...invocation.headers } : undefined,
          body: invocation.body ? new Uint8Array(invocation.body) : undefined,
        }
        : undefined,
      timestamp: Date.now(),
    };
    this.runs.push(record);

    if (this.customHandler) {
      return Promise.resolve(this.customHandler(artifact, limits, invocation));
    }

    const payload = JSON.stringify({
      ok: true,
      entrypoint: artifact.entrypoint,
      artifactId: artifact.id,
      requestId: invocation?.requestId,
    });

    return Promise.resolve({
      statusCode: HTTP_STATUS_OK,
      headers: {
        "content-type": "application/json",
        "x-function-executed": artifact.entrypoint,
      },
      body: new TextEncoder().encode(payload),
      cpuTimeMs: 2,
      wallClockMs: 5,
    });
  }
}

/**
 * Mock control plane daemon simulating /v1/projects/:projectId/snapshot distribution.
 * spec: contracts/platform.contract.md#PLAT-1, PLAT-8
 */
interface MockControlPlane {
  url: string;
  port: number;
  getPollCount(): number;
  getLastIfNoneMatch(): string | null;
  setSnapshot(snapshot: RoutingSnapshot | null): void;
  setStatusCode(code: number): void;
  close(): Promise<void>;
}

/**
 * Spawns an in-memory HTTP server on dynamic port 0 simulating the control plane snapshot API.
 * spec: contracts/platform.contract.md#PLAT-8
 */
function createMockControlPlane(
  projectId: string,
  initialSnapshot?: RoutingSnapshot,
): MockControlPlane {
  let currentSnapshot: RoutingSnapshot | null = initialSnapshot ?? null;
  let overrideStatusCode = 0;
  let pollCount = 0;
  let lastIfNoneMatch: string | null = null;

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === `/v1/projects/${projectId}/snapshot`) {
        pollCount++;
        lastIfNoneMatch = req.headers.get("if-none-match");

        if (overrideStatusCode > 0) {
          return new Response(
            JSON.stringify({
              error: {
                code: "UNAVAILABLE",
                message: "Control plane offline",
              },
            }),
            {
              status: overrideStatusCode,
              headers: { "content-type": "application/json" },
            },
          );
        }

        if (!currentSnapshot) {
          return new Response(
            JSON.stringify({
              error: {
                code: "RESOURCE_NOT_FOUND",
                message: "No snapshot available",
              },
            }),
            {
              status: HTTP_STATUS_NOT_FOUND,
              headers: { "content-type": "application/json" },
            },
          );
        }

        const etag = `"${currentSnapshot.version}"`;
        if (
          lastIfNoneMatch &&
          (lastIfNoneMatch === etag || lastIfNoneMatch === `W/${etag}`)
        ) {
          return new Response(null, {
            status: 304,
            headers: { "etag": etag },
          });
        }

        return new Response(JSON.stringify(currentSnapshot), {
          status: HTTP_STATUS_OK,
          headers: {
            "content-type": "application/json",
            "etag": etag,
          },
        });
      }

      if (url.pathname === "/login") {
        return new Response("<html>Login Page</html>", {
          status: HTTP_STATUS_OK,
          headers: { "content-type": "text/html" },
        });
      }

      return new Response("Not found", { status: HTTP_STATUS_NOT_FOUND });
    },
  );

  const port = (server.addr as Deno.NetAddr).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    getPollCount: () => pollCount,
    getLastIfNoneMatch: () => lastIfNoneMatch,
    setSnapshot: (snap: RoutingSnapshot | null) => {
      currentSnapshot = snap;
    },
    setStatusCode: (code: number) => {
      overrideStatusCode = code;
    },
    close: async () => {
      await server.shutdown();
    },
  };
}

/**
 * Creates a valid mock RoutingSnapshot complying with PLAT-8 and PLAT-14.
 * spec: contracts/platform.contract.md#PLAT-8, PLAT-14
 */
function createMockSnapshot(
  options?: {
    version?: number;
    routes?: Array<{ pattern: string; function: string }>;
    functions?: Record<string, FunctionSnapshot>;
  },
): RoutingSnapshot {
  const version = options?.version ?? 1;
  const routes = options?.routes ?? [
    { pattern: "/api/users", function: "users" },
    { pattern: "/api/*", function: "wildcard" },
  ];
  const functions = options?.functions ?? {
    users: {
      functionName: "users",
      revisionId: "rev_01HZX000000000000000000001",
      artifactId:
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      permissions: { kv: ["app:users"] },
      limits: { cpu_ms: 200, timeout_ms: 30000, memory_mb: 128 },
    },
    wildcard: {
      functionName: "wildcard",
      revisionId: "rev_01HZX000000000000000000002",
      artifactId:
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      permissions: {},
      limits: { cpu_ms: 200, timeout_ms: 30000, memory_mb: 128 },
    },
  };

  return {
    snapshotId: "snap_01HZX000000000000000000000",
    version,
    routes,
    functions,
    generatedAt: Date.now(),
  };
}

/**
 * Helper to poll until condition holds or timeout expires.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor condition timed out after ${timeoutMs}ms`);
}

// ============================================================================
// AC1: Server Startup & Initial Snapshot Loading (PLAT-1, PLAT-8)
// ============================================================================

Deno.test("AC1: startRuntimeServer loads initial snapshot and serves /healthz with valid ULID", async () => {
  const projectId = "proj_test_startup";
  const initialSnapshot = createMockSnapshot({ version: 1 });
  const mockCp = createMockControlPlane(projectId, initialSnapshot);
  const isolationProvider = new MockIsolationProvider();
  let server: RuntimeServer | null = null;

  try {
    const options: RuntimeServerOptions = {
      projectId,
      controlPlaneUrl: mockCp.url,
      isolationProvider,
      pollIntervalMs: 10000,
    };
    server = await startRuntimeServer(options);

    // Verify dynamic port assignment and snapshot version loaded
    assertExists(server.port);
    assert(server.port > 0, `Expected server.port > 0, got ${server.port}`);
    assertEquals(server.getSnapshotVersion(), 1);

    // Verify GET /healthz returns 200 OK with railfog-runtime service
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assertEquals(res.status, HTTP_STATUS_OK);
    assertEquals(res.headers.get("content-type"), "application/json");

    const headerReqId = res.headers.get("x-request-id");
    assertExists(headerReqId, "Missing x-request-id header");
    assert(
      isValidUlid(headerReqId),
      `x-request-id must be valid ULID, got ${headerReqId}`,
    );
    assertMatch(headerReqId, ULID_REGEX);
    assertEquals(res.headers.get("request-id"), headerReqId);

    const body = await res.json();
    assertEquals(body.status, "ok");
    assertEquals(body.service, RUNTIME_SERVICE_NAME);
    assertExists(body.request_id);
    assert(
      isValidUlid(body.request_id),
      `body.request_id must be valid ULID, got ${body.request_id}`,
    );
    assertEquals(body.request_id, headerReqId);
  } finally {
    if (server) await server.close();
    await mockCp.close();
  }
});

Deno.test("AC1: GET /healthz propagates existing request_id header unchanged per PLAT-12", async () => {
  const projectId = "proj_test_healthz_prop";
  const mockCp = createMockControlPlane(projectId, createMockSnapshot());
  const isolationProvider = new MockIsolationProvider();
  let server: RuntimeServer | null = null;

  try {
    const options: RuntimeServerOptions = {
      projectId,
      controlPlaneUrl: mockCp.url,
      isolationProvider,
      pollIntervalMs: 10000,
    };
    server = await startRuntimeServer(options);

    const clientUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`, {
      headers: { "x-request-id": clientUlid },
    });

    assertEquals(res.status, HTTP_STATUS_OK);
    assertEquals(res.headers.get("x-request-id"), clientUlid);
    assertEquals(res.headers.get("request-id"), clientUlid);

    const body = await res.json();
    assertEquals(body.request_id, clientUlid);
  } finally {
    if (server) await server.close();
    await mockCp.close();
  }
});

// ============================================================================
// AC2: Route Dispatching & PLAT-11 Specificity Scoring (PLAT-4, PLAT-11, PLAT-14)
// ============================================================================

Deno.test("AC2: dispatches requests according to PLAT-11 specificity score", async () => {
  const projectId = "proj_test_specificity";
  // Pattern /api/users: 2 literal segments = score 4
  // Pattern /api/*: 1 literal + 1 wildcard = score 3
  // Pattern /*: 1 wildcard = score 1
  const snapshot: RoutingSnapshot = {
    snapshotId: "snap_01HZX000000000000000000001",
    version: 1,
    routes: [
      { pattern: "/api/*", function: "wildcard_fn" },
      { pattern: "/api/users", function: "specific_users_fn" },
      { pattern: "/*", function: "catchall_fn" },
    ],
    functions: {
      specific_users_fn: {
        functionName: "specific_users_fn",
        revisionId: "rev_01HZX000000000000000000010",
        artifactId: "sha256:users10",
        permissions: {},
        limits: { cpu_ms: 200, timeout_ms: 30000, memory_mb: 128 },
      },
      wildcard_fn: {
        functionName: "wildcard_fn",
        revisionId: "rev_01HZX000000000000000000020",
        artifactId: "sha256:wildcard20",
        permissions: {},
        limits: { cpu_ms: 200, timeout_ms: 30000, memory_mb: 128 },
      },
      catchall_fn: {
        functionName: "catchall_fn",
        revisionId: "rev_01HZX000000000000000000030",
        artifactId: "sha256:catchall30",
        permissions: {},
        limits: { cpu_ms: 200, timeout_ms: 30000, memory_mb: 128 },
      },
    },
    generatedAt: Date.now(),
  };

  const mockCp = createMockControlPlane(projectId, snapshot);
  const isolationProvider = new MockIsolationProvider();
  let server: RuntimeServer | null = null;

  try {
    server = await startRuntimeServer({
      projectId,
      controlPlaneUrl: mockCp.url,
      isolationProvider,
      pollIntervalMs: 10000,
    });

    // 1. Specific route /api/users should match specific_users_fn (score 4 > score 3)
    // even though /api/* was declared first in the routes array!
    const resUsers = await fetch(`http://127.0.0.1:${server.port}/api/users`);
    assertEquals(resUsers.status, HTTP_STATUS_OK);
    const lastRun1 = isolationProvider.runs[isolationProvider.runs.length - 1];
    assertEquals(lastRun1.artifact.id, "sha256:users10");
    const reqId1 = resUsers.headers.get("x-request-id");
    assertExists(reqId1);
    assert(isValidUlid(reqId1));
    assertMatch(reqId1, ULID_REGEX);
    assertEquals(resUsers.headers.get("request-id"), reqId1);

    // 2. /api/other should match wildcard_fn (score 3)
    const resWildcard = await fetch(
      `http://127.0.0.1:${server.port}/api/other`,
    );
    assertEquals(resWildcard.status, HTTP_STATUS_OK);
    const lastRun2 = isolationProvider.runs[isolationProvider.runs.length - 1];
    assertEquals(lastRun2.artifact.id, "sha256:wildcard20");

    // 3. /unmatched/path should match catchall_fn (score 1)
    const resCatchall = await fetch(
      `http://127.0.0.1:${server.port}/unmatched/path`,
    );
    assertEquals(resCatchall.status, HTTP_STATUS_OK);
    const lastRun3 = isolationProvider.runs[isolationProvider.runs.length - 1];
    assertEquals(lastRun3.artifact.id, "sha256:catchall30");
  } finally {
    if (server) await server.close();
    await mockCp.close();
  }
});

Deno.test("AC2: unmapped route returns HTTP 404 RESOURCE_NOT_FOUND per PLAT-12", async () => {
  const projectId = "proj_test_404";
  const snapshot = createMockSnapshot({
    routes: [{ pattern: "/api/items", function: "users" }],
  });
  const mockCp = createMockControlPlane(projectId, snapshot);
  const isolationProvider = new MockIsolationProvider();
  let server: RuntimeServer | null = null;

  try {
    server = await startRuntimeServer({
      projectId,
      controlPlaneUrl: mockCp.url,
      isolationProvider,
      pollIntervalMs: 10000,
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/unmapped/route`);
    assertEquals(res.status, HTTP_STATUS_NOT_FOUND);
    assertEquals(res.headers.get("content-type"), "application/json");

    const reqId = res.headers.get("x-request-id");
    assertExists(reqId);
    assert(isValidUlid(reqId));
    assertMatch(reqId, ULID_REGEX);
    assertEquals(res.headers.get("request-id"), reqId);

    const body = await res.json();
    assertExists(body.error);
    assertEquals(body.error.code, ERROR_RESOURCE_NOT_FOUND);
    assertEquals(body.error.request_id, reqId);
  } finally {
    if (server) await server.close();
    await mockCp.close();
  }
});

Deno.test("AC2: propagates HTTP method, request headers, and body to IsolationProvider", async () => {
  const projectId = "proj_test_payload_dispatch";
  const snapshot = createMockSnapshot({
    routes: [{ pattern: "/submit", function: "users" }],
  });
  const mockCp = createMockControlPlane(projectId, snapshot);
  const isolationProvider = new MockIsolationProvider();
  let server: RuntimeServer | null = null;

  try {
    server = await startRuntimeServer({
      projectId,
      controlPlaneUrl: mockCp.url,
      isolationProvider,
      pollIntervalMs: 10000,
    });

    const requestPayload = JSON.stringify({ name: "Alice", role: "admin" });
    const res = await fetch(
      `http://127.0.0.1:${server.port}/submit?tab=overview`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer secret-token-xyz",
          "x-custom-tenant": "tenant-42",
        },
        body: requestPayload,
      },
    );

    assertEquals(res.status, HTTP_STATUS_OK);
    assertEquals(isolationProvider.runs.length, 1);

    const run = isolationProvider.runs[0];
    assertExists(run.invocation);
    assertEquals(run.invocation.method, "POST");
    assert(
      run.invocation.url?.includes("/submit?tab=overview"),
      `Expected url to include path and query, got ${run.invocation.url}`,
    );
    assertExists(run.invocation.headers);
    assertEquals(
      run.invocation.headers["authorization"],
      "Bearer secret-token-xyz",
    );
    assertEquals(run.invocation.headers["x-custom-tenant"], "tenant-42");

    assertExists(run.invocation.body);
    const decodedBody = new TextDecoder().decode(run.invocation.body);
    assertEquals(decodedBody, requestPayload);
  } finally {
    if (server) await server.close();
    await mockCp.close();
  }
});

Deno.test("PLAT-12: unhandled error in isolation provider returns HTTP 500 INTERNAL with valid ULID", async () => {
  const projectId = "proj_test_internal_error";
  const snapshot = createMockSnapshot();
  const mockCp = createMockControlPlane(projectId, snapshot);
  const isolationProvider = new MockIsolationProvider();
  isolationProvider.customHandler = () => {
    throw new Error("Simulated unhandled isolate crash");
  };

  const options: RuntimeServerOptions = {
    projectId,
    controlPlaneUrl: mockCp.url,
    isolationProvider,
    pollIntervalMs: 10000,
  };

  let server: RuntimeServer | null = null;
  try {
    server = await startRuntimeServer(options);

    const res = await fetch(`http://127.0.0.1:${server.port}/api/users`);
    assertEquals(res.status, HTTP_STATUS_INTERNAL);
    assertEquals(res.headers.get("content-type"), "application/json");

    const reqId = res.headers.get("x-request-id");
    assertExists(reqId);
    assertMatch(reqId, ULID_REGEX);

    const body = await res.json();
    assertExists(body.error);
    assertEquals(body.error.code, ERROR_INTERNAL);
    assertEquals(body.error.request_id, reqId);
  } finally {
    if (server) await server.close();
    await mockCp.close();
  }
});

// ============================================================================
// AC3: Fail-Static Operation During Control Plane Outage (PLAT-8, PLAT-10)
// ============================================================================

Deno.test("AC3: continues serving traffic indefinitely during complete control plane outage (PLAT-8)", async () => {
  const projectId = "proj_test_fail_static";
  const initialSnapshot = createMockSnapshot({ version: 2 });
  const mockCp = createMockControlPlane(projectId, initialSnapshot);
  const isolationProvider = new MockIsolationProvider();
  let server: RuntimeServer | null = null;

  try {
    server = await startRuntimeServer({
      projectId,
      controlPlaneUrl: mockCp.url,
      isolationProvider,
      pollIntervalMs: 50, // Short polling interval to guarantee poller triggers during outage
    });

    assertEquals(server.getSnapshotVersion(), 2);

    // Verify baseline request succeeds
    const res1 = await fetch(`http://127.0.0.1:${server.port}/api/users`);
    assertEquals(res1.status, HTTP_STATUS_OK);

    // Simulate catastrophic control plane crash / network drop
    await mockCp.close();

    // Wait for multiple background polling intervals to pass
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Runtime data plane must continue serving traffic with 200 OK and zero downtime
    for (let i = 0; i < 5; i++) {
      const res: Response = await fetch(
        `http://127.0.0.1:${server!.port}/api/users`,
      );
      assertEquals(res.status, HTTP_STATUS_OK);
      const reqId = res.headers.get("x-request-id");
      assertExists(reqId);
      assert(isValidUlid(reqId));
      assertMatch(reqId, ULID_REGEX);
    }

    // Snapshot version remains preserved as last-known-good
    assertEquals(server.getSnapshotVersion(), 2);
  } finally {
    if (server) await server.close();
  }
});

Deno.test("AC3: cold starts from disk cache when control plane is completely unavailable (PLAT-8, PLAT-10)", async () => {
  const projectId = "proj_test_cold_start";
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-cache-test-" });
  const diskCachePath = join(tempDir, "cached-snapshot.json");

  const diskSnapshot = createMockSnapshot({
    version: 7,
    routes: [{ pattern: "/cached-route", function: "users" }],
  });
  await Deno.writeTextFile(diskCachePath, JSON.stringify(diskSnapshot));

  const deadControlPlaneUrl = "http://127.0.0.1:1"; // Guaranteed connection failure
  const isolationProvider = new MockIsolationProvider();
  let server: RuntimeServer | null = null;

  try {
    server = await startRuntimeServer({
      projectId,
      controlPlaneUrl: deadControlPlaneUrl,
      snapshotDiskCachePath: diskCachePath,
      isolationProvider,
      pollIntervalMs: 50,
    });

    // Verify cold start loaded snapshot from disk cache despite unreachable control plane
    assertEquals(server.getSnapshotVersion(), 7);

    // Verify cached route is actively served
    const res = await fetch(`http://127.0.0.1:${server.port}/cached-route`);
    assertEquals(res.status, HTTP_STATUS_OK);
    const lastRun = isolationProvider.runs[isolationProvider.runs.length - 1];
    assertEquals(
      lastRun.artifact.id,
      diskSnapshot.functions["users"].artifactId,
    );
  } finally {
    if (server) await server.close();
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Best effort cleanup
    }
  }
});

// ============================================================================
// AC4 & Security: Warm Isolate Reuse & Fresh Context Isolation (FN-6, PLAT-4)
// ============================================================================

Deno.test("AC4 & Security: consecutive invocations in warm isolates receive fresh request context and distinct ULID (FN-6)", async () => {
  const projectId = "proj_test_context_freshness";
  const snapshot = createMockSnapshot();
  const mockCp = createMockControlPlane(projectId, snapshot);

  // IsolationProvider tracking invocation contexts to verify zero reference reuse or bleeding
  const receivedInvocationIds: string[] = [];
  const receivedHeadersList: Array<Record<string, string>> = [];

  const isolationProvider = new MockIsolationProvider();
  isolationProvider.customHandler = (_artifact, _limits, invocation) => {
    assertExists(invocation, "InvocationRequest must be provided");
    receivedInvocationIds.push(invocation.requestId);
    receivedHeadersList.push({ ...(invocation.headers ?? {}) });

    return {
      statusCode: HTTP_STATUS_OK,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(
        JSON.stringify({ reqId: invocation.requestId }),
      ),
      cpuTimeMs: 1,
      wallClockMs: 2,
    };
  };

  let server: RuntimeServer | null = null;

  try {
    server = await startRuntimeServer({
      projectId,
      controlPlaneUrl: mockCp.url,
      isolationProvider,
      pollIntervalMs: 10000,
    });

    // Dispatch request 1 with specific header
    const res1 = await fetch(`http://127.0.0.1:${server.port}/api/users`, {
      headers: { "x-client-session": "session-aaa-111" },
    });
    assertEquals(res1.status, HTTP_STATUS_OK);
    const reqId1 = res1.headers.get("x-request-id")!;
    assert(isValidUlid(reqId1));
    assertMatch(reqId1, ULID_REGEX);

    // Dispatch request 2 with distinct header
    const res2 = await fetch(`http://127.0.0.1:${server.port}/api/users`, {
      headers: { "x-client-session": "session-bbb-222" },
    });
    assertEquals(res2.status, HTTP_STATUS_OK);
    const reqId2 = res2.headers.get("x-request-id")!;
    assert(isValidUlid(reqId2));
    assertMatch(reqId2, ULID_REGEX);

    // Dispatch request 3 with distinct header
    const res3 = await fetch(`http://127.0.0.1:${server.port}/api/users`, {
      headers: { "x-client-session": "session-ccc-333" },
    });
    assertEquals(res3.status, HTTP_STATUS_OK);
    const reqId3 = res3.headers.get("x-request-id")!;
    assert(isValidUlid(reqId3));
    assertMatch(reqId3, ULID_REGEX);

    // FN-6: Assert distinct ULID request identifiers for every single invocation
    assertNotEquals(reqId1, reqId2);
    assertNotEquals(reqId2, reqId3);
    assertNotEquals(reqId1, reqId3);

    assertEquals(receivedInvocationIds.length, 3);
    assertEquals(receivedInvocationIds[0], reqId1);
    assertEquals(receivedInvocationIds[1], reqId2);
    assertEquals(receivedInvocationIds[2], reqId3);

    // FN-6 Security: Verify headers from invocation 1 did NOT bleed into invocation 2 or 3
    assertEquals(
      receivedHeadersList[0]["x-client-session"],
      "session-aaa-111",
    );
    assertEquals(
      receivedHeadersList[1]["x-client-session"],
      "session-bbb-222",
    );
    assertEquals(
      receivedHeadersList[2]["x-client-session"],
      "session-ccc-333",
    );
  } finally {
    if (server) await server.close();
    await mockCp.close();
  }
});

// ============================================================================
// AC5: Dynamic Background Snapshot Update (PLAT-8)
// ============================================================================

Deno.test("AC5: dynamically updates routing snapshot in background without dropped connections (PLAT-8)", async () => {
  const projectId = "proj_test_dyn_snapshot";
  const initialSnapshot = createMockSnapshot({
    version: 1,
    routes: [{ pattern: "/api/v1", function: "users" }],
  });
  const mockCp = createMockControlPlane(projectId, initialSnapshot);
  const isolationProvider = new MockIsolationProvider();
  let server: RuntimeServer | null = null;

  try {
    server = await startRuntimeServer({
      projectId,
      controlPlaneUrl: mockCp.url,
      isolationProvider,
      pollIntervalMs: 50, // Polling every 50ms for responsive test
    });

    assertEquals(server.getSnapshotVersion(), 1);

    // /api/v1 is present, /api/v2 returns 404
    const resV1 = await fetch(`http://127.0.0.1:${server.port}/api/v1`);
    assertEquals(resV1.status, HTTP_STATUS_OK);

    const resV2Before = await fetch(`http://127.0.0.1:${server.port}/api/v2`);
    assertEquals(resV2Before.status, HTTP_STATUS_NOT_FOUND);

    // Control plane updates snapshot with version 2 and adds /api/v2
    const updatedSnapshot: RoutingSnapshot = {
      snapshotId: "snap_01HZX000000000000000000099",
      version: 2,
      routes: [
        { pattern: "/api/v1", function: "users" },
        { pattern: "/api/v2", function: "wildcard" },
      ],
      functions: {
        users: initialSnapshot.functions["users"],
        wildcard: initialSnapshot.functions["wildcard"],
      },
      generatedAt: Date.now(),
    };
    mockCp.setSnapshot(updatedSnapshot);

    // Wait for poller to pick up updated snapshot version
    await waitFor(() => server!.getSnapshotVersion() === 2, 3000, 25);
    assertEquals(server.getSnapshotVersion(), 2);

    // /api/v2 is now dispatchable without server restart
    const resV2After = await fetch(`http://127.0.0.1:${server.port}/api/v2`);
    assertEquals(resV2After.status, HTTP_STATUS_OK);

    // /api/v1 remains actively dispatchable
    const resV1After = await fetch(`http://127.0.0.1:${server.port}/api/v1`);
    assertEquals(resV1After.status, HTTP_STATUS_OK);
  } finally {
    if (server) await server.close();
    await mockCp.close();
  }
});

Deno.test("AC5: poller includes If-None-Match header and handles 304 Not Modified efficiently (PLAT-8)", async () => {
  const projectId = "proj_test_etag_polling";
  const snapshot = createMockSnapshot({ version: 4 });
  const mockCp = createMockControlPlane(projectId, snapshot);
  const isolationProvider = new MockIsolationProvider();
  let server: RuntimeServer | null = null;

  try {
    server = await startRuntimeServer({
      projectId,
      controlPlaneUrl: mockCp.url,
      isolationProvider,
      pollIntervalMs: 40,
    });

    // Wait for at least 3 polling cycles to execute
    await waitFor(() => mockCp.getPollCount() >= 3, 2000, 20);

    // Control plane must have received If-None-Match header matching current version ETag
    const lastIfNoneMatch = mockCp.getLastIfNoneMatch();
    assertExists(lastIfNoneMatch);
    assert(
      lastIfNoneMatch.includes("4"),
      `Expected If-None-Match to include version 4, got ${lastIfNoneMatch}`,
    );

    // Snapshot version remains steady at 4
    assertEquals(server.getSnapshotVersion(), 4);

    // Traffic continues serving with zero errors
    const res = await fetch(`http://127.0.0.1:${server.port}/api/users`);
    assertEquals(res.status, HTTP_STATUS_OK);
  } finally {
    if (server) await server.close();
    await mockCp.close();
  }
});

// ============================================================================
// Server Lifecycle & Clean Shutdown
// ============================================================================

Deno.test("Server Lifecycle: close() terminates cleanly and stops polling without hanging", async () => {
  const projectId = "proj_test_lifecycle";
  const mockCp = createMockControlPlane(projectId, createMockSnapshot());
  const isolationProvider = new MockIsolationProvider();

  const server = await startRuntimeServer({
    projectId,
    controlPlaneUrl: mockCp.url,
    isolationProvider,
    pollIntervalMs: 50,
  });

  const port = server.port;
  assert(port > 0);

  // Close server
  await server.close();

  // Polling must stop and socket must be released
  await assertRejects(
    () => fetch(`http://127.0.0.1:${port}/healthz`),
    TypeError, // Connection refused in Deno fetch throws TypeError
  );

  await mockCp.close();
});

Deno.test("Server Lifecycle: respects AbortSignal for graceful shutdown", async () => {
  const projectId = "proj_test_abort_signal";
  const mockCp = createMockControlPlane(projectId, createMockSnapshot());
  const isolationProvider = new MockIsolationProvider();
  const controller = new AbortController();

  const server = await startRuntimeServer({
    projectId,
    controlPlaneUrl: mockCp.url,
    isolationProvider,
    pollIntervalMs: 50,
    signal: controller.signal,
  });

  const port = server.port;
  assert(port > 0);

  // Trigger abort signal
  controller.abort();

  // Wait for server socket to shut down
  await waitFor(
    async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/healthz`);
        return false;
      } catch {
        return true;
      }
    },
    3000,
    50,
  );

  await mockCp.close();
});

Deno.test("FN-5: runtime server rejects request body exceeding 10MB limit with HTTP 413 PAYLOAD_TOO_LARGE", async () => {
  const projectId = "proj_test_payload_limit";
  const snapshot = createMockSnapshot();
  const mockCp = createMockControlPlane(projectId, snapshot);
  const isolationProvider = new MockIsolationProvider();

  let server: RuntimeServer | null = null;
  try {
    server = await startRuntimeServer({
      projectId,
      controlPlaneUrl: mockCp.url,
      isolationProvider,
      pollIntervalMs: 10000,
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/api/users`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(11 * 1024 * 1024),
    });

    assertEquals(res.status, 413);
    const body = await res.json();
    assertEquals(body.error.code, "PAYLOAD_TOO_LARGE");
  } finally {
    if (server) await server.close();
    await mockCp.close();
  }
});

Deno.test("Control Plane Routing: proxies /login to controlPlaneUrl when configured", async () => {
  const projectId = "proj_test_control_proxy";
  const snapshot = createMockSnapshot();
  const mockCp = createMockControlPlane(projectId, snapshot);
  const isolationProvider = new MockIsolationProvider();

  let server: RuntimeServer | null = null;
  try {
    server = await startRuntimeServer({
      projectId,
      controlPlaneUrl: mockCp.url,
      isolationProvider,
      pollIntervalMs: 10000,
    });

    const res = await fetch(
      `http://127.0.0.1:${server.port}/login?callback=http%3A%2F%2F127.0.0.1%3A4840%2Fcallback`,
    );
    assertEquals(res.status, HTTP_STATUS_OK);
    const text = await res.text();
    assertEquals(text, "<html>Login Page</html>");
  } finally {
    if (server) await server.close();
    await mockCp.close();
  }
});

Deno.test("Control Plane Routing: returns informative 404 when /login accessed without controlPlaneUrl", async () => {
  const isolationProvider = new MockIsolationProvider();

  let server: RuntimeServer | null = null;
  try {
    server = await startRuntimeServer({
      projectId: "proj_test_no_cp",
      isolationProvider,
      pollIntervalMs: 10000,
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/login`);
    assertEquals(res.status, HTTP_STATUS_NOT_FOUND);
    const data = await res.json();
    assertEquals(data.error.code, ERROR_RESOURCE_NOT_FOUND);
    assert(data.error.message.includes("Control Plane route"));
  } finally {
    if (server) await server.close();
  }
});
