/**
 * Standalone Runtime Data Plane Daemon Adversarial Security Tests (T-0606).
 *
 * Spec references:
 * - PLAT-1: Control plane vs data plane separation (no control endpoints served, no credential leaks).
 * - PLAT-4: Isolation & defense in depth (IsolationProvider execution boundary).
 * - PLAT-8: Fail-static snapshot integrity, version monotonicity, outage resilience.
 * - PLAT-11: Routing specificity algorithm & route injection resistance.
 * - PLAT-12: Canonical error model (all errors formatted as { error: { code, message, request_id } }).
 * - PLAT-14: Crockford Base32 ULID request_id uniqueness & preservation.
 * - FN-1: Request body extraction & isolation.
 * - FN-6: Isolation & warm-reuse rule (zero header/body bleeding across warm invocations).
 */

import { assert, assertEquals, assertExists, assertMatch } from "@std/assert";
import { join } from "@std/path";
import type { RuntimeServer } from "../../apps/runtime/runtime-server.ts";
import { startRuntimeServer } from "../../apps/runtime/runtime-server.ts";
import type {
  ExecutionResult,
  IsolationProvider,
} from "../../primitives/compute/compute-provider.ts";
import { isValidUlid } from "../../packages/core/id/ulid.ts";
import type { RoutingSnapshot } from "../../packages/protocol/snapshot.ts";

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function createTestSnapshot(version = 1): RoutingSnapshot {
  return {
    snapshotId: `snap_01HZX00000000000000000000${version}`,
    version,
    routes: [
      { pattern: "/api/users", function: "users" },
      { pattern: "/api/wild/*", function: "wildcard" },
    ],
    functions: {
      users: {
        functionName: "users",
        revisionId: "rev_01HZX000000000000000000001",
        artifactId: "sha256:users-artifact",
        permissions: { kv: ["app:users"] },
        limits: { cpu_ms: 200, timeout_ms: 30000, memory_mb: 128 },
      },
      wildcard: {
        functionName: "wildcard",
        revisionId: "rev_01HZX000000000000000000002",
        artifactId: "sha256:wildcard-artifact",
        permissions: {},
        limits: { cpu_ms: 200, timeout_ms: 30000, memory_mb: 128 },
      },
    },
    generatedAt: Date.now(),
  };
}

function createDummyExecutionResult(payload = {}): ExecutionResult {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(payload)),
    cpuTimeMs: 1,
    wallClockMs: 1,
  };
}

// ============================================================================
// Checklist 1: Warm Isolate State Bleeding & Context Injection (FN-6, PLAT-4)
// ============================================================================

