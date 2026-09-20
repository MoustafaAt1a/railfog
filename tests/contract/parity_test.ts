/**
 * Local/Cloud Provider Parity Contract Test Suite (Task T-0509)
 *
 * Spec references:
 * - docs/contracts/platform.contract.md: PLAT-4 (Isolation), PLAT-12 (Error model),
 *   PLAT-14 (ULID), PLAT-16 (Provider abstraction), PLAT-17 (Local/production parity)
 * - docs/contracts/kv.contract.md: KV-2 (API & TTL), KV-3 (Optimistic concurrency CAS),
 *   KV-5 (Consistency tiers: strong CAS-backed)
 * - docs/contracts/objects.contract.md: OBJ-2 (API), OBJ-3 (Direct client-to-storage transfer),
 *   OBJ-4 (Content addressing: sha256:{hex} and sha256-{base64})
 * - docs/contracts/queues.contract.md: Q-2 (API & delay/batch), Q-3 (Redelivery & visibility timeout),
 *   Q-4 (Idempotency with retention TTL)
 * - docs/contracts/worked-example.md: Canonical end-to-end upload and queue processing pipeline
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

// Parity runner harness interface imports
import {
  type ProviderBundle,
  runParitySuite,
} from "../fixtures/parity-runner.ts";

// Concrete Provider Implementations (PLAT-16, PLAT-17)
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { DenoDeployKVProvider } from "../../providers/kv/deno-deploy-provider.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { R2Provider } from "../../providers/objects/r2-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";
import { CloudflareQueueProvider } from "../../providers/queues/cloudflare-queue-provider.ts";
import { LocalIsolationProvider } from "../../runtime/sandbox/local-isolation.ts";
import { ProcessIsolationProvider } from "../../runtime/sandbox/process-isolation.ts";

// Primitive Types and Cryptographic Helpers
import type {
  Artifact,
  InvocationRequest,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";
import {
  computeArtifactId,
  computeIntegrity,
} from "../../packages/core/crypto/content-address.ts";

// ============================================================================
// Local Bundle Factory Helpers
// ============================================================================

/**
 * DirectUploadLocalFSProvider: LocalFSProvider wrapper that preserves all
 * real filesystem operations while directing presigned URLs to an in-process
 * direct storage HTTP endpoint for true OBJ-3 client-to-storage transfer.
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
 * Starts an in-process direct storage HTTP server for LocalFSProvider,
 * verifying presigned URL HMAC tokens per OBJ-3.
 */
function startLocalFSStorageServer(provider: DirectUploadLocalFSProvider): {
  port: number;
  close: () => Promise<void>;
} {
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/local-fs/")) {
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
        if (req.method === "PUT") {
          const body = await req.arrayBuffer();
          await provider.put(key, body);
          return new Response(null, { status: 200 });
        }
        if (req.method === "GET") {
          const stream = await provider.get(key);
          if (!stream) return new Response("Not Found", { status: 404 });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
        }
      }
      return new Response("Not Found", { status: 404 });
    },
  );

  const port = (server.addr as Deno.NetAddr).port;
  provider.setStoragePort(port);

  return {
    port,
    close: () => server.shutdown(),
  };
}

/**
 * Creates a Local ProviderBundle:
 * - KV: SQLiteKVProvider (in-memory strong CAS backing)
 * - Objects: LocalFSProvider with in-process direct storage server (OBJ-3)
 * - Queues: SQLiteQueueProvider (in-memory at-least-once queue)
 * - Compute: LocalIsolationProvider (in-process capability-injected isolate)
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-16, PLAT-17
 */
export async function createLocalBundle(): Promise<ProviderBundle> {
  const storageDir = await Deno.makeTempDir({ prefix: "rf_parity_local_fs_" });
  const objects = new DirectUploadLocalFSProvider(storageDir);
  const storageServer = startLocalFSStorageServer(objects);

  const kv = new SQLiteKVProvider(":memory:");
  const queues = new SQLiteQueueProvider(":memory:");
  const compute = new LocalIsolationProvider();

  return {
    name: "local",
    kv,
    objects,
    queues,
    compute,
    cleanup: async () => {
      try {
        await storageServer.close();
      } catch {
        // Ignore server shutdown errors
      }
      try {
        await Deno.remove(storageDir, { recursive: true });
      } catch {
        // Ignore temp dir cleanup errors
      }
    },
  };
}

