/**
 * Milestone 0.4 Reliability and Fault Injection Integration Test Suite (T-0412).
 *
 * Spec references:
 * - PLAT-3: Deployment safety check & atomic cutover
 * - PLAT-7: Multi-tenant physical prefix isolation
 * - PLAT-8: Fail-static control/data plane split (in-memory & disk snapshot cache)
 * - PLAT-10: 99.95% data plane SLO via synchronous in-memory reads and circuit breaking
 * - PLAT-12: Error model (UNAVAILABLE, CONFLICT, VALIDATION_FAILED)
 * - PLAT-13: Usage accounting, Prometheus & OTLP metric exports
 * - PLAT-14: ULID identifiers (snap_{ULID}, bak_{ULID}, rev_{ULID})
 * - PLAT-15: Auto-redaction of secrets in errors and logs
 * - PLAT-16: Provider abstraction
 * - PLAT-17: Local and production provider parity
 * - PLAT-18: Resource hierarchy Org -> Project -> { Function, KV, Object, Queue }
 * - FN-3: Function lifecycle, immutable revisions, instant pointer-flip rollback
 * - Q-1: At-least-once queue delivery guarantee
 * - Q-3: Visibility timeout and DLQ redelivery state machine
 * - Q-5: Queue polling backoff interval
 * - Q-6: Composed reliability patterns (circuit breaker library over kv.atomic)
 * - OBJ-1: Durable binary storage for backups
 * - OBJ-4: Content addressing and integrity verification
 * - ADR-0002: State backup and disaster recovery archive specification
 */

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";
import { DeploymentService } from "../../apps/api/deployment-service.ts";
import { packageFunctionArtifact } from "../../packages/core/artifact/packager.ts";
import {
  ConflictError,
  UnavailableError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import {
  createDiskSnapshotCache,
  type DiskSnapshotCache,
} from "../../runtime/snapshot/disk-snapshot-cache.ts";
import { RuntimeSnapshotCache } from "../../runtime/snapshot/snapshot-cache.ts";
import type { RoutingSnapshot } from "../../packages/protocol/snapshot.ts";
import { QueueConsumerWorker } from "../../apps/worker/queue-consumer.ts";
import type { QueueMessage } from "../../primitives/queues/queue-provider.ts";
import {
  type CircuitBreaker,
  createCircuitBreaker,
} from "../../packages/policy/circuit-breaker.ts";
import {
  createMetricsExporter,
  type MetricsExporter,
} from "../../packages/metrics/otel-exporter.ts";
import type { UsageRecord } from "../../packages/metrics/usage-collector.ts";
import {
  createStateBackupService,
  type StateBackupService,
} from "../../apps/api/state-backup-service.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";
import { normalizeProviderError } from "../../providers/resilient/resilient-provider.ts";

/**
 * Creates a valid mock RoutingSnapshot for fail-static tests.
 * Spec-anchor: PLAT-8, PLAT-14.
 */
function createMockRoutingSnapshot(version: number = 1): RoutingSnapshot {
  const snapUlid = generateUlid();
  const rev1Ulid = generateUlid();
  const rev2Ulid = generateUlid();
  return {
    snapshotId: `snap_${snapUlid}`,
    version,
    routes: [
      { pattern: "/api/users", function: "users" },
      { pattern: "/api/*", function: "wildcard" },
    ],
    functions: {
      users: {
        functionName: "users",
        revisionId: `rev_${rev1Ulid}`,
        artifactId:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        permissions: {},
        limits: { cpu_ms: 200, timeout_ms: 30000, memory_mb: 128 },
      },
      wildcard: {
        functionName: "wildcard",
        revisionId: `rev_${rev2Ulid}`,
        artifactId:
          "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
        permissions: {},
        limits: { cpu_ms: 200, timeout_ms: 30000, memory_mb: 128 },
      },
    },
    generatedAt: Date.now(),
  };
}

// ============================================================================
// 1. Integration: Control plane outage fail-static & cold boot recovery (PLAT-8, PLAT-10)
// ============================================================================

Deno.test({
  name:
    "Reliability AC1 - Live runtime serves traffic from snapshot cache indefinitely during CP outage (PLAT-8, PLAT-10)",
  fn: async () => {
    let controlPlaneAlive = true;
    const initialSnapshot = createMockRoutingSnapshot(1);

    const fetchSnapshot = () => {
      if (!controlPlaneAlive) {
        return Promise.reject(
          new Error("Control plane unreachable (ECONNREFUSED)"),
        );
      }
      return Promise.resolve(initialSnapshot);
    };

    const runtimeCache = new RuntimeSnapshotCache(fetchSnapshot, {
      pollIntervalMs: 50,
    });

    // Populate initial snapshot and start background polling
    await runtimeCache.forceRefresh();
    runtimeCache.start();

    const snapshotBeforeOutage = runtimeCache.getLatestSnapshot();
    assert(snapshotBeforeOutage !== null);
    assertEquals(snapshotBeforeOutage.version, 1);

    // Simulate complete control plane termination
    controlPlaneAlive = false;

    // Simulate multiple incoming HTTP requests over time during the outage
    for (let req = 0; req < 5; req++) {
      const activeSnapshot = runtimeCache.getLatestSnapshot();
      assert(
        activeSnapshot !== null,
        "Runtime cache must never return null during CP outage (PLAT-8)",
      );
      assertEquals(activeSnapshot.version, 1);

      // Verify route matching algorithm still functions synchronously without CP
      const matchedRoute = activeSnapshot.routes.find((r) =>
        r.pattern === "/api/users"
      );
      assert(matchedRoute !== undefined);
      assertEquals(matchedRoute.function, "users");
    }

    runtimeCache.stop();
  },
});

Deno.test({
  name:
    "Reliability AC2 - Cold-starting secondary runtime node recovers routes from disk cache during CP outage (PLAT-8)",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const cacheFilePath = join(tempDir, "routing-snapshot.json");

    // 1. Primary node writes initial snapshot to disk while CP is healthy
    const healthySnapshot = createMockRoutingSnapshot(1);
    const primaryNodeCache: DiskSnapshotCache = await createDiskSnapshotCache({
      cacheFilePath,
      pollIntervalMs: 10000,
      fetchSnapshot: () => Promise.resolve(healthySnapshot),
    });

    // Explicitly write snapshot to disk
    await primaryNodeCache.forceRefresh();
    primaryNodeCache.stop();

    // 2. Control plane dies completely
    const deadControlPlaneFetch = () =>
      Promise.reject(
        new Error("Fatal: Control Plane process crashed (PLAT-8)"),
      );

    // 3. Secondary runtime node cold-boots from disk cache while CP is dead
    const secondaryNodeCache: DiskSnapshotCache = await createDiskSnapshotCache(
      {
        cacheFilePath,
        pollIntervalMs: 10000,
        fetchSnapshot: deadControlPlaneFetch,
      },
    );

    // Synchronous read path must succeed immediately on cold start
    const recoveredSnapshot = secondaryNodeCache.getLatestSnapshot();
    assert(
      recoveredSnapshot !== null,
      "Cold-started node must recover snapshot from disk (PLAT-8)",
    );
    assertEquals(recoveredSnapshot.version, 1);
    assertEquals(recoveredSnapshot.routes.length, 2);

    // Live traffic served immediately without throwing UNAVAILABLE
    const userRoute = recoveredSnapshot.routes.find((r) =>
      r.pattern === "/api/users"
    );
    assertEquals(userRoute?.function, "users");

    secondaryNodeCache.stop();
  },
});

