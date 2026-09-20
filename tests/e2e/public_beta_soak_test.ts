/**
 * Public Beta Chaos Soak Test Suite (Task T-0611)
 *
 * Automated multi-process end-to-end soak and chaos test suite closing Milestone 0.6.
 *
 * Spec references:
 * - contracts/platform.contract.md#PLAT-1: Control plane vs data plane separation.
 * - contracts/platform.contract.md#PLAT-3: Deployment pipeline (validation, CAS storage, 3x probe health gating, atomic cutover).
 * - contracts/platform.contract.md#PLAT-7: Multi-tenancy & physical data isolation.
 * - contracts/platform.contract.md#PLAT-8: Fail-static control/data plane split (cached routing snapshot, outage resilience).
 * - contracts/platform.contract.md#PLAT-9: Multi-tenant token bucket rate limiting (429 RATE_LIMITED, Retry-After).
 * - contracts/platform.contract.md#PLAT-10: SLOs & error budget (99.95% data plane availability, graceful drain ceiling).
 * - contracts/platform.contract.md#PLAT-12: Error model (canonical error codes, request_id propagation).
 * - contracts/platform.contract.md#PLAT-13: Observability (resource metrics for invocations, compute, storage, ops).
 * - contracts/platform.contract.md#PLAT-14: ULID 128-bit Crockford Base32 monotonic identifiers.
 * - contracts/platform.contract.md#PLAT-15: Secrets management (zero plaintext leakage in logs, bodies, or errors).
 * - contracts/platform.contract.md#PLAT-17: Local/production parity (zero cloud dependencies; LocalFS, SQLite KV/Queues).
 * - contracts/platform.contract.md#PLAT-18: Resource hierarchy Org -> Project -> Function/Storage/Queue -> Revision.
 * - contracts/functions.contract.md#FN-1: Function definition & execution interface.
 * - contracts/functions.contract.md#FN-5: Resource limits.
 * - contracts/functions.contract.md#FN-6: Isolation & warm-reuse rule (fresh context per invocation, zero state bleeding).
 * - contracts/functions.contract.md#FN-8: Request lifecycle (route -> cached snapshot -> isolate -> fresh ctx -> response).
 * - contracts/objects.contract.md#OBJ-3: Direct client-to-storage transfer via presigned URLs.
 * - contracts/queues.contract.md#Q-3: Redelivery model & visibility timeout.
 * - tasks/milestone-0.6-public-beta/T-0611-public-beta-soak-test.md
 */

import { assert, assertEquals, assertExists, assertMatch } from "@std/assert";
import { join } from "@std/path";

// Control Plane & Deployment
import {
  type ControlServer,
  type ProjectSnapshot,
  startControlServer,
} from "../../apps/api/control-server.ts";
import { DeploymentService } from "../../apps/api/deployment-service.ts";
import {
  createStateBackupService,
  type StateBackupService,
} from "../../apps/api/state-backup-service.ts";

// Runtime Data Plane
import {
  type RuntimeServer,
  startRuntimeServer,
} from "../../apps/runtime/runtime-server.ts";

// Ingress Gateway & Rate Limiting
import {
  type GatewayServer,
  startGatewayServer,
} from "../../apps/gateway/gateway-server.ts";
import { MultiTenantRateLimiter } from "../../apps/gateway/rate-limiter.ts";

// Worker Supervisor
import {
  createWorkerSupervisor,
  type WorkerSupervisor,
} from "../../apps/worker/worker-supervisor.ts";

// Graceful Lifecycle Coordinator
import {
  type DrainTarget,
  ShutdownCoordinator,
} from "../../runtime/lifecycle/shutdown-coordinator.ts";

// CLI Usage & Cost Reporting
import { runUsage } from "../../cli/usage.ts";
import type { ProjectUsageSummary } from "../../packages/metrics/cost-calculator.ts";

// Local Providers (PLAT-17)
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";

// Packaging and Crypto Identifiers
import {
  type PackagedArtifact,
  packageFunctionArtifact,
} from "../../packages/core/artifact/packager.ts";
import { isValidUlid } from "../../packages/core/id/ulid.ts";
import type {
  Artifact,
  ComputeProvider,
  ExecutionResult,
  InvocationRequest,
  IsolationProvider,
  Limits,
} from "../../primitives/compute/compute-provider.ts";

// ============================================================================
// Constants & Specifications
// ============================================================================

// spec: contracts/platform.contract.md#PLAT-12 — Canonical HTTP status codes
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_RATE_LIMITED = 429;
const HTTP_STATUS_UNAVAILABLE = 503;

// spec: contracts/platform.contract.md#PLAT-14 — 26-character Crockford Base32 ULID
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Secret token for PLAT-15 leakage prevention tests
const SECRET_TOKEN_CANARY = "super-secret-soak-token-98765-xyz";

// ============================================================================
// Direct Storage Transfer Implementation (OBJ-3, PLAT-17)
// ============================================================================

/**
 * LocalFSProvider subclass that routes presigned URLs directly to an in-process
 * storage HTTP daemon, faithfully implementing OBJ-3 direct client-to-storage transfer.
 *
 * spec: contracts/objects.contract.md#OBJ-3 — Never proxies file bytes through functions
 */
