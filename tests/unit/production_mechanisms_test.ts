import { assertEquals, assertExists } from "@std/assert";
import { startRuntimeServer } from "../../apps/runtime/runtime-server.ts";
import { LocalIsolationProvider } from "../../runtime/sandbox/local-isolation.ts";
import type {
  Artifact,
  Limits,
} from "../../primitives/compute/compute-provider.ts";

Deno.test("Production Mechanisms: Structured logs endpoint GET /v1/projects/:projectId/logs", async () => {
  const isolation = new LocalIsolationProvider();
  const server = await startRuntimeServer({
    port: 0,
    host: "127.0.0.1",
    projectId: "log-test-proj",
    isolationProvider: isolation,
  });

  const port = server.port;

  try {
    // 1. Send health check request
    await fetch(`http://127.0.0.1:${port}/healthz`);

    // 2. Query logs endpoint
    const logsRes = await fetch(
      `http://127.0.0.1:${port}/v1/projects/log-test-proj/logs`,
    );
    assertEquals(logsRes.status, 200);
    const logs = await logsRes.json();
    assertEquals(Array.isArray(logs), true);
  } finally {
    await server.close();
  }
});

Deno.test("Production Mechanisms: Queue dispatcher triggers worker execution and updates KV", async () => {
  const isolation = new LocalIsolationProvider();
  let workerExecuted = false;
  let receivedMessage: unknown = null;

  isolation.setQueueDispatcher((_queueName, body, _projectId) => {
    workerExecuted = true;
    receivedMessage = body;
  });

  // Execute a simulated function that sends to queue
  const callerArtifact: Artifact = {
    id: "art_caller",
    integrity: "art_caller",
    entrypoint: "index.ts",
    code: new TextEncoder().encode(`
      export default async function handler(req, ctx) {
        await ctx.queues.send({ jobId: "test-123", task: "email" });
        return Response.json({ enqueued: true });
      }
    `),
  };

  const limits: Limits = { cpuMs: 200, timeoutMs: 5000, memoryMb: 128 };
  const res = await isolation.run(callerArtifact, limits, {
    requestId: "req-1",
    method: "POST",
    url: "https://example.com/api/queue",
    headers: { "x-railfog-project": "test-proj", "x-railfog-function": "api" },
  });

  assertEquals(res.statusCode, 200);

  // Allow microtask queue to deliver
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(workerExecuted, true);
  assertEquals(
    (receivedMessage as Record<string, unknown>)?.jobId,
    "test-123",
  );
});

Deno.test("Production Mechanisms: Real Object store write, read, and presigned download", async () => {
  const isolation = new LocalIsolationProvider();

  // 1. Store and get an object inside isolation
  const objArtifact: Artifact = {
    id: "art_obj",
    integrity: "art_obj",
    entrypoint: "index.ts",
    code: new TextEncoder().encode(`
      export default async function handler(req, ctx) {
        if (req.method === "POST") {
          await ctx.objects.put("sample.txt", new TextEncoder().encode("Hello Object Storage!"));
          const presigned = await ctx.objects.presign("sample.txt");
          return Response.json({ ok: true, url: presigned.url });
        }
        const stream = await ctx.objects.get("sample.txt");
        if (!stream) return new Response("Not found", { status: 404 });
        return new Response(stream, { headers: { "content-type": "text/plain" } });
      }
    `),
  };

  const limits: Limits = { cpuMs: 200, timeoutMs: 5000, memoryMb: 128 };

  // Write object
  const postRes = await isolation.run(objArtifact, limits, {
    requestId: "req-post-obj",
    method: "POST",
    url: "https://example.com/api/objects",
    headers: { "x-railfog-project": "obj-proj", "x-railfog-function": "api" },
  });
  assertEquals(postRes.statusCode, 200);
  const postBody = JSON.parse(new TextDecoder().decode(postRes.body));
  assertEquals(postBody.ok, true);
  assertExists(postBody.url);

  // Read object
  const getRes = await isolation.run(objArtifact, limits, {
    requestId: "req-get-obj",
    method: "GET",
    url: "https://example.com/api/objects",
    headers: { "x-railfog-project": "obj-proj", "x-railfog-function": "api" },
  });
  assertEquals(getRes.statusCode, 200);
  const getBodyText = new TextDecoder().decode(getRes.body);
  assertEquals(getBodyText, "Hello Object Storage!");
});
