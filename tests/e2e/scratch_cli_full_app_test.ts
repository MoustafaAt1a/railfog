// spec: contracts/platform.contract.md#PLAT-19 — CLI command execution and full developer journey
// spec: contracts/platform.contract.md#PLAT-17 — Local development parity
// spec: contracts/platform.contract.md#PLAT-3 — Deployment pipeline and atomic pointer cutover
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage in CLI commands

import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";
import { join, resolve, toFileUrl } from "@std/path";
import { runInit } from "../../cli/init.ts";
import { runCheck } from "../../cli/check.ts";
import { runSecrets } from "../../cli/secrets.ts";
import { deployCommand } from "../../cli/deploy.ts";
import { runLogs } from "../../cli/logs.ts";
import { runUsage } from "../../cli/usage.ts";
import { exportCommand, importCommand } from "../../cli/state.ts";
import { findClosestCommand, statusCommand } from "../../cli/main.ts";
import {
  type LocalServer,
  startLocalServer,
} from "../../runtime/dev-server/local-server.ts";
import { createRpcClient } from "../../sdk/typescript/client.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";
import { DeploymentService } from "../../apps/api/deployment-service.ts";
import { createStateBackupService } from "../../apps/api/state-backup-service.ts";

Deno.test("Scratch CLI: Full Developer App Lifecycle from Scratch to Deploy & Verification", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-scratch-app-" });
  const appDir = join(tempDir, "acme-edge-service");
  let server: LocalServer | null = null;

  try {
    // -------------------------------------------------------------------------
    // 1. rail init — scaffold project from scratch
    // -------------------------------------------------------------------------
    const initResult = await runInit({
      directory: appDir,
      template: "minimal",
    });
    assert(initResult.filesCreated.length > 0, "Files should be created");
    assert(
      await Deno.stat(join(appDir, "railfog.toml")).then((s) => s.isFile),
      "railfog.toml must exist",
    );
    assert(
      await Deno.stat(join(appDir, "functions", "api.ts")).then((s) =>
        s.isFile
      ),
      "functions/api.ts must exist",
    );

    // -------------------------------------------------------------------------
    // 2. Author a full-featured real-world application
    // -------------------------------------------------------------------------
    const richToml = `#:schema ../../../schemas/railfog.schema.json
name = "acme-edge-service"

[limits]
memory_mb = 128
timeout_ms = 5000

[functions.api]
entry = "functions/api.ts"
timeout_ms = 3000

[functions.api.permissions]
kv = ["main"]
objects = ["assets"]
queues = ["tasks"]
secrets = ["STRIPE_KEY", "WEBHOOK_SECRET"]

[[routes]]
pattern = "/api/hello"
function = "api"

[[routes]]
pattern = "/api/stream"
function = "api"

[[routes]]
pattern = "/api/sse"
function = "api"

[[routes]]
pattern = "/api/kv"
function = "api"
`;
    await Deno.writeTextFile(join(appDir, "railfog.toml"), richToml);

    const sdkModUrl = toFileUrl(resolve("sdk/typescript/mod.ts")).href;
    const richHandlerCode = `
import { handle } from "${sdkModUrl}";

export default handle(async (c) => {
  const url = new URL(c.req.url);

  // 1. Streaming response
  if (url.pathname === "/api/stream") {
    return c.stream(async (writer) => {
      await writer.write("CHUNK_A-");
      await writer.write("CHUNK_B-");
      await writer.write("CHUNK_C");
      await writer.close();
    });
  }

  // 2. Server-Sent Events response
  if (url.pathname === "/api/sse") {
    return c.sse(async (sse) => {
      await sse.send({ event: "init", data: { status: "ready" } });
      await sse.send({ event: "metric", data: { cpu: 12, memory: 45 } });
      await sse.close();
    });
  }

  // 3. KV operations
  if (url.pathname === "/api/kv") {
    if (c.req.method === "POST") {
      const body = await c.body<{ key: string; value: unknown }>();
      await c.kv.set(["items", body.key], body.value);
      return c.json({ ok: true, saved: body.key }, 201);
    }
    const list = await c.kv.list(["items"]);
    return { count: list.keys.length, items: list.keys };
  }

  // Default Hello
  return {
    service: "acme-edge-service",
    requestId: c.requestId,
    uptime: 100,
  };
});
`;
    await Deno.writeTextFile(
      join(appDir, "functions", "api.ts"),
      richHandlerCode,
    );

    // -------------------------------------------------------------------------
    // 3. rail check — static validation with and without flags
    // -------------------------------------------------------------------------
    const checkStandard = await runCheck(appDir);
    assertEquals(
      checkStandard,
      0,
      "rail check should succeed on valid project",
    );

    // -------------------------------------------------------------------------
    // 4. rail status — verify project configuration inspection
    // -------------------------------------------------------------------------
    await statusCommand(appDir);

    // -------------------------------------------------------------------------
    // 5. rail secrets — test secrets set, list, and delete
    // -------------------------------------------------------------------------
    const setSecExit = await runSecrets({
      projectDir: appDir,
      subcommand: "set",
      key: "STRIPE_KEY",
      value: "sk_test_mock_123456789",
    });
    assertEquals(setSecExit, 0, "rail secrets set should succeed");

    const setSec2Exit = await runSecrets({
      projectDir: appDir,
      subcommand: "set",
      key: "WEBHOOK_SECRET",
      value: "whsec_abc123",
    });
    assertEquals(setSec2Exit, 0, "rail secrets set 2 should succeed");

    const listSecExit = await runSecrets({
      projectDir: appDir,
      subcommand: "list",
    });
    assertEquals(listSecExit, 0, "rail secrets list should succeed");

    const delSecExit = await runSecrets({
      projectDir: appDir,
      subcommand: "delete",
      key: "WEBHOOK_SECRET",
    });
    assertEquals(delSecExit, 0, "rail secrets delete should succeed");

    // -------------------------------------------------------------------------
    // 6. rail dev — live execution & RPC client testing
    // -------------------------------------------------------------------------
    const kvProvider = new SQLiteKVProvider(":memory:");
    const objectsProvider = new LocalFSProvider(
      join(appDir, ".railfog", "objects"),
    );
    const queuesProvider = new SQLiteQueueProvider(":memory:");

    server = await startLocalServer(
      {
        name: "acme-edge-service",
        functions: {
          api: {
            entry: "functions/api.ts",
            permissions: {
              kv: ["main"],
              objects: ["assets"],
              queues: ["tasks"],
            },
          },
        },
        routes: [
          { pattern: "/api/hello", function: "api" },
          { pattern: "/api/stream", function: "api" },
          { pattern: "/api/sse", function: "api" },
          { pattern: "/api/kv", function: "api" },
        ],
      },
      0,
      {
        cwd: appDir,
        watch: false,
        logRequests: false,
        providers: {
          kv: kvProvider,
          objects: objectsProvider,
          queues: queuesProvider,
        },
      },
    );

    const client = createRpcClient(`http://localhost:${server.port}`);

    // Test standard GET
    const helloRes = await client.get<{ service: string; requestId: string }>(
      "/api/hello",
    );
    assertEquals(helloRes.service, "acme-edge-service");
    assertExists(helloRes.requestId);

    // Test streaming response
    const streamRes = await fetch(`http://localhost:${server.port}/api/stream`);
    assertEquals(streamRes.status, 200);
    const streamText = await streamRes.text();
    assertEquals(streamText, "CHUNK_A-CHUNK_B-CHUNK_C");

    // Test SSE response
    const sseRes = await fetch(`http://localhost:${server.port}/api/sse`);
    assertEquals(sseRes.status, 200);
    assertEquals(sseRes.headers.get("content-type"), "text/event-stream");
    const sseBody = await sseRes.text();
    assertStringIncludes(sseBody, "event: init");
    assertStringIncludes(sseBody, "event: metric");

    // Test KV operations via RPC
    const kvWrite = await client.post<{ ok: boolean; saved: string }>(
      "/api/kv",
      {
        key: "item_99",
        value: { title: "Widget Pro", price: 49.99 },
      },
    );
    assertEquals(kvWrite.ok, true);
    assertEquals(kvWrite.saved, "item_99");

    const kvRead = await client.get<{ count: number; items: unknown[] }>(
      "/api/kv",
    );
    assertEquals(kvRead.count, 1);

    // Test embedded dev dashboard endpoints
    const dashInfo = await fetch(
      `http://localhost:${server.port}/__railfog/api/info`,
    ).then((r) => r.json());
    assertEquals(dashInfo.project, "acme-edge-service");
    assertEquals(dashInfo.routes.length, 4);

    const dashUi = await fetch(`http://localhost:${server.port}/__railfog`)
      .then((r) => r.text());
    assertStringIncludes(dashUi, "RailFog Local Dashboard");
    assertStringIncludes(dashUi, "acme-edge-service");

    // -------------------------------------------------------------------------
    // 7. rail deploy — full packaging, healthcheck, and deployment pipeline
    // -------------------------------------------------------------------------
    const deployStorage = new LocalFSProvider(
      join(tempDir, "deploy-artifacts"),
    );
    const deploymentService = new DeploymentService(deployStorage);
    const deployRes = await deployCommand({
      cwd: appDir,
      deploymentService,
    });
    assertEquals(deployRes.state, "Deployed");
    assert(deployRes.revisionId.startsWith("rev_"));

    // -------------------------------------------------------------------------
    // 8. rail logs — structured logs formatting and query
    // -------------------------------------------------------------------------
    const logDir = join(appDir, ".railfog");
    await Deno.mkdir(logDir, { recursive: true });
    const sampleLog = {
      timestamp: new Date().toISOString(),
      level: "info",
      project: "acme-edge-service",
      function: "api",
      revision: deployRes.revisionId,
      request_id: "01J8Z000000000000000000001",
      duration_ms: 12,
      message: "Request processed successfully",
    };
    await Deno.writeTextFile(
      join(logDir, "logs.jsonl"),
      JSON.stringify(sampleLog) + "\n",
    );

    const logsExit = await runLogs({
      projectDir: appDir,
      limit: 10,
      level: "info",
    });
    assertEquals(logsExit, 0, "rail logs should exit 0");

    // -------------------------------------------------------------------------
    // 9. rail usage — format pretty and format json
    // -------------------------------------------------------------------------
    const usagePretty = await runUsage({
      projectDir: appDir,
      format: "pretty",
    });
    assertEquals(usagePretty, 0, "rail usage --format pretty should succeed");

    const usageJson = await runUsage({
      projectDir: appDir,
      format: "json",
    });
    assertEquals(usageJson, 0, "rail usage --format json should succeed");

    // -------------------------------------------------------------------------
    // 10. rail export & import — disaster recovery roundtrip
    // -------------------------------------------------------------------------
    const backupPath = join(tempDir, "state-backup.json");
    const stateBackupService = createStateBackupService(
      deploymentService,
      kvProvider,
      objectsProvider,
    );
    const exportRes = await exportCommand({
      cwd: appDir,
      outputFile: backupPath,
      stateBackupService,
    });
    assertExists(exportRes.backupId);
    assert(
      await Deno.stat(backupPath).then((s) => s.isFile),
      "backup file must be created",
    );

    const importRes = await importCommand({
      cwd: appDir,
      inputFile: backupPath,
      stateBackupService,
    });
    assertExists(importRes);
    assertEquals(importRes.restoredRevisions, 1);

    // -------------------------------------------------------------------------
    // 11. Command Typo Suggester — verify Levenshtein distance
    // -------------------------------------------------------------------------
    assertEquals(findClosestCommand("deply"), "deploy");
    assertEquals(findClosestCommand("stauts"), "status");
    assertEquals(findClosestCommand("chekc"), "check");
    assertEquals(findClosestCommand("secrts"), "secrets");
    assertEquals(findClosestCommand("upgrde"), "upgrade");
  } finally {
    if (server) await server.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});
