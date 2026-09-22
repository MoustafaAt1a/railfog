/**
 * Tests for Fail-Static Snapshot Distribution (T-0208).
 *
 * Spec references:
 * - PLAT-1: Control plane vs data plane (strong consistency for CP, fail-static for DP; live traffic unaffected)
 * - PLAT-8: Fail-static control/data plane split (runtime nodes never call control plane synchronously
 *           on request path; background polling ~5s; serve last-known-good snapshot indefinitely)
 * - PLAT-12: Error model (UNAVAILABLE error code when control plane unreachable; deploy paused, live traffic unaffected)
 * - PLAT-14: ULID identifier format (Crockford Base32, 26 chars, snap_{ULID})
 */

import {
  assertEquals,
  assertExists,
  assertFalse,
  assertMatch,
  assertRejects,
} from "@std/assert";
import { delay } from "@std/async/delay";
import {
  type FunctionSnapshot,
  type RoutingSnapshot,
  SnapshotDistributor,
} from "../../packages/protocol/snapshot.ts";
import { RuntimeSnapshotCache } from "../../runtime/snapshot/snapshot-cache.ts";
import type { RevisionRecord } from "../../apps/api/deployment-service.ts";
import { UnavailableError } from "../../packages/errors/mod.ts";

/**
 * Helper to construct a mock RevisionRecord conforming to PLAT-3 / PLAT-18.
 */