// ============================================================================
// Cloud Prototype Bundle Factory Helpers
// ============================================================================

/**
 * Starts an in-process mock S3 wire HTTP server simulating Cloudflare R2
 * with standard AWS SigV4 authentication and direct client transfer per OBJ-3.
 */
function startMockR2Server(bucketName: string): {
  port: number;
  storedObjects: Map<string, { bytes: Uint8Array; etag: string }>;
  close: () => Promise<void>;
} {
  const storedObjects = new Map<string, { bytes: Uint8Array; etag: string }>();

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req: Request) => {
      const url = new URL(req.url);
      const method = req.method;
      const pathParts = url.pathname.replace(/^\//, "").split("/");
      const bucket = pathParts[0];
      const key = pathParts.slice(1).join("/");

      if (bucket !== bucketName) {
        return new Response("Invalid bucket", { status: 400 });
      }

      // SigV4 auth header or presigned query param check (OBJ-3)
      const authHeader = req.headers.get("authorization");
      const sigV4Param =
        url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256";
      if (!authHeader && !sigV4Param) {
        return new Response("Missing SigV4 authorization", { status: 403 });
      }

      // Multipart upload initiate
      if (url.searchParams.has("uploads") && method === "POST") {
        const uploadId = `mp_${generateUlid()}`;
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Bucket>${bucket}</Bucket>
  <Key>${key}</Key>
  <UploadId>${uploadId}</UploadId>
</InitiateMultipartUploadResult>`;
        return new Response(xml, {
          status: 200,
          headers: { "content-type": "application/xml" },
        });
      }

      // List objects V2
      if (key === "" && method === "GET") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const maxKeys = parseInt(
          url.searchParams.get("max-keys") ?? "1000",
          10,
        );
        const continuationToken = url.searchParams.get("continuation-token");

        let matchingKeys = Array.from(storedObjects.keys()).filter((k) =>
          k.startsWith(prefix)
        );
        matchingKeys.sort();

        if (continuationToken) {
          const idx = matchingKeys.indexOf(continuationToken);
          if (idx !== -1) {
            matchingKeys = matchingKeys.slice(idx + 1);
          }
        }

        const pagedKeys = matchingKeys.slice(0, maxKeys);
        const isTruncated = matchingKeys.length > maxKeys;
        const nextToken = isTruncated ? pagedKeys[pagedKeys.length - 1] : "";

        const contentsXml = pagedKeys
          .map(
            (k) =>
              `<Contents><Key>${k}</Key><Size>${
                storedObjects.get(k)?.bytes.byteLength ?? 0
              }</Size><ETag>"${storedObjects.get(k)?.etag}"</ETag></Contents>`,
          )
          .join("");

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${bucket}</Name>
  <Prefix>${prefix}</Prefix>
  <MaxKeys>${maxKeys}</MaxKeys>
  <IsTruncated>${isTruncated}</IsTruncated>
  ${contentsXml}
  ${
          nextToken
            ? `<NextContinuationToken>${nextToken}</NextContinuationToken>`
            : ""
        }
</ListBucketResult>`;
        return new Response(xml, {
          status: 200,
          headers: { "content-type": "application/xml" },
        });
      }

      // PUT object
      if (method === "PUT") {
        const bytes = new Uint8Array(await req.arrayBuffer());
        const etag = `etag-${key}-${bytes.byteLength}`;
        storedObjects.set(key, { bytes, etag });
        return new Response(null, {
          status: 200,
          headers: { ETag: `"${etag}"` },
        });
      }

      // GET object
      if (method === "GET") {
        const obj = storedObjects.get(key);
        if (!obj) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(obj.bytes as unknown as BodyInit, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            ETag: `"${obj.etag}"`,
          },
        });
      }

      // HEAD object
      if (method === "HEAD") {
        const obj = storedObjects.get(key);
        if (!obj) {
          return new Response(null, { status: 404 });
        }
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": obj.bytes.byteLength.toString(),
            ETag: `"${obj.etag}"`,
          },
        });
      }

      // DELETE object
      if (method === "DELETE") {
        storedObjects.delete(key);
        return new Response(null, { status: 204 });
      }

      return new Response("Method not allowed", { status: 405 });
    },
  );

  const port = (server.addr as Deno.NetAddr).port;
  return {
    port,
    storedObjects,
    close: () => server.shutdown(),
  };
}

