/**
 * Tests for Fail-Static Snapshot Disk Cache and Cold-Start Recovery (T-0407).
 *
 * Spec references:
 * - PLAT-1: Control plane vs data plane (data plane consumes fail-static; synchronous CP calls banned on request path)
 * - PLAT-8: Fail-static control/data plane split (cold-start recovery via local disk snapshot, background refresh ~5s,
 *           serve last-known-good snapshot indefinitely on control plane outage, atomic write pattern)
 * - PLAT-10: SLOs & error budget (runtime data plane 99.95% SLO maintained via local disk cache even during CP downtime)
 * - PLAT-12: Error model (UNAVAILABLE for unreachable control plane; data plane never throws UNAVAILABLE on request path)
 * - PLAT-14: ULID identifier format (Crockford Base32, 26 chars, snap_{ULID})
 */

import {
  assertEquals,
  assertExists,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { delay } from "@std/async/delay";
import { join } from "@std/path";
import {
  type RoutingSnapshot,
  SnapshotDistributor,
} from "../../packages/protocol/snapshot.ts";
import type { RevisionRecord } from "../../apps/api/deployment-service.ts";
import { UnavailableError } from "../../packages/errors/mod.ts";
import {
  createDiskSnapshotCache,
  type DiskSnapshotCache,
} from "../../runtime/snapshot/disk-snapshot-cache.ts";

/**
 * Helper to construct a mock RevisionRecord conforming to PLAT-3 / PLAT-18.
 */
function createMockRevision(
  functionName: string,
  revisionId = "rev_01J8Z000000000000000000001",
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

/**
 * Factory for creating versioned RoutingSnapshot fixtures using SnapshotDistributor.
 */
function createTestDistributor(): {
  distributor: SnapshotDistributor;
  createSnap: (
    routes?: Array<{ pattern: string; function: string }>,
    customRevisions?: Record<string, RevisionRecord>,
  ) => RoutingSnapshot;
} {
  const distributor = new SnapshotDistributor();
  return {
    distributor,
    createSnap: (
      routes = [{ pattern: "/api/*", function: "api" }],
      customRevisions,
    ) => {
      const revisions: Record<string, RevisionRecord> = customRevisions ?? {};
      for (const route of routes) {
        if (!revisions[route.function]) {
          revisions[route.function] = createMockRevision(route.function);
        }
      }
      return distributor.createSnapshot(routes, revisions);
    },
  };
}

/**
 * Helper to test if a file or directory exists without throwing.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Suite 1: Cold Start Recovery During Outages (AC1, PLAT-8, PLAT-10)
// ---------------------------------------------------------------------------

Deno.test("createDiskSnapshotCache - AC1 & Integration: cold start loads existing snapshot from disk during control plane outage (PLAT-8)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "routing-snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const diskSnapshot = createSnap([
      { pattern: "/api/*", function: "api" },
      { pattern: "/auth/*", function: "auth" },
    ]);

    // Pre-populate valid snapshot on disk
    await Deno.writeTextFile(
      cacheFilePath,
      JSON.stringify(diskSnapshot, null, 2),
    );

    // Control plane is dead from cold start
    const fetchSnapshot = () =>
      Promise.reject(new UnavailableError("Control plane offline"));

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot,
    });

    const loaded = cache.getLatestSnapshot();
    assertExists(
      loaded,
      "Snapshot should be recovered from disk on cold start",
    );
    assertEquals(loaded.snapshotId, diskSnapshot.snapshotId);
    assertEquals(loaded.version, diskSnapshot.version);
    assertEquals(loaded.routes, diskSnapshot.routes);
    assertEquals(loaded.functions["api"].functionName, "api");
    assertEquals(loaded.functions["auth"].functionName, "auth");
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("createDiskSnapshotCache - AC1: cold start with no disk cache and dead control plane initializes with null without throwing", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "nonexistent-snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const fetchSnapshot = () =>
      Promise.reject(new UnavailableError("Control plane offline"));

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot,
    });

    assertEquals(cache.getLatestSnapshot(), null);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("createDiskSnapshotCache - AC1: cold start with live control plane writes initial snapshot to disk", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const snap1 = createSnap();

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.resolve(snap1),
    });

    await cache.forceRefresh();

    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap1.snapshotId);
    assertEquals(
      await fileExists(cacheFilePath),
      true,
      "Snapshot file should be written to disk",
    );

    const content = await Deno.readTextFile(cacheFilePath);
    const parsed = JSON.parse(content);
    assertEquals(parsed.snapshotId, snap1.snapshotId);
    assertEquals(parsed.version, snap1.version);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Suite 2: In-Memory Update & Atomic Disk Persistence (AC2, AC3, PLAT-8)
// ---------------------------------------------------------------------------

Deno.test("DiskSnapshotCache - AC2 & Unit: forceRefresh updates in-memory cache and writes to disk on newer version (PLAT-8)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const snap1 = createSnap([{ pattern: "/v1/*", function: "v1" }]);
    const snap2 = createSnap([{ pattern: "/v2/*", function: "v2" }]);

    let currentRemote = snap1;
    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.resolve(currentRemote),
    });

    // Populate v1
    await cache.forceRefresh();
    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap1.snapshotId);
    assertEquals(cache.getLatestSnapshot()?.version, snap1.version);

    // Verify v1 written to disk
    const diskContent1 = await Deno.readTextFile(cacheFilePath);
    const parsed1 = JSON.parse(diskContent1);
    assertEquals(parsed1.snapshotId, snap1.snapshotId);
    assertEquals(parsed1.version, snap1.version);

    // Receive newer version v2
    currentRemote = snap2;
    await cache.forceRefresh();

    // Verify in-memory updated
    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap2.snapshotId);
    assertEquals(cache.getLatestSnapshot()?.version, snap2.version);

    // Verify disk updated to v2
    const diskContent2 = await Deno.readTextFile(cacheFilePath);
    const parsed2 = JSON.parse(diskContent2);
    assertEquals(parsed2.snapshotId, snap2.snapshotId);
    assertEquals(parsed2.version, snap2.version);
    assertEquals(parsed2.routes, snap2.routes);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("DiskSnapshotCache - AC3 & Unit: atomic write writes via .tmp and leaves no leftover temporary file on success (PLAT-8)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  const tmpFilePath = `${cacheFilePath}.tmp`;
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const snap1 = createSnap();

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.resolve(snap1),
    });

    await cache.forceRefresh();

    // The final target exists and temp file is cleaned up / renamed
    assertEquals(
      await fileExists(cacheFilePath),
      true,
      "Target cache file should exist",
    );
    assertEquals(
      await fileExists(tmpFilePath),
      false,
      "Temporary .tmp file should not linger after write",
    );

    const content = await Deno.readTextFile(cacheFilePath);
    const parsed = JSON.parse(content);
    assertEquals(parsed.snapshotId, snap1.snapshotId);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("DiskSnapshotCache - AC3 & Unit: atomic write preserves existing cache file when temporary file exists or write interrupted (PLAT-8)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  const tmpFilePath = `${cacheFilePath}.tmp`;
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const validSnap1 = createSnap([{ pattern: "/v1", function: "v1" }]);

    // Initial valid file on disk
    await Deno.writeTextFile(
      cacheFilePath,
      JSON.stringify(validSnap1, null, 2),
    );

    // Simulate an interrupted write that left a corrupted .tmp file behind
    await Deno.writeTextFile(tmpFilePath, '{"incomplete": true, "corrupt":');

    // Startup with CP offline should safely recover the uncorrupted original cacheFilePath
    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.reject(new UnavailableError("CP down")),
    });

    const current = cache.getLatestSnapshot();
    assertExists(current);
    assertEquals(current.snapshotId, validSnap1.snapshotId);
    assertEquals(current.version, validSnap1.version);

    // Verify cacheFilePath is still intact
    const diskContent = await Deno.readTextFile(cacheFilePath);
    const parsed = JSON.parse(diskContent);
    assertEquals(parsed.snapshotId, validSnap1.snapshotId);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("DiskSnapshotCache - AC3 & Unit: failed fetchSnapshot preserves original disk snapshot unchanged (PLAT-8)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const snap1 = createSnap();

    let shouldFail = false;
    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => {
        if (shouldFail) {
          return Promise.reject(new UnavailableError("CP connection lost"));
        }
        return Promise.resolve(snap1);
      },
    });

    await cache.forceRefresh();
    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap1.snapshotId);

    // Now fail subsequent refresh
    shouldFail = true;
    await assertRejects(
      () => cache!.forceRefresh(),
      UnavailableError,
    );

    // Memory and disk remain snap1
    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap1.snapshotId);
    const diskContent = await Deno.readTextFile(cacheFilePath);
    const parsed = JSON.parse(diskContent);
    assertEquals(parsed.snapshotId, snap1.snapshotId);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Suite 3: Monotonic Versioning & Stale Snapshot Protection (PLAT-8)
// ---------------------------------------------------------------------------

Deno.test("DiskSnapshotCache - monotonic versioning: older snapshot version from CP does not overwrite newer disk/memory snapshot (PLAT-8)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const snap1 = createSnap([{ pattern: "/v1", function: "v1" }]); // v1
    const snap2 = createSnap([{ pattern: "/v2", function: "v2" }]); // v2
    const snap3 = createSnap([{ pattern: "/v3", function: "v3" }]); // v3

    // Pre-populate disk with v3
    await Deno.writeTextFile(cacheFilePath, JSON.stringify(snap3, null, 2));

    // Control plane tries to send older v1
    let cpSnap = snap1;
    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.resolve(cpSnap),
    });

    assertEquals(cache.getLatestSnapshot()?.version, snap3.version);

    // Try forceRefresh with older v1
    await cache.forceRefresh();

    // Should not downgrade
    assertEquals(cache.getLatestSnapshot()?.version, snap3.version);
    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap3.snapshotId);

    // Verify disk was NOT overwritten with older version
    const diskContent = await Deno.readTextFile(cacheFilePath);
    const parsed = JSON.parse(diskContent);
    assertEquals(parsed.version, snap3.version);
    assertEquals(parsed.snapshotId, snap3.snapshotId);

    // Try forceRefresh with v2 (still older than v3)
    cpSnap = snap2;
    await cache.forceRefresh();
    assertEquals(cache.getLatestSnapshot()?.version, snap3.version);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("DiskSnapshotCache - monotonic versioning: identical version from CP is a no-op and preserves disk state (PLAT-8)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const snap1 = createSnap();

    await Deno.writeTextFile(cacheFilePath, JSON.stringify(snap1, null, 2));

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.resolve(snap1),
    });

    assertEquals(cache.getLatestSnapshot()?.version, snap1.version);

    // forceRefresh with same version
    await cache.forceRefresh();
    assertEquals(cache.getLatestSnapshot()?.version, snap1.version);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Suite 4: Corrupted Disk Cache Handling & Safe Fallback (AC4, PLAT-8, PLAT-12)
// ---------------------------------------------------------------------------

Deno.test("createDiskSnapshotCache - AC4 & Unit: truncated JSON on disk is safely discarded on startup, initializing with null (PLAT-8)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    // Truncated JSON
    await Deno.writeTextFile(
      cacheFilePath,
      '{"snapshotId": "snap_01J8Z000000000000000000001", "version": 1, "routes": [{"pattern":',
    );

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () =>
        Promise.reject(new UnavailableError("CP unreachable")),
    });

    assertEquals(
      cache.getLatestSnapshot(),
      null,
      "Corrupted snapshot should be discarded and initialized as null",
    );
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("createDiskSnapshotCache - AC4 & Unit: schema-invalid snapshot JSON on disk is safely discarded on startup (PLAT-8, PLAT-12)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    // Valid JSON but invalid RoutingSnapshot (missing functions, invalid version, etc.)
    await Deno.writeTextFile(
      cacheFilePath,
      JSON.stringify({
        snapshotId: "not_a_valid_ulid_snapshot",
        version: -5,
        routes: "invalid-routes",
      }),
    );

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () =>
        Promise.reject(new UnavailableError("CP unreachable")),
    });

    assertEquals(
      cache.getLatestSnapshot(),
      null,
      "Invalid schema snapshot should be discarded",
    );
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("DiskSnapshotCache - AC4 & Unit: self-heals corrupted disk cache when control plane becomes reachable (PLAT-8)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const snap1 = createSnap();

    // Corrupted file on disk initially
    await Deno.writeTextFile(
      cacheFilePath,
      "Corrupted garbage non-json payload",
    );

    let cpOnline = false;
    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => {
        if (!cpOnline) {
          return Promise.reject(new UnavailableError("CP down"));
        }
        return Promise.resolve(snap1);
      },
    });

    assertEquals(cache.getLatestSnapshot(), null);

    // Control plane comes online and forceRefresh is called
    cpOnline = true;
    await cache.forceRefresh();

    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap1.snapshotId);

    // Disk is now overwritten with healthy snapshot
    const diskContent = await Deno.readTextFile(cacheFilePath);
    const parsed = JSON.parse(diskContent);
    assertEquals(parsed.snapshotId, snap1.snapshotId);
    assertEquals(parsed.version, snap1.version);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Suite 5: Synchronous Request Path & Non-Blocking Guarantee (AC5, PLAT-1, PLAT-8, PLAT-10, PLAT-12)
// ---------------------------------------------------------------------------

Deno.test("DiskSnapshotCache - AC5 & Integration: synchronous read path never blocks or throws UNAVAILABLE during CP outage (PLAT-8, PLAT-10)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const validSnap = createSnap([
      { pattern: "/api/users", function: "users" },
      { pattern: "/api/*", function: "api" },
    ]);

    // Pre-populate disk
    await Deno.writeTextFile(cacheFilePath, JSON.stringify(validSnap, null, 2));

    // CP is dead
    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.reject(new UnavailableError("CP dead")),
    });

    // Start cache
    await cache.start();

    // Verify 5,000 synchronous non-blocking reads on request path
    const start = performance.now();
    for (let i = 0; i < 5000; i++) {
      const snap = cache.getLatestSnapshot();
      assertFalse(
        snap instanceof Promise,
        "getLatestSnapshot() must return synchronously, not a Promise",
      );
      assertFalse(
        snap !== null &&
          typeof (snap as unknown as Record<string, unknown>).then ===
            "function",
        "getLatestSnapshot() must not return a thenable",
      );
      assertEquals(snap?.snapshotId, validSnap.snapshotId);
      assertEquals(snap?.routes.length, 2);
    }
    const duration = performance.now() - start;

    // Must be non-blocking in-memory reads (< 100ms for 5,000 iterations)
    assertEquals(
      duration < 100,
      true,
      `Synchronous in-memory reads exceeded threshold: ${duration}ms`,
    );
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("DiskSnapshotCache - AC5 & Unit: getLatestSnapshot() reads strictly from memory and never hits disk on request path (PLAT-8)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const validSnap = createSnap();

    await Deno.writeTextFile(cacheFilePath, JSON.stringify(validSnap, null, 2));

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.reject(new UnavailableError("CP dead")),
    });

    assertEquals(cache.getLatestSnapshot()?.snapshotId, validSnap.snapshotId);

    // Delete the file from disk completely
    await Deno.remove(cacheFilePath);
    assertEquals(await fileExists(cacheFilePath), false);

    // getLatestSnapshot must still return the cached snapshot from memory without throwing
    const memSnap = cache.getLatestSnapshot();
    assertExists(memSnap);
    assertEquals(memSnap.snapshotId, validSnap.snapshotId);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Suite 6: Directory Auto-Creation & Edge Cases (Assumption 1, PLAT-8)
// ---------------------------------------------------------------------------

Deno.test("DiskSnapshotCache - directory creation: recursively creates parent directories when cacheFilePath directory is missing", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "nested", "sub", "dir", "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const snap1 = createSnap();

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.resolve(snap1),
    });

    await cache.forceRefresh();

    // Parent directory and file should now exist
    assertEquals(await fileExists(cacheFilePath), true);
    const diskContent = await Deno.readTextFile(cacheFilePath);
    const parsed = JSON.parse(diskContent);
    assertEquals(parsed.snapshotId, snap1.snapshotId);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("createDiskSnapshotCache - directory creation: gracefully handles missing parent directory on cold start with dead CP", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "uncreated", "dir", "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.reject(new UnavailableError("CP offline")),
    });

    assertEquals(cache.getLatestSnapshot(), null);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Suite 7: Polling Lifecycle Management (AC6, PLAT-8)
// ---------------------------------------------------------------------------

Deno.test("DiskSnapshotCache - AC6: stop() halts background polling timer cleanly and is idempotent", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const snap1 = createSnap();
    const snap2 = createSnap();

    let currentSnap = snap1;
    let fetchCount = 0;
    const fetcher = (): Promise<RoutingSnapshot> => {
      fetchCount++;
      return Promise.resolve(currentSnap);
    };

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      pollIntervalMs: 25,
      fetchSnapshot: fetcher,
    });

    await cache.start();
    await delay(60);
    const countWhileRunning = fetchCount;
    assertEquals(countWhileRunning > 0, true, "Polling should have occurred");

    // Stop polling
    cache.stop();
    const countAfterStop = fetchCount;

    // Change remote snapshot
    currentSnap = snap2;

    // Wait more intervals
    await delay(80);

    assertEquals(
      fetchCount,
      countAfterStop,
      "Polling count must not increase after stop()",
    );
    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap1.snapshotId);

    // Multiple calls to stop() must be idempotent and not throw
    cache.stop();
    cache.stop();
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("DiskSnapshotCache - Integration: background polling automatically updates memory and writes to disk", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const snap1 = createSnap([{ pattern: "/v1", function: "v1" }]);
    const snap2 = createSnap([{ pattern: "/v2", function: "v2" }]);

    let currentSnap = snap1;
    cache = await createDiskSnapshotCache({
      cacheFilePath,
      pollIntervalMs: 25,
      fetchSnapshot: () => Promise.resolve(currentSnap),
    });

    await cache.start();
    await delay(40);

    assertEquals(cache.getLatestSnapshot()?.version, snap1.version);
    const disk1 = JSON.parse(await Deno.readTextFile(cacheFilePath));
    assertEquals(disk1.version, snap1.version);

    // CP updates to v2
    currentSnap = snap2;

    // Background poll should detect it
    await delay(70);

    assertEquals(cache.getLatestSnapshot()?.version, snap2.version);
    const disk2 = JSON.parse(await Deno.readTextFile(cacheFilePath));
    assertEquals(disk2.version, snap2.version);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("DiskSnapshotCache - PLAT-8: background polling swallows CP errors without disrupting cached snapshot", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const snap1 = createSnap();

    let shouldFail = false;
    cache = await createDiskSnapshotCache({
      cacheFilePath,
      pollIntervalMs: 25,
      fetchSnapshot: () => {
        if (shouldFail) {
          return Promise.reject(new UnavailableError("CP intermittent 503"));
        }
        return Promise.resolve(snap1);
      },
    });

    await cache.forceRefresh();
    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap1.snapshotId);

    // Start polling with CP failing
    shouldFail = true;
    await cache.start();
    await delay(60);

    // In-memory and disk snapshot preserved
    assertEquals(cache.getLatestSnapshot()?.snapshotId, snap1.snapshotId);
    const disk = JSON.parse(await Deno.readTextFile(cacheFilePath));
    assertEquals(disk.snapshotId, snap1.snapshotId);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Suite 8: Immutability & Adversarial Security (PLAT-8, PLAT-15)
// ---------------------------------------------------------------------------

Deno.test("DiskSnapshotCache - Adversarial PLAT-8: deepFreeze enforces strict immutability across all snapshot properties", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const snap1 = createSnap([{ pattern: "/users", function: "users" }]);

    await Deno.writeTextFile(cacheFilePath, JSON.stringify(snap1, null, 2));

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.reject(new UnavailableError("CP offline")),
    });

    const loaded = cache.getLatestSnapshot();
    assertExists(loaded);

    // 1. Mutate top-level properties
    assertThrows(() => {
      (loaded as unknown as Record<string, unknown>).version = 9999;
    }, TypeError);
    assertThrows(() => {
      (loaded as unknown as Record<string, unknown>).snapshotId = "snap_evil";
    }, TypeError);

    // 2. Mutate routes array and elements
    assertThrows(() => {
      loaded.routes.push({ pattern: "/hacked", function: "evil" });
    }, TypeError);
    assertThrows(() => {
      loaded.routes[0].pattern = "/tampered";
    }, TypeError);
    assertThrows(() => {
      loaded.routes[0].function = "tampered";
    }, TypeError);

    // 3. Mutate functions map, permissions, and limits
    assertThrows(() => {
      (loaded.functions as unknown as Record<string, unknown>)["backdoor"] =
        {} as unknown;
    }, TypeError);
    assertThrows(() => {
      loaded.functions["users"].functionName = "evil";
    }, TypeError);
    assertThrows(() => {
      loaded.functions["users"].permissions.kv?.push("all:*");
    }, TypeError);
    assertThrows(() => {
      (loaded.functions["users"].limits as unknown as Record<string, unknown>)
        .cpu_ms = 999999;
    }, TypeError);
    assertThrows(() => {
      delete (loaded.functions as unknown as Record<string, unknown>)["users"];
    }, TypeError);

    // 4. Property definition and prototype tampering
    assertThrows(() => {
      Object.defineProperty(loaded, "version", { value: 9999 });
    }, TypeError);
    assertThrows(() => {
      Object.setPrototypeOf(loaded, {});
    }, TypeError);

    // Verify snapshot was completely unmutated
    const recheck = cache.getLatestSnapshot();
    assertExists(recheck);
    assertEquals(recheck.version, snap1.version);
    assertEquals(recheck.routes.length, 1);
    assertEquals(recheck.routes[0].pattern, "/users");
    assertEquals(recheck.functions["users"].permissions.kv, ["app:sessions"]);
    assertEquals(recheck.functions["users"].limits.cpu_ms, 200);
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("DiskSnapshotCache - Adversarial PLAT-15: zero secret persistence guarantees credentials never touch disk", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { distributor } = createTestDistributor();
    const leakedSecretToken = "sk_live_super_secret_adversarial_token_98765";
    const bearerCredential = "Bearer secret-credential-token-xyz";
    const databaseSecretUri =
      "postgres://admin:supersecretpass@db.internal/prod";

    // Simulate active revisions from deployment service where manifests contain secret declarations
    // or extra runtime fields attempting to smuggle secrets
    const activeRevisions: Record<string, RevisionRecord> = {
      api: {
        id: "rev_01J8Z000000000000000000001",
        project: "proj_01J8Z000000000000000000000",
        functionName: "api",
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
          permissions: {
            kv: ["app:sessions"],
            objects: ["app:uploads"],
            queues: ["app:jobs"],
            // Manifest secrets declaration (PLAT-15 capability scope)
            secrets: ["STRIPE_KEY", "DATABASE_URL"],
          } as unknown as {
            kv?: string[];
            objects?: string[];
            queues?: string[];
          },
          limits: { cpu_ms: 200, timeout_ms: 30000, memory_mb: 128 },
          dependencies: {},
          // Smuggled secret values that must NEVER be persisted
          env: {
            DATABASE_URL: databaseSecretUri,
            STRIPE_KEY: leakedSecretToken,
            AUTH_HEADER: bearerCredential,
          },
        } as unknown as RevisionRecord["manifest"],
      },
    };

    const snapshot = distributor.createSnapshot(
      [{ pattern: "/api/*", function: "api" }],
      activeRevisions,
    );

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.resolve(snapshot),
    });

    await cache.forceRefresh();

    // Read raw disk file content and verify complete absence of secrets
    const rawDiskContent = await Deno.readTextFile(cacheFilePath);

    assertEquals(
      rawDiskContent.includes(leakedSecretToken),
      false,
      "Secret token must NEVER appear in disk snapshot (PLAT-15)",
    );
    assertEquals(
      rawDiskContent.includes(bearerCredential),
      false,
      "Bearer credentials must NEVER appear in disk snapshot (PLAT-15)",
    );
    assertEquals(
      rawDiskContent.includes(databaseSecretUri),
      false,
      "Database credentials must NEVER appear in disk snapshot (PLAT-15)",
    );
    assertEquals(
      rawDiskContent.includes("supersecretpass"),
      false,
      "Secret passwords must NEVER appear in disk snapshot (PLAT-15)",
    );

    // Verify snapshot structure strictly contains only non-secret capability names
    const parsed = JSON.parse(rawDiskContent);
    const apiFn = parsed.functions["api"];
    assertExists(apiFn);
    assertEquals(apiFn.permissions.kv, ["app:sessions"]);
    assertEquals(apiFn.permissions.objects, ["app:uploads"]);
    assertEquals(apiFn.permissions.queues, ["app:jobs"]);
    assertEquals(
      apiFn.permissions.secrets,
      undefined,
      "secrets must not be in FunctionSnapshot permissions",
    );
    assertEquals(apiFn.env, undefined, "env must not be in FunctionSnapshot");
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("DiskSnapshotCache - Adversarial Path Traversal: malicious route patterns and function names cannot escape or corrupt disk", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { distributor } = createTestDistributor();

    // Adversarial routes and functions containing path traversal and special characters
    const traversalPattern = "../../../../etc/passwd";
    const traversalWindowsPattern = "..\\..\\Windows\\System32\\cmd.exe";
    const maliciousFnName = "../../../../bin/malicious_exec";

    const snapshot = distributor.createSnapshot(
      [
        { pattern: traversalPattern, function: maliciousFnName },
        { pattern: traversalWindowsPattern, function: maliciousFnName },
      ],
      {
        [maliciousFnName]: createMockRevision(maliciousFnName),
      },
    );

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.resolve(snapshot),
    });

    await cache.forceRefresh();

    // The single legitimate cacheFilePath must exist
    assertEquals(await fileExists(cacheFilePath), true);

    // Verify no rogue traversal files were created on the filesystem
    const escapedFile1 = join(tempDir, "..", "passwd");
    const escapedFile2 = join(tempDir, "..", "..", "passwd");
    const escapedFile3 = join(tempDir, "..", "malicious_exec");

    assertEquals(await fileExists(escapedFile1), false);
    assertEquals(await fileExists(escapedFile2), false);
    assertEquals(await fileExists(escapedFile3), false);

    // Verify contents are cleanly contained within JSON payload of cacheFilePath
    const diskContent = await Deno.readTextFile(cacheFilePath);
    const parsed = JSON.parse(diskContent);
    assertEquals(parsed.routes[0].pattern, traversalPattern);
    assertEquals(parsed.routes[1].pattern, traversalWindowsPattern);
    assertEquals(
      parsed.functions[maliciousFnName].functionName,
      maliciousFnName,
    );
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("DiskSnapshotCache - Adversarial Disk Injection: arbitrary JS, malformed JSON, and prototype pollution are safely neutralized", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    // 1. Attack with arbitrary executable JS injected on disk
    await Deno.writeTextFile(
      cacheFilePath,
      `(() => { throw new Error("EXPLOIT_EXECUTED"); })(); console.log("HACKED");`,
    );

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.reject(new UnavailableError("CP down")),
    });

    assertEquals(
      cache.getLatestSnapshot(),
      null,
      "Executable JS on disk must not execute and must safely initialize to null",
    );

    // 2. Attack with prototype pollution payload injected into disk JSON
    const protoPollutionPayload = JSON.stringify({
      "__proto__": { "polluted": true, "isAdmin": true },
      "constructor": { "prototype": { "pollutedProto": true } },
      "snapshotId": "snap_01J8Z000000000000000000001",
      "version": 1,
      "routes": [
        {
          "pattern": "/api/*",
          "function": "api",
          "__proto__": { "routePolluted": true },
        },
      ],
      "functions": {
        "__proto__": {
          "functionName": "evil",
          "revisionId": "rev_01J8Z000000000000000000001",
          "artifactId":
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          "permissions": {},
          "limits": { "cpu_ms": 100, "timeout_ms": 1000, "memory_mb": 128 },
        },
        "api": {
          "functionName": "api",
          "revisionId": "rev_01J8Z000000000000000000001",
          "artifactId":
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          "permissions": {
            "__proto__": { "permPolluted": true },
            "kv": ["app:data"],
          },
          "limits": { "cpu_ms": 100, "timeout_ms": 1000, "memory_mb": 128 },
        },
      },
      "generatedAt": Date.now(),
    });

    await Deno.writeTextFile(cacheFilePath, protoPollutionPayload);

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      fetchSnapshot: () => Promise.reject(new UnavailableError("CP down")),
    });

    const loaded = cache.getLatestSnapshot();
    assertExists(loaded);

    // Verify prototype pollution attack failed completely
    assertEquals(
      (loaded as unknown as Record<string, unknown>).polluted,
      undefined,
    );
    assertEquals(
      (loaded as unknown as Record<string, unknown>).isAdmin,
      undefined,
    );
    assertEquals(({} as Record<string, unknown>).polluted, undefined);
    assertEquals(({} as Record<string, unknown>).isAdmin, undefined);
    assertEquals(({} as Record<string, unknown>).pollutedProto, undefined);
    assertEquals(({} as Record<string, unknown>).routePolluted, undefined);
    assertEquals(({} as Record<string, unknown>).permPolluted, undefined);
    assertEquals(
      Object.isFrozen(Object.prototype),
      false,
      "Object.prototype must not be frozen",
    );
    assertEquals(typeof Object.prototype.hasOwnProperty, "function");
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("DiskSnapshotCache - Adversarial DOS (PLAT-8, PLAT-10): hanging fetcher and slow disk never block getLatestSnapshot()", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog-disk-cache-test-",
  });
  const cacheFilePath = join(tempDir, "snapshot.json");
  let cache: DiskSnapshotCache | null = null;
  try {
    const { createSnap } = createTestDistributor();
    const validSnap = createSnap([
      { pattern: "/api/*", function: "api" },
    ]);
    await Deno.writeTextFile(cacheFilePath, JSON.stringify(validSnap, null, 2));

    // Fetcher that hangs indefinitely (simulating network partition or slow upstream)
    const isHanging = true;
    const hangingFetcher = (): Promise<RoutingSnapshot> => {
      if (isHanging) {
        return new Promise<RoutingSnapshot>(() => {}); // Never resolves
      }
      return Promise.resolve(validSnap);
    };

    cache = await createDiskSnapshotCache({
      cacheFilePath,
      pollIntervalMs: 15,
      fetchSnapshot: hangingFetcher,
    });

    await cache.start();

    // High throughput data plane simulation: 10,000 requests while fetcher is hung
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      const readSnap: RoutingSnapshot | null = cache.getLatestSnapshot();
      assertFalse(
        readSnap instanceof Promise,
        "Must return synchronously, never a Promise",
      );
      assertExists(readSnap);
      assertEquals(readSnap.snapshotId, validSnap.snapshotId);
    }
    const elapsedMs = performance.now() - start;
    const avgLatencyUs = (elapsedMs / 10000) * 1000;

    // Must be non-blocking in-memory reads (< 50ms total, sub-microsecond average)
    assertEquals(
      elapsedMs < 100,
      true,
      `Synchronous in-memory reads exceeded threshold: ${elapsedMs}ms (${avgLatencyUs}us/op)`,
    );
  } finally {
    cache?.stop();
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});