function createMockRevision(
  functionName: string,
  revisionId: string = "rev_01J8Z000000000000000000001",
  options?: {
    permissions?: {
      kv?: string[];
      objects?: string[];
      queues?: string[];
    };
    limits?: {
      cpu_ms: number;
      timeout_ms: number;
      memory_mb: number;
    };
  },
): RevisionRecord {
  return {
    id: revisionId,
    project: "proj_01J8Z000000000000000000000",
    functionName,
    artifactId:
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    state: "Deployed",
    createdAt: Date.now(),
    manifest: {
      runtime: "railfog-deno",
      runtimeVersion: "1.0",
      entrypoint: "index.ts",
      integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
      permissions: options?.permissions ?? {
        kv: ["app:sessions"],
        objects: ["app:uploads"],
        queues: ["app:jobs"],
      },
      limits: options?.limits ?? {
        cpu_ms: 200,
        timeout_ms: 30000,
        memory_mb: 128,
      },
      dependencies: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Unit Tests — SnapshotDistributor.createSnapshot (AC1, PLAT-14, PLAT-8)
// ---------------------------------------------------------------------------

Deno.test("SnapshotDistributor - AC1: generates valid snapshotId matching /^snap_[0-9A-HJKMNP-TV-Z]{26}$/ (PLAT-14)", () => {
  const distributor = new SnapshotDistributor();
  const routes = [{ pattern: "/api/*", function: "api" }];
  const revisions = { api: createMockRevision("api") };

  const snapshot: RoutingSnapshot = distributor.createSnapshot(
    routes,
    revisions,
  );

  assertExists(snapshot.snapshotId);
  assertMatch(
    snapshot.snapshotId,
    /^snap_[0-9A-HJKMNP-TV-Z]{26}$/,
    "snapshotId must be prefixed with 'snap_' followed by a 26-char Crockford Base32 ULID per PLAT-14",
  );
});

Deno.test("SnapshotDistributor - AC1: produces versioned RoutingSnapshot with monotonically incrementing version", () => {
  const distributor = new SnapshotDistributor();
  const routes = [{ pattern: "/api/*", function: "api" }];
  const revisions = { api: createMockRevision("api") };

  const snap1 = distributor.createSnapshot(routes, revisions);
  const snap2 = distributor.createSnapshot(routes, revisions);
  const snap3 = distributor.createSnapshot(routes, revisions);

  assertEquals(typeof snap1.version, "number");
  assertEquals(snap1.version >= 1, true);
  assertEquals(snap2.version, snap1.version + 1);
  assertEquals(snap3.version, snap2.version + 1);
});

Deno.test("SnapshotDistributor - AC1: correctly maps routes and extracts FunctionSnapshot metadata from manifest", () => {
  const distributor = new SnapshotDistributor();
  const routes = [
    { pattern: "/users", function: "users" },
    { pattern: "/auth/*", function: "auth" },
  ];
  const revisions: Record<string, RevisionRecord> = {
    users: createMockRevision("users", "rev_01J8Z000000000000000000001", {
      permissions: { kv: ["users:kv"], objects: ["users:avatars"] },
      limits: { cpu_ms: 150, timeout_ms: 10000, memory_mb: 256 },
    }),
    auth: createMockRevision("auth", "rev_01J8Z000000000000000000002", {
      permissions: { queues: ["auth:events"] },
      limits: { cpu_ms: 50, timeout_ms: 5000, memory_mb: 64 },
    }),
  };

  const snapshot = distributor.createSnapshot(routes, revisions);

  // Validate routes
  assertEquals(snapshot.routes, routes);

  // Validate functions metadata typed as FunctionSnapshot
  const userFn: FunctionSnapshot = snapshot.functions["users"];
  assertExists(userFn);
  assertEquals(userFn.functionName, "users");
  assertEquals(userFn.revisionId, "rev_01J8Z000000000000000000001");
  assertEquals(userFn.artifactId, revisions["users"].artifactId);
  assertEquals(userFn.permissions.kv, ["users:kv"]);
  assertEquals(userFn.permissions.objects, ["users:avatars"]);
  assertEquals(userFn.limits.cpu_ms, 150);
  assertEquals(userFn.limits.timeout_ms, 10000);
  assertEquals(userFn.limits.memory_mb, 256);

  const authFn: FunctionSnapshot = snapshot.functions["auth"];
  assertExists(authFn);
  assertEquals(authFn.functionName, "auth");
  assertEquals(authFn.revisionId, "rev_01J8Z000000000000000000002");
  assertEquals(authFn.permissions.queues, ["auth:events"]);
  assertEquals(authFn.limits.cpu_ms, 50);
  assertEquals(authFn.limits.timeout_ms, 5000);
  assertEquals(authFn.limits.memory_mb, 64);
});

Deno.test("SnapshotDistributor - AC1: records generatedAt timestamp close to invocation time", () => {
  const distributor = new SnapshotDistributor();
  const start = Date.now();
  const snapshot = distributor.createSnapshot([], {});
  const end = Date.now();

  assertEquals(typeof snapshot.generatedAt, "number");
  assertEquals(
    snapshot.generatedAt >= start && snapshot.generatedAt <= end,
    true,
  );
});

Deno.test("SnapshotDistributor - AC1: guarantees immutability of returned RoutingSnapshot (PLAT-8)", () => {
  const distributor = new SnapshotDistributor();
  const routes = [{ pattern: "/api/*", function: "api" }];
  const revisions = { api: createMockRevision("api") };

  const snapshot = distributor.createSnapshot(routes, revisions);

  // Defensive copy test: mutating input routes or revisions does not alter snapshot
  routes.push({ pattern: "/hacked", function: "evil" });
  revisions["api"].functionName = "mutated";

  assertEquals(snapshot.routes.length, 1);
  assertEquals(snapshot.routes[0].pattern, "/api/*");
  assertEquals(snapshot.functions["api"].functionName, "api");

  // Immutability test: snapshot should be frozen
  const isFrozen = Object.isFrozen(snapshot) ||
    Object.isFrozen(snapshot.routes);
  assertEquals(
    isFrozen,
    true,
    "RoutingSnapshot should be frozen to guarantee immutability per PLAT-8",
  );
});

Deno.test("SnapshotDistributor - Unit: supports full JSON serialization and deserialization without data loss", () => {
  const distributor = new SnapshotDistributor();
  const routes = [{ pattern: "/api/*", function: "api" }];
  const revisions = { api: createMockRevision("api") };

  const snapshot = distributor.createSnapshot(routes, revisions);
  const jsonStr = JSON.stringify(snapshot);
  const parsed = JSON.parse(jsonStr) as RoutingSnapshot;

  assertEquals(parsed.snapshotId, snapshot.snapshotId);
  assertEquals(parsed.version, snapshot.version);
  assertEquals(parsed.routes, snapshot.routes);
  assertEquals(
    parsed.functions,
    JSON.parse(JSON.stringify(snapshot.functions)),
  );
  assertEquals(parsed.generatedAt, snapshot.generatedAt);
});

Deno.test("SnapshotDistributor - Unit: handles empty routes and revisions gracefully", () => {
  const distributor = new SnapshotDistributor();
  const snapshot = distributor.createSnapshot([], {});

  assertExists(snapshot.snapshotId);
  assertEquals(snapshot.routes, []);
  assertEquals(snapshot.functions, {});
  assertEquals(typeof snapshot.version, "number");
});

// ---------------------------------------------------------------------------
// Suite 2: Unit Tests — RuntimeSnapshotCache Synchronous Access & Version Ordering (AC2, PLAT-8)
// ---------------------------------------------------------------------------

Deno.test("RuntimeSnapshotCache - AC2: getLatestSnapshot() returns null before initial load", () => {
  const cache = new RuntimeSnapshotCache(() =>
    Promise.reject(new Error("Should not be called"))
  );

  const snapshot = cache.getLatestSnapshot();
  assertEquals(snapshot, null);
});

Deno.test("RuntimeSnapshotCache - AC2 & Security: getLatestSnapshot() is strictly synchronous and returns RoutingSnapshot without returning Promise (PLAT-8)", async () => {
  const distributor = new SnapshotDistributor();
  const snap = distributor.createSnapshot(
    [{ pattern: "/ping", function: "ping" }],
    { ping: createMockRevision("ping") },
  );

  const cache = new RuntimeSnapshotCache(() => Promise.resolve(snap));
  await cache.forceRefresh();

  // Call getLatestSnapshot() on synchronous data-plane path
  const result = cache.getLatestSnapshot();

  assertExists(result);
  assertEquals(result.snapshotId, snap.snapshotId);
  assertEquals(result.version, snap.version);

  // Strict check: must NOT return a Promise or Thenable
  assertFalse(
    result instanceof Promise,
    "getLatestSnapshot() must be strictly synchronous and never return a Promise (PLAT-8)",
  );
  assertFalse(
    typeof (result as unknown as Record<string, unknown>).then === "function",
    "getLatestSnapshot() must never return a thenable (PLAT-8)",
  );
});

Deno.test("RuntimeSnapshotCache - Unit: version ordering ignores stale or older snapshots", async () => {
  const distributor = new SnapshotDistributor();
  const snap1 = distributor.createSnapshot(
    [{ pattern: "/v1", function: "v1" }],
    { v1: createMockRevision("v1") },
  );
  const snap2 = distributor.createSnapshot(
    [{ pattern: "/v2", function: "v2" }],
    { v2: createMockRevision("v2") },
  );
  // snap2.version > snap1.version

  let currentSnapshot = snap2;
  const cache = new RuntimeSnapshotCache(() =>
    Promise.resolve(currentSnapshot)
  );
  await cache.forceRefresh();
  assertEquals(cache.getLatestSnapshot()?.version, snap2.version);

  // Control plane returns an older snapshot (out of order delivery or stale read)
  currentSnapshot = snap1;
  try {
    await cache.forceRefresh();
  } catch {
    // May reject stale version
  }

  // Cache must retain higher version
  assertEquals(
    cache.getLatestSnapshot()?.version,
    snap2.version,
    "Cache must retain the highest version and not regress to older versions",
  );
});

// ---------------------------------------------------------------------------
// Suite 3: Integration Tests — Fail-Static Guarantee & Recovery (AC3, AC4, AC5, PLAT-8, PLAT-12)
// ---------------------------------------------------------------------------

Deno.test("RuntimeSnapshotCache - AC3: background polling catches errors gracefully and continues serving last-known-good snapshot indefinitely (PLAT-8)", async () => {
  const distributor = new SnapshotDistributor();
  const snap1 = distributor.createSnapshot(
    [{ pattern: "/api/*", function: "api" }],
    { api: createMockRevision("api") },
  );

  let shouldFail = false;
  let fetchAttempts = 0;
  const fetcher = (): Promise<RoutingSnapshot> => {
    fetchAttempts++;
    if (shouldFail) {
      return Promise.reject(
        new Error("Control plane unreachable: connection refused"),
      );
    }
    return Promise.resolve(snap1);
  };

  const cache = new RuntimeSnapshotCache(fetcher, { pollIntervalMs: 25 });
  try {
    // Seed the cache
    await cache.forceRefresh();
    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap1.snapshotId);

    // Simulate control plane failure
    shouldFail = true;
    cache.start();

    // Wait for at least 3-4 background poll cycles (real time elapsed, ANTIHALLUCINATION Rule 5)
    await delay(100);

    // Verify polling continued without throwing unhandled rejection, and snapshot is still served
    const served = cache.getLatestSnapshot();
    assertExists(served);
    assertEquals(served.snapshotId, snap1.snapshotId);
    assertEquals(served.version, snap1.version);
    assertEquals(
      fetchAttempts > 2,
      true,
      "Background polling should have attempted multiple fetches during the outage",
    );
  } finally {
    cache.stop();
  }
});

Deno.test("RuntimeSnapshotCache - AC4: background polling updates cache when control plane recovers with newer snapshot", async () => {
  const distributor = new SnapshotDistributor();
  const snap1 = distributor.createSnapshot(
    [{ pattern: "/api/*", function: "api" }],
    { api: createMockRevision("api", "rev_01J8Z000000000000000000001") },
  );
  const snap2 = distributor.createSnapshot(
    [
      { pattern: "/api/*", function: "api" },
      { pattern: "/health", function: "health" },
    ],
    {
      api: createMockRevision("api", "rev_01J8Z000000000000000000001"),
      health: createMockRevision("health", "rev_01J8Z000000000000000000002"),
    },
  );

  let currentSnapshot: RoutingSnapshot = snap1;
  let isDown = false;

  const fetcher = (): Promise<RoutingSnapshot> => {
    if (isDown) {
      return Promise.reject(new Error("Control plane 503 Service Unavailable"));
    }
    return Promise.resolve(currentSnapshot);
  };

  const cache = new RuntimeSnapshotCache(fetcher, { pollIntervalMs: 25 });
  try {
    await cache.forceRefresh();
    assertEquals(cache.getLatestSnapshot()?.version, snap1.version);

    // Control plane goes down
    isDown = true;
    cache.start();
    await delay(60);
    assertEquals(cache.getLatestSnapshot()?.version, snap1.version);

    // Control plane recovers with newer snapshot
    currentSnapshot = snap2;
    isDown = false;

    // Wait for background poll to pick it up
    await delay(75);

    const updated = cache.getLatestSnapshot();
    assertExists(updated);
    assertEquals(updated.snapshotId, snap2.snapshotId);
    assertEquals(updated.version, snap2.version);
    assertEquals(updated.routes.length, 2);
    assertExists(updated.functions["health"]);
  } finally {
    cache.stop();
  }
});

Deno.test("RuntimeSnapshotCache - AC5: forceRefresh() immediately fetches; preserves last-known-good snapshot on failure", async () => {
  const distributor = new SnapshotDistributor();
  const snap1 = distributor.createSnapshot(
    [{ pattern: "/api/*", function: "api" }],
    { api: createMockRevision("api") },
  );
  const snap2 = distributor.createSnapshot(
    [{ pattern: "/v2/*", function: "v2" }],
    { v2: createMockRevision("v2") },
  );

  let currentSnap = snap1;
  let shouldFail = false;

  const fetcher = (): Promise<RoutingSnapshot> => {
    if (shouldFail) {
      return Promise.reject(new Error("Network timeout during forceRefresh"));
    }
    return Promise.resolve(currentSnap);
  };

  const cache = new RuntimeSnapshotCache(fetcher, { pollIntervalMs: 10000 });
  try {
    // Initial fetch
    await cache.forceRefresh();
    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap1.snapshotId);

    // Immediate update to snap2
    currentSnap = snap2;
    await cache.forceRefresh();
    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap2.snapshotId);

    // Subsequent failure preserves previous last-known-good snapshot
    shouldFail = true;
    try {
      await cache.forceRefresh();
    } catch {
      // Allowed to throw or swallow, but cached snapshot must survive
    }

    const preserved = cache.getLatestSnapshot();
    assertExists(preserved);
    assertEquals(preserved.snapshotId, snap2.snapshotId);
    assertEquals(preserved.version, snap2.version);
  } finally {
    cache.stop();
  }
});