/**
 * Starts an in-process mock Cloudflare Queues HTTP server simulating
 * the Cloudflare Queues REST API endpoints per Q-1, Q-2, Q-3.
 */
function startMockCloudflareQueuesServer(expectedToken = "mock-cf-token"): {
  port: number;
  close: () => Promise<void>;
} {
  interface StoredQueueMsg {
    id: string;
    body: unknown;
    visibleAfter: number;
    attempts: number;
    acked: boolean;
  }

  const messages: StoredQueueMsg[] = [];

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req: Request) => {
      const url = new URL(req.url);
      const authHeader = req.headers.get("authorization");
      if (authHeader !== `Bearer ${expectedToken}`) {
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
            messages: [],
            result: null,
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }

      const match = url.pathname.match(
        /(?:\/client\/v4)?\/accounts\/([^/]+)\/queues\/([^/]+)\/messages(?:\/(batch|pull|ack))?$/,
      );
      if (!match) {
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 7000, message: "No route matched" }],
            messages: [],
            result: null,
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      const [, , , action] = match;
      const bodyText = await req.text();
      let parsedBody: unknown = undefined;
      if (bodyText) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          parsedBody = bodyText;
        }
      }

      // 1. Send single message
      if (!action && req.method === "POST") {
        const bodyObj = parsedBody as {
          body?: unknown;
          delay_seconds?: number;
        };
        const id = `cf_msg_${generateUlid()}`;
        const delaySeconds = bodyObj?.delay_seconds ?? 0;
        messages.push({
          id,
          body: bodyObj?.body,
          visibleAfter: Date.now() + delaySeconds * 1000,
          attempts: 0,
          acked: false,
        });
        return new Response(
          JSON.stringify({ success: true, result: { id } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // 2. Send batch
      if (action === "batch" && req.method === "POST") {
        const batchObj = parsedBody as {
          messages?: Array<{ body: unknown; delay_seconds?: number }>;
        };
        const rawMessages = batchObj?.messages ?? [];
        const result: Array<{ id: string }> = [];
        for (const item of rawMessages) {
          const id = `cf_msg_${generateUlid()}`;
          const delaySeconds = item.delay_seconds ?? 0;
          messages.push({
            id,
            body: item.body,
            visibleAfter: Date.now() + delaySeconds * 1000,
            attempts: 0,
            acked: false,
          });
          result.push({ id });
        }
        return new Response(
          JSON.stringify({ success: true, result }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // 3. Pull / receive
      if (action === "pull" && req.method === "POST") {
        const pullObj = parsedBody as {
          visibility_timeout_ms?: number;
          batch_size?: number;
        };
        const visibilityTimeoutMs = pullObj?.visibility_timeout_ms ?? 30000;
        const batchSize = pullObj?.batch_size ?? 1;
        const now = Date.now();

        const available = messages.filter((m) =>
          !m.acked && m.visibleAfter <= now
        );
        const selected = available.slice(0, batchSize);

        const resultMessages = selected.map((m) => {
          m.attempts += 1;
          m.visibleAfter = now + visibilityTimeoutMs;
          return {
            id: m.id,
            body: m.body,
            attempts: m.attempts,
          };
        });

        return new Response(
          JSON.stringify({
            success: true,
            result: { messages: resultMessages },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // 4. Ack
      if (action === "ack" && req.method === "POST") {
        const ackObj = parsedBody as { acks?: Array<{ id: string }> };
        const acks = ackObj?.acks ?? [];
        for (const { id } of acks) {
          const found = messages.find((m) => m.id === id);
          if (found) found.acked = true;
        }
        return new Response(
          JSON.stringify({ success: true, result: { ackCount: acks.length } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("Method not allowed", { status: 405 });
    },
  );

  const port = (server.addr as Deno.NetAddr).port;
  return {
    port,
    close: () => server.shutdown(),
  };
}

/**
 * Creates a Cloud Prototype ProviderBundle:
 * - KV: DenoDeployKVProvider (Deno KV linearizable strong tier, KV-5)
 * - Objects: R2Provider (S3-compatible wire protocol with SigV4, OBJ-1, OBJ-3)
 * - Queues: CloudflareQueueProvider (REST API at-least-once queue, Q-1, Q-2, Q-3)
 * - Compute: ProcessIsolationProvider (Subprocess sandbox boundary, PLAT-4)
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-16, PLAT-17
 */
export async function createCloudBundle(): Promise<ProviderBundle> {
  const tempDir = await Deno.makeTempDir({ prefix: "rf_parity_cloud_" });
  const kvPath = join(tempDir, "cloud.kv");
  const kv = new DenoDeployKVProvider({ path: kvPath });

  const bucketName = "rf-cloud-parity-bucket";
  const r2Server = startMockR2Server(bucketName);
  const objects = new R2Provider({
    endpoint: `http://127.0.0.1:${r2Server.port}`,
    bucket: bucketName,
    accessKeyId: "mockAccessKeyId",
    secretAccessKey: "mockSecretAccessKey123",
    region: "auto",
  });

  const cfToken = "parity-cf-token-12345";
  const queueServer = startMockCloudflareQueuesServer(cfToken);
  const queues = new CloudflareQueueProvider({
    accountId: "cf-account-parity",
    queueId: "cf-queue-parity",
    apiToken: cfToken,
    baseUrl: `http://127.0.0.1:${queueServer.port}`,
  });

  const compute = new ProcessIsolationProvider();

  return {
    name: "cloud",
    kv,
    objects,
    queues,
    compute,
    cleanup: async () => {
      try {
        await kv.close();
      } catch {
        // Ignore kv close error
      }
      try {
        await r2Server.close();
      } catch {
        // Ignore r2 server shutdown error
      }
      try {
        await queueServer.close();
      } catch {
        // Ignore queue server shutdown error
      }
      try {
        await compute.shutdown();
      } catch {
        // Ignore compute shutdown error
      }
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Ignore temp dir cleanup error
      }
    },
  };
}

// ============================================================================
// Parameterized Parity Suite Execution (Local & Cloud)
// ============================================================================

// 1. Run parity suite for Local bundle factory (PLAT-16, PLAT-17)
runParitySuite(createLocalBundle);

// 2. Run parity suite for Cloud bundle factory (PLAT-16, PLAT-17)
runParitySuite(createCloudBundle);

// ============================================================================
// Dual-Matrix Differential Parity Contract Tests (PLAT-17)
// ============================================================================

/**
 * Creates a canonical minimal test artifact per PLAT-3 and OBJ-4.
 */
async function createParityArtifact(code: string): Promise<Artifact> {
  const codeBytes = new TextEncoder().encode(code);
  return {
    id: await computeArtifactId(codeBytes),
    integrity: await computeIntegrity(codeBytes),
    entrypoint: "index.ts",
    code: codeBytes,
  };
}

Deno.test(
  "Parity Contract: KV Differential Parity across Local and Cloud bundles (KV-2, KV-3, KV-5, PLAT-17)",
  async () => {
    const local = await createLocalBundle();
    const cloud = await createCloudBundle();

    try {
      // 1. Atomic CAS Parity (KV-3):
      // Initial write: check version 0, set value
      const key = ["parity", "cas", generateUlid()];
      const localCas1 = await local.kv.atomic().check(key, 0).set(key, {
        count: 1,
      }).commit();
      const cloudCas1 = await cloud.kv.atomic().check(key, 0).set(key, {
        count: 1,
      }).commit();

      assertEquals(localCas1.ok, true, "Local CAS initial commit must succeed");
      assertEquals(cloudCas1.ok, true, "Cloud CAS initial commit must succeed");
      assertEquals(
        localCas1.ok,
        cloudCas1.ok,
        "Both bundles must return ok=true on valid CAS",
      );

      // Conflicting write: check stale version 0, must fail on both
      const localCas2 = await local.kv.atomic().check(key, 0).set(key, {
        count: 99,
      }).commit();
      const cloudCas2 = await cloud.kv.atomic().check(key, 0).set(key, {
        count: 99,
      }).commit();

      assertEquals(
        localCas2.ok,
        false,
        "Local CAS conflicting commit must fail",
      );
      assertEquals(
        cloudCas2.ok,
        false,
        "Cloud CAS conflicting commit must fail",
      );
      assertEquals(
        localCas2.ok,
        cloudCas2.ok,
        "Both bundles must return ok=false on CAS conflict",
      );

      // Value remains unchanged after failed CAS
      assertEquals(await local.kv.get(key), { count: 1 });
      assertEquals(await cloud.kv.get(key), { count: 1 });

      // 2. TTL Expiration Parity (KV-2):
      const ttlKey = ["parity", "ttl", generateUlid()];
      await local.kv.set(ttlKey, "temp-value", { ttl: 1 });
      await cloud.kv.set(ttlKey, "temp-value", { ttl: 1 });

      assertEquals(await local.kv.get(ttlKey), "temp-value");
      assertEquals(await cloud.kv.get(ttlKey), "temp-value");

      // Wait 1.1s for TTL expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const localExpired = await local.kv.get(ttlKey);
      const cloudExpired = await cloud.kv.get(ttlKey);
      assertEquals(
        localExpired,
        null,
        "Local key must expire to null after TTL",
      );
      assertEquals(
        cloudExpired,
        null,
        "Cloud key must expire to null after TTL",
      );
      assertEquals(
        localExpired,
        cloudExpired,
        "Both bundles must return null for expired TTL",
      );

      // 3. List Pagination Parity (KV-2):
      const prefix = ["parity", "list", generateUlid()];
      const items = ["alpha", "beta", "gamma", "delta"];
      for (const item of items) {
        await local.kv.set([...prefix, item], `val_${item}`);
        await cloud.kv.set([...prefix, item], `val_${item}`);
      }

      const localList1 = await local.kv.list(prefix, { limit: 2 });
      const cloudList1 = await cloud.kv.list(prefix, { limit: 2 });

      assertEquals(localList1.keys.length, 2);
      assertEquals(cloudList1.keys.length, 2);
      assertEquals(
        localList1.keys.map((k: { key: string[] }) => k.key),
        cloudList1.keys.map((k: { key: string[] }) => k.key),
        "List page 1 keys must match identically across bundles",
      );

      assert(localList1.cursor !== undefined);
      assert(cloudList1.cursor !== undefined);

      const localList2 = await local.kv.list(prefix, {
        cursor: localList1.cursor,
      });
      const cloudList2 = await cloud.kv.list(prefix, {
        cursor: cloudList1.cursor,
      });

      assertEquals(localList2.keys.length, 2);
      assertEquals(cloudList2.keys.length, 2);
      assertEquals(
        localList2.keys.map((k: { key: string[] }) => k.key),
        cloudList2.keys.map((k: { key: string[] }) => k.key),
        "List page 2 keys must match identically across bundles",
      );
    } finally {
      await local.cleanup();
      await cloud.cleanup();
    }
  },
);

Deno.test(
  "Parity Contract: Objects Differential Parity across Local and Cloud bundles (OBJ-2, OBJ-3, OBJ-4, PLAT-17)",
  async () => {
    const local = await createLocalBundle();
    const cloud = await createCloudBundle();

    try {
      const key = `parity/objects/${generateUlid()}.bin`;
      const testBytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);

      // 1. Direct Presigned Upload Parity (OBJ-3):
      const localPresign = await local.objects.presign(key, {
        method: "PUT",
        expiresIn: 300,
      });
      const cloudPresign = await cloud.objects.presign(key, {
        method: "PUT",
        expiresIn: 300,
      });

      assert(
        localPresign.url.startsWith("http://"),
        "Local presign URL must be valid HTTP URL",
      );
      assert(
        cloudPresign.url.startsWith("http://"),
        "Cloud presign URL must be valid HTTP URL",
      );

      // Direct client PUT to presigned URLs
      const localPutRes = await fetch(localPresign.url, {
        method: "PUT",
        body: testBytes,
      });
      const cloudPutRes = await fetch(cloudPresign.url, {
        method: "PUT",
        body: testBytes,
      });

      assertEquals(
        localPutRes.status,
        200,
        "Direct PUT to LocalFS storage must return 200",
      );
      assertEquals(
        cloudPutRes.status,
        200,
        "Direct PUT to R2 storage must return 200",
      );
      assertEquals(
        localPutRes.status,
        cloudPutRes.status,
        "Both presigned direct uploads return 200",
      );

      // 2. Direct Presigned Download Parity (OBJ-3):
      const localGetPresign = await local.objects.presign(key, {
        method: "GET",
        expiresIn: 300,
      });
      const cloudGetPresign = await cloud.objects.presign(key, {
        method: "GET",
        expiresIn: 300,
      });

      const localGetRes = await fetch(localGetPresign.url, { method: "GET" });
      const cloudGetRes = await fetch(cloudGetPresign.url, { method: "GET" });

      assertEquals(localGetRes.status, 200);
      assertEquals(cloudGetRes.status, 200);

      const localDownloaded = new Uint8Array(await localGetRes.arrayBuffer());
      const cloudDownloaded = new Uint8Array(await cloudGetRes.arrayBuffer());

      assertEquals(
        localDownloaded,
        testBytes,
        "Downloaded bytes from Local storage must match uploaded",
      );
      assertEquals(
        cloudDownloaded,
        testBytes,
        "Downloaded bytes from Cloud storage must match uploaded",
      );
      assertEquals(
        localDownloaded,
        cloudDownloaded,
        "Both direct downloads return identical byte content",
      );

      // 3. Head & Get CRUD Parity (OBJ-2):
      const localHead = await local.objects.head(key);
      const cloudHead = await cloud.objects.head(key);

      assert(localHead !== null);
      assert(cloudHead !== null);
      assertEquals(localHead.size, testBytes.byteLength);
      assertEquals(cloudHead.size, testBytes.byteLength);
      assertEquals(
        localHead.size,
        cloudHead.size,
        "Object sizes must be identical",
      );

      // 4. Content Addressing Parity (OBJ-4):
      const artifactId = await computeArtifactId(testBytes);
      const integrity = await computeIntegrity(testBytes);

      assert(artifactId.startsWith("sha256:"));
      assert(integrity.startsWith("sha256-"));

      // 5. Delete Parity (OBJ-2):
      await local.objects.delete(key);
      await cloud.objects.delete(key);

      assertEquals(await local.objects.head(key), null);
      assertEquals(await cloud.objects.head(key), null);
      assertEquals(await local.objects.get(key), null);
      assertEquals(await cloud.objects.get(key), null);
    } finally {
      await local.cleanup();
      await cloud.cleanup();
    }
  },
);

Deno.test(
  "Parity Contract: Queues Differential Parity across Local and Cloud bundles (Q-2, Q-3, PLAT-17)",
  async () => {
    const local = await createLocalBundle();
    const cloud = await createCloudBundle();

    try {
      const payload1 = { job: "resize", imageId: "img_001", priority: 1 };
      const payload2 = { job: "email", userId: "usr_002", priority: 2 };

      // 1. Single send & receive parity (Q-2):
      const localSend = await local.queues.send(payload1);
      const cloudSend = await cloud.queues.send(payload1);

      assert(typeof localSend.id === "string" && localSend.id.length > 0);
      assert(typeof cloudSend.id === "string" && cloudSend.id.length > 0);

      const localMsg1 = await local.queues.receive();
      const cloudMsg1 = await cloud.queues.receive();

      assert(localMsg1 !== null);
      assert(cloudMsg1 !== null);
      assertEquals(localMsg1.body, payload1);
      assertEquals(cloudMsg1.body, payload1);
      assertEquals(localMsg1.attempts, 1);
      assertEquals(cloudMsg1.attempts, 1);
      assertEquals(
        localMsg1.body,
        cloudMsg1.body,
        "Message bodies must match across bundles",
      );

      // 2. Ack permanently removes message (Q-3):
      await local.queues.ack(localMsg1.id);
      await cloud.queues.ack(cloudMsg1.id);

      assertEquals(await local.queues.receive(), null);
      assertEquals(await cloud.queues.receive(), null);

      // 3. Batch send parity (Q-2):
      const batchPayloads = [{ idx: 1 }, { idx: 2 }, { idx: 3 }];
      const localBatch = await local.queues.sendBatch(batchPayloads);
      const cloudBatch = await cloud.queues.sendBatch(batchPayloads);

      assertEquals(localBatch.length, 3);
      assertEquals(cloudBatch.length, 3);

      for (let i = 0; i < 3; i++) {
        const lMsg = await local.queues.receive();
        const cMsg = await cloud.queues.receive();
        assert(lMsg !== null);
        assert(cMsg !== null);
        assertEquals(lMsg.body, batchPayloads[i]);
        assertEquals(cMsg.body, batchPayloads[i]);
        await local.queues.ack(lMsg.id);
        await cloud.queues.ack(cMsg.id);
      }

      assertEquals(await local.queues.receive(), null);
      assertEquals(await cloud.queues.receive(), null);

      // 4. Visibility timeout & redelivery attempts parity (Q-3):
      await local.queues.send(payload2);
      await cloud.queues.send(payload2);

      const lFirst = await local.queues.receive({ visibilityTimeoutMs: 500 });
      const cFirst = await cloud.queues.receive({ visibilityTimeoutMs: 500 });
      assert(lFirst && cFirst);
      assertEquals(lFirst.attempts, 1);
      assertEquals(cFirst.attempts, 1);

      // Hidden during visibility window
      assertEquals(await local.queues.receive(), null);
      assertEquals(await cloud.queues.receive(), null);

      // Wait for visibility timeout to expire (600ms)
      await new Promise((resolve) => setTimeout(resolve, 600));

      const lSecond = await local.queues.receive();
      const cSecond = await cloud.queues.receive();
      assert(lSecond && cSecond);
      assertEquals(
        lSecond.attempts,
        2,
        "Local redelivery must increment attempts to 2",
      );
      assertEquals(
        cSecond.attempts,
        2,
        "Cloud redelivery must increment attempts to 2",
      );
      assertEquals(
        lSecond.attempts,
        cSecond.attempts,
        "Redelivery attempt counts must match",
      );

      await local.queues.ack(lSecond.id);
      await cloud.queues.ack(cSecond.id);
    } finally {
      await local.cleanup();
      await cloud.cleanup();
    }
  },
);

Deno.test(
  "Parity Contract: Compute Differential Parity across Local and Cloud bundles (PLAT-4, PLAT-16, PLAT-17, FN-5)",
  async () => {
    const local = await createLocalBundle();
    const cloud = await createCloudBundle();

    try {
      // Artifact that echos request method and parsed body with a custom header
      const handlerSource = `
export default async function handler(req: Request, ctx: any): Promise<Response> {
  let bodyData: unknown = null;
  try {
    bodyData = await req.json();
  } catch {
    bodyData = null;
  }
  return new Response(JSON.stringify({
    echoMethod: req.method,
    echoBody: bodyData,
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-parity-confirmed": "true",
    },
  });
}
`;
      const artifact = await createParityArtifact(handlerSource);
      const limits: Limits = { cpuMs: 500, timeoutMs: 3000, memoryMb: 128 };
      const reqId = generateUlid();
      const invocation: InvocationRequest = {
        requestId: reqId,
        method: "POST",
        url: "http://localhost/test-parity",
        headers: {
          "content-type": "application/json",
          "x-custom-parity": "present",
        },
        body: new TextEncoder().encode(
          JSON.stringify({ parityKey: "value-123" }),
        ),
      };

      const localResult = await local.compute.run(artifact, limits, invocation);
      const cloudResult = await cloud.compute.run(artifact, limits, invocation);

      // Status code parity
      assertEquals(localResult.statusCode, 200);
      assertEquals(cloudResult.statusCode, 200);
      assertEquals(
        localResult.statusCode,
        cloudResult.statusCode,
        "Status codes must match",
      );

      // Response body parity
      const localJson = JSON.parse(new TextDecoder().decode(localResult.body));
      const cloudJson = JSON.parse(new TextDecoder().decode(cloudResult.body));
      assertEquals(
        localJson,
        cloudJson,
        "Compute execution JSON body must match identically",
      );
      assertEquals(localJson.echoMethod, "POST");
      assertEquals(localJson.echoBody, { parityKey: "value-123" });

      // Response headers parity
      assertEquals(
        localResult.headers["x-parity-confirmed"],
        cloudResult.headers["x-parity-confirmed"],
        "Custom response headers must match identically",
      );

      // Metrics non-negativity check (FN-5)
      assert(localResult.cpuTimeMs >= 0);
      assert(localResult.wallClockMs >= 0);
      assert(cloudResult.cpuTimeMs >= 0);
      assert(cloudResult.wallClockMs >= 0);
    } finally {
      await local.cleanup();
      await cloud.cleanup();
    }
  },
);

Deno.test(
  "Parity Contract: Worked-Example Canonical Flow Differential Parity across Local and Cloud bundles (worked-example.md, Q-4, KV-2, OBJ-2, OBJ-3, PLAT-12, PLAT-17)",
  async () => {
    const local = await createLocalBundle();
    const cloud = await createCloudBundle();

    try {
      /**
       * Executes the canonical worked-example flow against any provider bundle:
       * 1. Client requests presigned upload URL (OBJ-2)
       * 2. Client uploads payload directly via HTTP PUT (OBJ-3)
       * 3. Send queue job (Q-2)
       * 4. Processor consumes queue message with dedupe check (Q-4), reads object (OBJ-2),
       *    writes status to KV (KV-2), and writes dedupe key with 14-day retention TTL (Q-4).
       * 5. Redelivered duplicate message is detected in KV and safely skipped (Q-4).
       */
      const executeCanonicalFlow = async (bundle: ProviderBundle) => {
        const fileKey = `upload_${generateUlid()}.dat`;
        const testPayload = new TextEncoder().encode(
          "Canonical worked-example binary payload",
        );

        // Step 1: Request presigned upload URL
        const presignResult = await bundle.objects.presign(fileKey, {
          method: "PUT",
          expiresIn: 600,
        });
        assert(presignResult.url && presignResult.expiresAt > Date.now());

        // Step 2: Client uploads directly to storage
        const putRes = await fetch(presignResult.url, {
          method: "PUT",
          body: testPayload,
          headers: { "content-type": "application/octet-stream" },
        });
        assertEquals(
          putRes.status,
          200,
          `${bundle.name}: direct client PUT must succeed`,
        );

        // Step 3: Send message to queue
        const uploadedAt = Date.now();
        await bundle.queues.send({ key: fileKey, uploadedAt });

        // Step 4: Worker consumes message and simulates processor function
        const msg = await bundle.queues.receive();
        assert(msg !== null, `${bundle.name}: queue message must be received`);
        const { key } = msg.body as { key: string; uploadedAt: number };
        assertEquals(key, fileKey);

        // Processor logic per worked-example.md:
        const dedupeKey = ["processed", key];
        const existingDedupe = await bundle.kv.get(dedupeKey);
        assert(
          existingDedupe === null,
          `${bundle.name}: dedupe key must not exist on first run`,
        );

        const stream = await bundle.objects.get(key);
        assert(
          stream !== null,
          `${bundle.name}: object stream must exist in storage`,
        );
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const downloadedBytes = new Uint8Array(
          chunks.reduce((acc, c) => acc + c.length, 0),
        );
        let offset = 0;
        for (const c of chunks) {
          downloadedBytes.set(c, offset);
          offset += c.length;
        }
        assertEquals(
          downloadedBytes,
          testPayload,
          `${bundle.name}: object bytes must match`,
        );

        // Save status and dedupe key with 14-day TTL per Q-4
        await bundle.kv.set(["files", key], { status: "processed" });
        await bundle.kv.set(dedupeKey, true, { ttl: 14 * 24 * 3600 });
        await bundle.queues.ack(msg.id);

        // Step 5: Duplicate message delivery test (Q-1 / Q-4)
        await bundle.queues.send({ key: fileKey, uploadedAt });
        const duplicateMsg = await bundle.queues.receive();
        assert(duplicateMsg !== null);

        // Dedupe inspection
        const dedupeFound = await bundle.kv.get(dedupeKey);
        assertEquals(
          dedupeFound,
          true,
          `${bundle.name}: dedupe key must exist on duplicate`,
        );
        // Idempotency skip: no object fetch or status overwrite occurs, ack message
        await bundle.queues.ack(duplicateMsg.id);

        const finalStatus = await bundle.kv.get(["files", key]);
        return {
          finalStatus,
          dedupeFound,
          objectSize: downloadedBytes.byteLength,
        };
      };

      const localFlow = await executeCanonicalFlow(local);
      const cloudFlow = await executeCanonicalFlow(cloud);

      assertEquals(
        localFlow.finalStatus,
        { status: "processed" },
        "Local flow final status must be { status: 'processed' }",
      );
      assertEquals(
        cloudFlow.finalStatus,
        { status: "processed" },
        "Cloud flow final status must be { status: 'processed' }",
      );
      assertEquals(
        localFlow.finalStatus,
        cloudFlow.finalStatus,
        "Both flows must record identical KV status",
      );
      assertEquals(localFlow.dedupeFound, true);
      assertEquals(cloudFlow.dedupeFound, true);
      assertEquals(localFlow.objectSize, cloudFlow.objectSize);
    } finally {
      await local.cleanup();
      await cloud.cleanup();
    }
  },
);
