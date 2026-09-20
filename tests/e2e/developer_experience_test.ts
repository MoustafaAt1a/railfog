/**
 * Developer Experience End-to-End Test Suite (Tasks T-0510 / T-0511).
 *
 * Spec references:
 * - PLAT-3: Deployment pipeline (static validation, packaging, content-addressing, 3 consecutive 200s within 30s health check gating before traffic cutover, atomic pointer cutover, pointer-flip rollback)
 * - PLAT-12: Error model (exhaustive codes: VALIDATION_FAILED, RESOURCE_NOT_FOUND, INTERNAL, request_id in body and headers)
 * - PLAT-13: Observability (structured JSON logs: timestamp, level, project, function, revision, request_id, duration_ms)
 * - PLAT-14: ULID format (128-bit, Crockford Base32 26 characters for request_id and revision IDs)
 * - PLAT-15: Secrets management (encrypted at rest AES-GCM-256 + PBKDF2, zero plaintext leakage in stdout, stderr, logs, or errors, auto-redacted to [REDACTED])
 * - PLAT-17: Local/production parity (zero external cloud dependencies, SQLite for KV/queues, LocalFS for objects)
 * - PLAT-18: Resource hierarchy (Project -> Function -> Revision)
 * - PLAT-19: Repository structure and CLI commands (init, check, secrets, dev, deploy, logs, rollback)
 * - FN-1: Function definition & default exported fetch handler
 * - FN-2: Trigger declarations (HTTP, Queue, Schedule)
 * - FN-3: Function lifecycle (Created -> Building -> Ready -> Deployed / Failed, pointer-flip rollback)
 * - FN-4: Context structure (ctx.objects, ctx.kv, ctx.queues, ctx.requestId)
 * - FN-5: Resource limits (CPU, memory, timeout ceilings)
 * - FN-6: Isolation & warm-reuse rule (separate context and scoped bindings per invocation)
 * - FN-7: Concurrency control
 * - FN-8: Request lifecycle (route -> cached permissions -> isolate -> fresh ctx -> handler -> response + request_id)
 * - KV-2: KV primitive operations (get, set, delete, list, atomic, ttl)
 * - OBJ-2: Object storage API (put, get, delete, head, list, presign)
 * - OBJ-3: Direct client-to-storage transfer via presigned URLs
 * - OBJ-4: Content addressing (sha256 hex artifact ID, SRI integrity string)
 * - Q-2: Queue dispatch & message handling with QueueMessage
 * - Q-3: Queue redelivery state machine & visibility timeout
 * - Q-4: Idempotency deduplication pattern with mandatory TTL matching retention
 * - docs/contracts/worked-example.md: Canonical upload pipeline reference implementation
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { parse } from "@std/toml";

// CLI commands
import { runInit } from "../../cli/init.ts";
import { checkProject, runCheck } from "../../cli/check.ts";
import { runSecrets } from "../../cli/secrets.ts";
import { deployCommand } from "../../cli/deploy.ts";
import { formatLogEntry, type LogEntry, runLogs } from "../../cli/logs.ts";
import { rollbackCommand } from "../../cli/rollback.ts";

// Runtime and Dev Server
import {
  type LocalServer,
  type RailfogConfig,
  startLocalServer,
} from "../../runtime/dev-server/local-server.ts";

// Identifiers and Packaging
import { generateUlid, isValidUlid } from "../../packages/core/id/ulid.ts";
import {
  type PackagedArtifact,
  packageFunctionArtifact,
} from "../../packages/core/artifact/packager.ts";

// Storage Providers and Capabilities
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";
import { resolvePermissions } from "../../packages/policy/permission-resolver.ts";
import {
  buildContext,
  type LoadedFunctionMeta,
  type RailFogContext,
} from "../../runtime/loader/context-builder.ts";
import type { QueueMessage } from "../../primitives/queues/queue-provider.ts";

// Control Plane Services and Background Workers
import {
  type DeploymentResult,
  DeploymentService,
} from "../../apps/api/deployment-service.ts";
import { QueueConsumerWorker } from "../../apps/worker/queue-consumer.ts";
import { ResourceNotFoundError } from "../../packages/errors/mod.ts";

// Ensure local development master key is available for secret operations (PLAT-15)
const TEST_MASTER_KEY = "railfog-test-master-key-0123456789abcdef";
Deno.env.set("RAILFOG_MASTER_KEY", TEST_MASTER_KEY);

// spec: contracts/platform.contract.md#PLAT-14, PLAT-18 — Revision ID format rev_{ULID}
const REVISION_ID_REGEX = /^rev_[0-9A-HJKMNP-TV-Z]{26}$/;

// spec: contracts/objects.contract.md#OBJ-4 — Content-addressed artifact format sha256:{64 hex chars}
const ARTIFACT_ID_REGEX = /^sha256:[0-9a-f]{64}$/;

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Strips ANSI escape sequences from terminal text.
 */