Deno.test("Attack 1a: Mutated headers in warm isolate never bleed to subsequent invocations", async () => {
  let invocationCount = 0;
  const capturedHeaders: Array<Record<string, string>> = [];

  const mockIsolation: IsolationProvider = {
    run: (_artifact, _limits, invocation) => {
      invocationCount++;
      assertExists(invocation);
      capturedHeaders.push({ ...(invocation.headers ?? {}) });

      // Simulate malicious isolate handler attempting to pollute / mutate invocation headers
      if (invocation.headers) {
        invocation.headers["injected-secret"] = "LEAKED_TENANT_SECRET";
        invocation.headers["authorization"] = "Bearer stolen-token";
      }

      return Promise.resolve(createDummyExecutionResult({ ok: true }));
    },
  };

  const snapshot = createTestSnapshot(1);
  const tempDir = await Deno.makeTempDir();
  const cachePath = join(tempDir, "snap.json");
  await Deno.writeTextFile(cachePath, JSON.stringify(snapshot));

  let server: RuntimeServer | null = null;
  try {
    server = await startRuntimeServer({
      projectId: "proj_test_attack1a",
      snapshotDiskCachePath: cachePath,
      isolationProvider: mockIsolation,
    });

    // Request 1: sends tenant A auth
    await fetch(`http://127.0.0.1:${server.port}/api/users`, {
      headers: {
        "authorization": "Bearer tenant-a-token",
        "x-tenant-id": "tenant-a",
      },
    });

    // Request 2: sends tenant B auth
    await fetch(`http://127.0.0.1:${server.port}/api/users`, {
      headers: {
        "authorization": "Bearer tenant-b-token",
        "x-tenant-id": "tenant-b",
      },
    });

    // Request 3: sends unauthenticated request
    await fetch(`http://127.0.0.1:${server.port}/api/users`);

    assertEquals(invocationCount, 3);

    // Verify Request 1 received tenant A
    assertEquals(capturedHeaders[0]["authorization"], "Bearer tenant-a-token");
    assertEquals(capturedHeaders[0]["x-tenant-id"], "tenant-a");
    assertEquals(capturedHeaders[0]["injected-secret"], undefined);

    // Verify Request 2 received tenant B without tenant A's or isolate's injected secrets
    assertEquals(capturedHeaders[1]["authorization"], "Bearer tenant-b-token");
    assertEquals(capturedHeaders[1]["x-tenant-id"], "tenant-b");
    assertEquals(capturedHeaders[1]["injected-secret"], undefined);

    // Verify Request 3 received no authorization header (zero bleeding from req 1, 2 or isolate)
    assertEquals(capturedHeaders[2]["authorization"], undefined);
    assertEquals(capturedHeaders[2]["x-tenant-id"], undefined);
    assertEquals(capturedHeaders[2]["injected-secret"], undefined);
  } finally {
    if (server) await server.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Attack 1b: Request body buffer mutation does not bleed across warm invocations", async () => {
  const capturedBodies: Uint8Array[] = [];

  const mockIsolation: IsolationProvider = {
    run: (_artifact, _limits, invocation) => {
      assertExists(invocation);
      if (invocation.body) {
        capturedBodies.push(new Uint8Array(invocation.body));
        // Adversarially mutate the buffer in place
        invocation.body.fill(0xff);
      }

      return Promise.resolve(createDummyExecutionResult());
    },
  };

  const snapshot = createTestSnapshot(1);
  const tempDir = await Deno.makeTempDir();
  const cachePath = join(tempDir, "snap.json");
  await Deno.writeTextFile(cachePath, JSON.stringify(snapshot));

  let server: RuntimeServer | null = null;
  try {
    server = await startRuntimeServer({
      projectId: "proj_test_attack1b",
      snapshotDiskCachePath: cachePath,
      isolationProvider: mockIsolation,
    });

    const body1 = new TextEncoder().encode("Hello from Tenant 1");
    await fetch(`http://127.0.0.1:${server.port}/api/users`, {
      method: "POST",
      body: body1,
    });

    const body2 = new TextEncoder().encode("Hello from Tenant 2");
    await fetch(`http://127.0.0.1:${server.port}/api/users`, {
      method: "POST",
      body: body2,
    });

    assertEquals(capturedBodies.length, 2);
    assertEquals(
      new TextDecoder().decode(capturedBodies[0]),
      "Hello from Tenant 1",
    );
    assertEquals(
      new TextDecoder().decode(capturedBodies[1]),
      "Hello from Tenant 2",
    );
  } finally {
    if (server) await server.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Attack 1c: Distinct Crockford Base32 ULID request_ids assigned to consecutive requests", async () => {
  const requestIds: string[] = [];

  const mockIsolation: IsolationProvider = {
    run: (_artifact, _limits, invocation) => {
      assertExists(invocation);
      requestIds.push(invocation.requestId);
      return Promise.resolve(createDummyExecutionResult());
    },
  };

  const snapshot = createTestSnapshot(1);
  const tempDir = await Deno.makeTempDir();
  const cachePath = join(tempDir, "snap.json");
  await Deno.writeTextFile(cachePath, JSON.stringify(snapshot));

  let server: RuntimeServer | null = null;
  try {
    server = await startRuntimeServer({
      projectId: "proj_test_attack1c",
      snapshotDiskCachePath: cachePath,
      isolationProvider: mockIsolation,
    });

    for (let i = 0; i < 10; i++) {
      const res: Response = await fetch(
        `http://127.0.0.1:${server.port}/api/users`,
      );
      const headerReqId = res.headers.get("x-request-id");
      assertExists(headerReqId);
      assert(isValidUlid(headerReqId));
      assertMatch(headerReqId, ULID_REGEX);
    }

    assertEquals(requestIds.length, 10);
    // All must be unique
    const uniqueIds = new Set(requestIds);
    assertEquals(uniqueIds.size, 10);
  } finally {
    if (server) await server.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Checklist 2: Route Injection & Path Traversal (PLAT-11, PLAT-1)
// ============================================================================

Deno.test("Attack 2a: Path traversal attempts cannot access files or bypass router", async () => {
  const snapshot = createTestSnapshot(1);
  const tempDir = await Deno.makeTempDir();
  const cachePath = join(tempDir, "snap.json");
  await Deno.writeTextFile(cachePath, JSON.stringify(snapshot));

  let server: RuntimeServer | null = null;
  try {
    server = await startRuntimeServer({
      projectId: "proj_test_attack2a",
      snapshotDiskCachePath: cachePath,
      isolationProvider: {
        run: () => Promise.resolve(createDummyExecutionResult()),
      },
    });

    const traversalPaths = [
      "/../etc/passwd",
      "/../../control",
      "//v1/..",
      "/api/users/../../../etc/shadow",
      "/%2e%2e/%2e%2e/control",
      "/v1/projects/myproj/snapshot",
      "/admin",
    ];

    for (const p of traversalPaths) {
      const res: Response = await fetch(`http://127.0.0.1:${server.port}${p}`);
      assertEquals(
        res.status,
        404,
        `Expected 404 for path ${p}, got ${res.status}`,
      );
      assertEquals(res.headers.get("content-type"), "application/json");

      const body: { error: { code: string; request_id: string } } = await res
        .json();
      assertEquals(body.error.code, "RESOURCE_NOT_FOUND");
      assertExists(body.error.request_id);
      assert(isValidUlid(body.error.request_id));
    }
  } finally {
    if (server) await server.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Attack 2b: Runtime server does not serve control plane endpoints or leak credentials", async () => {
  const snapshot = createTestSnapshot(1);
  const tempDir = await Deno.makeTempDir();
  const cachePath = join(tempDir, "snap.json");
  await Deno.writeTextFile(cachePath, JSON.stringify(snapshot));

  let server: RuntimeServer | null = null;
  try {
    server = await startRuntimeServer({
      projectId: "proj_test_attack2b",
      snapshotDiskCachePath: cachePath,
      isolationProvider: {
        run: () => Promise.resolve(createDummyExecutionResult()),
      },
    });

    const resHealthz = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assertEquals(resHealthz.status, 200);
    const healthzBody = await resHealthz.json();

    // Verify no secret or internal config is leaked in healthz
    assertEquals(Object.keys(healthzBody).sort(), [
      "request_id",
      "service",
      "snapshotVersion",
      "status",
    ]);

    // Verify control plane snapshot route is not exposed by data plane
    const resCpSnapshot = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/proj_test_attack2b/snapshot`,
    );
    assertEquals(resCpSnapshot.status, 404);
  } finally {
    if (server) await server.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Attack 2c: Snapshot route pointing to prototype property (toString) returns canonical 404, not unhandled crash", async () => {
  const snapshotWithProtoRoute: RoutingSnapshot = {
    snapshotId: "snap_01HZX000000000000000000099",
    version: 1,
    routes: [
      { pattern: "/api/proto-test", function: "toString" },
      { pattern: "/api/proto-test2", function: "valueOf" },
      { pattern: "/api/proto-test3", function: "hasOwnProperty" },
      { pattern: "/api/proto-test4", function: "constructor" },
    ],
    functions: {}, // empty functions map!
    generatedAt: Date.now(),
  };

  const tempDir = await Deno.makeTempDir();
  const cachePath = join(tempDir, "snap.json");
  await Deno.writeTextFile(cachePath, JSON.stringify(snapshotWithProtoRoute));

  let server: RuntimeServer | null = null;
  try {
    server = await startRuntimeServer({
      projectId: "proj_test_attack2c",
      snapshotDiskCachePath: cachePath,
      isolationProvider: {
        run: () => Promise.resolve(createDummyExecutionResult()),
      },
    });

    for (
      const p of [
        "/api/proto-test",
        "/api/proto-test2",
        "/api/proto-test3",
        "/api/proto-test4",
      ]
    ) {
      const res: Response = await fetch(`http://127.0.0.1:${server.port}${p}`);
      assertEquals(
        res.status,
        404,
        `Expected 404 RESOURCE_NOT_FOUND for ${p}, got ${res.status}`,
      );
      const body: { error: { code: string; request_id: string } } = await res
        .json();
      assertEquals(body.error.code, "RESOURCE_NOT_FOUND");
      assertExists(body.error.request_id);
    }
  } finally {
    if (server) await server.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Checklist 3: Fail-Static Snapshot Integrity & Tampering (PLAT-8)
// ============================================================================

Deno.test("Attack 3a: Version downgrade replay is rejected by runtime server", async () => {
  const snapshotV2 = createTestSnapshot(2);
  const tempDir = await Deno.makeTempDir();
  const cachePath = join(tempDir, "snap.json");
  await Deno.writeTextFile(cachePath, JSON.stringify(snapshotV2));

  // Mock control plane returning an older snapshot (version 1)
  const snapshotV1 = createTestSnapshot(1);
  let pollCount = 0;
  const mockCpServer = Deno.serve({ port: 0, onListen: () => {} }, () => {
    pollCount++;
    return new Response(JSON.stringify(snapshotV1), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const cpPort = (mockCpServer.addr as Deno.NetAddr).port;

  let server: RuntimeServer | null = null;
  try {
    server = await startRuntimeServer({
      projectId: "proj_test_attack3a",
      controlPlaneUrl: `http://127.0.0.1:${cpPort}`,
      snapshotDiskCachePath: cachePath,
      isolationProvider: {
        run: () => Promise.resolve(createDummyExecutionResult()),
      },
      pollIntervalMs: 50,
    });

    // Server must NOT downgrade to version 1
    assertEquals(server.getSnapshotVersion(), 2);

    // Wait for at least 2 background polls of version 1
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Server must still be at version 2
    assertEquals(
      server.getSnapshotVersion(),
      2,
      "Server snapshot version must be monotonic and refuse downgrade to v1",
    );

    // Disk cache must not have been overwritten with version 1
    const cachedDisk = JSON.parse(await Deno.readTextFile(cachePath));
    assertEquals(
      cachedDisk.version,
      2,
      "Disk cache must not be overwritten with downgraded version",
    );
  } finally {
    if (server) await server.close();
    await mockCpServer.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Attack 3b: Identical version number does not overwrite active snapshot", async () => {
  const snapshotV2 = createTestSnapshot(2);
  const tempDir = await Deno.makeTempDir();
  const cachePath = join(tempDir, "snap.json");
  await Deno.writeTextFile(cachePath, JSON.stringify(snapshotV2));

  // Mock control plane returning same version 2 but with tampered routes
  const tamperedV2 = {
    ...createTestSnapshot(2),
    routes: [{ pattern: "/api/tampered", function: "users" }],
  };

  const mockCpServer = Deno.serve({ port: 0, onListen: () => {} }, () => {
    return new Response(JSON.stringify(tamperedV2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const cpPort = (mockCpServer.addr as Deno.NetAddr).port;

  let server: RuntimeServer | null = null;
  try {
    server = await startRuntimeServer({
      projectId: "proj_test_attack3b",
      controlPlaneUrl: `http://127.0.0.1:${cpPort}`,
      snapshotDiskCachePath: cachePath,
      isolationProvider: {
        run: () => Promise.resolve(createDummyExecutionResult()),
      },
      pollIntervalMs: 50,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    // Original routes must still be active
    const resOrig = await fetch(`http://127.0.0.1:${server.port}/api/users`);
    assertEquals(resOrig.status, 200);

    // Tampered route with identical version must NOT have overwritten active routes
    const resTampered = await fetch(
      `http://127.0.0.1:${server.port}/api/tampered`,
    );
    assertEquals(
      resTampered.status,
      404,
      "Identical version number must not overwrite active snapshot routes",
    );
  } finally {
    if (server) await server.close();
    await mockCpServer.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Attack 3c: Ingestion of corrupted/malformed snapshots does not crash daemon or corrupt disk cache", async () => {
  const snapshotV1 = createTestSnapshot(1);
  const tempDir = await Deno.makeTempDir();
  const cachePath = join(tempDir, "snap.json");
  await Deno.writeTextFile(cachePath, JSON.stringify(snapshotV1));

  let responsePayload = "NOT_JSON{{{";

  const mockCpServer = Deno.serve({ port: 0, onListen: () => {} }, () => {
    return new Response(responsePayload, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const cpPort = (mockCpServer.addr as Deno.NetAddr).port;

  let server: RuntimeServer | null = null;
  try {
    server = await startRuntimeServer({
      projectId: "proj_test_attack3c",
      controlPlaneUrl: `http://127.0.0.1:${cpPort}`,
      snapshotDiskCachePath: cachePath,
      isolationProvider: {
        run: () => Promise.resolve(createDummyExecutionResult()),
      },
      pollIntervalMs: 50,
    });

    // 1. Non-JSON response
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(server.getSnapshotVersion(), 1);
    const res1 = await fetch(`http://127.0.0.1:${server.port}/api/users`);
    assertEquals(res1.status, 200);

    // 2. Schema-violating response (missing required snapshotId and functions)
    responsePayload = JSON.stringify({
      version: 999,
      routes: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(server.getSnapshotVersion(), 1);
    const res2 = await fetch(`http://127.0.0.1:${server.port}/api/users`);
    assertEquals(res2.status, 200);

    // Disk cache still intact at version 1
    const diskContent = JSON.parse(await Deno.readTextFile(cachePath));
    assertEquals(diskContent.version, 1);
  } finally {
    if (server) await server.close();
    await mockCpServer.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});