// ============================================================================
// 2. Integration: Health check deployment gating & pointer-flip rollback (PLAT-3, FN-3)
// ============================================================================

Deno.test({
  name:
    "Reliability AC3 - Failing health check keeps revision in Failed state and preserves serving revision (PLAT-3, FN-3)",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const objectProvider = new LocalFSProvider(tempDir);
    const deploymentService = new DeploymentService(objectProvider);
    const project = "proj-health-test";
    const functionName = "api";

    // 1. Deploy rev 1 with healthy probe
    const artifact1 = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode('export default () => new Response("v1 ok");'),
    );
    const dep1 = await deploymentService.deploy(
      project,
      functionName,
      artifact1,
      () => Promise.resolve(true),
    );

    assertEquals(dep1.state, "Deployed");
    assertEquals(dep1.active, true);

    const activeRevBefore = await deploymentService.getActiveRevision(
      project,
      functionName,
    );
    assertEquals(activeRevBefore?.id, dep1.revisionId);

    // 2. Deploy rev 2 with failing health check probe (simulating 500 error)
    const artifact2 = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode(
        'export default () => new Response("v2 error", { status: 500 });',
      ),
    );
    const dep2 = await deploymentService.deploy(
      project,
      functionName,
      artifact2,
      () => Promise.resolve(false), // Probe returns false (500)
    );

    // Candidate transitions to Failed, active remains false
    assertEquals(dep2.state, "Failed");
    assertEquals(dep2.active, false);

    // Live traffic pointer strictly remains at rev 1 (zero downtime)
    const activeRevAfter = await deploymentService.getActiveRevision(
      project,
      functionName,
    );
    assertEquals(activeRevAfter?.id, dep1.revisionId);
  },
});

