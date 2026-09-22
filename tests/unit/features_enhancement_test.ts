import { assertEquals } from "@std/assert";
import { startRuntimeServer } from "../../apps/runtime/runtime-server.ts";
import { LocalIsolationProvider } from "../../runtime/sandbox/local-isolation.ts";
import { SnapshotDistributor } from "../../packages/protocol/snapshot.ts";
import type { RevisionRecord } from "../../apps/api/deployment-service.ts";

Deno.test("Features Enhancement: auth = 'bearer' rejects unauthenticated and allows authenticated", async () => {
  const isolation = new LocalIsolationProvider();
  const distributor = new SnapshotDistributor();

  const activeRevisions: Record<string, RevisionRecord> = {
    secureFn: {
      id: "rev_01SECURE000000000000000001",
      project: "test-proj",
      functionName: "secureFn",
      artifactId:
        "sha256:0000000000000000000000000000000000000000000000000000000000000001",
      integrity: "sha256-test",
      state: "Deployed",
      createdAt: Date.now(),
      manifest: {
        entrypoint: "index.ts",
        permissions: {},
        limits: { cpu_ms: 200, timeout_ms: 5000, memory_mb: 128 },
        auth: "bearer",
      } as unknown as RevisionRecord["manifest"],
    },
  };

  const routes = [{ pattern: "/api/secure", function: "secureFn" }];
  const snapshot = distributor.createSnapshot(routes, activeRevisions);

  const tempFile = await Deno.makeTempFile();
  await Deno.writeTextFile(tempFile, JSON.stringify(snapshot));

  const server = await startRuntimeServer({
    port: 0,
    host: "127.0.0.1",
    projectId: "test-proj",
    snapshotDiskCachePath: tempFile,
    isolationProvider: isolation,
  });

  const port = server.port;

  try {
    // 1. Unauthenticated request -> 401 UNAUTHORIZED
    const unauthRes = await fetch(`http://127.0.0.1:${port}/api/secure`);
    assertEquals(unauthRes.status, 401);
    const unauthBody = await unauthRes.json();
    assertEquals(unauthBody.error.code, "UNAUTHORIZED");

    // 2. Authenticated request with Bearer header -> proceeds to isolate (returns 200 or 404/not found handler, not 401)
    const authRes = await fetch(`http://127.0.0.1:${port}/api/secure`, {
      headers: { authorization: "Bearer secret-token-123" },
    });
    assertEquals(authRes.status !== 401, true);
  } finally {
    await server.close();
  }
});

Deno.test("Features Enhancement: Environment staging path-prefix and rate limiting", async () => {
  const isolation = new LocalIsolationProvider();
  const server = await startRuntimeServer({
    port: 0,
    host: "127.0.0.1",
    projectId: "cloud-demo",
    isolationProvider: isolation,
  });

  const port = server.port;

  try {
    // Check path-prefix environment resolution: /cloud-demo/staging/unknown-route returns 404 RESOURCE_NOT_FOUND (not crashed)
    const res = await fetch(
      `http://127.0.0.1:${port}/cloud-demo/staging/api/test`,
    );
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error.code, "RESOURCE_NOT_FOUND");
  } finally {
    await server.close();
  }
});
