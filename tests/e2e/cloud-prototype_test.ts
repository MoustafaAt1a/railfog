/**
 * Cloud Prototype End-to-End Test Suite (Task T-0211)
 *
 * Exercises the canonical worked example (docs/contracts/worked-example.md)
 * across the control plane and data plane (docs/contracts/platform.contract.md PLAT-1):
 * - Control plane revision deployment pipeline (DeploymentService, PLAT-3, OBJ-4).
 * - CLI deploy command (deployCommand, PLAT-3, PLAT-14).
 * - Data plane request routing and fail-static snapshot cache (RuntimeSnapshotCache, PLAT-8, PLAT-11).
 * - Direct client-to-storage transfer via presigned URL (OBJ-2, OBJ-3).
 * - Background queue consumer worker dispatching queue triggers to processor (FN-2, Q-2, Q-3).
 * - Composed KV idempotency pattern with TTL retention (Q-4, KV-2).
 * - Fail-static split: data plane continues serving uninterrupted when control plane fails (PLAT-8, PLAT-12).
 * - Capability injection guarantees and tenant isolation (PLAT-6, PLAT-7).
 *
 * Zero external cloud dependency per PLAT-17 (LocalFSProvider, SQLiteKVProvider, SQLiteQueueProvider).
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { deployCommand } from "../../cli/deploy.ts";
import { DeploymentService } from "../../apps/api/deployment-service.ts";
import { RuntimeSnapshotCache } from "../../runtime/snapshot/snapshot-cache.ts";
import { matchRoute } from "../../runtime/router/route-matcher.ts";
import { QueueConsumerWorker } from "../../apps/worker/queue-consumer.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { R2Provider } from "../../providers/objects/r2-provider.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";
import { SnapshotDistributor } from "../../packages/protocol/snapshot.ts";
import { isValidUlid } from "../../packages/core/id/ulid.ts";
import { resolvePermissions } from "../../packages/policy/permission-resolver.ts";
import {
  buildContext,
  type LoadedFunctionMeta,
  type RailFogContext,
} from "../../runtime/loader/context-builder.ts";
import { loadFunction } from "../../runtime/loader/function-loader.ts";
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type { QueueMessage } from "../../primitives/queues/queue-provider.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";

// ============================================================================
// Fixture Helpers: Canonical upload-demo application per worked-example.md
// ============================================================================

const TOML_CONFIG = `name = "upload-demo"

[functions.api]
entry = "functions/api.ts"
[functions.api.permissions]
objects = ["app:uploads"]
queues = ["app:jobs"]

[functions.processor]
entry = "functions/processor.ts"
[functions.processor.triggers]
queue = "app:jobs"
[functions.processor.permissions]
objects = ["app:uploads"]
kv = ["app:files"]

[[routes]]
pattern = "/upload"
function = "api"
`;

const API_SOURCE = `// functions/api.ts — worked-example.md
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const key = crypto.randomUUID();
  const { url } = await ctx.objects.presign(key, { method: "PUT" });   // OBJ-2
  await ctx.queues.send({ key, uploadedAt: Date.now() });               // Q-2
  return Response.json({ uploadUrl: url, key });
}
`;

const PROCESSOR_SOURCE = `// functions/processor.ts — worked-example.md
export default async function consume(message: any, ctx: any): Promise<void> {
  const { key } = message.body as { key: string };

  const dedupeKey = ["processed", key];                                 // Q-4
  if (await ctx.kv.get(dedupeKey)) return;

  const stream = await ctx.objects.get(key);                            // OBJ-2
  if (!stream) return;                                                  // object not yet uploaded — safe no-op (Q-3)

  await ctx.kv.set(["files", key], { status: "processed" });            // KV-2
  await ctx.kv.set(dedupeKey, true, { ttl: 14 * 24 * 3600 });            // Q-4, ttl matches retention_days
}
`;

/**
 * Creates the canonical upload-demo application directory structure.
 */
async function setupUploadDemoProject(dir: string): Promise<void> {
  await Deno.writeTextFile(join(dir, "railfog.toml"), TOML_CONFIG);
  const functionsDir = join(dir, "functions");
  await Deno.mkdir(functionsDir, { recursive: true });
  await Deno.writeTextFile(join(functionsDir, "api.ts"), API_SOURCE);
  await Deno.writeTextFile(
    join(functionsDir, "processor.ts"),
    PROCESSOR_SOURCE,
  );
}

/**
 * DirectUploadLocalFSProvider: LocalFSProvider wrapper that preserves all
 * real filesystem operations while directing presigned URLs to an in-process
 * direct storage HTTP endpoint.
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
      u.port = this.port.toString();
      return { url: u.toString(), expiresAt: res.expiresAt };
    }
    return res;
  }
}

/**
 * Starts an in-process direct storage HTTP server that accepts PUT uploads
 * verifying presigned URL tokens, faithfully implementing OBJ-3 direct transfer.
 */
function startDirectStorageServer(provider: DirectUploadLocalFSProvider): {
  port: number;
  close: () => Promise<void>;
} {
  const server = Deno.serve({ port: 0 }, async (req: Request) => {
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
  });

  const port = (server.addr as Deno.NetAddr).port;
  provider.setStoragePort(port);

  return {
    port,
    close: () => server.shutdown(),
  };
}