Deno.test({
  name:
    "Reliability AC4 - Rollback flips traffic pointer instantly without rebuilding code (FN-3, PLAT-3)",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const objectProvider = new LocalFSProvider(tempDir);
    const deploymentService = new DeploymentService(objectProvider);
    const project = "proj-rollback-test";
    const functionName = "api";

    // Deploy rev 1
    const art1 = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode('export default () => new Response("rev1");'),
    );
    const dep1 = await deploymentService.deploy(project, functionName, art1);

    // Deploy rev 2
    const art2 = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode('export default () => new Response("rev2");'),
    );
    const dep2 = await deploymentService.deploy(project, functionName, art2);

    assertEquals(
      (await deploymentService.getActiveRevision(project, functionName))?.id,
      dep2.revisionId,
    );

    // Rollback to rev 1
    const rollbackResult = await deploymentService.rollback(
      project,
      functionName,
      dep1.revisionId,
    );
    assertEquals(rollbackResult.previousRevisionId, dep2.revisionId);
    assertEquals(rollbackResult.activeRevisionId, dep1.revisionId);

    // Verify pointer flipped back to rev 1
    const currentActive = await deploymentService.getActiveRevision(
      project,
      functionName,
    );
    assertEquals(currentActive?.id, dep1.revisionId);
  },
});

// ============================================================================
// 3. Integration: Queue consumer redelivery & DLQ fault injection (Q-1, Q-3, Q-5)
// ============================================================================

Deno.test({
  name:
    "Reliability AC5 - Poison queue message retried with visibility timeout and delivered to DLQ after 5 attempts (Q-3, Q-5)",
  fn: async () => {
    const primaryQueue = new SQLiteQueueProvider(":memory:");
    const dlqProvider = new SQLiteQueueProvider(":memory:");

    let attemptsSeen = 0;
    const poisonPayload = { task: "crash_always", error: "fatal" };

    // Worker invokes function which always throws on the poison message
    const worker = new QueueConsumerWorker(
      primaryQueue,
      (_fnName: string, msg: QueueMessage) => {
        attemptsSeen++;
        return Promise.reject(
          new Error(`Simulated consumer crash attempt #${msg.attempts}`),
        );
      },
      {
        queueName: "jobs",
        targetFunctionName: "processor",
        visibilityTimeoutMs: 0, // Instant redelivery for deterministic test execution
        maxReceives: 5, // Q-3 default: 5 attempts before DLQ
        dlqProvider,
      },
    );

    // Send poison message into primary queue
    await primaryQueue.send(poisonPayload);

    // Process message across 5 failure attempts
    for (let i = 1; i <= 5; i++) {
      const processed = await worker.processNext();
      // processNext returns false on failure
      assertEquals(processed, false);
    }

    assertEquals(attemptsSeen, 5);

    // Message must now be routed to DLQ and acknowledged from primary queue
    const primaryMessage = await primaryQueue.receive({
      visibilityTimeoutMs: 1000,
    });
    assertEquals(
      primaryMessage,
      null,
      "Primary queue must be empty after DLQ routing",
    );

    const dlqMessage = await dlqProvider.receive({ visibilityTimeoutMs: 1000 });
    assert(dlqMessage !== null, "Message must be delivered to DLQ");
    assertEquals(dlqMessage.body, poisonPayload);
  },
});

// ============================================================================
// 4. Integration: Provider circuit breaker trip and recovery (Q-6, KV-3, PLAT-10, PLAT-12)
// ============================================================================

