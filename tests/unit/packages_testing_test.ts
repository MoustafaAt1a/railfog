// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
// spec: contracts/platform.contract.md#PLAT-17 — Local/production parity
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: packages/testing
// spec: contracts/functions.contract.md#FN-4 — RailFogContext structure
// spec: contracts/functions.contract.md#FN-5 — Resource limits
// spec: tasks/milestone-0.7-repo-consolidation/T-0708-reusable-test-harness-package.md

import { assertEquals, assertExists } from "@std/assert";
import {
  createMockComputeProvider,
  createMockKVProvider,
  createMockObjectProvider,
  createMockQueueProvider,
  createTestArtifact,
  createTestContext,
  createTestLimits,
} from "../../packages/testing/mod.ts";
import { isValidUlid } from "../../packages/core/id/ulid.ts";

Deno.test("T-0708: createMockKVProvider implements KVProvider and isolates storage", async () => {
  const initial = new Map<string, unknown>([["config:theme", "dark"]]);
  const kv1 = createMockKVProvider(initial);
  const kv2 = createMockKVProvider();

  // Initial read
  assertEquals(await kv1.get(["config", "theme"]), "dark");
  assertEquals(await kv2.get(["config", "theme"]), null);

  // Set and get
  await kv1.set(["users", "1"], { name: "Alice" });
  assertEquals(await kv1.get(["users", "1"]), { name: "Alice" });
  assertEquals(await kv2.get(["users", "1"]), null);

  // List
  const listRes = await kv1.list(["users"]);
  assertEquals(listRes.keys.length, 1);
  assertEquals(listRes.keys[0].key, ["users", "1"]);

  // Delete
  await kv1.delete(["users", "1"]);
  assertEquals(await kv1.get(["users", "1"]), null);

  // Atomic builder
  const atomicRes = await kv1.atomic()
    .set(["atomic", "key"], 123)
    .commit();
  assertEquals(atomicRes.ok, true);
  assertEquals(await kv1.get(["atomic", "key"]), 123);
});

Deno.test("T-0708: createMockObjectProvider implements ObjectProvider", async () => {
  const objProvider = createMockObjectProvider();
  const testData = new TextEncoder().encode("file contents");

  // Put
  const putRes = await objProvider.put("docs/readme.txt", testData.buffer);
  assertExists(putRes.etag);

  // Head
  const headRes = await objProvider.head("docs/readme.txt");
  assertExists(headRes);
  assertEquals(headRes?.size, testData.byteLength);

  // Get stream
  const stream = await objProvider.get("docs/readme.txt");
  assertExists(stream);
  const reader = stream!.getReader();
  const chunk = await reader.read();
  assertEquals(new TextDecoder().decode(chunk.value), "file contents");

  // List
  const listRes = await objProvider.list("docs/");
  assertEquals(listRes.keys, ["docs/readme.txt"]);

  // Presign & Multipart
  const presignRes = await objProvider.presign("docs/readme.txt", {
    method: "GET",
  });
  assertExists(presignRes.url);
  const multipartRes = await objProvider.createMultipartUpload(
    "docs/large.bin",
  );
  assertExists(multipartRes.uploadId);

  // Delete
  await objProvider.delete("docs/readme.txt");
  assertEquals(await objProvider.head("docs/readme.txt"), null);
});

Deno.test("T-0708: createMockQueueProvider implements QueueProvider", async () => {
  const queue = createMockQueueProvider();

  // Send single message
  const sendRes = await queue.send({ task: "resize", id: 1 });
  assertExists(sendRes.id);
  assertEquals(queue.messages.length, 1);

  // Send batch
  const batchRes = await queue.sendBatch([
    { task: "email", id: 2 },
    { task: "audit", id: 3 },
  ]);
  assertEquals(batchRes.length, 2);
  assertEquals(queue.messages.length, 3);

  // Receive
  const msg = await queue.receive();
  assertExists(msg);
  assertEquals(msg?.id, sendRes.id);
  assertEquals(msg?.body, { task: "resize", id: 1 });

  // Ack
  await queue.ack(msg!.id);
  assertEquals(queue.messages.length, 2);
});

Deno.test("T-0708: createMockComputeProvider records calls and executes handler", async () => {
  let customCalled = false;
  const compute = createMockComputeProvider(
    (_artifact, _limits, _invocation) => {
      customCalled = true;
      return Promise.resolve({
        statusCode: 201,
        headers: { "x-custom": "true" },
        body: new TextEncoder().encode("custom-response"),
        cpuTimeMs: 10,
        wallClockMs: 25,
      });
    },
  );

  const artifact = createTestArtifact();
  const limits = createTestLimits();

  const res = await compute.run(artifact, limits, {
    requestId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });

  assertEquals(customCalled, true);
  assertEquals(res.statusCode, 201);
  assertEquals(compute.calls.length, 1);
  assertEquals(compute.calls[0].artifact, artifact);
  assertEquals(compute.calls[0].limits, limits);
  assertEquals(
    compute.calls[0].invocation?.requestId,
    "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  );
});

Deno.test("T-0708: Fixture factories generate valid test objects (PLAT-14, FN-4, FN-5)", () => {
  // Limits
  const limits = createTestLimits({ cpuMs: 500 });
  assertEquals(limits.cpuMs, 500);
  assertEquals(limits.memoryMb, 128);
  assertEquals(limits.timeoutMs, 30000);

  // Artifact
  const artifact = createTestArtifact({ entrypoint: "custom.ts" });
  assertEquals(artifact.entrypoint, "custom.ts");
  assertExists(artifact.id);
  assertExists(artifact.integrity);

  // Context
  const ctx = createTestContext({ project: "custom_proj" });
  assertEquals(ctx.project, "custom_proj");
  assertEquals(isValidUlid(ctx.requestId), true);
  assertEquals(typeof ctx.timeRemaining(), "number");
  assertEquals(ctx.timeRemaining() > 0, true);
  assertExists(ctx.kv);
  assertExists(ctx.objects);
  assertExists(ctx.queues);
  assertExists(ctx.env);
});