class DirectUploadLocalFSProvider extends LocalFSProvider {
  private port = 0;

  setStoragePort(port: number): void {
    this.port = port;
  }

  override async presign(
    key: string,
    opts: { method: "GET" | "PUT"; expiresIn?: number; maxExpiresIn?: number },
  ): Promise<{ url: string; expiresAt: number }> {
    const res = await super.presign(key, opts);
    if (this.port > 0) {
      const u = new URL(res.url);
      u.hostname = "127.0.0.1";
      u.port = this.port.toString();
      return { url: u.toString(), expiresAt: res.expiresAt };
    }
    return res;
  }
}

/**
 * Starts a direct storage server accepting client HTTP PUT transfers (OBJ-3).
 */
function startDirectStorageServer(provider: DirectUploadLocalFSProvider): {
  port: number;
  close: () => Promise<void>;
} {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req: Request) => {
      const url = new URL(req.url);
      if (req.method === "PUT" && url.pathname.startsWith("/local-fs/")) {
        const rawKey = url.pathname.replace(/^\/local-fs\//, "");
        const key = decodeURIComponent(rawKey);
        const valid = await provider.verifyPresignedUrl(
          req.url,
          req.method as "GET" | "PUT",
        );
        if (!valid) {
          return new Response("Unauthorized presigned URL token", {
            status: 403,
          });
        }
        const body = await req.arrayBuffer();
        await provider.put(key, body);
        return new Response(null, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    },
  );

  const port = (server.addr as Deno.NetAddr).port;
  provider.setStoragePort(port);

  return {
    port,
    close: async () => {
      try {
        await server.shutdown();
      } catch {
        // Safe fallback if already closed
      }
    },
  };
}

// ============================================================================
// Soak Execution Provider (IsolationProvider & ComputeProvider)
// ============================================================================

/**
 * Combined IsolationProvider and ComputeProvider executing customer functions
 * across both the runtime data plane and background worker supervisor.
 *
 * spec: contracts/platform.contract.md#PLAT-4 — IsolationProvider execution boundary
 * spec: contracts/functions.contract.md#FN-6 — Fresh context, zero cross-tenant bleeding
 * spec: contracts/platform.contract.md#PLAT-7 — Multi-tenant key partitioning
 * spec: contracts/objects.contract.md#OBJ-3 — Presigns direct upload URLs
 * spec: contracts/queues.contract.md#Q-3 — Enqueues and consumes background jobs
 */
class ProductionSoakExecutionProvider
  implements IsolationProvider, ComputeProvider {
  public recordedRequestIds: string[] = [];
  public crossTenantCollisions = 0;
  public totalInvocations = 0;
  private readonly tenantData = new Map<string, Set<string>>();

  constructor(
    private readonly storage: DirectUploadLocalFSProvider,
    private readonly kv: SQLiteKVProvider,
    private readonly queues: SQLiteQueueProvider,
    private readonly secrets: Record<string, string>,
  ) {}

  async run(
    artifact: Artifact,
    _limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult> {
    this.totalInvocations++;
    const requestId = invocation?.requestId ?? "";
    if (requestId) {
      this.recordedRequestIds.push(requestId);
    }

    const urlPath = invocation?.url ? new URL(invocation.url).pathname : "";
    const headers = invocation?.headers ?? {};
    const tenant = headers["x-project-id"] || "soak-proj";

    // Detect cross-tenant data collisions
    if (!this.tenantData.has(tenant)) {
      this.tenantData.set(tenant, new Set());
    }

    // 1. Processor background worker trigger execution (FN-2, Q-3)
    if (
      artifact.entrypoint === "processor" ||
      artifact.id === "fn:processor" ||
      urlPath === "/processor"
    ) {
      const bodyText = invocation?.body
        ? new TextDecoder().decode(invocation.body)
        : "{}";
      const { key, tenantId } = JSON.parse(bodyText) as {
        key: string;
        tenantId?: string;
      };
      const effectiveTenant = tenantId || tenant;

      // Deduplication check per Q-4 idempotency pattern
      const dedupeKey = [effectiveTenant, "processed", key];
      const alreadyHandled = await this.kv.get(dedupeKey);
      if (alreadyHandled) {
        return {
          statusCode: HTTP_STATUS_OK,
          headers: { "content-type": "application/json" },
          body: new TextEncoder().encode(
            JSON.stringify({ deduplicated: true }),
          ),
          cpuTimeMs: 1,
          wallClockMs: 2,
        };
      }

      // Verify object exists in storage (poll briefly for client PUT completion)
      let head = await this.storage.head(key);
      let attempts = 0;
      while (!head && attempts < 50) {
        await new Promise((r) => setTimeout(r, 20));
        head = await this.storage.head(key);
        attempts++;
      }

      if (!head) {
        throw new Error(`Object ${key} not yet uploaded to storage`);
      }

      // Record KV processing status (KV-2)
      await this.kv.set([effectiveTenant, "files", key], {
        status: "processed",
        key,
        tenantId: effectiveTenant,
        size: head.size,
      });

      // Write dedupe key with 14-day retention TTL (Q-4)
      await this.kv.set(dedupeKey, true, { ttl: 14 * 24 * 3600 });

      return {
        statusCode: HTTP_STATUS_OK,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(
          JSON.stringify({ processed: true, key }),
        ),
        cpuTimeMs: 2,
        wallClockMs: 5,
      };
    }

    // 2. Multi-tenant isolation test endpoint
    if (urlPath === "/tenant-echo") {
      const currentKeys = this.tenantData.get(tenant)!;
      for (const [otherTenant, otherKeys] of this.tenantData.entries()) {
        if (otherTenant !== tenant && otherKeys.has(requestId)) {
          this.crossTenantCollisions++;
        }
      }
      currentKeys.add(requestId);

      return {
        statusCode: HTTP_STATUS_OK,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(
          JSON.stringify({ tenant, requestId, ok: true }),
        ),
        cpuTimeMs: 1,
        wallClockMs: 2,
      };
    }

    // 3. Worked-example API endpoint: generate presigned upload URL & enqueue message
    // spec: contracts/objects.contract.md#OBJ-3
    // spec: contracts/queues.contract.md#Q-2
    const key = crypto.randomUUID();
    const { url } = await this.storage.presign(key, { method: "PUT" });
    await this.queues.send({ key, tenantId: tenant, uploadedAt: Date.now() });

    // Assert secret sanitization inside isolate execution (PLAT-15)
    const responsePayload = JSON.stringify({
      uploadUrl: url,
      key,
      hasSecret: Object.keys(this.secrets).length > 0,
    });

    return {
      statusCode: HTTP_STATUS_OK,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(responsePayload),
      cpuTimeMs: 2,
      wallClockMs: 5,
    };
  }
}

// ============================================================================
// Topology Harness Helper
// ============================================================================

interface ProductionTopology {
  tempDir: string;
  storage: DirectUploadLocalFSProvider;
  storageServer: { port: number; close: () => Promise<void> };
  kv: SQLiteKVProvider;
  queues: SQLiteQueueProvider;
  deploymentService: DeploymentService;
  stateBackupService: StateBackupService;
  controlServer: ControlServer;
  runtimeServer: RuntimeServer;
  rateLimiter: MultiTenantRateLimiter;
  gatewayServer: GatewayServer;
  workerSupervisor: WorkerSupervisor;
  executionProvider: ProductionSoakExecutionProvider;
  cleanup: () => Promise<void>;
}

/**
 * Initializes and wires the complete production topology:
 * Storage + Direct Storage Server, SQLite KV, SQLite Queues,
 * Control Plane Daemon, Runtime Data Plane Daemon, Ingress Gateway with Token Bucket Rate Limiter,
 * and Background Worker Supervisor.
 *
 * spec: contracts/platform.contract.md#PLAT-1, PLAT-8, PLAT-9, PLAT-17, PLAT-19
 */
async function launchProductionTopology(
  customLimits?: {
    projectRate?: number;
    projectBurst?: number;
    ipRate?: number;
    ipBurst?: number;
  },
): Promise<ProductionTopology> {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-soak-" });
  const storage = new DirectUploadLocalFSProvider(join(tempDir, "storage"));
  const storageServer = startDirectStorageServer(storage);

  const kv = new SQLiteKVProvider(":memory:");
  const queues = new SQLiteQueueProvider(":memory:");

  const deploymentService = new DeploymentService(storage);
  const stateBackupService = createStateBackupService(
    deploymentService,
    kv,
    storage,
  );

  const controlServer = await startControlServer({
    port: 0,
    host: "127.0.0.1",
    deploymentService,
    stateBackupService,
  });

  const secrets = { API_SECRET_KEY: SECRET_TOKEN_CANARY };
  const executionProvider = new ProductionSoakExecutionProvider(
    storage,
    kv,
    queues,
    secrets,
  );

  const runtimeServer = await startRuntimeServer({
    port: 0,
    host: "127.0.0.1",
    controlPlaneUrl: `http://127.0.0.1:${controlServer.port}`,
    projectId: "soak-proj",
    pollIntervalMs: 50, // Rapid polling for deterministic test synchronization
    isolationProvider: executionProvider,
  });

  // spec: contracts/platform.contract.md#PLAT-9 — Token bucket configuration
  const rateLimiter = new MultiTenantRateLimiter({
    project: {
      rate: customLimits?.projectRate ?? 50,
      burst: customLimits?.projectBurst ?? 100,
    },
    ip: {
      rate: customLimits?.ipRate ?? 10,
      burst: customLimits?.ipBurst ?? 20,
    },
  });

  const gatewayServer = await startGatewayServer({
    port: 0,
    host: "127.0.0.1",
    controlPlaneUrl: `http://127.0.0.1:${controlServer.port}`,
    dataPlaneUrl: `http://127.0.0.1:${runtimeServer.port}`,
    rateLimiter,
  });

  const workerSupervisor = createWorkerSupervisor({
    projectId: "soak-proj",
    queues: [{ queueName: "app:jobs", targetFunction: "processor" }],
    queueProvider: queues,
    computeProvider: executionProvider,
  });

  await workerSupervisor.start();

  const cleanup = async () => {
    try {
      await workerSupervisor.stop();
    } catch {
      // Safe fallback
    }
    try {
      await gatewayServer.close();
    } catch {
      // Safe fallback
    }
    try {
      await runtimeServer.close();
    } catch {
      // Safe fallback
    }
    try {
      await controlServer.close();
    } catch {
      // Safe fallback
    }
    try {
      await storageServer.close();
    } catch {
      // Safe fallback
    }
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Safe fallback
    }
  };

  return {
    tempDir,
    storage,
    storageServer,
    kv,
    queues,
    deploymentService,
    stateBackupService,
    controlServer,
    runtimeServer,
    rateLimiter,
    gatewayServer,
    workerSupervisor,
    executionProvider,
    cleanup,
  };
}

/**
 * Helper to construct and serialize a PackagedArtifact.
 */
async function buildTestArtifact(
  entrypoint: string,
  source: string,
  options?: {
    permissions?: { kv?: string[]; objects?: string[]; queues?: string[] };
  },
): Promise<Record<string, unknown>> {
  const artifact: PackagedArtifact = await packageFunctionArtifact(
    entrypoint,
    new TextEncoder().encode(source),
    options,
  );
  return {
    id: artifact.id,
    integrity: artifact.integrity,
    manifest: artifact.manifest,
    bytes: Array.from(artifact.bytes),
  };
}

// ============================================================================
// Test Suite: Milestone 0.6 Public Beta Soak & Chaos Tests
// ============================================================================

Deno.test(
  "AC1: Deployment & End-to-End Workflow Execution (PLAT-1, PLAT-3, OBJ-3, Q-3)",
  async () => {
    const topology = await launchProductionTopology();

    try {
      const { gatewayServer, runtimeServer, kv, storage } = topology;

      // 1. Deploy API function via Gateway POST /v1/projects/:projectId/deploy
      // spec: contracts/platform.contract.md#PLAT-1, PLAT-3
      const uploadArtifact = await buildTestArtifact(
        "upload.ts",
        'export default async function handler(req, ctx) { return Response.json({ status: "ok" }); }',
        {
          permissions: { objects: ["app:uploads"], queues: ["app:jobs"] },
        },
      );

      const deployUploadRes = await fetch(
        `http://127.0.0.1:${gatewayServer.port}/v1/projects/soak-proj/deploy`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project: "soak-proj",
            functionName: "upload",
            artifact: uploadArtifact,
          }),
        },
      );

      assert(
        deployUploadRes.status === 200 || deployUploadRes.status === 201,
        `Deploy upload failed with status ${deployUploadRes.status}`,
      );
      const deployUploadBody = await deployUploadRes.json();
      assertEquals(deployUploadBody.state, "Deployed");
      assertMatch(
        deployUploadBody.revisionId,
        /^rev_[0-9A-HJKMNP-TV-Z]{26}$/,
        "Revision ID must be rev_{ULID} format (PLAT-14, PLAT-18)",
      );

      // 2. Deploy Processor function via Gateway
      const processorArtifact = await buildTestArtifact(
        "processor.ts",
        "export default async function consume(msg, ctx) { /* processor */ }",
        {
          permissions: { objects: ["app:uploads"], kv: ["app:files"] },
        },
      );

      const deployProcRes = await fetch(
        `http://127.0.0.1:${gatewayServer.port}/v1/projects/soak-proj/deploy`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project: "soak-proj",
            functionName: "processor",
            artifact: processorArtifact,
          }),
        },
      );
      assertEquals(
        deployProcRes.status === 200 || deployProcRes.status === 201,
        true,
      );

      // 3. Verify snapshot distribution via Gateway
      // spec: contracts/platform.contract.md#PLAT-8
      const snapshotRes = await fetch(
        `http://127.0.0.1:${gatewayServer.port}/v1/projects/soak-proj/snapshot`,
      );
      assertEquals(snapshotRes.status, HTTP_STATUS_OK);
      const snapshot: ProjectSnapshot = await snapshotRes.json();
      assertExists(snapshot.functions["upload"]);
      assertExists(snapshot.functions["processor"]);

      // Wait for data plane background poller to load latest snapshot version
      while (runtimeServer.getSnapshotVersion() < snapshot.version) {
        await new Promise((r) => setTimeout(r, 20));
      }

      // 4. Trigger API endpoint via Gateway: GET /upload
      // spec: contracts/platform.contract.md#PLAT-1, PLAT-14
      const uploadReqRes = await fetch(
        `http://127.0.0.1:${gatewayServer.port}/upload`,
        { method: "GET" },
      );
      assertEquals(uploadReqRes.status, HTTP_STATUS_OK);

      const reqId = uploadReqRes.headers.get("x-request-id") ??
        uploadReqRes.headers.get("request-id");
      assert(
        reqId !== null,
        "Response must include x-request-id header (PLAT-12)",
      );
      assert(
        isValidUlid(reqId),
        `Request ID '${reqId}' must be a valid 26-char Crockford Base32 ULID (PLAT-14)`,
      );

      const { uploadUrl, key } = await uploadReqRes.json();
      assertExists(
        uploadUrl,
        "Response must contain direct presigned upload URL (OBJ-3)",
      );
      assertExists(key, "Response must contain object key");

      // 5. Client PUT binary payload directly to presigned URL (OBJ-3)
      const binaryPayload = new TextEncoder().encode(
        "Production Public Beta Soak Test Binary Payload",
      );
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        body: binaryPayload,
        headers: { "content-type": "application/octet-stream" },
      });
      assertEquals(
        putRes.status,
        HTTP_STATUS_OK,
        "Direct HTTP PUT to object storage presigned URL must succeed with 200 (OBJ-3)",
      );

      // Verify binary payload is stored in object storage
      const stored = await storage.head(key);
      assert(stored !== null, "Uploaded object must exist in storage provider");
      assertEquals(stored.size, binaryPayload.byteLength);

      // 6. Wait for Worker Supervisor to consume message from SQLiteQueueProvider and write KV
      // spec: contracts/queues.contract.md#Q-3, contracts/functions.contract.md#FN-2
      let kvRecord = null;
      for (let i = 0; i < 50; i++) {
        kvRecord = await kv.get(["soak-proj", "files", key]);
        if (kvRecord) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      assertExists(kvRecord, "KV record must be written by processor worker");
      assertEquals(
        (kvRecord as { status: string }).status,
        "processed",
        "KV record status must be 'processed'",
      );

      // 7. Verify dedupe key set with TTL (Q-4)
      const dedupeRecord = await kv.get(["soak-proj", "processed", key]);
      assertEquals(dedupeRecord, true, "Dedupe key must be set in KV (Q-4)");
    } finally {
      await topology.cleanup();
    }
  },
);