Deno.test({
  name:
    "Reliability AC6 - Atomic circuit breaker trips to Open after threshold failures and recovers via Half-Open (Q-6, PLAT-10, PLAT-12)",
  fn: async () => {
    const kv = new SQLiteKVProvider(":memory:");
    const circuitKey = ["circuit", "payment_gateway"];

    let currentTime = 1000;
    const nowProvider = () => currentTime;

    const breaker: CircuitBreaker = createCircuitBreaker(kv, circuitKey, {
      failureThreshold: 3, // Trip after 3 consecutive failures
      cooldownMs: 5000, // 5s cooldown
      halfOpenSuccessThreshold: 2, // 2 successes to close
      nowProvider,
    });

    const failingOp = () =>
      Promise.reject(new Error("Vendor 503 Service Unavailable"));
    const succeedingOp = () => Promise.resolve("success");

    // 1. First 2 failures - state remains Closed
    await assertRejects(() => breaker.execute(failingOp));
    await assertRejects(() => breaker.execute(failingOp));
    assertEquals((await breaker.getState()).state, "Closed");

    // 2. Third failure trips breaker to Open
    await assertRejects(() => breaker.execute(failingOp));
    assertEquals((await breaker.getState()).state, "Open");

    // 3. Fast-fail in Open state: immediately rejects with UnavailableError without executing op
    let opExecuted = false;
    const err = await assertRejects(
      () =>
        breaker.execute(() => {
          opExecuted = true;
          return Promise.resolve("should_not_run");
        }),
      UnavailableError,
    );
    assertEquals(err.code, "UNAVAILABLE");
    assertEquals(
      opExecuted,
      false,
      "Operation must not be invoked when circuit is Open (PLAT-10)",
    );

    // 4. Advance time past cooldown period -> enters Half-Open on next execution
    currentTime += 6000;

    // First trial success in Half-Open
    const res1 = await breaker.execute(succeedingOp);
    assertEquals(res1, "success");
    assertEquals((await breaker.getState()).state, "Half-Open");

    // Second trial success in Half-Open -> resets breaker to Closed
    const res2 = await breaker.execute(succeedingOp);
    assertEquals(res2, "success");
    assertEquals((await breaker.getState()).state, "Closed");
  },
});

// ============================================================================
// 5. Integration: Usage metrics accumulation and export (PLAT-13)
// ============================================================================

Deno.test({
  name:
    "Reliability AC7 - MetricsExporter accumulates usage records and outputs valid OTLP and Prometheus text (PLAT-13)",
  fn: () => {
    const exporter: MetricsExporter = createMetricsExporter();

    const testRecords: UsageRecord[] = [
      {
        timestamp: Date.now(),
        project: "proj_analytics",
        functionName: "api",
        revisionId: "rev_01J8Z000000000000000000001",
        metric: "function.invocation",
        value: 1,
      },
      {
        timestamp: Date.now(),
        project: "proj_analytics",
        functionName: "api",
        revisionId: "rev_01J8Z000000000000000000001",
        metric: "function.error",
        value: 1,
      },
      {
        timestamp: Date.now(),
        project: "proj_analytics",
        functionName: "api",
        revisionId: "rev_01J8Z000000000000000000001",
        metric: "kv.read",
        value: 1,
      },
      {
        timestamp: Date.now(),
        project: "proj_analytics",
        functionName: "api",
        revisionId: "rev_01J8Z000000000000000000001",
        metric: "kv.write",
        value: 1,
      },
    ];

    exporter.consumeBatch(testRecords);

    // Verify in-memory snapshot
    const snapshot = exporter.getSnapshot();
    assertEquals(snapshot.counters["function.invocations"], 1);
    assertEquals(snapshot.counters["function.errors"], 1);
    assertEquals(snapshot.counters["kv.reads"], 1);
    assertEquals(snapshot.counters["kv.writes"], 1);

    // Verify Prometheus text export
    const prometheusText = exporter.toPrometheusText();
    assertMatch(prometheusText, /railfog_function_invocations_total 1/);
    assertMatch(prometheusText, /railfog_function_errors_total 1/);
    assertMatch(prometheusText, /railfog_kv_reads_total 1/);
    assertMatch(prometheusText, /railfog_kv_writes_total 1/);

    // Verify OTLP JSON export conforms to valid JSON structure
    const otlpJson = exporter.toOtlpJson();
    const parsedOtlp = JSON.parse(otlpJson);
    assert(parsedOtlp.resourceMetrics !== undefined);
    assert(Array.isArray(parsedOtlp.resourceMetrics));
  },
});

// ============================================================================
// 6. Security: Tenant prefix isolation (PLAT-7) & Secret redaction (PLAT-15)
// ============================================================================