/**
 * Starts a real data plane HTTP server utilizing RuntimeSnapshotCache,
 * matchRoute, and dynamic capability injection per FN-8 and PLAT-8.
 */
function startDataPlaneServer(
  snapshotCache: RuntimeSnapshotCache,
  providers: {
    kv: SQLiteKVProvider;
    objects: DirectUploadLocalFSProvider;
    queues: SQLiteQueueProvider;
  },
  projectDir: string,
  orgId = "local-org",
  projectId = "upload-demo",
): {
  port: number;
  url: string;
  close: () => Promise<void>;
} {
  const server = Deno.serve(
    { port: 0 },
    async (req: Request): Promise<Response> => {
      // 1. Synchronously get latest snapshot from cache — zero network calls (PLAT-8)
      const snapshot = snapshotCache.getLatestSnapshot();
      if (!snapshot) {
        return Response.json(
          { error: "UNAVAILABLE", message: "Snapshot not loaded" },
          { status: 503 },
        );
      }

      const url = new URL(req.url);

      // 2. Specificity routing (PLAT-11)
      const matchedRoute = matchRoute(snapshot.routes, url.pathname);
      if (!matchedRoute) {
        return Response.json(
          {
            error: "RESOURCE_NOT_FOUND",
            message: `No route for ${url.pathname}`,
          },
          { status: 404 },
        );
      }

      // 3. Resolve function snapshot
      const fnSnapshot = snapshot.functions[matchedRoute.function];
      if (!fnSnapshot) {
        return Response.json(
          {
            error: "RESOURCE_NOT_FOUND",
            message: `Function ${matchedRoute.function} missing`,
          },
          { status: 404 },
        );
      }

      // 4. Resolve capability bindings (PLAT-6, PLAT-7)
      const resolvedBindings = resolvePermissions(
        fnSnapshot.permissions,
        orgId,
        projectId,
        providers,
      );

      // 5. Build execution context with ULID request-id (FN-4, PLAT-12, PLAT-14)
      const fnMeta: LoadedFunctionMeta = {
        project: projectId,
        function: matchedRoute.function,
        revision: fnSnapshot.revisionId,
        timeout_ms: fnSnapshot.limits.timeout_ms,
      };
      const ctx = buildContext(fnMeta, resolvedBindings);

      // 6. Load and execute function handler (FN-1, FN-6)
      const entryPath = join(
        projectDir,
        "functions",
        `${matchedRoute.function}.ts`,
      );
      const loaded = await loadFunction(entryPath, {
        revision: fnSnapshot.revisionId,
      });
      const response = await loaded.handler(req, ctx);

      // 7. Attach PLAT-12/PLAT-14 ULID request-id header
      response.headers.set("request-id", ctx.requestId);
      response.headers.set("x-request-id", ctx.requestId);
      return response;
    },
  );

  const port = (server.addr as Deno.NetAddr).port;
  return {
    port,
    url: `http://localhost:${port}`,
    close: () => server.shutdown(),
  };
}

// ============================================================================
// Acceptance Criteria Tests
// ============================================================================

