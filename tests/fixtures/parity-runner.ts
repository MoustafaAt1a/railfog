/**
 * Local/Cloud Provider Parity Contract Test Harness (Task T-0509)
 *
 * Spec references:
 * - docs/contracts/platform.contract.md: PLAT-4 (Isolation), PLAT-16 (Provider abstraction),
 *   PLAT-17 (Local/production parity)
 * - docs/contracts/kv.contract.md: KV-2 (API & TTL), KV-3 (Optimistic concurrency CAS),
 *   KV-5 (Consistency tiers: strong CAS-backed)
 * - docs/contracts/objects.contract.md: OBJ-2 (API shape), OBJ-3 (Direct client-to-storage transfer),
 *   OBJ-4 (Content addressing)
 * - docs/contracts/queues.contract.md: Q-1 (At-least-once delivery), Q-2 (API shape),
 *   Q-3 (Redelivery & visibility timeout)
 * - docs/contracts/functions.contract.md: FN-1 (Function definition), FN-5 (Resource limits)
 */

import { assert, assertEquals, assertRejects } from "@std/assert";

import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type { QueueProvider } from "../../primitives/queues/queue-provider.ts";
import type {
  Artifact,
  ComputeProvider,
  InvocationRequest,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";
import {
  computeArtifactId,
  computeIntegrity,
} from "../../packages/core/crypto/content-address.ts";

export interface ProviderBundle {
  name: "local" | "cloud";
  kv: KVProvider;
  objects: ObjectProvider;
  queues: QueueProvider;
  compute: ComputeProvider;
  cleanup(): Promise<void>;
}

/**
 * Helper to drain a ReadableStream into a contiguous Uint8Array.
 * Spec-anchor: docs/contracts/objects.contract.md#OBJ-2
 */
async function streamToBytes(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const chunk = value instanceof Uint8Array
        ? value
        : new Uint8Array(value as ArrayBuffer);
      chunks.push(chunk);
      totalLength += chunk.byteLength;
    }
  }

  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Helper to build a canonical minimal test artifact per PLAT-3, OBJ-4, and FN-1.
 * Spec-anchor: docs/contracts/objects.contract.md#OBJ-4
 */
async function createTestArtifact(code: string): Promise<Artifact> {
  const codeBytes = new TextEncoder().encode(code);
  return {
    id: await computeArtifactId(codeBytes),
    integrity: await computeIntegrity(codeBytes),
    entrypoint: "index.ts",
    code: codeBytes,
  };
}

let suiteCounter = 0;

/**
 * Registers parameterized Deno.test suites against the bundle produced by bundleFactory().
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-16, PLAT-17
 */