Deno.test("RuntimeSnapshotCache - AC6: stop() halts background polling timer cleanly and is idempotent", async () => {
  const distributor = new SnapshotDistributor();
  const snap1 = distributor.createSnapshot(
    [{ pattern: "/api/*", function: "api" }],
    { api: createMockRevision("api") },
  );
  const snap2 = distributor.createSnapshot(
    [{ pattern: "/v2/*", function: "v2" }],
    { v2: createMockRevision("v2") },
  );

  let currentSnap = snap1;
  let fetchCount = 0;
  const fetcher = (): Promise<RoutingSnapshot> => {
    fetchCount++;
    return Promise.resolve(currentSnap);
  };

  const cache = new RuntimeSnapshotCache(fetcher, { pollIntervalMs: 25 });
  await cache.forceRefresh();
  const initialCount = fetchCount;

  cache.start();
  await delay(60);
  const runningCount = fetchCount;
  assertEquals(runningCount > initialCount, true);

  // Stop the polling
  cache.stop();
  const countAfterStop = fetchCount;

  // Change snapshot on control plane
  currentSnap = snap2;

  // Wait additional time to verify no more polls occur
  await delay(80);

  assertEquals(
    fetchCount,
    countAfterStop,
    "Polling should not trigger after stop()",
  );
  assertEquals(cache.getLatestSnapshot()?.snapshotId, snap1.snapshotId);

  // Idempotent stop - multiple calls should not throw or error
  cache.stop();
  cache.stop();
});