Deno.test(
  "AC1: Canonical upload-demo application deployed via deployCommand stores artifacts and activates revisions (PLAT-3, PLAT-14, OBJ-4)",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const storageDir = await Deno.makeTempDir();

    try {
      await setupUploadDemoProject(tempDir);

      const storage = new LocalFSProvider(storageDir);
      const deploymentService = new DeploymentService(storage);

      // Deploy project via deployCommand (cli/deploy.ts)
      const deployResult = await deployCommand({
        cwd: tempDir,
        project: "upload-demo",
        deploymentService,
      });

      // Verify deployCommand completed and returned active revision ULID
      assertEquals(deployResult.state, "Deployed");
      assertMatch(
        deployResult.revisionId,
        /^rev_[0-9A-HJKMNP-TV-Z]{26}$/,
        "Revision ID must be rev_{ULID} format (PLAT-14, PLAT-18)",
      );

      // Verify both functions are activated in the control plane (PLAT-3)
      const apiRev = await deploymentService.getActiveRevision(
        "upload-demo",
        "api",
      );
      const procRev = await deploymentService.getActiveRevision(
        "upload-demo",
        "processor",
      );

      assert(apiRev !== null, "api function must have active revision");
      assert(procRev !== null, "processor function must have active revision");
      assertEquals(apiRev.state, "Deployed");
      assertEquals(procRev.state, "Deployed");

      // Verify content-addressed artifact storage per OBJ-4
      assertMatch(
        apiRev.artifactId,
        /^sha256:[0-9a-f]{64}$/,
        "Artifact ID must be sha256:{hex} (OBJ-4)",
      );
      assertMatch(
        apiRev.integrity,
        /^sha256-[A-Za-z0-9+/=]+$/,
        "Artifact integrity must be sha256-{base64} (OBJ-4)",
      );

      // Verify artifact bytes exist in object storage at artifacts/{artifact_id}
      const artifactKey = `artifacts/${apiRev.artifactId}`;
      const artifactStream = await storage.get(artifactKey);
      assert(
        artifactStream !== null,
        "Artifact must be retrievable from storage at artifacts/{artifact_id}",
      );

      // Verify processor artifact is also stored content-addressed
      const procArtifactKey = `artifacts/${procRev.artifactId}`;
      const procArtifactStream = await storage.get(procArtifactKey);
      assert(
        procArtifactStream !== null,
        "Processor artifact must be retrievable from storage",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC2: Client calls POST /upload on data plane returning HTTP 200, direct upload URL, and ULID request-id header (PLAT-12, PLAT-14, OBJ-2, OBJ-3)",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const storageDir = await Deno.makeTempDir();

    const storage = new DirectUploadLocalFSProvider(storageDir);
    const storageServer = startDirectStorageServer(storage);
    const kv = new SQLiteKVProvider(":memory:");
    const queues = new SQLiteQueueProvider(":memory:");
    const deploymentService = new DeploymentService(storage);

    let dataPlane:
      | { port: number; url: string; close: () => Promise<void> }
      | null = null;
    let snapshotCache: RuntimeSnapshotCache | null = null;

    try {
      await setupUploadDemoProject(tempDir);
      await deployCommand({
        cwd: tempDir,
        project: "upload-demo",
        deploymentService,
      });

      const apiRev = await deploymentService.getActiveRevision(
        "upload-demo",
        "api",
      );
      const procRev = await deploymentService.getActiveRevision(
        "upload-demo",
        "processor",
      );
      assert(apiRev && procRev);

      const distributor = new SnapshotDistributor();
      const snapshot = distributor.createSnapshot(
        [{ pattern: "/upload", function: "api" }],
        { api: apiRev, processor: procRev },
      );

      snapshotCache = new RuntimeSnapshotCache(() => Promise.resolve(snapshot));
      await snapshotCache.forceRefresh();

      dataPlane = startDataPlaneServer(
        snapshotCache,
        { kv, objects: storage, queues },
        tempDir,
      );

      // Invoke POST /upload on data plane
      const res = await fetch(`${dataPlane.url}/upload`, { method: "POST" });
      assertEquals(res.status, 200);

      // Verify PLAT-12 & PLAT-14 ULID request-id header
      const reqId = res.headers.get("request-id");
      assert(reqId !== null, "request-id header must be present (PLAT-12)");
      assertEquals(
        isValidUlid(reqId),
        true,
        `request-id '${reqId}' must be a valid 26-char Crockford Base32 ULID (PLAT-14)`,
      );

      // Verify response body shape per worked-example.md
      const body = (await res.json()) as { uploadUrl: string; key: string };
      assert(typeof body.uploadUrl === "string", "uploadUrl must be a string");
      assert(
        typeof body.key === "string" && body.key.length > 0,
        "key must be non-empty",
      );

      // Verify uploadUrl points directly to storage server, not through data plane (OBJ-3)
      const parsedUploadUrl = new URL(body.uploadUrl);
      assertEquals(
        parsedUploadUrl.port,
        storageServer.port.toString(),
        "Presigned URL must target storage server port directly (OBJ-3)",
      );
      assert(
        parsedUploadUrl.pathname.includes(body.key),
        "Upload URL must reference object key",
      );
    } finally {
      if (dataPlane) await dataPlane.close();
      await storageServer.close();
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC3: Client uploads binary payload directly via HTTP PUT to storage without proxying bytes through function (OBJ-3)",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const storageDir = await Deno.makeTempDir();

    const storage = new DirectUploadLocalFSProvider(storageDir);
    const storageServer = startDirectStorageServer(storage);
    const kv = new SQLiteKVProvider(":memory:");
    const queues = new SQLiteQueueProvider(":memory:");
    const deploymentService = new DeploymentService(storage);

    let dataPlane:
      | { port: number; url: string; close: () => Promise<void> }
      | null = null;
    let snapshotCache: RuntimeSnapshotCache | null = null;

    try {
      await setupUploadDemoProject(tempDir);
      await deployCommand({
        cwd: tempDir,
        project: "upload-demo",
        deploymentService,
      });

      const apiRev = await deploymentService.getActiveRevision(
        "upload-demo",
        "api",
      );
      const procRev = await deploymentService.getActiveRevision(
        "upload-demo",
        "processor",
      );
      assert(apiRev && procRev);

      const distributor = new SnapshotDistributor();
      const snapshot = distributor.createSnapshot(
        [{ pattern: "/upload", function: "api" }],
        { api: apiRev, processor: procRev },
      );

      snapshotCache = new RuntimeSnapshotCache(() => Promise.resolve(snapshot));
      await snapshotCache.forceRefresh();

      dataPlane = startDataPlaneServer(
        snapshotCache,
        { kv, objects: storage, queues },
        tempDir,
      );

      // Step 1: Request presigned URL from function
      const uploadInitRes = await fetch(`${dataPlane.url}/upload`, {
        method: "POST",
      });
      assertEquals(uploadInitRes.status, 200);
      const { uploadUrl, key } = await uploadInitRes.json();

      // Step 2: Client uploads binary payload directly to storage URL via PUT (OBJ-3)
      const binaryPayload = new Uint8Array([
        0xde,
        0xad,
        0xbe,
        0xef,
        0x42,
        0x99,
      ]);
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        body: binaryPayload,
        headers: { "content-type": "application/octet-stream" },
      });
      assertEquals(
        putRes.status,
        200,
        "Direct HTTP PUT to object storage presigned URL must succeed with 200",
      );

      // Step 3: Verify payload is stored directly in storage under physical key (PLAT-7)
      const physicalKey = `local-org/upload-demo/app:uploads/${key}`;
      const head = await storage.head(physicalKey);
      assert(head !== null, "Object must exist directly in storage provider");
      assertEquals(
        head.size,
        binaryPayload.length,
        "Stored size must match uploaded binary bytes",
      );

      // Verify stored bytes match exactly
      const stream = await storage.get(physicalKey);
      assert(stream !== null);
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      const actual = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        actual.set(c, offset);
        offset += c.length;
      }
      assertEquals(
        actual,
        binaryPayload,
        "Storage bytes must match direct client PUT bytes exactly",
      );
    } finally {
      if (dataPlane) await dataPlane.close();
      await storageServer.close();
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC4: Background queue consumer worker consumes message, processor retrieves object bytes, records in KV, and sets dedupe key with TTL (FN-2, OBJ-2, KV-2, Q-4)",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const storageDir = await Deno.makeTempDir();

    const storage = new DirectUploadLocalFSProvider(storageDir);
    const storageServer = startDirectStorageServer(storage);
    const kv = new SQLiteKVProvider(":memory:");
    const queues = new SQLiteQueueProvider(":memory:");
    const deploymentService = new DeploymentService(storage);

    let dataPlane:
      | { port: number; url: string; close: () => Promise<void> }
      | null = null;
    let snapshotCache: RuntimeSnapshotCache | null = null;

    try {
      await setupUploadDemoProject(tempDir);
      await deployCommand({
        cwd: tempDir,
        project: "upload-demo",
        deploymentService,
      });

      const apiRev = await deploymentService.getActiveRevision(
        "upload-demo",
        "api",
      );
      const procRev = await deploymentService.getActiveRevision(
        "upload-demo",
        "processor",
      );
      assert(apiRev && procRev);

      const distributor = new SnapshotDistributor();
      const snapshot = distributor.createSnapshot(
        [{ pattern: "/upload", function: "api" }],
        { api: apiRev, processor: procRev },
      );

      snapshotCache = new RuntimeSnapshotCache(() => Promise.resolve(snapshot));
      await snapshotCache.forceRefresh();

      dataPlane = startDataPlaneServer(
        snapshotCache,
        { kv, objects: storage, queues },
        tempDir,
      );

      // 1. Client calls POST /upload — dispatches queue message
      const uploadRes = await fetch(`${dataPlane.url}/upload`, {
        method: "POST",
      });
      assertEquals(uploadRes.status, 200);
      const { uploadUrl, key } = await uploadRes.json();

      // 2. Client completes direct object upload
      const testData = new TextEncoder().encode(
        "Canonical worked-example binary payload",
      );
      const putRes = await fetch(uploadUrl, { method: "PUT", body: testData });
      assertEquals(putRes.status, 200);

      // 3. Setup QueueConsumerWorker dispatching to processor function (FN-2, Q-2)
      const processorEntryPath = join(tempDir, "functions", "processor.ts");
      let processorInvocationCount = 0;

      const worker = new QueueConsumerWorker(
        queues,
        async (fnName: string, message: QueueMessage) => {
          processorInvocationCount++;
          assertEquals(fnName, "processor");

          // Resolve processor capability bindings: objects=app:uploads, kv=app:files (PLAT-6)
          const resolvedBindings = resolvePermissions(
            { kv: ["app:files"], objects: ["app:uploads"] },
            "local-org",
            "upload-demo",
            { kv, objects: storage, queues },
          );

          const fnMeta: LoadedFunctionMeta = {
            project: "upload-demo",
            function: "processor",
            revision: procRev.id,
            timeout_ms: 30000,
          };
          const ctx = buildContext(fnMeta, resolvedBindings);

          const loaded = await loadFunction(processorEntryPath, {
            revision: procRev.id,
          });
          await (loaded.handler as unknown as (
            msg: QueueMessage,
            ctx: RailFogContext,
          ) => Promise<void>)(
            message,
            ctx,
          );
        },
        {
          queueName: "app:jobs",
          targetFunctionName: "processor",
          visibilityTimeoutMs: 5000,
        },
      );

      // 4. Worker processes message from queue
      const processed = await worker.processNext();
      assertEquals(
        processed,
        true,
        "Worker must successfully process queue message",
      );
      assertEquals(
        processorInvocationCount,
        1,
        "Processor handler must be invoked once",
      );

      // 5. Verify KV records written by processor: ["files", key] = { status: "processed" } (KV-2)
      const fileRecord = await kv.get([
        "local-org",
        "upload-demo",
        "app:files",
        "files",
        key,
      ]);
      assertEquals(
        fileRecord,
        { status: "processed" },
        "KV must contain ['files', key] with status: 'processed' (KV-2)",
      );

      // 6. Verify dedupe key in KV: ["processed", key] = true with TTL (Q-4)
      const dedupeRecord = await kv.get([
        "local-org",
        "upload-demo",
        "app:files",
        "processed",
        key,
      ]);
      assertEquals(
        dedupeRecord,
        true,
        "Dedupe key ['processed', key] must be set in KV (Q-4)",
      );

      // Verify raw SQLite database column has valid TTL (Q-4 / KV-2)
      const dedupeKeyPath = kv.encodeKeyPath([
        "local-org",
        "upload-demo",
        "app:files",
        "processed",
        key,
      ]);
      const dedupeRow = (
        kv as unknown as {
          db: {
            prepare: (
              q: string,
            ) => { get: (k: string) => { expires_at: number | null } };
          };
        }
      ).db
        .prepare("SELECT expires_at FROM kv_entries WHERE key_path = ?")
        .get(dedupeKeyPath);
      assert(
        dedupeRow && dedupeRow.expires_at !== null,
        "Dedupe key must have non-null expires_at per Q-4 / KV-2",
      );
      const minExpectedTtl = Date.now() + (14 * 24 * 3600 - 60) * 1000;
      assert(
        dedupeRow.expires_at >= minExpectedTtl,
        "Dedupe key TTL must match 14-day retention window per Q-4",
      );

      // 7. Verify queue message was acknowledged and removed from queue (Q-3)
      const nextMessage = await queues.receive();
      assertEquals(
        nextMessage,
        null,
        "Queue message must be acknowledged and removed after processing",
      );
    } finally {
      if (dataPlane) await dataPlane.close();
      await storageServer.close();
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC5: Idempotency - duplicate queue message with same key is detected in KV and safely skips re-execution (Q-4, KV-2)",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const storageDir = await Deno.makeTempDir();

    const storage = new DirectUploadLocalFSProvider(storageDir);
    const storageServer = startDirectStorageServer(storage);
    const kv = new SQLiteKVProvider(":memory:");
    const queues = new SQLiteQueueProvider(":memory:");

    try {
      await setupUploadDemoProject(tempDir);
      const key = crypto.randomUUID();

      // Pre-seed storage and KV as if message was previously processed (AC4 completed)
      const testBytes = new TextEncoder().encode(
        "Idempotency test object data",
      );
      await storage.put(
        `local-org/upload-demo/app:uploads/${key}`,
        testBytes.buffer,
      );

      // KV has file status and dedupe key with 14-day TTL
      await kv.set(
        ["local-org", "upload-demo", "app:files", "files", key],
        { status: "processed" },
      );
      await kv.set(
        ["local-org", "upload-demo", "app:files", "processed", key],
        true,
        { ttl: 14 * 24 * 3600 },
      );

      // Redeliver / duplicate queue message sent with same key (Q-1 at-least-once delivery)
      await queues.send({ key, uploadedAt: Date.now() });

      let objectGetCalls = 0;
      let kvSetCalls = 0;

      // Wrapped providers to detect if re-execution occurs
      const trackingKv: KVProvider = {
        get: (k: string[]) => kv.get(k),
        set: (k: string[], v: unknown, opts?: { ttl?: number }) => {
          kvSetCalls++;
          return kv.set(k, v, opts);
        },
        delete: (k: string[]) => kv.delete(k),
        list: (p: string[], opts?: { limit?: number; cursor?: string }) =>
          kv.list(p, opts),
        atomic: () => kv.atomic(),
      };

      const trackingStorage: ObjectProvider = {
        put: (k: string, d: ArrayBuffer | ReadableStream) => storage.put(k, d),
        get: (k: string) => {
          objectGetCalls++;
          return storage.get(k);
        },
        delete: (k: string) => storage.delete(k),
        head: (k: string) => storage.head(k),
        list: (p: string, opts?: { limit?: number; cursor?: string }) =>
          storage.list(p, opts),
        presign: (
          k: string,
          opts: {
            method: "GET" | "PUT";
            expiresIn?: number;
            maxExpiresIn?: number;
          },
        ) => storage.presign(k, opts),
        createMultipartUpload: (k: string) => storage.createMultipartUpload(k),
      };

      const processorEntryPath = join(tempDir, "functions", "processor.ts");
      const worker = new QueueConsumerWorker(
        queues,
        async (_fnName: string, message: QueueMessage) => {
          const resolvedBindings = resolvePermissions(
            { kv: ["app:files"], objects: ["app:uploads"] },
            "local-org",
            "upload-demo",
            { kv: trackingKv, objects: trackingStorage, queues },
          );
          const fnMeta: LoadedFunctionMeta = {
            project: "upload-demo",
            function: "processor",
            revision: "rev_idempotency_test",
            timeout_ms: 30000,
          };
          const ctx = buildContext(fnMeta, resolvedBindings);
          const loaded = await loadFunction(processorEntryPath, {
            revision: "rev_idempotency_test",
          });
          await (loaded.handler as unknown as (
            msg: QueueMessage,
            ctx: RailFogContext,
          ) => Promise<void>)(
            message,
            ctx,
          );
        },
        { queueName: "app:jobs", targetFunctionName: "processor" },
      );

      // Process duplicate message
      const processed = await worker.processNext();
      assertEquals(
        processed,
        true,
        "Duplicate message must be safely processed and acked",
      );

      // Assert idempotency check stopped re-execution: no storage reads and no KV writes
      assertEquals(
        objectGetCalls,
        0,
        "Idempotency check must skip objects.get when dedupe key exists (Q-4)",
      );
      assertEquals(
        kvSetCalls,
        0,
        "Idempotency check must skip kv.set when dedupe key exists (Q-4)",
      );

      // Verify queue message was acked so duplicate is not stuck
      const remainingMsg = await queues.receive();
      assertEquals(
        remainingMsg,
        null,
        "Duplicate message must be acknowledged and removed",
      );
    } finally {
      await storageServer.close();
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC6: Fail-static split - data plane continues serving live requests from cached snapshot indefinitely after control plane stops (PLAT-1, PLAT-8, PLAT-12)",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const storageDir = await Deno.makeTempDir();

    const storage = new DirectUploadLocalFSProvider(storageDir);
    const storageServer = startDirectStorageServer(storage);
    const kv = new SQLiteKVProvider(":memory:");
    const queues = new SQLiteQueueProvider(":memory:");
    const deploymentService = new DeploymentService(storage);

    let dataPlane:
      | { port: number; url: string; close: () => Promise<void> }
      | null = null;
    let snapshotCache: RuntimeSnapshotCache | null = null;

    try {
      await setupUploadDemoProject(tempDir);
      await deployCommand({
        cwd: tempDir,
        project: "upload-demo",
        deploymentService,
      });

      const apiRev = await deploymentService.getActiveRevision(
        "upload-demo",
        "api",
      );
      const procRev = await deploymentService.getActiveRevision(
        "upload-demo",
        "processor",
      );
      assert(apiRev && procRev);

      const distributor = new SnapshotDistributor();
      const snapshot = distributor.createSnapshot(
        [{ pattern: "/upload", function: "api" }],
        { api: apiRev, processor: procRev },
      );

      // Control plane simulator: start in healthy state, then fail
      let controlPlaneHealthy = true;
      const fetchSnapshot = () => {
        if (!controlPlaneHealthy) {
          return Promise.reject(
            new Error("Control plane connection refused (PLAT-8 simulation)"),
          );
        }
        return Promise.resolve(snapshot);
      };

      snapshotCache = new RuntimeSnapshotCache(fetchSnapshot, {
        pollIntervalMs: 50,
      });
      await snapshotCache.forceRefresh();
      snapshotCache.start();

      dataPlane = startDataPlaneServer(
        snapshotCache,
        { kv, objects: storage, queues },
        tempDir,
      );

      // 1. Verify baseline traffic serves HTTP 200 before outage
      const resBefore = await fetch(`${dataPlane.url}/upload`, {
        method: "POST",
      });
      assertEquals(resBefore.status, 200);

      // 2. STOP THE CONTROL PLANE: simulate hard network outage / control-plane crash
      controlPlaneHealthy = false;

      // Force a refresh attempt while control plane is dead — must reject while preserving cache
      await assertRejects(
        () => snapshotCache!.forceRefresh(),
        Error,
        "Control plane connection refused",
      );

      // 3. Verify cached snapshot is intact and accessible synchronously (PLAT-8)
      const cached = snapshotCache.getLatestSnapshot();
      assert(
        cached !== null,
        "Cached snapshot must be preserved after control plane failure",
      );
      assertEquals(cached.snapshotId, snapshot.snapshotId);

      // 4. Send multiple live HTTP requests to data plane during control plane outage
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${dataPlane.url}/upload`, { method: "POST" });
        assertEquals(
          res.status,
          200,
          `Request ${
            i + 1
          } during control plane outage must continue serving HTTP 200 (PLAT-8)`,
        );
        const data = await res.json();
        assert(
          data.uploadUrl,
          "Must continue returning uploadUrl from cached snapshot",
        );
        assert(data.key, "Must continue returning generated key");
        assertMatch(
          res.headers.get("request-id")!,
          /^[0-9A-HJKMNP-TV-Z]{26}$/,
          "Each live response must carry valid ULID request-id",
        );
      }
    } finally {
      if (snapshotCache) snapshotCache.stop();
      if (dataPlane) await dataPlane.close();
      await storageServer.close();
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: Capability injection guarantees - api cannot access KV and processor cannot access ungranted resources (PLAT-6, PLAT-7)",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const storageDir = await Deno.makeTempDir();

    const storage = new LocalFSProvider(storageDir);
    const kv = new SQLiteKVProvider(":memory:");
    const queues = new SQLiteQueueProvider(":memory:");

    try {
      await setupUploadDemoProject(tempDir);

      // 1. Inspect api function resolved bindings: declared objects=app:uploads, queues=app:jobs
      // MUST NOT have KV capability (PLAT-6)
      const apiBindings = resolvePermissions(
        { objects: ["app:uploads"], queues: ["app:jobs"] },
        "local-org",
        "upload-demo",
        { kv, objects: storage, queues },
      );

      assertEquals(
        apiBindings.kv,
        undefined,
        "api function bindings must NOT have KV capability",
      );
      assert(
        apiBindings.objects !== undefined,
        "api function must have objects capability",
      );
      assert(
        apiBindings.queues !== undefined,
        "api function must have queues capability",
      );

      const apiCtx = buildContext(
        { project: "upload-demo", function: "api", revision: "rev_sec_test" },
        apiBindings,
      );

      // Invoking ctx.kv methods on api must fail structurally (TypeError: not a function)
      assertEquals(
        (apiCtx.kv as unknown as Record<string, unknown>).get,
        undefined,
        "api ctx.kv.get must be undefined",
      );
      assertEquals(
        (apiCtx.kv as unknown as Record<string, unknown>).set,
        undefined,
        "api ctx.kv.set must be undefined",
      );

      // 2. Inspect processor function resolved bindings: declared objects=app:uploads, kv=app:files
      // MUST NOT have queues sending capability (PLAT-6)
      const procBindings = resolvePermissions(
        { objects: ["app:uploads"], kv: ["app:files"] },
        "local-org",
        "upload-demo",
        { kv, objects: storage, queues },
      );

      assertEquals(
        procBindings.queues,
        undefined,
        "processor bindings must NOT have queues capability",
      );
      assert(
        procBindings.kv !== undefined,
        "processor must have kv capability",
      );
      assert(
        procBindings.objects !== undefined,
        "processor must have objects capability",
      );

      const procCtx = buildContext(
        {
          project: "upload-demo",
          function: "processor",
          revision: "rev_sec_test",
        },
        procBindings,
      );

      assertEquals(
        (procCtx.queues as unknown as Record<string, unknown>).send,
        undefined,
        "processor ctx.queues.send must be undefined",
      );

      // 3. Multi-tenant key prefix isolation (PLAT-7)
      // When processor writes to KV, key is structurally prepended with {org}/{project}/{resource}
      await procCtx.kv.set(["user", "123"], { name: "Alice" });
      const rawKvRecord = await kv.get([
        "local-org",
        "upload-demo",
        "app:files",
        "user",
        "123",
      ]);
      assertEquals(
        rawKvRecord,
        { name: "Alice" },
        "KV key must be physically isolated under local-org/upload-demo/app:files/ (PLAT-7)",
      );

      // Path traversal probe on object keys is rejected at capability layer
      assertThrows(
        () => procCtx.objects.get("../escaped-path"),
        ValidationFailedError,
        "Path traversal not allowed in object keys",
      );
      assertThrows(
        () => procCtx.objects.presign("/absolute-path", { method: "PUT" }),
        ValidationFailedError,
        "Path traversal not allowed in object keys",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security & OBJ-3: Direct client-to-storage upload with AWS SigV4 URL format using R2Provider (OBJ-2, OBJ-3, PLAT-16)",
  async () => {
    // Start an in-process mock S3 / R2 storage server
    let uploadedPayload: Uint8Array | null = null;
    let receivedSigV4Headers = false;

    const s3Server = Deno.serve({ port: 0 }, async (req: Request) => {
      const url = new URL(req.url);
      if (req.method === "PUT" && url.pathname.includes("/uploads/")) {
        // Verify SigV4 query parameters were received on direct upload
        if (
          url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" &&
          url.searchParams.has("X-Amz-Signature") &&
          url.searchParams.has("X-Amz-Credential")
        ) {
          receivedSigV4Headers = true;
        }
        uploadedPayload = new Uint8Array(await req.arrayBuffer());
        return new Response(null, {
          status: 200,
          headers: { ETag: '"test-etag-12345"' },
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const s3Port = (s3Server.addr as Deno.NetAddr).port;

    try {
      const r2Provider = new R2Provider({
        endpoint: `http://127.0.0.1:${s3Port}`,
        bucket: "app-uploads",
        accessKeyId: "testAccessKey",
        secretAccessKey: "testSecretKey12345",
        region: "auto",
      });

      // 1. Presign PUT URL with SigV4 (OBJ-2, OBJ-3)
      const { url, expiresAt } = await r2Provider.presign(
        "uploads/direct-file.bin",
        {
          method: "PUT",
          expiresIn: 600,
        },
      );

      const parsedUrl = new URL(url);

      // Verify SigV4 parameters
      assertEquals(
        parsedUrl.searchParams.get("X-Amz-Algorithm"),
        "AWS4-HMAC-SHA256",
      );
      assert(parsedUrl.searchParams.has("X-Amz-Signature"));
      assert(parsedUrl.searchParams.has("X-Amz-Credential"));
      assert(parsedUrl.searchParams.has("X-Amz-Date"));
      assertEquals(parsedUrl.searchParams.get("X-Amz-Expires"), "600");
      assert(expiresAt > Date.now());

      // 2. Client performs direct HTTP PUT to the SigV4 presigned URL
      const clientData = new Uint8Array([1, 3, 3, 7, 4, 2]);
      const putRes = await fetch(url, {
        method: "PUT",
        body: clientData,
      });

      assertEquals(putRes.status, 200);
      assertEquals(
        receivedSigV4Headers,
        true,
        "Storage endpoint must receive valid SigV4 parameters",
      );
      assertEquals(
        uploadedPayload,
        clientData,
        "Payload must be stored directly in object storage",
      );
    } finally {
      await s3Server.shutdown();
    }
  },
);