Deno.test({
  name:
    "Security - AC8, PLAT-7: disaster recovery export and restore enforces strict tenant physical prefix re-scoping",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const objectProvider = new LocalFSProvider(tempDir);
    const kvProvider = new SQLiteKVProvider(":memory:");
    const deploymentService = new DeploymentService(objectProvider);
    const backupService: StateBackupService = createStateBackupService(
      deploymentService,
      kvProvider,
      objectProvider,
    );

    const sourceOrg = "org_production";
    const sourceProj = "proj_app";
    const targetOrg = "org_dr";
    const targetProj = "proj_app_dr";

    // Seed source state
    await kvProvider.set(
      [sourceOrg, sourceProj, "config", "endpoint"],
      "https://api.source.com",
    );
    await objectProvider.put(
      `${sourceOrg}/${sourceProj}/assets/logo.png`,
      new TextEncoder().encode("logo data").buffer as ArrayBuffer,
    );

    // Export source project
    const archive = await backupService.exportProject({
      orgId: sourceOrg,
      projectId: sourceProj,
    });

    // Import into target project
    const importResult = await backupService.importProject({
      targetOrgId: targetOrg,
      targetProjectId: targetProj,
      archive,
    });

    assert(importResult.restoredKvKeys >= 1);
    assert(importResult.restoredObjects >= 1);

    // Assert target project has keys re-scoped to its physical prefix
    const targetKvVal = await kvProvider.get([
      targetOrg,
      targetProj,
      "config",
      "endpoint",
    ]);
    assertEquals(targetKvVal, "https://api.source.com");

    const targetObj = await objectProvider.get(
      `${targetOrg}/${targetProj}/assets/logo.png`,
    );
    assert(targetObj !== null);

    // Source keys remain intact and unmodified
    const sourceKvVal = await kvProvider.get([
      sourceOrg,
      sourceProj,
      "config",
      "endpoint",
    ]);
    assertEquals(sourceKvVal, "https://api.source.com");

    // AC8: Revisions with conflicting hashes in target project are rejected with ConflictError
    const existingArt = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode("existing code"),
    );
    const deployed = await deploymentService.deploy(
      targetProj,
      "api",
      existingArt,
    );

    const conflictArchive = structuredClone(archive);
    conflictArchive.functions = [
      {
        name: "api",
        activeRevisionId: deployed.revisionId,
        revisions: [
          {
            id: deployed.revisionId,
            artifactId:
              "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            state: "Deployed",
            createdAt: Date.now(),
            manifest: existingArt.manifest,
          },
        ],
      },
    ];

    await assertRejects(
      () =>
        backupService.importProject({
          targetOrgId: targetOrg,
          targetProjectId: targetProj,
          archive: conflictArchive,
        }),
      ConflictError,
    );

    // Adversarial PLAT-7: Rejects path traversal and strictly protects source tenant
    await assertRejects(
      () =>
        backupService.importProject({
          targetOrgId: "../victim_org",
          targetProjectId: targetProj,
          archive,
        }),
      ValidationFailedError,
    );

    const sourceKvPost = await kvProvider.get([
      sourceOrg,
      sourceProj,
      "config",
      "endpoint",
    ]);
    assertEquals(sourceKvPost, "https://api.source.com");
  },
});

Deno.test({
  name:
    "Security - PLAT-15: auto-redacts sensitive credentials across provider failures and error normalization",
  fn: () => {
    const sensitiveTokens = [
      "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive_payload",
      "railfog_sec_live_999888777666555444",
      "postgres://admin:SuperSecretPassword123@db.prod.internal:5432/railfog",
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260915/us-east-1/s3/aws4_request",
    ];

    for (const token of sensitiveTokens) {
      const upstreamError = new Error(
        `Connection failed to upstream endpoint with authorization token ${token}`,
      );
      const normalized = normalizeProviderError(upstreamError);

      assert(
        !normalized.message.includes(token),
        `Plaintext secret must not leak in error message (PLAT-15): ${token}`,
      );
      assertMatch(
        normalized.message,
        /\[REDACTED\]/,
        "Secret must be replaced with [REDACTED] (PLAT-15)",
      );

      if (normalized.stack) {
        assert(
          !normalized.stack.includes(token),
          `Plaintext secret must not leak in stack trace (PLAT-15): ${token}`,
        );
      }
    }

    // Adversarial PLAT-15: Composite error containing multiple secrets simultaneously
    const compositeError = new Error(
      "Database connection to postgres://admin:SuperSecretPassword123@db.prod.internal:5432/railfog failed with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive_payload and key railfog_sec_live_999888777666555444",
    );
    const normalizedComposite = normalizeProviderError(compositeError);
    for (const token of sensitiveTokens.slice(0, 3)) {
      assert(
        !normalizedComposite.message.includes(token),
        `Plaintext secret must not leak in composite message (PLAT-15): ${token}`,
      );
      if (normalizedComposite.stack) {
        assert(
          !normalizedComposite.stack.includes(token),
          `Plaintext secret must not leak in composite stack trace (PLAT-15): ${token}`,
        );
      }
    }

    // Adversarial PLAT-15: Nested error .cause chain containing secrets
    const nestedError = new Error("Provider execution failed", {
      cause: new Error(
        "Underlying network error: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive_payload rejected",
      ),
    });
    const normalizedNested = normalizeProviderError(nestedError);
    assert(normalizedNested.cause instanceof Error);
    assert(
      !(normalizedNested.cause as Error).message.includes(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive_payload",
      ),
      "Nested error cause message must be auto-redacted (PLAT-15)",
    );
  },
});