Deno.test("RuntimeSnapshotCache - PLAT-12: unreachable control plane is typed as UNAVAILABLE while data plane continues serving", async () => {
  const distributor = new SnapshotDistributor();
  const snap = distributor.createSnapshot(
    [{ pattern: "/status", function: "status" }],
    { status: createMockRevision("status") },
  );

  let cpAvailable = true;
  const controlPlaneClient = {
    deployNewRevision(): Promise<void> {
      if (!cpAvailable) {
        return Promise.reject(
          new UnavailableError("Control plane unreachable: deployment paused"),
        );
      }
      return Promise.resolve();
    },
    fetchSnapshot(): Promise<RoutingSnapshot> {
      if (!cpAvailable) {
        return Promise.reject(
          new UnavailableError("Control plane unreachable"),
        );
      }
      return Promise.resolve(snap);
    },
  };

  const cache = new RuntimeSnapshotCache(
    () => controlPlaneClient.fetchSnapshot(),
    { pollIntervalMs: 25 },
  );

  try {
    await cache.forceRefresh();
    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap.snapshotId);

    // Control plane goes down
    cpAvailable = false;
    cache.start();

    // Deploy attempt to control plane fails with UNAVAILABLE error per PLAT-12
    const deployError = await assertRejects(
      () => controlPlaneClient.deployNewRevision(),
      UnavailableError,
    );
    assertEquals(deployError.code, "UNAVAILABLE");

    // Wait for background poll to hit the UNAVAILABLE error
    await delay(60);

    // Live traffic data plane request continues without downtime per PLAT-1 / PLAT-8
    const liveSnapshot = cache.getLatestSnapshot();
    assertExists(liveSnapshot);
    assertEquals(liveSnapshot.snapshotId, snap.snapshotId);
  } finally {
    cache.stop();
  }
});