Deno.test(
  "End-to-End: Full canonical worked-example flow spanning deployment, upload, direct PUT, queue consumption, and idempotency",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const storageDir = await Deno.makeTempDir();

    const storage = new DirectUploadLocalFSProvider(storageDir);
    const storageServer = startDirectStorageServer(storage);
    const kv = new SQLiteKVProvider(":memory:");
    const queues = new SQLiteQueueProvider(":memory:");
    const deploymentService = new DeploymentService(storage);

    let dataPlane:
      | { port: number; url: string; close: () => Promise<void> }
      | null = null;
    let snapshotCache: RuntimeSnapshotCache | null = null;

    try {
      // 1. Deploy upload-demo application (AC1)
      await setupUploadDemoProject(tempDir);
      const deployRes = await deployCommand({
        cwd: tempDir,
        project: "upload-demo",
        deploymentService,
      });
      assertEquals(deployRes.state, "Deployed");

      // 2. Generate snapshot and start data plane (PLAT-8)
      const apiRev = await deploymentService.getActiveRevision(
        "upload-demo",
        "api",
      );
      const procRev = await deploymentService.getActiveRevision(
        "upload-demo",
        "processor",
      );
      assert(apiRev && procRev);

      const distributor = new SnapshotDistributor();
      const snapshot = distributor.createSnapshot(
        [{ pattern: "/upload", function: "api" }],
        { api: apiRev, processor: procRev },
      );

      snapshotCache = new RuntimeSnapshotCache(() => Promise.resolve(snapshot));
      await snapshotCache.forceRefresh();

      dataPlane = startDataPlaneServer(
        snapshotCache,
        { kv, objects: storage, queues },
        tempDir,
      );

      // 3. Client calls POST /upload (AC2)
      const initRes = await fetch(`${dataPlane.url}/upload`, {
        method: "POST",
      });
      assertEquals(initRes.status, 200);
      const requestId = initRes.headers.get("request-id");
      assert(requestId && isValidUlid(requestId));

      const { uploadUrl, key } = await initRes.json();
      assert(uploadUrl && key);

      // 4. Client uploads binary payload directly via HTTP PUT to storage (AC3, OBJ-3)
      const payload = new TextEncoder().encode(
        "Hello, RailFog Cloud Prototype E2E!",
      );
      const putRes = await fetch(uploadUrl, { method: "PUT", body: payload });
      assertEquals(putRes.status, 200);

      // 5. Worker consumes queue message and invokes processor (AC4)
      const processorEntryPath = join(tempDir, "functions", "processor.ts");
      const worker = new QueueConsumerWorker(
        queues,
        async (_fnName: string, message: QueueMessage) => {
          const resolvedBindings = resolvePermissions(
            { kv: ["app:files"], objects: ["app:uploads"] },
            "local-org",
            "upload-demo",
            { kv, objects: storage, queues },
          );
          const fnMeta: LoadedFunctionMeta = {
            project: "upload-demo",
            function: "processor",
            revision: procRev.id,
            timeout_ms: 30000,
          };
          const ctx = buildContext(fnMeta, resolvedBindings);
          const loaded = await loadFunction(processorEntryPath, {
            revision: procRev.id,
          });
          await (loaded.handler as unknown as (
            msg: QueueMessage,
            ctx: RailFogContext,
          ) => Promise<void>)(
            message,
            ctx,
          );
        },
        { queueName: "app:jobs", targetFunctionName: "processor" },
      );

      const consumed = await worker.processNext();
      assertEquals(
        consumed,
        true,
        "Worker must successfully consume queue message",
      );

      // Verify KV state
      const fileRecord = await kv.get([
        "local-org",
        "upload-demo",
        "app:files",
        "files",
        key,
      ]);
      assertEquals(fileRecord, { status: "processed" });

      const dedupeRecord = await kv.get([
        "local-org",
        "upload-demo",
        "app:files",
        "processed",
        key,
      ]);
      assertEquals(dedupeRecord, true);

      // 6. Duplicate delivery (AC5): redeliver same key
      await queues.send({ key, uploadedAt: Date.now() });
      const duplicateConsumed = await worker.processNext();
      assertEquals(
        duplicateConsumed,
        true,
        "Duplicate message must be safely processed",
      );

      // Verify KV state is still { status: "processed" }
      const fileRecordAfter = await kv.get([
        "local-org",
        "upload-demo",
        "app:files",
        "files",
        key,
      ]);
      assertEquals(fileRecordAfter, { status: "processed" });

      // Queue must be empty
      assertEquals(await queues.receive(), null);
    } finally {
      if (dataPlane) await dataPlane.close();
      await storageServer.close();
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);