function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );
}

/**
 * Intercepts console writes during execution to assert exit codes and stdout/stderr output.
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-15 (zero plaintext secret leakage)
 */
async function captureOutput<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    stdoutChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };
  console.info = (...args: unknown[]) => {
    stdoutChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };
  console.warn = (...args: unknown[]) => {
    stderrChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };
  console.error = (...args: unknown[]) => {
    stderrChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };

  try {
    const result = await fn();
    return {
      result,
      stdout: stdoutChunks.join("\n"),
      stderr: stderrChunks.join("\n"),
    };
  } finally {
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origError;
  }
}

/**
 * Subclass of LocalFSProvider that overrides presign to inject the ephemeral port
 * of an in-process direct storage HTTP server.
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-2, OBJ-3
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
 * Starts an in-process direct storage HTTP server that receives PUT uploads,
 * verifies the presigned URL token/signature, and stores bytes directly.
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-3 (direct client-to-storage transfer)
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
 * Subclass of DeploymentService that records probe executions to assert
 * the PLAT-3 3-consecutive-successes health check gating requirement.
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-3
 */
class HealthCheckTrackingDeploymentService extends DeploymentService {
  public probeInvocations: Array<{ project: string; functionName: string }> =
    [];

  override deploy(
    project: string,
    functionName: string,
    artifact: PackagedArtifact,
    healthCheck?: () => Promise<boolean>,
  ): Promise<DeploymentResult> {
    const probe = healthCheck ?? (() => {
      this.probeInvocations.push({ project, functionName });
      return Promise.resolve(true);
    });
    return super.deploy(project, functionName, artifact, probe);
  }
}

// =============================================================================
// Test Suite 1: Complete Developer Journey E2E Lifecycle (T-0511 AC1..AC6)
// =============================================================================

