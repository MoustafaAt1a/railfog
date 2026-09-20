/**
 * Adversarial Security Tests for Snapshot Protocol & Cache (T-0208).
 *
 * Spec references:
 * - PLAT-1: Control plane / data plane separation (fail-static data plane, zero synchronous calls)
 * - PLAT-8: Fail-static guarantee & Audit Finding #7
 *           (Synchronous request routing, serve last-known-good snapshot indefinitely)
 * - PLAT-12: UNAVAILABLE error model during control plane outage
 * - PLAT-14: Identifier format (snap_{ULID})
 *
 * Attack checklist:
 * 1. PLAT-8 / Audit Finding #7: getLatestSnapshot() synchronous zero-network and non-blocking guarantee.
 * 2. Outage & Degradation: Behavior when fetchSnapshot hangs, throws, 503s, or returns corrupt data.
 * 3. Tampering & Immutability: In-place mutation of routes, permissions, and limits from data-plane code.
 * 4. Version Downgrade & Monotonicity: Injection of stale, equal, or malformed version numbers.
 */

import {
  assertEquals,
  assertExists,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { delay } from "@std/async/delay";
import type { RoutingSnapshot } from "../../packages/protocol/snapshot.ts";
import { RuntimeSnapshotCache } from "../../runtime/snapshot/snapshot-cache.ts";
import {
  UnavailableError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

function createValidSnapshot(version: number = 1): RoutingSnapshot {
  return {
    snapshotId: "snap_01J8Z000000000000000000001",
    version,
    routes: [
      { pattern: "/api/v1/users", function: "users" },
      { pattern: "/api/v1/billing", function: "billing" },
    ],
    functions: {
      users: {
        functionName: "users",
        revisionId: "rev_01J8Z000000000000000000001",
        artifactId:
          "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        permissions: {
          kv: ["app:users"],
          objects: ["app:avatars"],
        },
        limits: {
          cpu_ms: 100,
          timeout_ms: 5000,
          memory_mb: 128,
        },
      },
      billing: {
        functionName: "billing",
        revisionId: "rev_01J8Z000000000000000000002",
        artifactId:
          "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        permissions: {
          kv: ["app:billing"],
          queues: ["app:invoices"],
        },
        limits: {
          cpu_ms: 200,
          timeout_ms: 10000,
          memory_mb: 256,
        },
      },
    },
    generatedAt: Date.now(),
  };
}

// ============================================================================
// Attack 1: Request-Path Synchronous Separation & Non-Blocking (PLAT-8)
// ============================================================================

Deno.test("Adversarial PLAT-8: getLatestSnapshot() makes zero network calls and executes in microsecond latency", async () => {
  const baseSnap = createValidSnapshot(1);
  let networkCalls = 0;

  const fetcher = async (): Promise<RoutingSnapshot> => {
    networkCalls++;
    await delay(10);
    return baseSnap;
  };

  const cache = new RuntimeSnapshotCache(fetcher);
  await cache.forceRefresh();
  assertEquals(networkCalls, 1);

  // High-throughput data plane simulation: 10,000 calls
  const start = performance.now();
  for (let i = 0; i < 10000; i++) {
    const snap = cache.getLatestSnapshot();
    assertExists(snap);
    assertFalse(snap instanceof Promise);
  }
  const totalElapsedMs = performance.now() - start;
  const avgUs = (totalElapsedMs / 10000) * 1000;

  assertEquals(
    networkCalls,
    1,
    "Zero network calls permitted during getLatestSnapshot()",
  );
  // Average access should be < 10 microseconds
  assertEquals(
    avgUs < 10,
    true,
    `Expected <10us average latency, got ${avgUs}us`,
  );
});

Deno.test("Adversarial PLAT-8: Hanging fetcher does not block getLatestSnapshot() or fail-static serving", async () => {
  const baseSnap = createValidSnapshot(1);
  let isHanging = false;

  const hangingFetcher = (): Promise<RoutingSnapshot> => {
    if (isHanging) {
      return new Promise<RoutingSnapshot>(() => {}); // Never resolves
    }
    return Promise.resolve(baseSnap);
  };

  const cache = new RuntimeSnapshotCache(hangingFetcher, {
    pollIntervalMs: 20,
  });
  await cache.forceRefresh();
  assertEquals(cache.getLatestSnapshot()?.version, 1);

  // Induce network hang on control plane
  isHanging = true;
  cache.start();

  try {
    await delay(60); // 3 poll cycles while hanging

    // Data plane request path must still be immediate and serve last-known-good
    const snap = cache.getLatestSnapshot();
    assertExists(snap);
    assertEquals(snap.version, 1);
    assertEquals(snap.routes.length, 2);
  } finally {
    cache.stop();
  }
});

// ============================================================================
// Attack 2: Outage, 503 UNAVAILABLE, and Corrupt Payload Injection (PLAT-8, PLAT-12)
// ============================================================================

Deno.test("Adversarial PLAT-8/12: Control plane 503 UNAVAILABLE preserves last-known-good snapshot indefinitely", async () => {
  const baseSnap = createValidSnapshot(1);
  let failWith503 = false;

  const fetcher = (): Promise<RoutingSnapshot> => {
    if (failWith503) {
      return Promise.reject(new UnavailableError("503 Control Plane Down"));
    }
    return Promise.resolve(baseSnap);
  };

  const cache = new RuntimeSnapshotCache(fetcher, { pollIntervalMs: 25 });
  await cache.forceRefresh();

  failWith503 = true;
  cache.start();

  try {
    await delay(100);
    const snap = cache.getLatestSnapshot();
    assertExists(snap);
    assertEquals(snap.snapshotId, baseSnap.snapshotId);
  } finally {
    cache.stop();
  }
});

