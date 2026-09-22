import { assertEquals, assertExists } from "@std/assert";
import { startRuntimeServer } from "../../apps/runtime/runtime-server.ts";
import { startGatewayServer } from "../../apps/gateway/gateway-server.ts";
import { LocalIsolationProvider } from "../../runtime/sandbox/local-isolation.ts";
import type {
  Artifact,
  ComputeProvider,
  ExecutionResult,
  InvocationRequest,
  IsolationProvider,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import type { RoutingSnapshot } from "../../packages/protocol/snapshot.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";

Deno.test("Optimization 1: Runtime server uses null-prototype invocationHeaders frame", async () => {
  let capturedHeaders: Record<string, string> | undefined;

  class HeaderCapturingIsolationProvider implements IsolationProvider {
    run(
      _artifact: Artifact,
      _limits: Limits,
      invocation?: InvocationRequest,
    ): Promise<ExecutionResult> {
      capturedHeaders = invocation?.headers;
      return Promise.resolve({
        statusCode: 200,
        headers: {},
        body: new Uint8Array(),
        cpuTimeMs: 1,
        wallClockMs: 2,
      });
    }
  }

  const snapshot: RoutingSnapshot = {
    snapshotId: `snap_${generateUlid()}`,
    version: 1,
    routes: [{ pattern: "/api/test", function: "testFn" }],
    functions: {
      testFn: {
        functionName: "testFn",
        revisionId: "rev_test_1",
        artifactId: "sha256:test1",
        permissions: {},
        limits: { cpu_ms: 100, timeout_ms: 2000, memory_mb: 64 },
      },
    },
    generatedAt: Date.now(),
  };

  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, JSON.stringify(snapshot));

  const server = await startRuntimeServer({
    port: 0,
    host: "127.0.0.1",
    projectId: "test-proj",
    snapshotDiskCachePath: tempFile,
    isolationProvider: new HeaderCapturingIsolationProvider(),
  });

  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/test`, {
      headers: { "x-custom-foo": "bar" },
    });
    assertEquals(res.status, 200);
    assertExists(capturedHeaders);
    // Verify null prototype: Object.getPrototypeOf(invocationHeaders) is null
    assertEquals(Object.getPrototypeOf(capturedHeaders), null);
    assertEquals(capturedHeaders["x-custom-foo"], "bar");
    assertEquals(capturedHeaders["toString"], undefined);
    assertEquals(capturedHeaders["valueOf"], undefined);
  } finally {
    await server.close();
    try {
      await Deno.remove(tempFile);
    } catch {
      // ignore
    }
  }
});

Deno.test("Optimization 1: Gateway server strips untrusted internal headers via O(1) delete calls", async () => {
  let receivedHeaders: Headers | undefined;

  const mockUpstream = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    receivedHeaders = new Headers(req.headers);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const upstreamPort = (mockUpstream.addr as Deno.NetAddr).port;

  const gateway = await startGatewayServer({
    port: 0,
    host: "127.0.0.1",
    controlPlaneUrl: `http://127.0.0.1:${upstreamPort}`,
    dataPlaneUrl: `http://127.0.0.1:${upstreamPort}`,
  });

  try {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/api/customer`, {
      headers: {
        "x-forwarded-by": "untrusted-client",
        "x-railfog-trigger": "internal-exploit",
        "x-railfog-call-depth": "999",
        "x-railfog-invocation-id": "spoofed-id",
        "x-legit-header": "safe-value",
      },
    });
    assertEquals(res.status, 200);
    assertExists(receivedHeaders);
    assertEquals(receivedHeaders.get("x-forwarded-by"), "railfog-gateway");
    assertEquals(receivedHeaders.get("x-railfog-trigger"), null);
    assertEquals(receivedHeaders.get("x-railfog-call-depth"), null);
    assertEquals(receivedHeaders.get("x-railfog-invocation-id"), null);
    assertEquals(receivedHeaders.get("x-legit-header"), "safe-value");
  } finally {
    await gateway.close();
    await mockUpstream.shutdown();
  }
});

Deno.test("Optimization 2: LocalIsolationProvider prewarm caches code before live invocations", async () => {
  const provider = new LocalIsolationProvider();
  assertEquals(provider.getWarmCount(), 0);

  const functionCode = `
    let callCount = 0;
    export default function handler(req, ctx) {
      callCount++;
      return Response.json({ callCount });
    }
  `;
  const codeBytes = new TextEncoder().encode(functionCode);

  const artifact: Artifact = {
    id: "sha256:prewarm_test_artifact_01",
    integrity: "sha256-test",
    entrypoint: "index.ts",
    code: codeBytes,
  };
  (artifact as unknown as Record<string, unknown>).project = "prewarm-proj";
  (artifact as unknown as Record<string, unknown>).function = "prewarmFn";
  (artifact as unknown as Record<string, unknown>).revision = "rev-1";
  (artifact as unknown as Record<string, unknown>).orgId = "test-org";

  const limits: Limits = {
    cpuMs: 200,
    timeoutMs: 5000,
    memoryMb: 128,
  };

  // 1. Prewarm before any requests
  await provider.prewarm(artifact, limits);
  assertEquals(provider.getWarmCount(), 1);

  // 2. Prewarm again is idempotent
  await provider.prewarm(artifact, limits);
  assertEquals(provider.getWarmCount(), 1);

  // 3. Live invocation reuses the prewarmed isolate
  const result = await provider.run(artifact, limits, {
    requestId: "req-01",
    headers: {
      "x-railfog-project": "prewarm-proj",
      "x-railfog-function": "prewarmFn",
      "x-railfog-revision": "rev-1",
      "x-railfog-org": "test-org",
    },
  });

  assertEquals(result.statusCode, 200);
  const data = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(data.callCount, 1);
  assertEquals(provider.getWarmCount(), 1);
});

Deno.test("Optimization 2: Runtime server invokes isolationProvider.prewarm on snapshot ingestion", async () => {
  let prewarmedCount = 0;
  let prewarmedArtifactId: string | undefined;

  class PrewarmingSpyProvider implements IsolationProvider {
    run(
      _artifact: Artifact,
      _limits: Limits,
      _invocation?: InvocationRequest,
    ): Promise<ExecutionResult> {
      return Promise.resolve({
        statusCode: 200,
        headers: {},
        body: new Uint8Array(),
        cpuTimeMs: 1,
        wallClockMs: 1,
      });
    }

    prewarm(artifact: Artifact, _limits?: Limits): Promise<void> {
      prewarmedCount++;
      prewarmedArtifactId = artifact.id;
      return Promise.resolve();
    }
  }

  const snapshot: RoutingSnapshot = {
    snapshotId: `snap_${generateUlid()}`,
    version: 1,
    routes: [{ pattern: "/api/hello", function: "helloFn" }],
    functions: {
      helloFn: {
        functionName: "helloFn",
        revisionId: "rev_01",
        artifactId: "sha256:art01",
        permissions: {},
        limits: { cpu_ms: 100, timeout_ms: 3000, memory_mb: 64 },
      },
    },
    generatedAt: Date.now(),
  };

  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, JSON.stringify(snapshot));

  const spyProvider = new PrewarmingSpyProvider();
  const server = await startRuntimeServer({
    port: 0,
    host: "127.0.0.1",
    projectId: "spy-proj",
    snapshotDiskCachePath: tempFile,
    isolationProvider: spyProvider,
  });

  try {
    assertEquals(prewarmedCount, 1);
    assertEquals(prewarmedArtifactId, "sha256:art01");
  } finally {
    await server.close();
    try {
      await Deno.remove(tempFile);
    } catch {
      // ignore
    }
  }
});

Deno.test("Optimization 3: GatewayOptions and RuntimeServerOptions expose socketPath configurations", async () => {
  // Test type interface compatibility for ComputeProvider and IsolationProvider prewarm
  const mockCompute: ComputeProvider = {
    run: (_art, _lim) =>
      Promise.resolve({
        statusCode: 200,
        headers: {},
        body: new Uint8Array(),
        cpuTimeMs: 0,
        wallClockMs: 0,
      }),
    prewarm: (_art, _lim) => Promise.resolve(),
  };
  assertExists(mockCompute.prewarm);

  // Test RuntimeServerOptions socketPath
  const provider = new LocalIsolationProvider();
  const server = await startRuntimeServer({
    port: 0,
    host: "127.0.0.1",
    projectId: "uds-test",
    socketPath: "/tmp/railfog-data.sock",
    isolationProvider: provider,
  });

  try {
    // On Windows, UDS is safely bypassed to TCP and port is > 0
    if (Deno.build.os === "windows") {
      assertEquals(server.port > 0, true);
    } else {
      assertEquals(server.socketPath, "/tmp/railfog-data.sock");
    }
  } finally {
    await server.close();
  }

  // Test GatewayOptions dataPlaneSocketPath accepted
  const gateway = await startGatewayServer({
    port: 0,
    host: "127.0.0.1",
    controlPlaneUrl: "http://127.0.0.1:8081",
    dataPlaneUrl: "http://127.0.0.1:8080",
    dataPlaneSocketPath: "/tmp/railfog-data.sock",
  });

  try {
    assertEquals(gateway.port > 0, true);
  } finally {
    await gateway.close();
  }
});