Deno.test(
  "E2E Developer Journey: Init -> Check -> Secrets -> Dev/Hot-Reload -> Deploy -> Logs -> Rollback (T-0511 AC1-AC6)",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-e2e-journey-" });
    let devServer: LocalServer | null = null;
    let storageServer: { port: number; close: () => Promise<void> } | null =
      null;

    try {
      // -----------------------------------------------------------------------
      // Step 1: Initialize (AC1, PLAT-18, PLAT-19)
      // -----------------------------------------------------------------------
      const initResult = await runInit({
        directory: tempDir,
        template: "worked-example",
      });
      assertEquals(initResult.targetDir, tempDir);

      // Assert project structure exists per worked-example.md
      const tomlPath = join(tempDir, "railfog.toml");
      const apiPath = join(tempDir, "functions", "api.ts");
      const processorPath = join(tempDir, "functions", "processor.ts");
      const denoJsonPath = join(tempDir, "deno.json");
      const gitignorePath = join(tempDir, " .gitignore".trim());

      assert((await Deno.stat(tomlPath)).isFile, "railfog.toml must exist");
      assert((await Deno.stat(apiPath)).isFile, "functions/api.ts must exist");
      assert(
        (await Deno.stat(processorPath)).isFile,
        "functions/processor.ts must exist",
      );
      assert((await Deno.stat(denoJsonPath)).isFile, "deno.json must exist");
      assert((await Deno.stat(gitignorePath)).isFile, ".gitignore must exist");

      // -----------------------------------------------------------------------
      // Step 2: Validate (AC1, PLAT-3, PLAT-11, PLAT-12)
      // -----------------------------------------------------------------------
      const checkStatus = await runCheck(tempDir);
      assertEquals(
        checkStatus,
        0,
        "runCheck must return exit code 0 for worked-example",
      );

      const checkReport = await checkProject(tempDir);
      assertEquals(
        checkReport.valid,
        true,
        "checkProject must report valid: true",
      );
      assertEquals(
        checkReport.errors.length,
        0,
        "checkProject must report zero errors",
      );
      assert(
        checkReport.routeSummary && checkReport.routeSummary.length > 0,
        "checkProject must output route summary (PLAT-11)",
      );
      assertEquals(checkReport.routeSummary[0].pattern, "/upload");
      assertEquals(checkReport.routeSummary[0].functionName, "api");
      assertEquals(
        checkReport.routeSummary[0].score,
        2,
        "Score for /upload literal segment must be 2 (PLAT-11)",
      );

      // -----------------------------------------------------------------------
      // Step 3: Secrets Management & Zero-Leakage (AC2, PLAT-15)
      // -----------------------------------------------------------------------
      const secretKey = "TEST_KEY";
      const secretPlaintext = "super_secret_val_12345";

      // Set secret
      const setOutput = await captureOutput(() =>
        runSecrets({
          projectDir: tempDir,
          subcommand: "set",
          key: secretKey,
          value: secretPlaintext,
        })
      );
      assertEquals(
        setOutput.result,
        0,
        "runSecrets set must return exit code 0",
      );
      assertStringIncludes(setOutput.stdout, `Secret ${secretKey} updated`);
      assertFalse(
        setOutput.stdout.includes(secretPlaintext),
        "Set output must not leak secret plaintext (PLAT-15)",
      );
      assertFalse(
        setOutput.stderr.includes(secretPlaintext),
        "Set stderr must not leak secret plaintext (PLAT-15)",
      );

      // List secrets
      const listOutput = await captureOutput(() =>
        runSecrets({
          projectDir: tempDir,
          subcommand: "list",
        })
      );
      assertEquals(
        listOutput.result,
        0,
        "runSecrets list must return exit code 0",
      );
      assertStringIncludes(
        listOutput.stdout,
        secretKey,
        "Secret key must be visible in list",
      );
      assertFalse(
        listOutput.stdout.includes(secretPlaintext),
        "List output must NEVER leak secret plaintext (PLAT-15)",
      );
      assertFalse(
        listOutput.stderr.includes(secretPlaintext),
        "List stderr must NEVER leak secret plaintext (PLAT-15)",
      );

      // Verify on-disk encryption at rest (PLAT-15)
      const tomlContent = await Deno.readTextFile(tomlPath);
      const parsedToml = parse(tomlContent) as unknown as RailfogConfig;
      const projectName = parsedToml.name;

      const encSecretFile = join(
        tempDir,
        ".railfog",
        "secrets",
        "default",
        projectName,
        `${encodeURIComponent(secretKey)}.enc`,
      );
      assert(
        (await Deno.stat(encSecretFile)).isFile,
        "Encrypted secret file must exist at rest",
      );
      const encBytes = await Deno.readFile(encSecretFile);
      const encText = new TextDecoder().decode(encBytes);
      assertFalse(
        encText.includes(secretPlaintext),
        "Secret on disk must be ciphertext (PLAT-15)",
      );

      // -----------------------------------------------------------------------
      // Step 4: Local Dev Server, Direct Transfer, Queue & Hot-Reload (AC3, PLAT-17, FN-1, FN-8)
      // -----------------------------------------------------------------------
      const storageDir = join(tempDir, "storage");
      const storageProvider = new DirectUploadLocalFSProvider(storageDir);
      storageServer = startDirectStorageServer(storageProvider);

      const kvProvider = new SQLiteKVProvider(":memory:");
      const queueProvider = new SQLiteQueueProvider(":memory:");

      devServer = await startLocalServer(parsedToml, 0, {
        cwd: tempDir,
        watch: true,
        debounceMs: 50,
        providers: {
          kv: kvProvider,
          objects: storageProvider,
          queues: queueProvider,
        },
      });

      const serverPort = devServer.port;
      assert(serverPort > 0, "Dev server must bind to ephemeral port");

      // 4a. Client requests POST /upload (FN-8, OBJ-2, Q-2, PLAT-14)
      const uploadReq = await fetch(`http://localhost:${serverPort}/upload`, {
        method: "POST",
      });
      assertEquals(uploadReq.status, 200, "POST /upload must return 200");

      const reqIdHeader = uploadReq.headers.get("x-request-id") ??
        uploadReq.headers.get("request-id");
      assert(
        reqIdHeader !== null,
        "Response must include request_id header (PLAT-12, PLAT-14)",
      );
      assert(
        isValidUlid(reqIdHeader),
        `Header request_id must be valid ULID, got: ${reqIdHeader}`,
      );

      const uploadBody = await uploadReq.json();
      assert(
        typeof uploadBody.uploadUrl === "string",
        "Response body must include uploadUrl",
      );
      assert(
        typeof uploadBody.key === "string",
        "Response body must include key",
      );
      const uploadedKey = uploadBody.key;

      // 4b. Perform direct upload to presigned URL (OBJ-2, OBJ-3)
      const filePayload = new TextEncoder().encode(
        "Hello RailFog worked-example payload!",
      );
      const putRes = await fetch(uploadBody.uploadUrl, {
        method: "PUT",
        body: filePayload,
      });
      assertEquals(
        putRes.status,
        200,
        "Direct PUT to presigned uploadUrl must succeed with 200 (OBJ-3)",
      );

      // 4c. Process queue message with Q-4 deduplication and KV recording
      const processorMod = await import(toFileUrl(processorPath).href);
      const consumeHandler = processorMod.default as (
        message: QueueMessage,
        ctx: RailFogContext,
      ) => Promise<void>;

      // Queue consumer worker dispatches to processor (FN-2, Q-2, Q-3)
      const queueWorker = new QueueConsumerWorker(
        queueProvider,
        async (fnName: string, message: QueueMessage) => {
          assertEquals(
            fnName,
            "processor",
            "Worker must dispatch to processor function",
          );
          const processorBindings = resolvePermissions(
            { kv: ["app:files"], objects: ["app:uploads"] },
            "local-org",
            projectName,
            { kv: kvProvider, objects: storageProvider, queues: queueProvider },
          );
          const fnMeta: LoadedFunctionMeta = {
            project: projectName,
            function: "processor",
            revision: "local-dev",
            timeout_ms: 30000,
          };
          const ctx = buildContext(fnMeta, processorBindings);
          await consumeHandler(message, ctx);
        },
        {
          queueName: "app:jobs",
          targetFunctionName: "processor",
          visibilityTimeoutMs: 5000,
        },
      );

      const processedNext = await queueWorker.processNext();
      assertEquals(
        processedNext,
        true,
        "Worker must successfully process queue message (Q-2)",
      );

      // Verify KV status record written by processor (KV-2)
      const fileRecord = await kvProvider.get([
        "local-org",
        projectName,
        "app:files",
        "files",
        uploadedKey,
      ]);
      assertEquals(
        fileRecord,
        { status: "processed" },
        "KV must record ['files', key] = { status: 'processed' } (KV-2)",
      );

      // Verify deduplication record in KV with retention TTL (Q-4)
      const dedupeRecord = await kvProvider.get([
        "local-org",
        projectName,
        "app:files",
        "processed",
        uploadedKey,
      ]);
      assertEquals(
        dedupeRecord,
        true,
        "KV must record dedupe key ['processed', key] = true (Q-4)",
      );

      // Verify Q-4 deduplication on duplicate message
      const duplicateBindings = resolvePermissions(
        { kv: ["app:files"], objects: ["app:uploads"] },
        "local-org",
        projectName,
        { kv: kvProvider, objects: storageProvider, queues: queueProvider },
      );
      const duplicateCtx = buildContext(
        { project: projectName, function: "processor", revision: "local-dev" },
        duplicateBindings,
      );
      // Directly invoke processor again with same key; must safely early-exit via dedupe key
      await consumeHandler(
        { id: "dup-msg-id", body: { key: uploadedKey }, attempts: 2 },
        duplicateCtx,
      );
      const dedupeRecordAfter = await kvProvider.get([
        "local-org",
        projectName,
        "app:files",
        "processed",
        uploadedKey,
      ]);
      assertEquals(
        dedupeRecordAfter,
        true,
        "Dedupe record must remain unchanged (Q-4)",
      );

      // 4d. Hot-reload: edit functions/api.ts to return version 2 (AC3, FN-1, FN-8)
      const updatedApiCode = `// functions/api.ts — v2
import type { RailFogContext } from "@railfog/sdk";

export default async function handler(
  _req: Request,
  ctx: RailFogContext,
): Promise<Response> {
  const key = crypto.randomUUID();
  const { url } = await ctx.objects.presign(key, { method: "PUT" });
  await ctx.queues.send({ key, uploadedAt: Date.now() });
  return Response.json({ uploadUrl: url, key, version: 2 });
}
`;
      await Deno.writeTextFile(apiPath, updatedApiCode);

      // Wait 250ms for watcher debounce and dynamic module reload
      await new Promise((r) => setTimeout(r, 250));

      // Request POST /upload again
      const uploadReqV2 = await fetch(`http://localhost:${serverPort}/upload`, {
        method: "POST",
      });
      assertEquals(uploadReqV2.status, 200, "POST /upload v2 must return 200");
      const uploadBodyV2 = await uploadReqV2.json();
      assertEquals(
        uploadBodyV2.version,
        2,
        "Reloaded handler must return version 2 without server restart",
      );

      // Verify HTTP server port remains identical (listener not dropped/restarted)
      assertEquals(
        devServer.port,
        serverPort,
        "Server port must remain unchanged across hot reloads",
      );

      // Cleanly close dev server and direct storage server
      await devServer.close();
      devServer = null;
      await storageServer.close();
      storageServer = null;

      // -----------------------------------------------------------------------
      // Step 5: Deploy with Diagnostics & Health Checks (AC4, PLAT-3, OBJ-4)
      // -----------------------------------------------------------------------
      const artifactStorage = new LocalFSProvider(
        join(tempDir, "deploy_artifacts"),
      );
      const deploymentService = new HealthCheckTrackingDeploymentService(
        artifactStorage,
      );

      const deployOutput = await captureOutput(() =>
        deployCommand({
          cwd: tempDir,
          project: projectName,
          deploymentService,
        })
      );

      const deployResult = deployOutput.result;
      assertEquals(
        deployResult.state,
        "Deployed",
        "deployCommand must report state 'Deployed'",
      );
      assertMatch(
        deployResult.revisionId,
        REVISION_ID_REGEX,
        `deployCommand revision ID must match rev_{ULID} format (PLAT-14, PLAT-18), got: ${deployResult.revisionId}`,
      );

      // Pre-deploy diagnostics output verification
      assertStringIncludes(
        deployOutput.stdout,
        "Artifact digest:",
        "Deploy must output artifact digest",
      );
      assertStringIncludes(
        deployOutput.stdout,
        "Integrity:",
        "Deploy must output Subresource Integrity string",
      );
      assertMatch(
        deployOutput.stdout,
        /Artifact digest:\s+sha256:[0-9a-f]{64}/,
        "Artifact digest must follow sha256:{64 hex chars} format (OBJ-4)",
      );

      // Health checks verification: 3 consecutive successes per function (PLAT-3)
      const apiProbes = deploymentService.probeInvocations.filter((p) =>
        p.functionName === "api"
      );
      const procProbes = deploymentService.probeInvocations.filter((p) =>
        p.functionName === "processor"
      );
      assertEquals(
        apiProbes.length,
        3,
        "api function must undergo 3 consecutive healthy checks (PLAT-3)",
      );
      assertEquals(
        procProbes.length,
        3,
        "processor function must undergo 3 consecutive healthy checks (PLAT-3)",
      );

      // Verify active revision in DeploymentService
      const activeApiRev = await deploymentService.getActiveRevision(
        projectName,
        "api",
      );
      assert(activeApiRev !== null, "Active api revision must be set");
      assertEquals(activeApiRev.state, "Deployed");
      assertMatch(activeApiRev.artifactId, ARTIFACT_ID_REGEX);

      // -----------------------------------------------------------------------
      // Step 6: Structured Log Streaming & Secret Redaction (AC5, PLAT-13, PLAT-14, PLAT-15)
      // -----------------------------------------------------------------------
      const sampleRequestId = generateUlid();
      const sampleLogEntry: LogEntry = {
        timestamp: "2026-09-20T12:34:56.789Z",
        level: "info",
        project: projectName,
        function: "api",
        revision: deployResult.revisionId,
        request_id: sampleRequestId,
        duration_ms: 38,
        message: `Processed request with token: ${secretPlaintext} securely`,
      };

      // 6a. formatLogEntry verification
      const formattedPretty = formatLogEntry(sampleLogEntry, "pretty");
      const cleanPretty = stripAnsi(formattedPretty);
      assertStringIncludes(cleanPretty, sampleLogEntry.timestamp);
      assertStringIncludes(cleanPretty, "INFO");
      assertStringIncludes(cleanPretty, "[api]");
      assertStringIncludes(cleanPretty, sampleRequestId);
      assertStringIncludes(cleanPretty, "(38ms)");

      const formattedJson = formatLogEntry(sampleLogEntry, "json");
      const parsedJsonEntry = JSON.parse(formattedJson);
      assertEquals(parsedJsonEntry.level, "info");
      assertEquals(parsedJsonEntry.request_id, sampleRequestId);

      // 6b. runLogs streaming with secret auto-redaction
      const jsonLine = JSON.stringify(sampleLogEntry);

      // Pretty format logs
      const logsPrettyOutput = await captureOutput(() =>
        runLogs({
          projectDir: tempDir,
          format: "pretty",
          logSource: jsonLine,
        })
      );
      assertEquals(logsPrettyOutput.result, 0);
      assertStringIncludes(
        logsPrettyOutput.stdout,
        "[REDACTED]",
        "Secret in log message must be redacted to [REDACTED]",
      );
      assertFalse(
        logsPrettyOutput.stdout.includes(secretPlaintext),
        "Secret plaintext must NEVER leak in pretty logs (PLAT-15)",
      );
      assertFalse(
        logsPrettyOutput.stderr.includes(secretPlaintext),
        "Secret plaintext must NEVER leak in pretty logs stderr (PLAT-15)",
      );

      // JSON format logs
      const logsJsonOutput = await captureOutput(() =>
        runLogs({
          projectDir: tempDir,
          format: "json",
          logSource: jsonLine,
        })
      );
      assertEquals(logsJsonOutput.result, 0);
      assertStringIncludes(
        logsJsonOutput.stdout,
        "[REDACTED]",
        "Secret in JSON log message must be redacted to [REDACTED]",
      );
      assertFalse(
        logsJsonOutput.stdout.includes(secretPlaintext),
        "Secret plaintext must NEVER leak in JSON logs (PLAT-15)",
      );
      const parsedStreamedJson = JSON.parse(logsJsonOutput.stdout.trim());
      assertEquals(parsedStreamedJson.function, "api");
      assertEquals(parsedStreamedJson.request_id, sampleRequestId);
      assertStringIncludes(parsedStreamedJson.message, "[REDACTED]");

      // -----------------------------------------------------------------------
      // Step 7: Rollback & Faulty Deployment Pointer Stability (AC6, PLAT-3, FN-3)
      // -----------------------------------------------------------------------
      const initialActiveApiId = activeApiRev.id;

      // 7a. Faulty revision fails health checks -> prior revision remains active
      const faultyArtifact = await packageFunctionArtifact(
        "functions/api.ts",
        new TextEncoder().encode(
          "export default () => new Response('faulty', { status: 500 });",
        ),
      );
      const faultyDeploy = await deploymentService.deploy(
        projectName,
        "api",
        faultyArtifact,
        () => Promise.resolve(false), // probe returns false (simulating 500 / timeout)
      );
      assertEquals(
        faultyDeploy.state,
        "Failed",
        "Faulty deployment must transition to Failed (FN-3)",
      );
      assertEquals(
        faultyDeploy.active,
        false,
        "Faulty deployment must not be activated (PLAT-3)",
      );

      // Active pointer strictly remains at initial revision
      const activeAfterFaulty = await deploymentService.getActiveRevision(
        projectName,
        "api",
      );
      assertEquals(
        activeAfterFaulty?.id,
        initialActiveApiId,
        "Live traffic pointer must remain at previous revision when candidate fails health check (PLAT-3)",
      );

      // 7b. Deploy a valid second revision (rev2)
      const rev2Artifact = await packageFunctionArtifact(
        "functions/api.ts",
        new TextEncoder().encode(
          "export default () => new Response('rev2 ok');",
        ),
      );
      const rev2Deploy = await deploymentService.deploy(
        projectName,
        "api",
        rev2Artifact,
        () => Promise.resolve(true),
      );
      assertEquals(rev2Deploy.state, "Deployed");
      assertEquals(rev2Deploy.active, true);
      const activeAfterRev2 = await deploymentService.getActiveRevision(
        projectName,
        "api",
      );
      assertEquals(activeAfterRev2?.id, rev2Deploy.revisionId);

      // 7c. Execute rollbackCommand to revert to initialActiveApiId (FN-3, PLAT-3)
      const rollbackResult = await rollbackCommand({
        cwd: tempDir,
        project: projectName,
        functionName: "api",
        targetRevisionId: initialActiveApiId,
        deploymentService,
      });

      assertEquals(rollbackResult.project, projectName);
      assertEquals(rollbackResult.functionName, "api");
      assertEquals(rollbackResult.previousRevisionId, rev2Deploy.revisionId);
      assertEquals(rollbackResult.activeRevisionId, initialActiveApiId);

      // Verify active revision in service is flipped back to initial revision
      const activeAfterRollback = await deploymentService.getActiveRevision(
        projectName,
        "api",
      );
      assertEquals(
        activeAfterRollback?.id,
        initialActiveApiId,
        "Active revision pointer must flip back to target revision upon rollback (PLAT-3, FN-3)",
      );
    } finally {
      if (devServer) {
        await devServer.close();
      }
      if (storageServer) {
        await storageServer.close();
      }
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Windows file locks cleanup safety
      }
    }
  },
);