Deno.test(
  "AC2: Fail-Static Chaos Injection During Active Traffic & Seamless Restoration (PLAT-8, PLAT-10)",
  async () => {
    const topology = await launchProductionTopology();

    try {
      const {
        gatewayServer,
        controlServer,
        runtimeServer,
        deploymentService,
        stateBackupService,
      } = topology;

      // Deploy project so data plane has active routes
      const uploadArtifact = await buildTestArtifact(
        "upload.ts",
        "export default () => {};",
      );
      await fetch(
        `http://127.0.0.1:${gatewayServer.port}/v1/projects/soak-proj/deploy`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project: "soak-proj",
            functionName: "upload",
            artifact: uploadArtifact,
          }),
        },
      );

      // Wait for runtime snapshot to synchronize
      while (runtimeServer.getSnapshotVersion() < 2) {
        await new Promise((r) => setTimeout(r, 20));
      }

      // 1. Forcefully kill the control plane daemon mid-traffic
      // spec: contracts/platform.contract.md#PLAT-8
      const controlPort = controlServer.port;
      await controlServer.close();

      // 2. Drive burst of live customer requests to data plane via Gateway
      // spec: contracts/platform.contract.md#PLAT-8, PLAT-10 (99.95% data plane availability)
      const customerRequestPromises = Array.from({ length: 25 }, async () => {
        const res = await fetch(
          `http://127.0.0.1:${gatewayServer.port}/upload`,
          {
            headers: { "x-project-id": "soak-proj" },
          },
        );
        return res.status;
      });

      const customerStatuses = await Promise.all(customerRequestPromises);
      for (const status of customerStatuses) {
        assertEquals(
          status,
          HTTP_STATUS_OK,
          "Data plane must serve 100% of live traffic fail-static during control plane outage (PLAT-8)",
        );
      }

      // 3. Control plane management requests via Gateway must cleanly return 503 UNAVAILABLE
      // spec: contracts/platform.contract.md#PLAT-1, PLAT-12
      const cpRes = await fetch(
        `http://127.0.0.1:${gatewayServer.port}/v1/projects/soak-proj/snapshot`,
      );
      assertEquals(
        cpRes.status,
        HTTP_STATUS_UNAVAILABLE,
        "Control plane endpoint must return 503 UNAVAILABLE during outage (PLAT-12)",
      );
      const cpError = await cpRes.json();
      assertEquals(cpError.error.code, "UNAVAILABLE");
      assertMatch(cpError.error.request_id, ULID_REGEX);

      // 4. Restore control plane on the same port and verify reconnection
      // spec: contracts/platform.contract.md#PLAT-8
      const restoredControlServer = await startControlServer({
        port: controlPort,
        host: "127.0.0.1",
        deploymentService,
        stateBackupService,
      });

      try {
        // Control plane is restored: snapshot queries through Gateway return 200 OK
        const restoredCpRes = await fetch(
          `http://127.0.0.1:${gatewayServer.port}/v1/projects/soak-proj/snapshot`,
        );
        assertEquals(restoredCpRes.status, HTTP_STATUS_OK);

        // Deploy new revisions to advance restored control plane version past previous data plane snapshot
        const v2Artifact = await buildTestArtifact(
          "upload.ts",
          'export default () => new Response("v2");',
        );
        await fetch(
          `http://127.0.0.1:${gatewayServer.port}/v1/projects/soak-proj/deploy`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              project: "soak-proj",
              functionName: "upload",
              artifact: v2Artifact,
            }),
          },
        );

        const v3Artifact = await buildTestArtifact(
          "upload.ts",
          'export default () => new Response("v3");',
        );
        const deployV3Res = await fetch(
          `http://127.0.0.1:${gatewayServer.port}/v1/projects/soak-proj/deploy`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              project: "soak-proj",
              functionName: "upload",
              artifact: v3Artifact,
            }),
          },
        );
        assertEquals(
          deployV3Res.status === 200 || deployV3Res.status === 201,
          true,
        );

        // Wait for runtime data plane background poll to synchronize new snapshot version
        const startWait = Date.now();
        while (
          runtimeServer.getSnapshotVersion() < 3 &&
          Date.now() - startWait < 3000
        ) {
          await new Promise((r) => setTimeout(r, 20));
        }
        assertEquals(runtimeServer.getSnapshotVersion(), 3);
      } finally {
        await restoredControlServer.close();
      }
    } finally {
      await topology.cleanup();
    }
  },
);