// ---------------------------------------------------------------------------
// Suite 4: Security Tests — Synchronous Zero-Network-Call Guarantee (PLAT-8)
// ---------------------------------------------------------------------------

Deno.test("RuntimeSnapshotCache - Security: zero network/fetch calls are invoked during request path getLatestSnapshot() (PLAT-8)", async () => {
  const distributor = new SnapshotDistributor();
  const snap = distributor.createSnapshot(
    [{ pattern: "/fast", function: "fast" }],
    { fast: createMockRevision("fast") },
  );

  let networkCalls = 0;
  const fetcher = async (): Promise<RoutingSnapshot> => {
    networkCalls++;
    await delay(10); // Simulated network latency
    return snap;
  };

  const cache = new RuntimeSnapshotCache(fetcher);
  await cache.forceRefresh();
  assertEquals(networkCalls, 1);

  // Request path: simulate high throughput requests calling getLatestSnapshot()
  const start = performance.now();
  for (let i = 0; i < 5000; i++) {
    const result = cache.getLatestSnapshot();
    assertFalse(
      result instanceof Promise,
      "getLatestSnapshot returned a Promise!",
    );
    assertFalse(
      result !== null &&
        typeof (result as unknown as Record<string, unknown>).then ===
          "function",
      "getLatestSnapshot returned a thenable!",
    );
    assertEquals(result?.snapshotId, snap.snapshotId);
  }
  const elapsed = performance.now() - start;

  // Zero network calls during 5000 request routing evaluations
  assertEquals(
    networkCalls,
    1,
    "No network calls may be made during getLatestSnapshot()",
  );
  // 5000 in-memory synchronous reads must complete quickly (< 100ms)
  assertEquals(
    elapsed < 100,
    true,
    `Expected synchronous reads < 100ms, took ${elapsed}ms`,
  );
});

Deno.test("RuntimeSnapshotCache - Security: cached snapshot is tamper-resistant against data-plane in-place mutation", async () => {
  const distributor = new SnapshotDistributor();
  const snap = distributor.createSnapshot(
    [{ pattern: "/api", function: "api" }],
    {
      api: createMockRevision("api", "rev_01J8Z000000000000000000001", {
        permissions: { kv: ["app:sessions"] },
      }),
    },
  );

  const cache = new RuntimeSnapshotCache(() => Promise.resolve(snap));
  await cache.forceRefresh();

  const retrieved1 = cache.getLatestSnapshot();
  assertExists(retrieved1);

  // Attempt malicious in-place mutation from data-plane handler
  try {
    (retrieved1 as unknown as Record<string, unknown>).version = 999;
    retrieved1.routes.push({ pattern: "/unauthorized", function: "admin" });
    retrieved1.functions["api"].permissions.kv?.push("secrets:*");
  } catch {
    // Expected if frozen
  }

  const retrieved2 = cache.getLatestSnapshot();
  assertExists(retrieved2);
  assertEquals(retrieved2.version, snap.version);
  assertEquals(retrieved2.routes.length, 1);
  assertEquals(retrieved2.functions["api"].permissions.kv, ["app:sessions"]);
});