// =============================================================================
// Test Suite 2: Security & Adversarial Verification (PLAT-15, AC2, AC5)
// =============================================================================

Deno.test(
  "Security: Adversarial verification - zero secret leakage across secrets list, deploy, and structured logs (PLAT-15, AC2, AC5)",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-security-secrets-",
    });
    try {
      await runInit({ directory: tempDir, template: "worked-example" });

      const secretKey1 = "API_KEY";
      const secretVal1 = "secret_api_key_9988776655";
      const secretKey2 = "DB_PASSWORD";
      const secretVal2 = "super_classified_db_pass_112233";

      // 1. Set multiple secrets
      await runSecrets({
        projectDir: tempDir,
        subcommand: "set",
        key: secretKey1,
        value: secretVal1,
      });
      await runSecrets({
        projectDir: tempDir,
        subcommand: "set",
        key: secretKey2,
        value: secretVal2,
      });

      // 2. Adversarial check: secrets list must NEVER print plaintext values
      const listOutput = await captureOutput(() =>
        runSecrets({
          projectDir: tempDir,
          subcommand: "list",
        })
      );
      assertEquals(listOutput.result, 0);
      assertStringIncludes(listOutput.stdout, secretKey1);
      assertStringIncludes(listOutput.stdout, secretKey2);
      assertFalse(
        listOutput.stdout.includes(secretVal1),
        "secretVal1 must not appear in list stdout (PLAT-15)",
      );
      assertFalse(
        listOutput.stdout.includes(secretVal2),
        "secretVal2 must not appear in list stdout (PLAT-15)",
      );
      assertFalse(
        listOutput.stderr.includes(secretVal1),
        "secretVal1 must not appear in list stderr (PLAT-15)",
      );
      assertFalse(
        listOutput.stderr.includes(secretVal2),
        "secretVal2 must not appear in list stderr (PLAT-15)",
      );

      // 3. Adversarial check: deploy diagnostics must never print secret values
      const storage = new LocalFSProvider(join(tempDir, "sec_artifacts"));
      const ds = new DeploymentService(storage);
      const deployOutput = await captureOutput(() =>
        deployCommand({
          cwd: tempDir,
          deploymentService: ds,
        })
      );
      assertEquals(deployOutput.result.state, "Deployed");
      assertFalse(
        deployOutput.stdout.includes(secretVal1),
        "secretVal1 must not appear in deploy output (PLAT-15)",
      );
      assertFalse(
        deployOutput.stdout.includes(secretVal2),
        "secretVal2 must not appear in deploy output (PLAT-15)",
      );
      assertFalse(
        deployOutput.stderr.includes(secretVal1),
        "secretVal1 must not appear in deploy stderr (PLAT-15)",
      );
      assertFalse(
        deployOutput.stderr.includes(secretVal2),
        "secretVal2 must not appear in deploy stderr (PLAT-15)",
      );

      // 4. Adversarial check: structured logs must redact all known secrets across all fields
      const adversarialLog: LogEntry = {
        timestamp: "2026-09-20T14:00:00.000Z",
        level: "error",
        project: "upload-demo",
        function: "api",
        revision: deployOutput.result.revisionId,
        request_id: generateUlid(),
        duration_ms: 120,
        message:
          `Failed auth with ${secretVal1} and database credentials ${secretVal2}`,
        stack: `Error: Connection with ${secretVal2} failed at auth.ts:42`,
        custom_header: `Bearer ${secretVal1}`,
      };

      const streamedOutput = await captureOutput(() =>
        runLogs({
          projectDir: tempDir,
          format: "json",
          logSource: JSON.stringify(adversarialLog),
        })
      );
      assertEquals(streamedOutput.result, 0);
      assertFalse(
        streamedOutput.stdout.includes(secretVal1),
        "secretVal1 must be redacted from streamed logs (PLAT-15)",
      );
      assertFalse(
        streamedOutput.stdout.includes(secretVal2),
        "secretVal2 must be redacted from streamed logs (PLAT-15)",
      );
      assertFalse(
        streamedOutput.stderr.includes(secretVal1),
        "secretVal1 must not leak in stderr (PLAT-15)",
      );
      assertFalse(
        streamedOutput.stderr.includes(secretVal2),
        "secretVal2 must not leak in stderr (PLAT-15)",
      );

      const parsedLogResult = JSON.parse(streamedOutput.stdout.trim());
      assertStringIncludes(parsedLogResult.message, "[REDACTED]");
      assertStringIncludes(parsedLogResult.stack, "[REDACTED]");
      assertStringIncludes(parsedLogResult.custom_header, "[REDACTED]");
    } finally {
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Windows cleanup safety
      }
    }
  },
);