export function runParitySuite(
  bundleFactory: () => Promise<ProviderBundle>,
): void {
  suiteCounter++;
  let tag = bundleFactory.name || `suite_${suiteCounter}`;
  if (tag.startsWith("create")) {
    tag = tag.slice(6);
  }
  if (tag.endsWith("Bundle")) {
    tag = tag.slice(0, -6);
  }
  tag = tag.toLowerCase() || `bundle_${suiteCounter}`;

  // 1. KV operations (KV-2): get, set, delete, list with pagination
  Deno.test(
    `Parity Suite [${tag}]: KV operations - get, set, delete, list with pagination (KV-2, PLAT-16, PLAT-17)`,
    async () => {
      const bundle = await bundleFactory();
      try {
        const prefix = ["parity", tag, "kv", generateUlid()];
        const key1 = [...prefix, "item1"];

        // Initial get on non-existent key returns null
        // spec: contracts/kv.contract.md#KV-2 — get returns null on non-existent key
        assertEquals(await bundle.kv.get(key1), null);

        // Set and get
        // spec: contracts/kv.contract.md#KV-2 — set writes value
        await bundle.kv.set(key1, { message: "initial", count: 1 });
        assertEquals(await bundle.kv.get(key1), {
          message: "initial",
          count: 1,
        });

        // Overwrite and get
        await bundle.kv.set(key1, { message: "overwritten", count: 2 });
        assertEquals(await bundle.kv.get(key1), {
          message: "overwritten",
          count: 2,
        });

        // Delete and get
        // spec: contracts/kv.contract.md#KV-2 — delete removes entry
        await bundle.kv.delete(key1);
        assertEquals(await bundle.kv.get(key1), null);

        // Deleting non-existent key should succeed without throwing
        await bundle.kv.delete(key1);

        // List with pagination
        // spec: contracts/kv.contract.md#KV-2 — list with limit and cursor pagination
        const listPrefix = [...prefix, "paged"];
        const items = ["alpha", "beta", "delta", "gamma"];
        for (const item of items) {
          await bundle.kv.set([...listPrefix, item], { name: item });
        }

        const page1 = await bundle.kv.list(listPrefix, { limit: 2 });
        assertEquals(page1.keys.length, 2);
        assert(
          page1.cursor !== undefined && page1.cursor !== "",
          "Cursor must be returned when more items exist",
        );

        const page2 = await bundle.kv.list(listPrefix, {
          cursor: page1.cursor,
          limit: 2,
        });
        assertEquals(page2.keys.length, 2);

        const allValues = [...page1.keys, ...page2.keys].map(
          (k) => (k.value as { name: string }).name,
        );
        assertEquals(allValues, ["alpha", "beta", "delta", "gamma"]);

        // When all items have been read, cursor should be undefined
        assertEquals(
          page2.cursor,
          undefined,
          "Cursor must be undefined on the final page",
        );
      } finally {
        await bundle.cleanup();
      }
    },
  );

  // 2. KV atomic CAS concurrency (KV-3, KV-5): atomic().check().set().commit()
  Deno.test(
    `Parity Suite [${tag}]: KV atomic CAS concurrency (KV-3, KV-5, PLAT-16, PLAT-17)`,
    async () => {
      const bundle = await bundleFactory();
      try {
        const key = ["parity", tag, "cas", generateUlid()];
        const key2 = ["parity", tag, "cas_other", generateUlid()];

        // Initial write with check(key, 0)
        // spec: contracts/kv.contract.md#KV-3 — non-existent key has version 0, CAS increments
        const cas1 = await bundle.kv.atomic()
          .check(key, 0)
          .set(key, { counter: 1 })
          .commit();

        assertEquals(cas1.ok, true, "Initial atomic CAS commit must succeed");
        assertEquals(await bundle.kv.get(key), { counter: 1 });

        // Stale check: expectedVersion 0 when version is now 1
        // spec: contracts/kv.contract.md#KV-3 — on mismatch return ok=false (conflict)
        const casConflict = await bundle.kv.atomic()
          .check(key, 0)
          .set(key, { counter: 999 })
          .commit();

        assertEquals(
          casConflict.ok,
          false,
          "Conflicting atomic CAS commit must return ok=false",
        );
        // Value must remain unchanged after failed CAS
        assertEquals(await bundle.kv.get(key), { counter: 1 });

        // Multi-key atomic operation: check key2 at version 0, set key2, delete key
        const casMulti = await bundle.kv.atomic()
          .check(key2, 0)
          .set(key2, { status: "created" })
          .delete(key)
          .commit();

        assertEquals(casMulti.ok, true, "Multi-key atomic commit must succeed");
        assertEquals(await bundle.kv.get(key), null);
        assertEquals(await bundle.kv.get(key2), { status: "created" });
      } finally {
        await bundle.cleanup();
      }
    },
  );

  // 3. KV TTL expiration behavior (KV-2)
  Deno.test(
    `Parity Suite [${tag}]: KV TTL expiration behavior (KV-2, PLAT-16, PLAT-17)`,
    async () => {
      const bundle = await bundleFactory();
      try {
        const key = ["parity", tag, "ttl", generateUlid()];

        // Set key with 1-second TTL
        // spec: contracts/kv.contract.md#KV-2 — ttl in seconds
        await bundle.kv.set(key, { ephemeral: true }, { ttl: 1 });

        // Immediately readable
        assertEquals(await bundle.kv.get(key), { ephemeral: true });

        // Wait for TTL expiration (1100 ms)
        await new Promise((resolve) => setTimeout(resolve, 1100));

        // After TTL expiration, key must evaluate to null
        // spec: contracts/kv.contract.md#KV-2 — expired entry returns null
        assertEquals(await bundle.kv.get(key), null);

        // Expired key should allow atomic check(key, 0)
        // spec: contracts/kv.contract.md#KV-3 — expired key behaves as version 0
        const reviveCas = await bundle.kv.atomic()
          .check(key, 0)
          .set(key, { revived: true })
          .commit();
        assertEquals(reviveCas.ok, true);
        assertEquals(await bundle.kv.get(key), { revived: true });
      } finally {
        await bundle.cleanup();
      }
    },
  );

  // 4. Objects CRUD and lifecycle (OBJ-2): put, get, head, list, delete
  Deno.test(
    `Parity Suite [${tag}]: Objects CRUD and lifecycle (OBJ-2, PLAT-16, PLAT-17)`,
    async () => {
      const bundle = await bundleFactory();
      try {
        const key = `parity/${tag}/objects/${generateUlid()}.dat`;
        const testData = new TextEncoder().encode(
          "RailFog Parity Test Payload 1234567890",
        );

        // Head and get on non-existent key return null
        // spec: contracts/objects.contract.md#OBJ-2 — head/get return null for missing key
        assertEquals(await bundle.objects.head(key), null);
        assertEquals(await bundle.objects.get(key), null);

        // Put object
        // spec: contracts/objects.contract.md#OBJ-2 — put returns etag
        const putResult = await bundle.objects.put(
          key,
          testData.buffer as ArrayBuffer,
        );
        assert(
          typeof putResult.etag === "string" && putResult.etag.length > 0,
          "Put must return non-empty etag",
        );

        // Head object
        // spec: contracts/objects.contract.md#OBJ-2 — head returns size and etag
        const headResult = await bundle.objects.head(key);
        assert(
          headResult !== null,
          "Head must return metadata for stored object",
        );
        assertEquals(headResult.size, testData.byteLength);
        assert(
          typeof headResult.etag === "string" && headResult.etag.length > 0,
        );

        // Get object stream
        // spec: contracts/objects.contract.md#OBJ-2 — get returns ReadableStream
        const stream = await bundle.objects.get(key);
        assert(
          stream !== null,
          "Get must return ReadableStream for stored object",
        );
        const downloadedBytes = await streamToBytes(stream);
        assertEquals(downloadedBytes, testData);

        // List with pagination
        const listPrefix = `parity/${tag}/list_${generateUlid()}/`;
        for (let i = 1; i <= 3; i++) {
          await bundle.objects.put(
            `${listPrefix}item_${i}.bin`,
            new Uint8Array([i, i + 1, i + 2]).buffer as ArrayBuffer,
          );
        }

        const listPage1 = await bundle.objects.list(listPrefix, { limit: 2 });
        assertEquals(listPage1.keys.length, 2);
        assert(
          listPage1.cursor !== undefined && listPage1.cursor !== "",
          "List cursor must be provided when more keys exist",
        );

        const listPage2 = await bundle.objects.list(listPrefix, {
          cursor: listPage1.cursor,
          limit: 2,
        });
        assertEquals(listPage2.keys.length, 1);

        const allKeys = [...listPage1.keys, ...listPage2.keys];
        assertEquals(allKeys, [
          `${listPrefix}item_1.bin`,
          `${listPrefix}item_2.bin`,
          `${listPrefix}item_3.bin`,
        ]);

        // Multipart upload initiate
        // spec: contracts/objects.contract.md#OBJ-2 — createMultipartUpload returns uploadId
        const mpResult = await bundle.objects.createMultipartUpload(key);
        assert(
          typeof mpResult.uploadId === "string" && mpResult.uploadId.length > 0,
        );

        // Delete object
        // spec: contracts/objects.contract.md#OBJ-2 — delete removes object
        await bundle.objects.delete(key);
        assertEquals(await bundle.objects.head(key), null);
        assertEquals(await bundle.objects.get(key), null);

        // Deleting non-existent key must not throw
        await bundle.objects.delete(
          `parity/${tag}/nonexistent_${generateUlid()}`,
        );
      } finally {
        await bundle.cleanup();
      }
    },
  );

  // 5. Objects presigning (OBJ-3): presign PUT and GET with expiration
  Deno.test(
    `Parity Suite [${tag}]: Objects presigning - direct client transfer and expiration (OBJ-2, OBJ-3, PLAT-16, PLAT-17)`,
    async () => {
      const bundle = await bundleFactory();
      try {
        const key = `parity/${tag}/presign/${generateUlid()}.dat`;
        const testPayload = new Uint8Array([11, 22, 33, 44, 55, 66, 77, 88]);

        // Presign PUT
        // spec: contracts/objects.contract.md#OBJ-2, OBJ-3 — presign PUT for direct client upload
        const presignPut = await bundle.objects.presign(key, {
          method: "PUT",
          expiresIn: 300,
        });
        assert(presignPut.url.startsWith("http"));
        assert(presignPut.expiresAt > Date.now());

        // Direct client HTTP PUT
        // spec: contracts/objects.contract.md#OBJ-3 — direct client-to-storage upload
        const putResponse = await fetch(presignPut.url, {
          method: "PUT",
          body: testPayload,
          headers: { "content-type": "application/octet-stream" },
        });
        assertEquals(
          putResponse.status,
          200,
          "Direct client PUT to presigned URL must return 200",
        );

        // Verify stored object via provider head
        const head = await bundle.objects.head(key);
        assert(head !== null);
        assertEquals(head.size, testPayload.byteLength);

        // Presign GET
        // spec: contracts/objects.contract.md#OBJ-2, OBJ-3 — presign GET for direct client download
        const presignGet = await bundle.objects.presign(key, {
          method: "GET",
          expiresIn: 300,
        });
        assert(presignGet.url.startsWith("http"));
        assert(presignGet.expiresAt > Date.now());

        // Direct client HTTP GET
        const getResponse = await fetch(presignGet.url, { method: "GET" });
        assertEquals(
          getResponse.status,
          200,
          "Direct client GET from presigned URL must return 200",
        );
        const downloadedBytes = new Uint8Array(
          await getResponse.arrayBuffer(),
        );
        assertEquals(downloadedBytes, testPayload);

        // Expiration validation: expiresIn > maxExpiresIn must reject
        // spec: contracts/objects.contract.md#OBJ-2 — expiresIn > maxExpiresIn is rejected
        await assertRejects(async () => {
          await bundle.objects.presign(key, {
            method: "GET",
            expiresIn: 90000,
            maxExpiresIn: 86400,
          });
        });

        // Cleanup
        await bundle.objects.delete(key);
      } finally {
        await bundle.cleanup();
      }
    },
  );

  // 6. Queues dispatch (Q-2, Q-3): send, sendBatch, receive, ack, visibility
  Deno.test(
    `Parity Suite [${tag}]: Queues dispatch - send, sendBatch, receive, ack, visibility (Q-1, Q-2, Q-3, PLAT-16, PLAT-17)`,
    async () => {
      const bundle = await bundleFactory();
      try {
        // Initial receive on empty queue returns null
        assertEquals(await bundle.queues.receive(), null);

        // 1. Single send and receive (Q-2)
        const job1 = { taskId: generateUlid(), action: "process-thumbnail" };
        const send1 = await bundle.queues.send(job1);
        assert(typeof send1.id === "string" && send1.id.length > 0);

        const msg1 = await bundle.queues.receive();
        assert(msg1 !== null, "Message must be received from queue");
        assertEquals(msg1.body, job1);
        assertEquals(msg1.attempts, 1);

        // 2. Ack removes message (Q-3)
        await bundle.queues.ack(msg1.id);
        assertEquals(await bundle.queues.receive(), null);

        // 3. Batch send (Q-2)
        const batchItems = [
          { index: 1, tag: generateUlid() },
          { index: 2, tag: generateUlid() },
          { index: 3, tag: generateUlid() },
        ];
        const batchRes = await bundle.queues.sendBatch(batchItems);
        assertEquals(batchRes.length, 3);
        assert(
          batchRes.every((r) => typeof r.id === "string" && r.id.length > 0),
        );

        // Consume and ack batch items
        for (let i = 0; i < 3; i++) {
          const rec = await bundle.queues.receive();
          assert(rec !== null, `Batch item ${i} must be received`);
          assertEquals(rec.attempts, 1);
          assertEquals(rec.body, batchItems[i]);
          await bundle.queues.ack(rec.id);
        }
        assertEquals(await bundle.queues.receive(), null);

        // 4. Visibility timeout and redelivery attempts (Q-3)
        // spec: contracts/queues.contract.md#Q-3 — invisible for visibility_timeout_ms, redelivered with incremented attempts
        const retryJob = { retryId: generateUlid(), count: 0 };
        await bundle.queues.send(retryJob);

        const firstReceive = await bundle.queues.receive({
          visibilityTimeoutMs: 500,
        });
        assert(firstReceive !== null);
        assertEquals(firstReceive.body, retryJob);
        assertEquals(firstReceive.attempts, 1);

        // During visibility window, receive returns null
        assertEquals(await bundle.queues.receive(), null);

        // Wait for visibility timeout to expire (600 ms)
        await new Promise((resolve) => setTimeout(resolve, 600));

        // After timeout expires, message is redelivered with attempts = 2
        const secondReceive = await bundle.queues.receive();
        assert(
          secondReceive !== null,
          "Message must be redelivered after visibility expires",
        );
        assertEquals(secondReceive.body, retryJob);
        assertEquals(
          secondReceive.attempts,
          2,
          "Redelivered message attempts must be 2",
        );

        // Ack to finalize
        await bundle.queues.ack(secondReceive.id);
        assertEquals(await bundle.queues.receive(), null);
      } finally {
        await bundle.cleanup();
      }
    },
  );

  // 7. Compute provider execution (PLAT-4, PLAT-16, FN-5)
  Deno.test(
    `Parity Suite [${tag}]: Compute provider execution - isolated artifact execution (PLAT-4, PLAT-16, FN-1, FN-5, OBJ-4)`,
    async () => {
      const bundle = await bundleFactory();
      try {
        // Function handler responding with echoed body, method, and a custom header
        // spec: contracts/functions.contract.md#FN-1 — standard Web Request/Response handler
        const handlerCode = `
export default async function handler(req: Request, ctx: unknown): Promise<Response> {
  let parsed: unknown = null;
  try {
    parsed = await req.json();
  } catch {
    parsed = null;
  }
  return new Response(JSON.stringify({
    ok: true,
    method: req.method,
    data: parsed,
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-parity-runner": "verified",
    },
  });
}
`;
        const artifact = await createTestArtifact(handlerCode);
        const limits: Limits = { cpuMs: 1000, timeoutMs: 5000, memoryMb: 128 };
        const reqPayload = { ping: "pong", ulid: generateUlid() };
        const invocation: InvocationRequest = {
          requestId: generateUlid(),
          method: "POST",
          url: "http://localhost/parity-exec",
          headers: {
            "content-type": "application/json",
            "x-invoked-by": "parity-runner",
          },
          body: new TextEncoder().encode(JSON.stringify(reqPayload)),
        };

        // spec: contracts/platform.contract.md#PLAT-16 — compute.run executes artifact
        const result = await bundle.compute.run(artifact, limits, invocation);

        // spec: contracts/platform.contract.md#PLAT-4, PLAT-16, FN-5 — ExecutionResult shape
        assertEquals(result.statusCode, 200);
        assertEquals(result.headers["x-parity-runner"], "verified");

        const responseJson = JSON.parse(new TextDecoder().decode(result.body));
        assertEquals(responseJson.ok, true);
        assertEquals(responseJson.method, "POST");
        assertEquals(responseJson.data, reqPayload);

        // spec: contracts/functions.contract.md#FN-5 — metrics non-negativity
        assert(result.cpuTimeMs >= 0, "cpuTimeMs must be non-negative");
        assert(result.wallClockMs >= 0, "wallClockMs must be non-negative");
      } finally {
        await bundle.cleanup();
      }
    },
  );
}