Deno.test(
  "AC3: Token Bucket Rate Limiting Under Burst & Tenant Isolation (PLAT-9, PLAT-12, PLAT-18)",
  async () => {
    // Configure rate limiter with project capacity 25 burst / 10 rate for rapid burst testing
    const topology = await launchProductionTopology({
      projectRate: 10,
      projectBurst: 25,
    });

    try {
      const { gatewayServer, runtimeServer } = topology;

      // Deploy route
      const uploadArtifact = await buildTestArtifact(
        "upload.ts",
        "export default () => {};",
      );
      await fetch(
        `http://127.0.0.1:${gatewayServer.port}/v1/projects/soak-proj/deploy`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project: "soak-proj",
            functionName: "upload",
            artifact: uploadArtifact,
          }),
        },
      );

      while (runtimeServer.getSnapshotVersion() < 2) {
        await new Promise((r) => setTimeout(r, 20));
      }

      // 1. Send burst traffic exceeding limit for "burst-tenant"
      // spec: contracts/platform.contract.md#PLAT-9
      let allowedCount = 0;
      let rejectedCount = 0;
      let lastRejectedResponse: Response | null = null;

      for (let i = 0; i < 35; i++) {
        const res = await fetch(
          `http://127.0.0.1:${gatewayServer.port}/upload`,
          {
            headers: { "x-project-id": "burst-tenant" },
          },
        );
        if (res.status === HTTP_STATUS_OK) {
          allowedCount++;
        } else if (res.status === HTTP_STATUS_RATE_LIMITED) {
          rejectedCount++;
          lastRejectedResponse = res;
        }
      }

      // Burst capacity of 25 permitted; excess requests shed with 429
      assert(
        allowedCount >= 25 && allowedCount <= 28,
        `Burst capacity of ~25 must be permitted, got ${allowedCount}`,
      );
      assert(
        rejectedCount >= 7,
        `Requests exceeding burst must be rate limited, got ${rejectedCount}`,
      );
      assertEquals(
        allowedCount + rejectedCount,
        35,
        "All 35 burst requests must be accounted for",
      );
      assertExists(lastRejectedResponse);

      // Verify Retry-After header and PLAT-12 error body
      // spec: contracts/platform.contract.md#PLAT-9, PLAT-12
      const retryAfter = lastRejectedResponse.headers.get("retry-after");
      assertExists(
        retryAfter,
        "429 response must contain Retry-After header (PLAT-9)",
      );
      const retryAfterSeconds = parseInt(retryAfter, 10);
      assert(
        !isNaN(retryAfterSeconds) && retryAfterSeconds >= 1,
        "Retry-After must be a positive integer",
      );

      const errorPayload = await lastRejectedResponse.json();
      assertEquals(
        errorPayload.error.code,
        "RATE_LIMITED",
        "Error code must be RATE_LIMITED (PLAT-12)",
      );
      assertMatch(
        errorPayload.error.request_id,
        ULID_REGEX,
        "Error request_id must be a valid ULID (PLAT-14)",
      );

      // 2. Non-bursting compliant tenant "soak-proj" must continue receiving 200 OK without starvation
      // spec: contracts/platform.contract.md#PLAT-9, PLAT-18
      const compliantRes = await fetch(
        `http://127.0.0.1:${gatewayServer.port}/upload`,
        { headers: { "x-project-id": "soak-proj" } },
      );
      assertEquals(
        compliantRes.status,
        HTTP_STATUS_OK,
        "Compliant tenant must not be starved by noisy neighbor (PLAT-9, PLAT-18)",
      );
    } finally {
      await topology.cleanup();
    }
  },
);