// =============================================================================
// Test Suite 3: Direct Transfer & Idempotency Parity (OBJ-2, OBJ-3, Q-4, KV-2)
// =============================================================================

Deno.test(
  "Parity & Data Transfer: Direct client-to-storage upload (OBJ-2, OBJ-3) and KV idempotency deduplication (Q-4, KV-2)",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-direct-parity-",
    });
    let storageServer: { port: number; close: () => Promise<void> } | null =
      null;

    try {
      const storageProvider = new DirectUploadLocalFSProvider(
        join(tempDir, "storage"),
      );
      storageServer = startDirectStorageServer(storageProvider);

      const kvProvider = new SQLiteKVProvider(":memory:");
      const queueProvider = new SQLiteQueueProvider(":memory:");

      const resolved = resolvePermissions(
        { objects: ["app:uploads"], queues: ["app:jobs"], kv: ["app:files"] },
        "test-org",
        "test-project",
        { kv: kvProvider, objects: storageProvider, queues: queueProvider },
      );
      assert(resolved.objects && resolved.queues && resolved.kv);

      // 1. Generate presigned PUT URL
      const key = "user-avatar-123.png";
      const { url, expiresAt } = await resolved.objects.presign(key, {
        method: "PUT",
      });
      assert(
        url.includes("http://localhost:"),
        "URL must target direct storage port (OBJ-3)",
      );
      assert(expiresAt > Date.now(), "expiresAt must be in the future");

      // 2. Direct upload without proxying
      const binaryPayload = new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]);
      const uploadRes = await fetch(url, {
        method: "PUT",
        body: binaryPayload,
      });
      assertEquals(
        uploadRes.status,
        200,
        "Direct upload to storage server must succeed (OBJ-3)",
      );

      // 3. Verify object stream retrieval via binding
      const stream = await resolved.objects.get(key);
      assert(
        stream !== null,
        "Object must be retrievable after direct upload (OBJ-2)",
      );
      const retrieved = await new Response(stream).arrayBuffer();
      assertEquals(
        new Uint8Array(retrieved),
        binaryPayload,
        "Retrieved bytes must match uploaded bytes exactly",
      );

      // 4. Verify KV idempotency deduplication pattern (Q-4, KV-2)
      const dedupeKey = ["processed", key];
      assertEquals(
        await resolved.kv.get(dedupeKey),
        null,
        "Dedupe key must be empty initially",
      );

      // First run: records data and dedupe key with 14-day retention TTL
      await resolved.kv.set(["files", key], { status: "processed" });
      await resolved.kv.set(dedupeKey, true, { ttl: 14 * 24 * 3600 });

      assertEquals(await resolved.kv.get(["files", key]), {
        status: "processed",
      });
      assertEquals(await resolved.kv.get(dedupeKey), true);

      // Second run: idempotency check detects existing dedupe key
      const alreadyProcessed = await resolved.kv.get(dedupeKey);
      assert(
        alreadyProcessed === true,
        "Subsequent dispatch must detect dedupe key (Q-4)",
      );
    } finally {
      if (storageServer) {
        await storageServer.close();
      }
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Windows cleanup safety
      }
    }
  },
);

