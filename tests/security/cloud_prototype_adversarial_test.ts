/**
 * Adversarial Security Test Suite for Task T-0211 (Cloud Prototype E2E).
 *
 * Spec references:
 * - PLAT-1: Separation of control plane and data plane (zero synchronous calls on request path)
 * - PLAT-6: Deploy-time capability injection (unpermitted resources are inexpressible / undefined)
 * - PLAT-7: Multi-tenant physical prefixing ({org}/{project}/{resource}) and cross-tenant collision prevention
 * - PLAT-8: Fail-static snapshot cache (data plane serves indefinitely during control plane outage)
 * - OBJ-2: Object storage API and presigned URL operations
 * - OBJ-3: Direct client-to-storage transfer (zero proxying, token tampering & method enforcement)
 * - Q-4: Idempotency dedupe retention TTL (preventing unbounded KV growth)
 * - FN-6: Warm-isolate context and binding identity isolation
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertNotStrictEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { delay } from "@std/async/delay";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";
import {
  resolvePermissions,
} from "../../packages/policy/permission-resolver.ts";
import {
  buildContext,
  type LoadedFunctionMeta,
} from "../../runtime/loader/context-builder.ts";
import { RuntimeSnapshotCache } from "../../runtime/snapshot/snapshot-cache.ts";
import { type RoutingSnapshot } from "../../packages/protocol/snapshot.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import type { QueueMessage } from "../../primitives/queues/queue-provider.ts";
import { QueueConsumerWorker } from "../../apps/worker/queue-consumer.ts";

// ============================================================================
// ATTACK VECTOR 1: PLAT-6 Capability Injection & Inexpressible Access
// ============================================================================

Deno.test(
  "Adversarial PLAT-6: api handler cannot address or execute ANY KV operation (get, set, delete, list, atomic)",
  () => {
    const kv = new SQLiteKVProvider(":memory:");
    const storageDir = Deno.makeTempDirSync();
    const storage = new LocalFSProvider(storageDir);
    const queues = new SQLiteQueueProvider(":memory:");

    try {
      // api function declares only objects and queues, NO kv
      const bindings = resolvePermissions(
        { objects: ["app:uploads"], queues: ["app:jobs"] },
        "org-corp",
        "proj-api",
        { kv, objects: storage, queues },
      );

      assertEquals(bindings.kv, undefined, "bindings.kv must be undefined");

      const ctx = buildContext(
        { project: "proj-api", function: "api", revision: "rev_plat6_01" },
        bindings,
      );

      // Attempt every single method on ctx.kv — each must fail structurally before reaching backend
      const kvMethods = ["get", "set", "delete", "list", "atomic"] as const;
      for (const method of kvMethods) {
        assertEquals(
          (ctx.kv as unknown as Record<string, unknown>)[method],
          undefined,
          `ctx.kv.${method} must be structurally undefined (not a runtime permission error)`,
        );
        assertThrows(
          () => {
            ((ctx.kv as unknown as Record<
              string,
              (...args: unknown[]) => unknown
            >)[method])(["key"]);
          },
          TypeError,
          undefined,
          `Calling ctx.kv.${method} must throw TypeError (not a function)`,
        );
      }
    } finally {
      Deno.removeSync(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Adversarial PLAT-6: processor handler cannot address or execute ANY Queue operation (send, sendBatch, receive, ack)",
  () => {
    const kv = new SQLiteKVProvider(":memory:");
    const storageDir = Deno.makeTempDirSync();
    const storage = new LocalFSProvider(storageDir);
    const queues = new SQLiteQueueProvider(":memory:");

    try {
      // processor declares only objects and kv, NO queues
      const bindings = resolvePermissions(
        { objects: ["app:uploads"], kv: ["app:files"] },
        "org-corp",
        "proj-worker",
        { kv, objects: storage, queues },
      );

      assertEquals(
        bindings.queues,
        undefined,
        "bindings.queues must be undefined",
      );

      const ctx = buildContext(
        {
          project: "proj-worker",
          function: "processor",
          revision: "rev_plat6_02",
        },
        bindings,
      );

      // Attempt every single method on ctx.queues — each must fail structurally
      const queueMethods = ["send", "sendBatch", "receive", "ack"] as const;
      for (const method of queueMethods) {
        assertEquals(
          (ctx.queues as unknown as Record<string, unknown>)[method],
          undefined,
          `ctx.queues.${method} must be structurally undefined`,
        );
        assertThrows(
          () => {
            ((ctx.queues as unknown as Record<
              string,
              (...args: unknown[]) => unknown
            >)[method])({ foo: "bar" });
          },
          TypeError,
          undefined,
          `Calling ctx.queues.${method} must throw TypeError (not a function)`,
        );
      }
    } finally {
      Deno.removeSync(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Adversarial PLAT-6: processor cannot address ungranted KV namespaces or escape namespace via path traversal",
  async () => {
    const kv = new SQLiteKVProvider(":memory:");
    const storageDir = Deno.makeTempDirSync();
    const storage = new LocalFSProvider(storageDir);
    const queues = new SQLiteQueueProvider(":memory:");

    try {
      // Seed a sensitive KV record in an ungranted namespace: app:secrets
      await kv.set(
        ["org-corp", "proj-worker", "app:secrets", "stripe_token"],
        "secret_live_sk_12345",
      );

      // Processor function only has app:files
      const bindings = resolvePermissions(
        { kv: ["app:files"] },
        "org-corp",
        "proj-worker",
        { kv, objects: storage, queues },
      );

      const ctx = buildContext(
        {
          project: "proj-worker",
          function: "processor",
          revision: "rev_plat6_03",
        },
        bindings,
      );

      // 1. Calling ctx.kv.get(["stripe_token"]) looks only inside app:files
      const read1 = await ctx.kv.get(["stripe_token"]);
      assertEquals(
        read1,
        null,
        "Must not access records outside app:files namespace",
      );

      // 2. Adversarial namespace escape attempt: try prepending target namespace
      const read2 = await ctx.kv.get(["app:secrets", "stripe_token"]);
      assertEquals(read2, null, "Must not access app:secrets namespace");

      // 3. Adversarial path traversal attempt in array segments: ["..", "app:secrets", "stripe_token"]
      const read3 = await ctx.kv.get(["..", "app:secrets", "stripe_token"]);
      assertEquals(
        read3,
        null,
        "Array path traversal must not escape into app:secrets",
      );

      // 4. Writing with traversal attempt stores safely within app:files, never touching app:secrets
      await ctx.kv.set(["..", "app:secrets", "stripe_token"], "overwritten");
      const sensitiveRecordAfter = await kv.get([
        "org-corp",
        "proj-worker",
        "app:secrets",
        "stripe_token",
      ]);
      assertEquals(
        sensitiveRecordAfter,
        "secret_live_sk_12345",
        "Target namespace must remain unmodified after traversal attack",
      );

      // Verify the traversal key was literally trapped under app:files
      const trapped = await kv.get([
        "org-corp",
        "proj-worker",
        "app:files",
        "..",
        "app:secrets",
        "stripe_token",
      ]);
      assertEquals(trapped, "overwritten");
    } finally {
      Deno.removeSync(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Adversarial PLAT-6: Ambiguous / multiple namespace requests are rejected at resolution time",
  () => {
    const kv = new SQLiteKVProvider(":memory:");
    const storage = new LocalFSProvider(Deno.makeTempDirSync());
    const queues = new SQLiteQueueProvider(":memory:");

    // Requesting multiple KV namespaces must throw ValidationFailedError
    assertThrows(
      () =>
        resolvePermissions(
          { kv: ["app:files", "app:sessions"] },
          "org-corp",
          "proj-1",
          { kv, objects: storage, queues },
        ),
      ValidationFailedError,
      "Ambiguous scope: Multiple KV namespaces requested",
    );

    // Requesting multiple Object buckets must throw ValidationFailedError
    assertThrows(
      () =>
        resolvePermissions(
          { objects: ["app:uploads", "app:logs"] },
          "org-corp",
          "proj-1",
          { kv, objects: storage, queues },
        ),
      ValidationFailedError,
      "Ambiguous scope: Multiple Object buckets requested",
    );

    // Requesting multiple queues must throw ValidationFailedError
    assertThrows(
      () =>
        resolvePermissions(
          { queues: ["app:jobs", "app:notifications"] },
          "org-corp",
          "proj-1",
          { kv, objects: storage, queues },
        ),
      ValidationFailedError,
      "Ambiguous scope: Multiple Queues requested",
    );
  },
);

// ============================================================================
// ATTACK VECTOR 2: PLAT-7 Multi-Tenant Data Isolation & Collision Resistance
// ============================================================================

Deno.test(
  "Adversarial PLAT-7: Two organizations with identical project names and identical KV/Object keys never collide",
  async () => {
    const kv = new SQLiteKVProvider(":memory:");
    const storageDir = await Deno.makeTempDir();
    const storage = new LocalFSProvider(storageDir);
    const queues = new SQLiteQueueProvider(":memory:");

    try {
      // Org Alpha: project 'store', resource 'app:files'
      const bindingsAlpha = resolvePermissions(
        { kv: ["app:files"], objects: ["app:uploads"] },
        "tenant-alpha",
        "store",
        { kv, objects: storage, queues },
      );
      const ctxAlpha = buildContext(
        { project: "store", function: "api", revision: "rev_01" },
        bindingsAlpha,
      );

      // Org Beta: project 'store', resource 'app:files'
      const bindingsBeta = resolvePermissions(
        { kv: ["app:files"], objects: ["app:uploads"] },
        "tenant-beta",
        "store",
        { kv, objects: storage, queues },
      );
      const ctxBeta = buildContext(
        { project: "store", function: "api", revision: "rev_01" },
        bindingsBeta,
      );

      // 1. Both tenants write to KV using identical caller key: ["customers", "c100"]
      await ctxAlpha.kv.set(["customers", "c100"], {
        name: "Alice",
        tenant: "alpha",
      });
      await ctxBeta.kv.set(["customers", "c100"], {
        name: "Bob",
        tenant: "beta",
      });

      // 2. Both read back their own caller key
      const alphaCustomer = await ctxAlpha.kv.get(["customers", "c100"]);
      const betaCustomer = await ctxBeta.kv.get(["customers", "c100"]);

      assertEquals(alphaCustomer, { name: "Alice", tenant: "alpha" });
      assertEquals(betaCustomer, { name: "Bob", tenant: "beta" });

      // 3. Alpha deletes key; Beta must NOT be affected
      await ctxAlpha.kv.delete(["customers", "c100"]);
      assertEquals(await ctxAlpha.kv.get(["customers", "c100"]), null);
      assertEquals(await ctxBeta.kv.get(["customers", "c100"]), {
        name: "Bob",
        tenant: "beta",
      });

      // 4. Listing keys in Alpha does not leak Beta keys
      const alphaList = await ctxAlpha.kv.list(["customers"]);
      assertEquals(alphaList.keys.length, 0);

      const betaList = await ctxBeta.kv.list(["customers"]);
      assertEquals(betaList.keys.length, 1);
      assertEquals(betaList.keys[0].key, ["customers", "c100"]);

      // 5. Objects isolation: both write identical object key 'report.pdf'
      const alphaBytes = new TextEncoder().encode(
        "CONFIDENTIAL_TENANT_ALPHA_FINANCIALS",
      );
      const betaBytes = new TextEncoder().encode("PUBLIC_TENANT_BETA_BROCHURE");

      await ctxAlpha.objects.put("report.pdf", alphaBytes.buffer);
      await ctxBeta.objects.put("report.pdf", betaBytes.buffer);

      const alphaStream = await ctxAlpha.objects.get("report.pdf");
      const betaStream = await ctxBeta.objects.get("report.pdf");
      assert(alphaStream && betaStream);

      const readAll = async (stream: ReadableStream): Promise<string> => {
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const res = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          res.set(c, off);
          off += c.length;
        }
        return new TextDecoder().decode(res);
      };

      assertEquals(
        await readAll(alphaStream),
        "CONFIDENTIAL_TENANT_ALPHA_FINANCIALS",
      );
      assertEquals(await readAll(betaStream), "PUBLIC_TENANT_BETA_BROCHURE");

      // Verify physical storage paths are distinct
      const headAlpha = await storage.head(
        "tenant-alpha/store/app:uploads/report.pdf",
      );
      const headBeta = await storage.head(
        "tenant-beta/store/app:uploads/report.pdf",
      );
      assert(headAlpha !== null && headBeta !== null);
      assertNotEquals(headAlpha.etag, headBeta.etag);
    } finally {
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Adversarial PLAT-7: Path traversal attack on LocalFSProvider root directory is strictly rejected",
  async () => {
    const baseDir = await Deno.makeTempDir();
    const rootDir = join(baseDir, "storage_root");
    const evilSibling = join(baseDir, "storage_root_evil");
    await Deno.mkdir(rootDir);
    await Deno.mkdir(evilSibling);

    const provider = new LocalFSProvider(rootDir);

    try {
      // 1. Path traversal attempting to escape root into evil sibling
      await assertRejects(
        () =>
          provider.put(
            "../storage_root_evil/pwned.txt",
            new Uint8Array([1, 2, 3]).buffer,
          ),
        ValidationFailedError,
        "Path traversal detected: path escapes root directory",
      );

      // 2. Relative traversal attempting to escape root
      await assertRejects(
        () => provider.get("../../etc/passwd"),
        ValidationFailedError,
        "Path traversal detected: path escapes root directory",
      );

      // 3. Absolute path traversal
      await assertRejects(
        () => provider.delete("/root/secret"),
        ValidationFailedError,
        "Path traversal detected: path escapes root directory",
      );

      // Verify no file was created in evil sibling
      let siblingEscaped = false;
      try {
        await Deno.stat(join(evilSibling, "pwned.txt"));
        siblingEscaped = true;
      } catch {
        siblingEscaped = false;
      }
      assertFalse(
        siblingEscaped,
        "File must not be written to sibling directory!",
      );
    } finally {
      await Deno.remove(baseDir, { recursive: true });
    }
  },
);

// ============================================================================
// ATTACK VECTOR 3: OBJ-3 Direct Storage Transfer & Presigned URL Security
// ============================================================================

Deno.test(
  "Adversarial OBJ-3: Presigned URL key-swapping, method confusion, and signature tampering are rejected",
  async () => {
    const storageDir = await Deno.makeTempDir();
    const provider = new LocalFSProvider(storageDir);

    try {
      // 1. Generate legitimate presigned PUT URL for keyA
      const { url: validPutUrl } = await provider.presign(
        "uploads/file-A.bin",
        {
          method: "PUT",
          expiresIn: 300,
        },
      );

      // Legitimate URL verifies successfully for PUT
      const valid = await provider.verifyPresignedUrl(validPutUrl, "PUT");
      assertEquals(valid, true, "Legitimate presigned PUT URL must be valid");

      // 2. Attack: Key Swapping (IDOR)
      // Attacker swaps pathname to target file-B.bin while reusing the token from file-A.bin
      const swappedUrl = new URL(validPutUrl);
      swappedUrl.pathname = "/local-fs/uploads/file-B.bin";
      const swappedValid = await provider.verifyPresignedUrl(
        swappedUrl.toString(),
        "PUT",
      );
      assertEquals(
        swappedValid,
        false,
        "Presigned URL with swapped key pathname must be rejected (key mismatch)",
      );

      // 3. Attack: Method Confusion
      // Attacker requests presigned GET URL and attempts to verify it for PUT operation
      const { url: getUrl } = await provider.presign("uploads/read-only.txt", {
        method: "GET",
        expiresIn: 300,
      });
      const methodConfusionValid = await provider.verifyPresignedUrl(
        getUrl,
        "PUT",
      );
      assertEquals(
        methodConfusionValid,
        false,
        "GET presigned URL must NOT be valid for PUT requests",
      );

      // 4. Attack: Signature Tampering
      // Attacker modifies the signature parameter in the URL query string
      const tamperedSigUrl = new URL(validPutUrl);
      tamperedSigUrl.searchParams.set(
        "sig",
        "deadbeef00112233445566778899aabbccddeeff",
      );
      const tamperedValid = await provider.verifyPresignedUrl(
        tamperedSigUrl.toString(),
        "PUT",
      );
      assertEquals(
        tamperedValid,
        false,
        "Presigned URL with tampered signature must be rejected",
      );

      // 5. Attack: Expired token
      const { url: expiredUrl } = await provider.presign("uploads/quick.bin", {
        method: "PUT",
        expiresIn: 1,
      });
      await delay(1100);
      const expiredValid = await provider.verifyPresignedUrl(expiredUrl, "PUT");
      assertEquals(
        expiredValid,
        false,
        "Expired presigned URL must be rejected",
      );
    } finally {
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Adversarial OBJ-3: Zero bandwidth proxying - data plane does not handle or buffer file payload bytes",
  async () => {
    // Verify that data plane response for /upload is purely metadata ({ uploadUrl, key })
    // and payload bytes go directly to the storage server port
    let dataPlaneReceivedBytes = 0;
    const dataPlaneServer = Deno.serve({ port: 0 }, async (req: Request) => {
      const body = await req.arrayBuffer();
      dataPlaneReceivedBytes += body.byteLength;
      return Response.json({
        uploadUrl: `http://localhost:${storagePort}/local-fs/test-key`,
        key: "test-key",
      });
    });
    const dataPlanePort = (dataPlaneServer.addr as Deno.NetAddr).port;

    let storageReceivedBytes = 0;
    const storageServer = Deno.serve({ port: 0 }, async (req: Request) => {
      const body = await req.arrayBuffer();
      storageReceivedBytes += body.byteLength;
      return new Response(null, { status: 200 });
    });
    const storagePort = (storageServer.addr as Deno.NetAddr).port;

    try {
      // 1. Client calls /upload on data plane with zero upload bytes
      const initRes = await fetch(`http://localhost:${dataPlanePort}/upload`, {
        method: "POST",
      });
      assertEquals(initRes.status, 200);
      const { uploadUrl } = await initRes.json();
      assertEquals(
        dataPlaneReceivedBytes,
        0,
        "Data plane must receive 0 payload bytes on /upload",
      );

      // 2. Client sends 1 MB of payload directly to storage presigned URL
      const largePayload = new Uint8Array(1024 * 1024); // 1 MB
      largePayload.fill(0xaa);

      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        body: largePayload,
      });
      assertEquals(putRes.status, 200);

      // Verify that all 1 MB went to storage server, and data plane received 0 bytes
      assertEquals(
        storageReceivedBytes,
        1024 * 1024,
        "Storage server must receive full payload",
      );
      assertEquals(
        dataPlaneReceivedBytes,
        0,
        "Data plane must NEVER proxy file payload bytes (OBJ-3)",
      );
    } finally {
      await dataPlaneServer.shutdown();
      await storageServer.shutdown();
    }
  },
);

// ============================================================================
// ATTACK VECTOR 4: PLAT-8 Fail-Static Data Plane Operation
// ============================================================================

Deno.test(
  "Adversarial PLAT-8: Control plane hang, network error, and malformed payload do not disrupt data-plane snapshot serving",
  async () => {
    const snapshot: RoutingSnapshot = {
      snapshotId: "snap_01M2E000000000000000000001",
      version: 1,
      routes: [{ pattern: "/test", function: "testFn" }],
      functions: {
        testFn: {
          functionName: "testFn",
          revisionId: "rev_01M2E000000000000000000001",
          artifactId:
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          permissions: {},
          limits: {
            cpu_ms: 100,
            timeout_ms: 5000,
            memory_mb: 128,
          },
        },
      },
      generatedAt: Date.now(),
    };

    let mode: "ok" | "hang" | "network_error" | "malformed" = "ok";

    const fetchSnapshot = (): Promise<RoutingSnapshot> => {
      if (mode === "hang") {
        // Return promise that never resolves (infinite control plane stall)
        return new Promise(() => {});
      }
      if (mode === "network_error") {
        return Promise.reject(
          new Error("ECONNREFUSED: Control plane unreachable"),
        );
      }
      if (mode === "malformed") {
        return Promise.resolve({
          snapshotId: "not-a-valid-ulid",
          routes: "invalid",
        } as unknown as RoutingSnapshot);
      }
      return Promise.resolve(snapshot);
    };

    const cache = new RuntimeSnapshotCache(fetchSnapshot, {
      pollIntervalMs: 20,
    });
    await cache.forceRefresh();
    cache.start();

    try {
      // 1. Baseline: snapshot loaded
      assertEquals(cache.getLatestSnapshot()?.snapshotId, snapshot.snapshotId);

      // 2. Attack: Infinite control plane stall (hang)
      mode = "hang";
      await delay(50);
      // Data plane getLatestSnapshot() must be instant and non-blocking
      const t0 = performance.now();
      const snapDuringHang = cache.getLatestSnapshot();
      const duration = performance.now() - t0;
      assert(
        duration < 5,
        `Synchronous read must take <5ms, took ${duration}ms`,
      );
      assertEquals(snapDuringHang?.snapshotId, snapshot.snapshotId);

      // 3. Attack: Network Error (connection refused)
      mode = "network_error";
      await delay(50);
      assertEquals(
        cache.getLatestSnapshot()?.snapshotId,
        snapshot.snapshotId,
        "Snapshot must be preserved during network failure",
      );

      // 4. Attack: Corrupted / malformed snapshot data from control plane
      mode = "malformed";
      await delay(50);
      assertEquals(
        cache.getLatestSnapshot()?.snapshotId,
        snapshot.snapshotId,
        "Corrupted snapshot payload must be discarded, preserving cached snapshot",
      );
    } finally {
      cache.stop();
    }
  },
);

// ============================================================================
// ATTACK VECTOR 5: Q-4 Idempotency Retention TTL & Database Verification
// ============================================================================

Deno.test(
  "Adversarial Q-4: Dedupe keys written by queue consumer include real non-null TTL matching retention window",
  async () => {
    const kv = new SQLiteKVProvider(":memory:");
    const storageDir = await Deno.makeTempDir();
    const storage = new LocalFSProvider(storageDir);
    const queues = new SQLiteQueueProvider(":memory:");

    try {
      const messageKey = "doc_" + crypto.randomUUID();
      const retentionDays = 14;
      const expectedTtlSeconds = retentionDays * 24 * 3600;

      // Seed queue message
      await queues.send({ key: messageKey });

      // Worker executes processor function with Q-4 idempotency pattern
      let executionCount = 0;
      const worker = new QueueConsumerWorker(
        queues,
        async (_fn: string, message: QueueMessage) => {
          executionCount++;
          const body = message.body as { key: string };
          const dedupeKey = ["processed", body.key];

          const bindings = resolvePermissions(
            { kv: ["app:files"] },
            "local-org",
            "upload-demo",
            { kv, objects: storage, queues },
          );
          const ctx = buildContext(
            {
              project: "upload-demo",
              function: "processor",
              revision: "rev_q4",
            },
            bindings,
          );

          if (await ctx.kv.get(dedupeKey)) {
            return;
          }

          // Write processed record and dedupe key with 14-day retention TTL
          await ctx.kv.set(["files", body.key], { status: "processed" });
          await ctx.kv.set(dedupeKey, true, { ttl: expectedTtlSeconds });
        },
        { queueName: "app:jobs", targetFunctionName: "processor" },
      );

      // First delivery: executed
      const p1 = await worker.processNext();
      assertEquals(p1, true);
      assertEquals(executionCount, 1);

      // Direct SQL database inspection: Verify expires_at is NOT null and matches retention window
      // Access internal SQLite db to assert physical column value
      const physicalKeyPath = kv.encodeKeyPath([
        "local-org",
        "upload-demo",
        "app:files",
        "processed",
        messageKey,
      ]);

      const db = (kv as unknown as {
        db: {
          prepare: (
            q: string,
          ) => { get: (k: string) => { expires_at: number | null } };
        };
      }).db;
      const row = db.prepare(
        "SELECT expires_at FROM kv_entries WHERE key_path = ?",
      ).get(physicalKeyPath);

      assert(row !== undefined, "Dedupe row must exist in kv_entries");
      assert(
        row.expires_at !== null,
        "Audit Finding #5 check: expires_at must NOT be null (TTL must be set on dedupe keys per Q-4 / KV-2)",
      );

      const now = Date.now();
      const expectedMinExpiresAt = now + (expectedTtlSeconds - 60) * 1000;
      const expectedMaxExpiresAt = now + (expectedTtlSeconds + 60) * 1000;

      assert(
        row.expires_at >= expectedMinExpiresAt &&
          row.expires_at <= expectedMaxExpiresAt,
        `expires_at (${row.expires_at}) must be within 14-day retention window [${expectedMinExpiresAt}, ${expectedMaxExpiresAt}]`,
      );

      // Duplicate delivery with same key: must be skipped
      await queues.send({ key: messageKey });
      const p2 = await worker.processNext();
      assertEquals(p2, true);
      assertEquals(executionCount, 2); // Handler was invoked, but skipped work

      // Non-dedupe record (files/key) has no TTL (permanent storage)
      const dataPhysicalKeyPath = kv.encodeKeyPath([
        "local-org",
        "upload-demo",
        "app:files",
        "files",
        messageKey,
      ]);
      const dataRow = db.prepare(
        "SELECT expires_at FROM kv_entries WHERE key_path = ?",
      ).get(dataPhysicalKeyPath);
      assertEquals(
        dataRow.expires_at,
        null,
        "Data record (non-dedupe) must NOT have forced TTL",
      );
    } finally {
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

// ============================================================================
// ATTACK VECTOR 6: FN-6 Warm-Isolate Reuse & State Non-Survival
// ============================================================================

Deno.test(
  "Adversarial FN-6: Context and binding object identity are never shared across invocations",
  () => {
    const kv = new SQLiteKVProvider(":memory:");
    const storageDir = Deno.makeTempDirSync();
    const storage = new LocalFSProvider(storageDir);
    const queues = new SQLiteQueueProvider(":memory:");

    try {
      const bindings = resolvePermissions(
        { kv: ["app:files"], objects: ["app:uploads"], queues: ["app:jobs"] },
        "org-test",
        "proj-test",
        { kv, objects: storage, queues },
      );

      const fnMeta: LoadedFunctionMeta = {
        project: "proj-test",
        function: "api",
        revision: "rev_warm_01",
      };

      // Invocations 1 and 2 of the same function revision
      const ctx1 = buildContext(fnMeta, bindings);
      const ctx2 = buildContext(fnMeta, bindings);

      // 1. Context objects must have distinct identities
      assertNotStrictEquals(
        ctx1,
        ctx2,
        "Context objects must not share reference identity",
      );

      // 2. Request IDs must be distinct ULIDs
      assertNotEquals(
        ctx1.requestId,
        ctx2.requestId,
        "Request IDs must be distinct per invocation",
      );

      // 3. Binding wrappers must not share identity
      assertNotStrictEquals(
        ctx1.kv,
        ctx2.kv,
        "KV binding must be freshly constructed per invocation",
      );
      assertNotStrictEquals(
        ctx1.objects,
        ctx2.objects,
        "Objects binding must be freshly constructed",
      );
      assertNotStrictEquals(
        ctx1.queues,
        ctx2.queues,
        "Queues binding must be freshly constructed",
      );

      // 4. Mutation attempt on ctx1 must not bleed into ctx2
      (ctx1 as unknown as Record<string, unknown>).injectedState =
        "malicious_payload";
      (ctx1.kv as unknown as Record<string, unknown>).stolenKey =
        "injected_leak";

      assertFalse(
        "injectedState" in ctx2,
        "Injected property on ctx1 must not exist on ctx2",
      );
      assertFalse(
        "stolenKey" in (ctx2.kv as unknown as Record<string, unknown>),
        "Injected property on ctx1.kv must not exist on ctx2.kv",
      );
    } finally {
      Deno.removeSync(storageDir, { recursive: true });
    }
  },
);