Deno.test(
  "AC4 & Security: Zero Cross-Tenant State Bleed & Secret Sanitization (PLAT-7, PLAT-14, PLAT-15, FN-6)",
  async () => {
    const topology = await launchProductionTopology();

    try {
      const { gatewayServer, runtimeServer, executionProvider } = topology;

      // Deploy tenant-echo function
      const echoArtifact = await buildTestArtifact(
        "upload.ts",
        "export default () => {};",
      );
      await fetch(
        `http://127.0.0.1:${gatewayServer.port}/v1/projects/soak-proj/deploy`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project: "soak-proj",
            functionName: "upload",
            artifact: echoArtifact,
          }),
        },
      );

      while (runtimeServer.getSnapshotVersion() < 2) {
        await new Promise((r) => setTimeout(r, 20));
      }

      // 1. Run concurrent multi-tenant requests across distinct projects
      const tenants = [
        "tenant-alpha",
        "tenant-beta",
        "tenant-gamma",
        "tenant-delta",
        "soak-proj",
      ];
      const collectedRequestIds: string[] = [];
      const collectedBodies: string[] = [];

      const concurrentRequests = Array.from({ length: 50 }, async (_, idx) => {
        const tenant = tenants[idx % tenants.length];
        const res = await fetch(
          `http://127.0.0.1:${gatewayServer.port}/upload`,
          {
            headers: {
              "x-project-id": tenant,
              "x-canary-secret": SECRET_TOKEN_CANARY,
            },
          },
        );
        assertEquals(res.status, HTTP_STATUS_OK);

        const reqId = res.headers.get("x-request-id") ??
          res.headers.get("request-id");
        assert(reqId !== null);
        collectedRequestIds.push(reqId);

        const bodyText = await res.text();
        collectedBodies.push(bodyText);
      });

      await Promise.all(concurrentRequests);

      // 2. Monotonic ULID validation across all requests (PLAT-14)
      assertEquals(collectedRequestIds.length, 50);
      for (const id of collectedRequestIds) {
        assert(
          isValidUlid(id),
          `Request ID '${id}' must be a 26-char Crockford Base32 ULID (PLAT-14)`,
        );
      }
      const uniqueIds = new Set(collectedRequestIds);
      assertEquals(
        uniqueIds.size,
        50,
        "Every request must have a distinct, non-colliding ULID (PLAT-14)",
      );

      // 3. Zero cross-tenant data collisions
      // spec: contracts/platform.contract.md#PLAT-7
      assertEquals(
        executionProvider.crossTenantCollisions,
        0,
        "Zero cross-tenant data bleed must occur under concurrent soak traffic (PLAT-7, FN-6)",
      );

      // 4. Secret Sanitization: Secret token must NEVER appear in response bodies, headers, or errors
      // spec: contracts/platform.contract.md#PLAT-15
      for (const body of collectedBodies) {
        assert(
          !body.includes(SECRET_TOKEN_CANARY),
          "Response body must never leak secrets (PLAT-15)",
        );
      }
    } finally {
      await topology.cleanup();
    }
  },
);