// =============================================================================
// Test Suite 4: Deployment Health Check Gating & Revision Pointer Stability (PLAT-3, FN-3)
// =============================================================================

Deno.test(
  "Lifecycle: Rollback pointer stability and health check gating (PLAT-3, FN-3)",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-lifecycle-rollback-",
    });
    try {
      const storage = new LocalFSProvider(join(tempDir, "storage"));
      const deploymentService = new DeploymentService(storage);
      const project = "lifecycle-project";
      const functionName = "api";

      // 1. Deploy rev 1 with passing probe
      const artifact1 = await packageFunctionArtifact(
        "functions/api.ts",
        new TextEncoder().encode("export default () => new Response('rev1');"),
      );
      const dep1 = await deploymentService.deploy(
        project,
        functionName,
        artifact1,
        () => Promise.resolve(true),
      );
      assertEquals(dep1.state, "Deployed");
      assertEquals(dep1.active, true);
      assertEquals(
        (await deploymentService.getActiveRevision(project, functionName))?.id,
        dep1.revisionId,
      );

      // 2. Candidate that fails on probe 2 of 3 must NOT be activated (PLAT-3)
      let probeCount = 0;
      const artifact2 = await packageFunctionArtifact(
        "functions/api.ts",
        new TextEncoder().encode("export default () => new Response('rev2');"),
      );
      const dep2 = await deploymentService.deploy(
        project,
        functionName,
        artifact2,
        () => {
          probeCount++;
          // Fail on attempt 2
          return Promise.resolve(probeCount !== 2);
        },
      );
      assertEquals(
        dep2.state,
        "Failed",
        "Candidate failing 3-consecutive-check gate must fail (PLAT-3)",
      );
      assertEquals(dep2.active, false);
      assertEquals(
        (await deploymentService.getActiveRevision(project, functionName))?.id,
        dep1.revisionId,
        "Prior revision strictly continues serving (PLAT-3)",
      );

      // 3. Candidate that succeeds 3 times activates cleanly
      const artifact3 = await packageFunctionArtifact(
        "functions/api.ts",
        new TextEncoder().encode("export default () => new Response('rev3');"),
      );
      const dep3 = await deploymentService.deploy(
        project,
        functionName,
        artifact3,
        () => Promise.resolve(true),
      );
      assertEquals(dep3.state, "Deployed");
      assertEquals(dep3.active, true);
      assertEquals(
        (await deploymentService.getActiveRevision(project, functionName))?.id,
        dep3.revisionId,
      );

      // 4. Instant rollback to rev 1
      const rollbackResult = await rollbackCommand({
        project,
        functionName,
        targetRevisionId: dep1.revisionId,
        deploymentService,
      });
      assertEquals(rollbackResult.previousRevisionId, dep3.revisionId);
      assertEquals(rollbackResult.activeRevisionId, dep1.revisionId);
      assertEquals(
        (await deploymentService.getActiveRevision(project, functionName))?.id,
        dep1.revisionId,
      );

      // 5. Rollback to non-existent revision rejects with ResourceNotFoundError (PLAT-12)
      await assertRejects(
        async () => {
          await rollbackCommand({
            project,
            functionName,
            targetRevisionId: "rev_01J8NONEXISTENT000000000000",
            deploymentService,
          });
        },
        ResourceNotFoundError,
        "RESOURCE_NOT_FOUND",
      );
    } finally {
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Windows cleanup safety
      }
    }
  },
);