Deno.test("Attack PLAT-8: Corrupt snapshot with higher version throws and does NOT overwrite last-known-good snapshot", async () => {
  const baseSnap = createValidSnapshot(1);
  let currentSnap: unknown = baseSnap;

  const fetcher = (): Promise<RoutingSnapshot> => {
    return Promise.resolve(currentSnap as RoutingSnapshot);
  };

  const cache = new RuntimeSnapshotCache(fetcher);
  await cache.forceRefresh();
  assertEquals(cache.getLatestSnapshot()?.routes.length, 2);

  // Corrupted response from degraded control plane: higher version, but missing routes/functions
  const corruptSnap = {
    version: 999,
    snapshotId: "snap_corrupted",
    // routes missing!
    // functions missing!
  };
  currentSnap = corruptSnap;

  // Refresh must throw ValidationFailedError and NOT overwrite cache
  await assertRejects(
    () => cache.forceRefresh(),
    ValidationFailedError,
  );

  const active = cache.getLatestSnapshot();
  assertExists(active);
  assertEquals(
    active.version,
    1,
    "Cache must preserve last-known-good snapshot",
  );
  assertEquals(active.routes.length, 2, "Routes must remain intact");
  assertFalse(active.routes === undefined);
});

Deno.test("Attack PLAT-8: Initial malformed response throws and does NOT brick cache", async () => {
  let currentSnap: unknown = {}; // initial empty response

  const cache = new RuntimeSnapshotCache(() =>
    Promise.resolve(currentSnap as RoutingSnapshot)
  );

  await assertRejects(
    () => cache.forceRefresh(),
    ValidationFailedError,
  );
  assertEquals(cache.getLatestSnapshot(), null);

  // Control plane recovers with valid snapshot
  currentSnap = createValidSnapshot(1);
  await cache.forceRefresh();

  const active = cache.getLatestSnapshot();
  assertExists(active);
  assertEquals(active.version, 1);
  assertEquals(active.routes.length, 2);
});

// ============================================================================
// Attack 3: Data-Plane Tampering & In-Place Mutation
// ============================================================================

Deno.test("Attack PLAT-8: Deserialized JSON snapshot is deeply frozen and in-place mutation throws TypeError", async () => {
  // In real deployment, fetchSnapshot receives JSON over HTTP
  const rawJson = JSON.stringify(createValidSnapshot(1));
  const fetcher = () => Promise.resolve(JSON.parse(rawJson) as RoutingSnapshot);

  const cache = new RuntimeSnapshotCache(fetcher);
  await cache.forceRefresh();

  const retrieved1 = cache.getLatestSnapshot();
  assertExists(retrieved1);

  // In-place mutation of routes throws TypeError
  assertThrows(
    () => {
      retrieved1.routes.unshift({
        pattern: "/*",
        function: "attacker_backdoor",
      });
    },
    TypeError,
  );

  // In-place mutation of permissions throws TypeError
  assertThrows(
    () => {
      retrieved1.functions["users"].permissions.kv?.push("secrets:*");
    },
    TypeError,
  );

  const retrieved2 = cache.getLatestSnapshot();
  assertExists(retrieved2);
  assertEquals(retrieved2.routes[0]?.function, "users");
  assertFalse(
    retrieved2.functions["users"].permissions.kv?.includes("secrets:*") ??
      false,
  );
});

// ============================================================================
// Attack 4: Version Downgrade, Monotonicity & Replay
// ============================================================================

Deno.test("Adversarial PLAT-8: Replay of older version is rejected", async () => {
  const snap1 = createValidSnapshot(1);
  const snap2 = createValidSnapshot(2);

  let currentSnap = snap2;
  const cache = new RuntimeSnapshotCache(() => Promise.resolve(currentSnap));
  await cache.forceRefresh();
  assertEquals(cache.getLatestSnapshot()?.version, 2);

  // Inject stale version 1
  currentSnap = snap1;
  try {
    await cache.forceRefresh();
  } catch {
    //
  }

  assertEquals(
    cache.getLatestSnapshot()?.version,
    2,
    "Cache must not regress to version 1",
  );
});

Deno.test("Attack PLAT-8: Replay of IDENTICAL version number does NOT overwrite active snapshot", async () => {
  const snapOriginal = createValidSnapshot(2);
  const snapReplayTampered = {
    ...createValidSnapshot(2),
    routes: [{ pattern: "/*", function: "tampered_same_version" }],
  };

  let currentSnap = snapOriginal;
  const cache = new RuntimeSnapshotCache(() => Promise.resolve(currentSnap));
  await cache.forceRefresh();
  assertEquals(cache.getLatestSnapshot()?.routes[0].function, "users");

  // Replay different content with SAME version number (version 2)
  currentSnap = snapReplayTampered;
  await cache.forceRefresh();

  assertEquals(
    cache.getLatestSnapshot()?.routes[0].function,
    "users",
    "Identical version number must not overwrite active snapshot",
  );
});