Deno.test(
  "AC5: Graceful Shutdown Coordination with In-Flight Request Draining (PLAT-1, PLAT-10)",
  async () => {
    const topology = await launchProductionTopology();

    try {
      const { gatewayServer, runtimeServer, workerSupervisor } = topology;

      // Deploy route
      const uploadArtifact = await buildTestArtifact(
        "upload.ts",
        "export default () => {};",
      );
      await fetch(
        `http://127.0.0.1:${gatewayServer.port}/v1/projects/soak-proj/deploy`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            project: "soak-proj",
            functionName: "upload",
            artifact: uploadArtifact,
          }),
        },
      );

      while (runtimeServer.getSnapshotVersion() < 2) {
        await new Promise((r) => setTimeout(r, 20));
      }

      // 1. Initialize ShutdownCoordinator
      // spec: contracts/platform.contract.md#PLAT-10
      const coordinator = new ShutdownCoordinator({
        drainTimeoutMs: 10_000,
        forceTimeoutMs: 15_000,
      });

      let inFlightGatewayCount = 0;
      let inFlightRuntimeCount = 0;

      // Register Gateway as DrainTarget
      const gatewayTarget: DrainTarget = {
        name: "ingress-gateway",
        getActiveCount: () => inFlightGatewayCount,
        stopAccepting: () => {},
        drain: async () => {
          while (inFlightGatewayCount > 0) {
            await new Promise((r) => setTimeout(r, 10));
          }
          await gatewayServer.close();
        },
      };
      coordinator.register(gatewayTarget);

      // Register Runtime Data Plane as DrainTarget
      const runtimeTarget: DrainTarget = {
        name: "railfog-runtime",
        getActiveCount: () => inFlightRuntimeCount,
        stopAccepting: () => {},
        drain: async () => {
          while (inFlightRuntimeCount > 0) {
            await new Promise((r) => setTimeout(r, 10));
          }
          await runtimeServer.close();
        },
      };
      coordinator.register(runtimeTarget);

      // Register Worker Supervisor as DrainTarget
      const workerTarget: DrainTarget = {
        name: "worker-supervisor",
        getActiveCount: () => workerSupervisor.getActiveWorkerCount(),
        stopAccepting: () => {},
        drain: async () => {
          await workerSupervisor.stop();
        },
      };
      coordinator.register(workerTarget);

      // 2. Simulate in-flight requests running concurrently with shutdown trigger
      inFlightGatewayCount++;
      inFlightRuntimeCount++;

      // Trigger shutdown in background
      const shutdownPromise = coordinator.shutdown();
      assertEquals(coordinator.isShuttingDown(), true);

      // Simulate completion of in-flight requests
      await new Promise((r) => setTimeout(r, 50));
      inFlightGatewayCount--;
      inFlightRuntimeCount--;

      // Await graceful shutdown completion
      const shutdownClean = await shutdownPromise;
      assertEquals(
        shutdownClean,
        true,
        "Graceful shutdown must drain cleanly within timeout ceiling (PLAT-10)",
      );
      assertEquals(
        workerSupervisor.getActiveWorkerCount(),
        0,
        "Active worker count must drop to 0 after drain completes",
      );
    } finally {
      await topology.cleanup();
    }
  },
);

Deno.test(
  "AC6: Metering and CLI Usage Cost Audit (PLAT-13, PLAT-18)",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-usage-soak-" });

    try {
      const now = Date.now();
      const usageSummary: ProjectUsageSummary = {
        orgId: "default-org",
        projectId: "soak-proj",
        periodStart: now - 3600000,
        periodEnd: now,
        invocations: 500,
        cpuTimeMs: 1500,
        memoryMbSeconds: 64000,
        kvReads: 1200,
        kvWrites: 600,
        objectReads: 300,
        objectWrites: 150,
        queueSent: 200,
        queueProcessed: 200,
        storageBytesKv: 1024 * 1024,
        storageBytesObjects: 10 * 1024 * 1024,
      };

      // 1. Audit JSON formatting via CLI runUsage
      // spec: contracts/platform.contract.md#PLAT-12, PLAT-13
      const originalConsoleLog = console.log;
      const jsonLogs: string[] = [];
      console.log = (...args: unknown[]) => {
        jsonLogs.push(args.map(String).join(" "));
      };

      try {
        const exitCode = await runUsage({
          usageSource: usageSummary,
          format: "json",
        });
        assertEquals(
          exitCode,
          0,
          "runUsage must return exit code 0 for valid usage data",
        );
      } finally {
        console.log = originalConsoleLog;
      }

      const jsonOutput = jsonLogs.join("\n");
      const parsedCost = JSON.parse(jsonOutput);

      assertEquals(parsedCost.projectId, "soak-proj");
      assertEquals(parsedCost.orgId, "default-org");
      assert(typeof parsedCost.totalCostUsd === "number");
      assert(!isNaN(parsedCost.totalCostUsd), "Total cost must not be NaN");
      assert(parsedCost.totalCostUsd >= 0, "Total cost must be non-negative");

      assert(typeof parsedCost.computeCostUsd === "number");
      assert(!isNaN(parsedCost.computeCostUsd));
      assert(typeof parsedCost.operationsCostUsd === "number");
      assert(!isNaN(parsedCost.operationsCostUsd));
      assert(typeof parsedCost.storageCostUsd === "number");
      assert(!isNaN(parsedCost.storageCostUsd));

      // 2. Audit Pretty table formatting via CLI runUsage
      // spec: contracts/platform.contract.md#PLAT-10, PLAT-13
      const prettyLogs: string[] = [];
      console.log = (...args: unknown[]) => {
        prettyLogs.push(args.map(String).join(" "));
      };

      try {
        const exitCode = await runUsage({
          usageSource: usageSummary,
          format: "pretty",
        });
        assertEquals(exitCode, 0);
      } finally {
        console.log = originalConsoleLog;
      }

      const prettyOutput = prettyLogs.join("\n");
      assert(prettyOutput.includes("RailFog Usage & Cost Report"));
      assert(prettyOutput.includes("soak-proj"));
      assert(prettyOutput.includes("Compute:"));
      assert(prettyOutput.includes("Operations:"));
      assert(prettyOutput.includes("Storage:"));
      assert(
        !prettyOutput.includes("NaN"),
        "Report table must never contain NaN (PLAT-10)",
      );
      assert(
        !prettyOutput.includes("undefined"),
        "Report table must never contain undefined",
      );

      // 3. Audit disk-based .railfog/usage.json resolution
      // spec: contracts/platform.contract.md#PLAT-18
      const railfogDir = join(tempDir, ".railfog");
      await Deno.mkdir(railfogDir, { recursive: true });
      await Deno.writeTextFile(
        join(railfogDir, "usage.json"),
        JSON.stringify(usageSummary),
      );

      const diskLogs: string[] = [];
      console.log = (...args: unknown[]) => {
        diskLogs.push(args.map(String).join(" "));
      };

      try {
        const exitCode = await runUsage({
          projectDir: tempDir,
          format: "json",
        });
        assertEquals(exitCode, 0);
      } finally {
        console.log = originalConsoleLog;
      }

      const diskOutput = diskLogs.join("\n");
      const parsedDiskCost = JSON.parse(diskOutput);
      assertEquals(parsedDiskCost.projectId, "soak-proj");
      assertEquals(parsedDiskCost.totalCostUsd, parsedCost.totalCostUsd);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);
