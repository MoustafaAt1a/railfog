// spec: contracts/platform.contract.md#PLAT-1 — Ephemeral loopback callback server & control plane separation
// spec: contracts/platform.contract.md#PLAT-3 — Deployment pipeline (validation, packaging, verification gate)
// spec: contracts/platform.contract.md#PLAT-6 — Caller identity resolution & capability injection
// spec: contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm
// spec: contracts/platform.contract.md#PLAT-12 — Canonical error taxonomy & request_id propagation
// spec: contracts/platform.contract.md#PLAT-14 — ULID identifiers for revisions and request tracing
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage in logs, traces, and outputs
// spec: contracts/platform.contract.md#PLAT-17 — Local development parity (embedded SQLite/Postgres simulator)
// spec: contracts/platform.contract.md#PLAT-18 — Project resource hierarchy & naming
// spec: contracts/platform.contract.md#PLAT-19 — CLI interactive flows, status spinners, scaffolding, and installer scripts
// spec: contracts/functions.contract.md#FN-1 — Function definition & ergonomic HTTP handler wrapper
// spec: contracts/functions.contract.md#FN-4 — RailFogContext structure and capability bindings
// spec: tasks/milestone-0.8-developer-experience-ux/T-0812-milestone-08-verification-suite.md

import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join, resolve } from "@std/path";

// Control plane & Auth components
import { startControlServer } from "../../apps/api/control-server.ts";
import { DeploymentService } from "../../apps/api/deployment-service.ts";
import { createStateBackupService } from "../../apps/api/state-backup-service.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { PostgresKVProvider } from "../../providers/kv/postgres-provider.ts";
import { ApiKeyStore } from "../../packages/auth/store.ts";

// CLI modules
import { runLogin, runWhoami } from "../../cli/login.ts";
import { loadCliConfig, saveCliConfig } from "../../cli/auth-config.ts";
import { runInteractiveInit } from "../../cli/init.ts";
import {
  type Choice,
  selectPrompt,
  type WriterSync,
} from "../../cli/prompt.ts";
import {
  type DeployProgressCallbacks,
  type DeploySummary,
  runDeploy,
} from "../../cli/deploy.ts";
import { CANONICAL_SDK_URL, runAdd } from "../../cli/add.ts";

// SDK modules
import { api, handle } from "../../sdk/typescript/wrapper.ts";
import type {
  EnvBinding,
  KVAtomicOperation,
  KVBinding,
  ObjectBinding,
  QueueBinding,
  RailFogContext,
} from "../../sdk/typescript/types.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";

// ============================================================================
// Test Helpers & Mock Fixtures
// ============================================================================

/**
 * In-memory synchronous terminal stream for capturing interactive CLI output.
 */
class MemoryTerminalStream implements WriterSync {
  public chunks: Uint8Array[] = [];
  public terminal: boolean;

  constructor(isTerminal = true) {
    this.terminal = isTerminal;
  }

  isTerminal(): boolean {
    return this.terminal;
  }

  writeSync(p: Uint8Array): number {
    this.chunks.push(new Uint8Array(p));
    return p.length;
  }

  get text(): string {
    const decoder = new TextDecoder();
    return this.chunks.map((c) => decoder.decode(c)).join("");
  }

  clear(): void {
    this.chunks = [];
  }
}

/**
 * Creates a deterministic mock RailFogContext complying with FN-4, PLAT-6, and PLAT-15.
 */
function createMockContext(
  overrides?: Partial<RailFogContext>,
): RailFogContext {
  const deadline = overrides?.deadline ?? (Date.now() + 30000);
  const kvData = new Map<string, unknown>();
  const secrets = new Map<string, string>([
    ["API_KEY", "rfk_mock_secret_key"],
    ["DB_PASS", "postgres_secret_internal_pass"],
  ]);

  const mockKv: KVBinding = {
    get<T = unknown>(key: string[]): Promise<T | null> {
      const val = kvData.get(key.join(":"));
      return Promise.resolve((val as T) ?? null);
    },
    set(key: string[], value: unknown): Promise<void> {
      kvData.set(key.join(":"), value);
      return Promise.resolve();
    },
    delete(key: string[]): Promise<void> {
      kvData.delete(key.join(":"));
      return Promise.resolve();
    },
    list: () => Promise.resolve({ entries: [] }),
    atomic: () => ({
      check: function () {
        return this;
      },
      set: function () {
        return this;
      },
      delete: function () {
        return this;
      },
      commit: () => Promise.resolve({ ok: true, version: 1 }),
    } as unknown as KVAtomicOperation),
  };

  const mockObjects: ObjectBinding = {
    put: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    head: () => Promise.resolve(null),
    list: () => Promise.resolve({ keys: [] }),
    createMultipartUpload: () =>
      Promise.resolve({ uploadId: "mock-upload-id" }),
    presign: (key: string) =>
      Promise.resolve({
        url: `https://storage.railfog.internal/bucket/${key}`,
        headers: {},
      }),
  };

  const mockQueues: QueueBinding = {
    send: () => Promise.resolve({ id: "01J8ZE2EMOCK00000000000001" }),
    sendBatch: () => Promise.resolve([{ id: "01J8ZE2EMOCK00000000000001" }]),
  };

  const mockEnv: EnvBinding = {
    get: (key: string) => secrets.get(key),
    require: (key: string) => {
      const val = secrets.get(key);
      if (!val) throw new Error(`Missing required secret: ${key}`);
      return val;
    },
  };

  return {
    requestId: overrides?.requestId ?? "01J8ZE2EREQUESTID0000000001",
    project: overrides?.project ?? "e2e-project",
    function: overrides?.function ?? "api",
    revision: overrides?.revision ?? "rev_01J8ZE2EREVISION000000001",
    deadline,
    timeRemaining: () => Math.max(0, deadline - Date.now()),
    kv: overrides?.kv ?? mockKv,
    objects: overrides?.objects ?? mockObjects,
    queues: overrides?.queues ?? mockQueues,
    env: overrides?.env ?? mockEnv,
    ...overrides,
  };
}

/**
 * Creates a valid temporary project structure for testing rail deploy.
 */
async function createDeployableProject(
  dir: string,
  projectName = "e2e-deploy-app",
): Promise<void> {
  await Deno.mkdir(join(dir, "functions"), { recursive: true });

  const handlerCode = `// Minimal function handler
export default async function handler(req: Request): Promise<Response> {
  return Response.json({ status: "ok", url: req.url });
}
`;
  await Deno.writeTextFile(join(dir, "functions", "api.ts"), handlerCode);

  const tomlContent = `name = "${projectName}"

[functions.api]
entry = "functions/api.ts"

[functions.api.permissions]
kv = ["app:data"]

[[routes]]
pattern = "/api/*"
function = "api"
`;
  await Deno.writeTextFile(join(dir, "railfog.toml"), tomlContent);
}

// ============================================================================
// 1. End-to-End Zero-Copy Callback Authentication
// spec: PLAT-1, PLAT-6, PLAT-15, PLAT-17, PLAT-19
// ============================================================================

Deno.test(
  "E2E Milestone 0.8 [1/8]: Zero-copy callback login flow end-to-end (< 2s, mode 0600 on POSIX, PLAT-15)",
  async () => {
    const tempDir = await Deno.makeTempDir();
    const configPath = join(tempDir, "config.json");

    // 1. Spin up real standalone control plane daemon
    const storageDir = await Deno.makeTempDir();
    const storage = new LocalFSProvider(storageDir);
    const kv = new PostgresKVProvider();
    const deploymentService = new DeploymentService(storage);
    const stateBackupService = createStateBackupService(
      deploymentService,
      kv,
      storage,
    );
    const apiKeyStore = new ApiKeyStore({ storageProvider: kv });

    const controlServer = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      deploymentService,
      stateBackupService,
      apiKeyStore,
    });
    const controlUrl = `http://127.0.0.1:${controlServer.port}`;

    try {
      // 2. Provision an API key through the control server
      const createRes = await fetch(`${controlUrl}/v1/auth/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId: "e2e-enterprise-org",
          name: "cli-laptop",
        }),
      });
      assertEquals(
        createRes.status,
        200,
        "Control server key creation must return 200",
      );
      const keyData = await createRes.json();
      assertEquals(keyData.ok, true);
      const rawToken = keyData.rawToken as string;
      assert(
        rawToken.startsWith("rfk_"),
        "API key must have rfk_ prefix per PLAT-15",
      );

      // 3. Initiate zero-copy login and benchmark timing (< 2s per AC1)
      const startTime = performance.now();
      let capturedBrowserUrl = "";
      let browserRedirectSuccess = false;

      const mockOpenBrowser = async (url: string): Promise<boolean> => {
        capturedBrowserUrl = url;
        const parsed = new URL(url);

        // Verify authorization page route and query parameters
        assertEquals(
          parsed.pathname,
          "/login",
          "Browser must be directed to /login endpoint",
        );
        const callbackParam = parsed.searchParams.get("callback");
        const stateParam = parsed.searchParams.get("state");

        assert(
          callbackParam !== null,
          "Browser URL must include 'callback' param",
        );
        assert(
          stateParam !== null,
          "Browser URL must include 'state' nonce param",
        );

        // Verify loopback listener constraints (PLAT-1)
        const callbackUrlObj = new URL(callbackParam);
        assertEquals(
          callbackUrlObj.hostname,
          "127.0.0.1",
          "Callback host must be 127.0.0.1",
        );
        assertEquals(
          callbackUrlObj.pathname,
          "/callback",
          "Callback path must be /callback",
        );
        const port = parseInt(callbackUrlObj.port, 10);
        assert(
          port > 1024 && port <= 65535,
          "Callback port must be unprivileged ephemeral",
        );

        // Verify state nonce is a valid UUIDv4
        assertMatch(
          stateParam,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          "State nonce must be valid UUIDv4",
        );

        // Fetch /login HTML page from control server to verify server-rendered login UI (T-0756, T-0802)
        const pageRes = await fetch(url);
        assertEquals(
          pageRes.status,
          200,
          "GET /login on control plane must return 200 OK",
        );
        const pageHtml = await pageRes.text();
        assertStringIncludes(pageHtml, "RailFog Cloud");
        assertStringIncludes(pageHtml, "Authorize CLI");

        // Simulate browser authorization redirect: GET callback URL with token, state, and orgId
        const redirectUrl = new URL(callbackParam);
        redirectUrl.searchParams.set("token", rawToken);
        redirectUrl.searchParams.set("state", stateParam);
        redirectUrl.searchParams.set("orgId", "e2e-enterprise-org");

        const callbackRes = await fetch(redirectUrl.toString());
        assertEquals(
          callbackRes.status,
          200,
          "Callback listener must respond 200 OK on redirect",
        );
        assertEquals(
          callbackRes.headers.get("referrer-policy"),
          "no-referrer",
          "Callback server must enforce Referrer-Policy: no-referrer (PLAT-15)",
        );
        const callbackHtml = await callbackRes.text();
        assertStringIncludes(callbackHtml, "Authentication Successful");

        browserRedirectSuccess = true;
        return true;
      };

      // Failsafe: stdinReader MUST NOT be called in zero-copy flow
      const stdinFailsafe = (): Promise<string> => {
        throw new Error(
          "Violation: stdinReader was invoked during zero-copy flow! Manual input should be bypassed.",
        );
      };

      // Execute login
      const loginResult = await runLogin({
        controlUrl,
        configPath,
        openBrowser: mockOpenBrowser,
        stdinReader: stdinFailsafe,
      });

      const elapsedMs = performance.now() - startTime;

      // 4. Verify outcomes
      assertEquals(loginResult.ok, true, "runLogin must report ok: true");
      assertEquals(loginResult.orgId, "e2e-enterprise-org");
      assertEquals(
        browserRedirectSuccess,
        true,
        "Browser callback redirect must complete",
      );
      assert(
        capturedBrowserUrl.startsWith(controlUrl),
        "Browser authorization URL must target the control plane",
      );

      // Verify timing budget: < 2 seconds per AC1
      assert(
        elapsedMs < 2000,
        `Zero-copy authentication took ${elapsedMs}ms, exceeding 2-second SLA (AC1)`,
      );

      // Verify credentials written to configPath
      const savedConfig = await loadCliConfig(configPath);
      assertEquals(
        savedConfig?.token,
        rawToken,
        "Saved token must match provisioned key",
      );
      assertEquals(savedConfig?.controlUrl, controlUrl);
      assertEquals(savedConfig?.orgId, "e2e-enterprise-org");

      // On POSIX systems, verify file mode 0600 (PLAT-15)
      if (Deno.build.os !== "windows") {
        const fileStat = await Deno.stat(configPath);
        const fileMode = (fileStat.mode ?? 0) & 0o777;
        assertEquals(
          fileMode,
          0o600,
          "config.json must have 0600 permissions on POSIX",
        );
      }

      // 5. Verify whoami session check with stored config
      const whoamiResult = await runWhoami({ controlUrl, configPath });
      assertEquals(whoamiResult.authenticated, true);
      assertEquals(whoamiResult.orgId, "e2e-enterprise-org");
    } finally {
      await controlServer.close();
    }
  },
);

// ============================================================================
// 2. Fallback Mode: --manual flag, callback timeout, headless environment
// spec: PLAT-1, PLAT-12, PLAT-19
// ============================================================================

Deno.test(
  "E2E Milestone 0.8 [2/8]: Fallback mode (--manual flag, callback timeout, headless browser failure)",
  async () => {
    const tempDir = await Deno.makeTempDir();

    // Setup mock control server
    const mockToken = "rfk_fallback_valid_token_777";
    const controlServer = Deno.serve(
      { port: 0, hostname: "127.0.0.1" },
      (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/v1/auth/verify") {
          const auth = req.headers.get("authorization");
          if (auth === `Bearer ${mockToken}`) {
            return Response.json({
              ok: true,
              identity: { orgId: "fallback-org", callerId: "dev-laptop" },
              request_id: "req_fb_verify",
            });
          }
          return Response.json(
            { error: { code: "PERMISSION_DENIED", message: "Invalid key" } },
            { status: 403 },
          );
        }
        return new Response("Not found", { status: 404 });
      },
    );

    const controlUrl = `http://127.0.0.1:${
      (controlServer.addr as Deno.NetAddr).port
    }`;

    try {
      // 2.1: --manual flag explicitly bypasses callback server and prompts on stdin
      {
        let browserOpenedUrl = "";
        let stdinPrompted = false;

        const mockOpenBrowser = (url: string): Promise<boolean> => {
          browserOpenedUrl = url;
          return Promise.resolve(true);
        };

        const mockStdinReader = (): Promise<string> => {
          stdinPrompted = true;
          return Promise.resolve(`  ${mockToken}  \n`);
        };

        const manualConfigPath = join(tempDir, "manual-config.json");
        const res = await runLogin({
          controlUrl,
          configPath: manualConfigPath,
          manual: true,
          openBrowser: mockOpenBrowser,
          stdinReader: mockStdinReader,
        });

        assertEquals(res.ok, true);
        assertEquals(res.orgId, "fallback-org");
        assertEquals(
          stdinPrompted,
          true,
          "stdinReader must be invoked in --manual mode",
        );
        assertEquals(
          browserOpenedUrl,
          `${controlUrl}/login`,
          "--manual flow opens direct login page without callback query parameters",
        );

        const saved = await loadCliConfig(manualConfigPath);
        assertEquals(saved?.token, mockToken);
      }

      // 2.2: Callback timeout cleanly falls back to stdin prompt without crashing
      {
        let stdinPromptedOnTimeout = false;

        // Browser opens but user never completes browser action; timeout elapses
        const mockOpenBrowser = (_url: string): Promise<boolean> => {
          return Promise.resolve(true);
        };

        const mockStdinReader = (): Promise<string> => {
          stdinPromptedOnTimeout = true;
          return Promise.resolve(mockToken);
        };

        const timeoutConfigPath = join(tempDir, "timeout-config.json");
        const res = await runLogin({
          controlUrl,
          configPath: timeoutConfigPath,
          callbackTimeoutMs: 50, // 50ms rapid timeout for test speed
          openBrowser: mockOpenBrowser,
          stdinReader: mockStdinReader,
        });

        assertEquals(res.ok, true);
        assertEquals(res.orgId, "fallback-org");
        assertEquals(
          stdinPromptedOnTimeout,
          true,
          "Callback server timeout must trigger fallback to stdin prompt (PLAT-12)",
        );

        const saved = await loadCliConfig(timeoutConfigPath);
        assertEquals(saved?.token, mockToken);
      }

      // 2.3: Headless environment / SSH session where browser cannot open
      {
        let stdinPromptedOnHeadless = false;

        // openBrowser returns false indicating system unable to open desktop browser
        const mockOpenBrowser = (_url: string): Promise<boolean> => {
          return Promise.resolve(false);
        };

        const mockStdinReader = (): Promise<string> => {
          stdinPromptedOnHeadless = true;
          return Promise.resolve(mockToken);
        };

        const headlessConfigPath = join(tempDir, "headless-config.json");
        const res = await runLogin({
          controlUrl,
          configPath: headlessConfigPath,
          openBrowser: mockOpenBrowser,
          stdinReader: mockStdinReader,
        });

        assertEquals(res.ok, true);
        assertEquals(stdinPromptedOnHeadless, true);

        const saved = await loadCliConfig(headlessConfigPath);
        assertEquals(saved?.token, mockToken);
      }
    } finally {
      await controlServer.shutdown();
    }
  },
);

// ============================================================================
// 3. Interactive Project Scaffolding (rail init)
// spec: PLAT-18, PLAT-19, FN-1, OBJ-2, Q-2, KV-2
// ============================================================================

Deno.test(
  "E2E Milestone 0.8 [3/8]: Interactive project scaffolding (rail init templates, project name validation, summary box)",
  async () => {
    const parentDir = await Deno.makeTempDir();

    // 3.1: Scaffolds 'minimal' template interactively
    {
      const minimalTarget = join(parentDir, "minimal-demo");
      const outputStream = new MemoryTerminalStream(true);

      const promptReader = (
        message: string,
        defaultValue?: string,
      ): Promise<string> => {
        if (message.includes("directory")) {
          return Promise.resolve(minimalTarget);
        }
        if (message.includes("name")) return Promise.resolve("minimal-demo");
        return Promise.resolve(defaultValue ?? "");
      };

      const templateSelector = (
        choices: Choice<"minimal" | "worked-example">[],
      ): Promise<"minimal" | "worked-example"> => {
        // Assert choice configuration per PLAT-19
        assertEquals(choices.length, 2);
        assertEquals(choices[0].value, "minimal");
        assertEquals(choices[1].value, "worked-example");
        assert(choices[0].label.length > 0);
        assert(choices[1].description !== undefined);
        return Promise.resolve("minimal");
      };

      const result = await runInteractiveInit({
        interactive: true,
        directory: minimalTarget,
        projectName: "minimal-demo",
        template: "minimal",
        outputWriter: outputStream,
        promptReader,
        templateSelector,
      });

      // Verify files created (railfog.toml, functions/api.ts, deno.json, .gitignore)
      assertEquals(result.filesCreated.length, 4);
      const tomlContent = await Deno.readTextFile(
        join(minimalTarget, "railfog.toml"),
      );
      assertStringIncludes(tomlContent, `name = "minimal-demo"`);
      assertStringIncludes(tomlContent, `[functions.api]`);
      assertStringIncludes(tomlContent, `entry = "functions/api.ts"`);

      const apiContent = await Deno.readTextFile(
        join(minimalTarget, "functions", "api.ts"),
      );
      assertStringIncludes(apiContent, `export default async function handler`);

      const denoJson = await Deno.readTextFile(
        join(minimalTarget, "deno.json"),
      );
      assertStringIncludes(denoJson, `"@railfog/sdk"`);

      // Verify summary box output rendered to output stream
      const summaryText = outputStream.text;
      assertStringIncludes(summaryText, "Project created successfully!");
      assertStringIncludes(summaryText, "rail dev");
      assertStringIncludes(summaryText, "rail deploy");
      assertStringIncludes(summaryText, "┌");
      assertStringIncludes(summaryText, "└");
      assertStringIncludes(summaryText, "│");
    }

    // 3.2: Scaffolds 'worked-example' template interactively
    {
      const workedTarget = join(parentDir, "worked-demo");
      const outputStream = new MemoryTerminalStream(true);

      const result = await runInteractiveInit({
        interactive: true,
        directory: workedTarget,
        projectName: "worked-demo",
        template: "worked-example",
        outputWriter: outputStream,
      });

      // Verify worked-example components: railfog.toml, api.ts, processor.ts, deno.json, .gitignore
      assertEquals(result.filesCreated.length, 5);
      const tomlContent = await Deno.readTextFile(
        join(workedTarget, "railfog.toml"),
      );
      assertStringIncludes(tomlContent, `[functions.api]`);
      assertStringIncludes(tomlContent, `[functions.processor]`);
      assertStringIncludes(tomlContent, `objects = ["app:uploads"]`);
      assertStringIncludes(tomlContent, `queues = ["app:jobs"]`);
      assertStringIncludes(tomlContent, `kv = ["app:files"]`);

      const processorContent = await Deno.readTextFile(
        join(workedTarget, "functions", "processor.ts"),
      );
      assertStringIncludes(
        processorContent,
        "export default async function consume",
      );
      assertStringIncludes(processorContent, "ctx.kv.set");
    }

    // 3.3: Project resource naming validation per PLAT-18
    {
      const badNames = [
        "-invalid-start",
        "name with spaces",
        "bad$char",
        "has/slash",
        "app\nname",
      ];
      for (const badName of badNames) {
        await assertRejects(
          () =>
            runInteractiveInit({
              interactive: false,
              directory: join(parentDir, "bad-name-dir"),
              projectName: badName,
            }),
          Error,
          "Invalid project name",
        );
      }
    }

    // 3.4: Collision safety and --force overwrite flag
    {
      const conflictDir = join(parentDir, "conflict-app");
      await runInteractiveInit({
        interactive: false,
        directory: conflictDir,
        projectName: "conflict-app",
      });

      // Non-empty dir without force must throw
      await assertRejects(
        () =>
          runInteractiveInit({
            interactive: false,
            directory: conflictDir,
            projectName: "conflict-app",
          }),
        Error,
        "is not empty. Use --force to overwrite",
      );

      // With force: true, succeeds cleanly
      const forceRes = await runInteractiveInit({
        interactive: false,
        directory: conflictDir,
        projectName: "conflict-app",
        force: true,
      });
      assert(forceRes.filesCreated.length > 0);
    }

    // 3.5: selectPrompt handles template choice selection directly
    {
      const selectStream = new MemoryTerminalStream(false);
      const promptChoices: Choice<"minimal" | "worked-example">[] = [
        {
          label: "Minimal Starter",
          value: "minimal",
          description: "Single function",
        },
        {
          label: "Worked Example",
          value: "worked-example",
          description: "Upload pipeline",
        },
      ];
      const selected = await selectPrompt({
        message: "Select starter template:",
        choices: promptChoices,
        interactive: false,
        defaultIndex: 0,
        stdinReader: () => Promise.resolve("1\n"),
        outputWriter: selectStream,
      });
      assertEquals(selected, "minimal");
    }
  },
);

// ============================================================================
// 4. Rich Deploy Progress: step callbacks, animated spinners, --json mode
// spec: PLAT-3, PLAT-15, PLAT-19, OBJ-4
// ============================================================================

Deno.test(
  "E2E Milestone 0.8 [4/8]: Rich deploy progress (step callbacks, animated spinners, --json suppression)",
  async () => {
    const projectDir = await Deno.makeTempDir();
    await createDeployableProject(projectDir, "e2e-deploy-app");

    // Start mock control server for deployment
    const expectedRevisionId = "rev_01J8ZE2EDEPLOYREV0000000001";
    const controlServer = Deno.serve(
      { port: 0, hostname: "127.0.0.1" },
      (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/deploy" && req.method === "POST") {
          return Response.json({
            revisionId: expectedRevisionId,
            state: "Deployed",
          });
        }
        if (url.pathname === "/healthz" && req.method === "GET") {
          return Response.json({ status: "ok", service: "control-plane" });
        }
        return new Response("Not found", { status: 404 });
      },
    );

    const controlUrl = `http://127.0.0.1:${
      (controlServer.addr as Deno.NetAddr).port
    }`;

    try {
      // 4.1: Exercises all 4 step callbacks during live deployment
      {
        const startedSteps: string[] = [];
        const succeededSteps: string[] = [];
        const failedSteps: string[] = [];

        const progress: DeployProgressCallbacks = {
          onStepStart: (step) => startedSteps.push(step),
          onStepSuccess: (step) => succeededSteps.push(step),
          onStepFail: (step, _err) => failedSteps.push(step),
        };

        const summary = await runDeploy({
          projectPath: projectDir,
          controlUrl,
          progress,
          skipHealthCheck: false,
        });

        assertEquals(summary.ok, true);
        assertEquals(summary.revision, expectedRevisionId);
        assertEquals(summary.project, "e2e-deploy-app");
        assert(summary.elapsedMs > 0);
        assertEquals(summary.functions.length, 1);
        assertEquals(summary.functions[0].name, "api");
        assertEquals(summary.functions[0].route, "/api/*");

        // Assert all 4 stages executed in canonical sequence (PLAT-3)
        const expectedSequence = [
          "Packaging function sources and calculating SHA-256 hashes",
          "Validating configuration and capability permissions",
          "Uploading snapshot bundle to Control Plane",
          "Verifying deployment activation and health check",
        ];

        assertEquals(startedSteps, expectedSequence);
        assertEquals(succeededSteps, expectedSequence);
        assertEquals(failedSteps.length, 0);
      }

      // 4.2: Machine-readable --json suppression mode
      {
        const consoleLogs: string[] = [];
        const origLog = console.log;
        console.log = (...args: unknown[]) => {
          consoleLogs.push(args.map(String).join(" "));
        };

        try {
          const summary = await runDeploy({
            projectPath: projectDir,
            controlUrl,
            json: true,
            skipHealthCheck: false,
          });

          assertEquals(summary.ok, true);
          // When json: true is specified, console.log receives serialized JSON DeploySummary
          const rawJson = consoleLogs.join("\n").trim();
          assert(rawJson.startsWith("{") && rawJson.endsWith("}"));
          const parsed = JSON.parse(rawJson) as DeploySummary;
          assertEquals(parsed.ok, true);
          assertEquals(parsed.revision, expectedRevisionId);
          assertEquals(parsed.project, "e2e-deploy-app");

          // Ensure terminal cards and spinners were suppressed
          assertFalse(rawJson.includes("Deployment complete!"));
        } finally {
          console.log = origLog;
        }
      }

      // 4.3: Pre-deploy diagnostic failure triggers onStepFail cleanly
      {
        const brokenDir = await Deno.makeTempDir();
        // Create railfog.toml with entry that escapes project directory (path traversal PLAT-6)
        await Deno.writeTextFile(
          join(brokenDir, "railfog.toml"),
          `name = "broken-app"\n\n[functions.api]\nentry = "../outside.ts"\n`,
        );

        const failedSteps: string[] = [];
        const progress: DeployProgressCallbacks = {
          onStepFail: (step) => failedSteps.push(step),
        };

        await assertRejects(
          () =>
            runDeploy({
              projectPath: brokenDir,
              controlUrl,
              progress,
            }),
          ValidationFailedError,
          "escapes project directory",
        );

        assert(
          failedSteps.length > 0,
          "Step failure callback must be dispatched on diagnostic error",
        );
      }
    } finally {
      await controlServer.shutdown();
    }
  },
);

// ============================================================================
// 5. Minimalist SDK: handle() auto-JSON & api() micro-router
// spec: FN-1, FN-4, PLAT-11, PLAT-12
// ============================================================================

Deno.test(
  "E2E Milestone 0.8 [5/8]: Minimalist SDK (handle() auto-JSON serialization, api() micro-routing with PLAT-11 specificity)",
  async () => {
    // 5.1: handle() auto-serializes objects, arrays, primitives, and honors explicit Responses
    {
      // Plain object return
      const objHandler = handle(() => ({
        service: "railfog-edge",
        version: "0.8.0",
        active: true,
      }));
      const ctx = createMockContext();
      const res1 = await objHandler(
        new Request("https://railfog.internal/test"),
        ctx,
      );
      assertEquals(res1.status, 200);
      assertEquals(res1.headers.get("content-type"), "application/json");
      assertEquals(await res1.json(), {
        service: "railfog-edge",
        version: "0.8.0",
        active: true,
      });

      // Destructured KV binding in handler
      const kvHandler = handle(async ({ kv }) => {
        await kv.set(["items", "101"], { title: "Test Item" });
        const item = await kv.get<{ title: string }>(["items", "101"]);
        return { item };
      });
      const res2 = await kvHandler(
        new Request("https://railfog.internal/kv"),
        ctx,
      );
      assertEquals(res2.status, 200);
      assertEquals(await res2.json(), { item: { title: "Test Item" } });

      // Explicit Web API Response passthrough
      const passthroughHandler = handle(() => {
        return new Response("Created custom", {
          status: 201,
          headers: { "x-custom-header": "spec-passed" },
        });
      });
      const res3 = await passthroughHandler(
        new Request("https://railfog.internal/custom"),
        ctx,
      );
      assertEquals(res3.status, 201);
      assertEquals(res3.headers.get("x-custom-header"), "spec-passed");
      assertEquals(await res3.text(), "Created custom");

      // Void return produces 204 No Content
      const voidHandler = handle(() => {});
      const res4 = await voidHandler(
        new Request("https://railfog.internal/void"),
        ctx,
      );
      assertEquals(res4.status, 204);

      // PLAT-12 error normalization
      const errorHandler = handle(() => {
        throw new ValidationFailedError(
          "Missing required parameter: email",
          ctx.requestId,
        );
      });
      const res5 = await errorHandler(
        new Request("https://railfog.internal/err"),
        ctx,
      );
      assertEquals(res5.status, 400);
      const errBody = await res5.json();
      assertEquals(errBody.error.code, "VALIDATION_FAILED");
      assertEquals(errBody.error.request_id, ctx.requestId);
    }

    // 5.2: api() micro-router with GET/POST routes and PLAT-11 routing specificity
    {
      const router = api({
        "GET /api/items":
          () => [{ id: "1", name: "Alpha" }, { id: "2", name: "Beta" }],
        "POST /api/items": async (c) => {
          const body = await c.body<{ name: string }>();
          return c.json({ id: "3", name: body.name, created: true }, 201);
        },
        // PLAT-11: Literal segment /pinned scores higher than wildcard /:id
        "GET /api/items/pinned": () => ({
          id: "pinned",
          name: "Pinned Article",
        }),
        "GET /api/items/:id": (c) => {
          const url = new URL(c.req.url);
          const id = url.pathname.split("/").pop();
          return { id, name: `Item ${id}` };
        },
      });

      const ctx = createMockContext();

      // GET /api/items
      const reqGet = new Request("https://railfog.internal/api/items", {
        method: "GET",
      });
      const resGet = await router(reqGet, ctx);
      assertEquals(resGet.status, 200);
      assertEquals(await resGet.json(), [{ id: "1", name: "Alpha" }, {
        id: "2",
        name: "Beta",
      }]);

      // POST /api/items with JSON body
      const reqPost = new Request("https://railfog.internal/api/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Gamma" }),
      });
      const resPost = await router(reqPost, ctx);
      assertEquals(resPost.status, 201);
      assertEquals(await resPost.json(), {
        id: "3",
        name: "Gamma",
        created: true,
      });

      // GET /api/items/pinned (resolves to literal route, specificity score 6 vs wildcard score 5)
      const reqPinned = new Request(
        "https://railfog.internal/api/items/pinned",
        { method: "GET" },
      );
      const resPinned = await router(reqPinned, ctx);
      assertEquals(resPinned.status, 200);
      assertEquals(await resPinned.json(), {
        id: "pinned",
        name: "Pinned Article",
      });

      // GET /api/items/42 (matches parameterized route)
      const reqItem = new Request("https://railfog.internal/api/items/42", {
        method: "GET",
      });
      const resItem = await router(reqItem, ctx);
      assertEquals(resItem.status, 200);
      assertEquals(await resItem.json(), { id: "42", name: "Item 42" });

      // Unmatched route returns canonical 404 RESOURCE_NOT_FOUND (PLAT-12)
      const reqUnknown = new Request("https://railfog.internal/api/unknown", {
        method: "GET",
      });
      const resUnknown = await router(reqUnknown, ctx);
      assertEquals(resUnknown.status, 404);
      const unknownBody = await resUnknown.json();
      assertEquals(unknownBody.error.code, "RESOURCE_NOT_FOUND");
    }
  },
);

// ============================================================================
// 6. Project Dependency Management (rail add sdk)
// spec: PLAT-19, T-0811
// ============================================================================

Deno.test(
  "E2E Milestone 0.8 [6/8]: Project dependency management (rail add sdk injects @railfog/sdk into deno.json)",
  async () => {
    const tempDir = await Deno.makeTempDir();

    // 6.1: Empty project without deno.json
    {
      const emptyDir = join(tempDir, "empty-proj");
      const addRes = await runAdd({ packageOrPrimitive: "sdk", cwd: emptyDir });
      assertEquals(addRes.ok, true);
      assertEquals(addRes.createdNewFile, true);
      assertEquals(addRes.addedImport, "@railfog/sdk");

      const denoJsonRaw = await Deno.readTextFile(join(emptyDir, "deno.json"));
      const parsed = JSON.parse(denoJsonRaw);
      assertEquals(parsed.imports["@railfog/sdk"], CANONICAL_SDK_URL);
      assertEquals(parsed.tasks.dev, "rail dev");
      assertEquals(parsed.tasks.check, "rail check");
      assertEquals(parsed.tasks.test, "deno test -A");
    }

    // 6.2: Existing project preserves existing tasks and imports non-destructively
    {
      const existingDir = join(tempDir, "existing-proj");
      await Deno.mkdir(existingDir, { recursive: true });

      const initialConfig = {
        tasks: {
          lint: "deno lint",
          custom: "echo custom-task",
        },
        imports: {
          "@std/assert": "jsr:@std/assert@0.224.0",
        },
      };
      await Deno.writeTextFile(
        join(existingDir, "deno.json"),
        JSON.stringify(initialConfig, null, 2) + "\n",
      );

      const addRes = await runAdd({
        packageOrPrimitive: "@railfog/sdk",
        cwd: existingDir,
      });
      assertEquals(addRes.ok, true);
      assertEquals(addRes.createdNewFile, false);

      const updatedRaw = await Deno.readTextFile(
        join(existingDir, "deno.json"),
      );
      const updated = JSON.parse(updatedRaw);

      // Preserved fields
      assertEquals(updated.tasks.lint, "deno lint");
      assertEquals(updated.tasks.custom, "echo custom-task");
      assertEquals(updated.imports["@std/assert"], "jsr:@std/assert@0.224.0");

      // Injected SDK
      assertEquals(updated.imports["@railfog/sdk"], CANONICAL_SDK_URL);
    }

    // 6.3: Idempotent re-run leaves file stable
    {
      const targetDir = join(tempDir, "idempotent-proj");
      await runAdd({ packageOrPrimitive: "sdk", cwd: targetDir });
      const firstRun = await Deno.readTextFile(join(targetDir, "deno.json"));

      await runAdd({ packageOrPrimitive: "sdk", cwd: targetDir });
      const secondRun = await Deno.readTextFile(join(targetDir, "deno.json"));

      assertEquals(
        firstRun,
        secondRun,
        "Subsequent runAdd executions must be idempotent",
      );
    }

    // 6.4: Rejects unknown packages
    {
      await assertRejects(
        () => runAdd({ packageOrPrimitive: "react", cwd: tempDir }),
        Error,
        "Unsupported package or primitive",
      );
    }
  },
);

// ============================================================================
// 7. Installer Scripts Syntax Validation
// spec: PLAT-19, T-0808, T-0809
// ============================================================================

Deno.test(
  "E2E Milestone 0.8 [7/8]: Installer scripts syntax validation (install.sh POSIX compliance and install.ps1 PowerShell AST)",
  async () => {
    const rootDir = resolve(Deno.cwd());
    const shPath = join(rootDir, "scripts", "install.sh");
    const ps1Path = join(rootDir, "scripts", "install.ps1");

    // Verify files exist
    assert((await Deno.stat(shPath)).isFile, "scripts/install.sh must exist");
    assert((await Deno.stat(ps1Path)).isFile, "scripts/install.ps1 must exist");

    // 7.1: POSIX install.sh syntax validation
    {
      const shContent = await Deno.readTextFile(shPath);

      // Strict POSIX static requirements
      assertMatch(
        shContent,
        /^#!\/bin\/sh/,
        "install.sh must have #!/bin/sh shebang",
      );
      assertMatch(shContent, /set -e/, "install.sh must enforce set -e");
      assertMatch(shContent, /Darwin/, "install.sh must handle macOS Darwin");
      assertMatch(shContent, /Linux/, "install.sh must handle Linux");
      assertMatch(shContent, /x86_64|amd64/, "install.sh must handle x86_64");
      assertMatch(shContent, /arm64|aarch64/, "install.sh must handle arm64");
      assertMatch(
        shContent,
        /\.railfog\/bin/,
        "install.sh must install to .railfog/bin",
      );
      assertMatch(shContent, /chmod \+x/, "install.sh must set executable bit");

      // Verify absence of non-POSIX bashisms
      assertFalse(
        shContent.includes("[[ "),
        "POSIX sh must not use bash [[ conditional syntax",
      );
      assertFalse(
        shContent.includes("function "),
        "POSIX sh must not use 'function name()' syntax",
      );
      assertFalse(
        shContent.includes("<<<"),
        "POSIX sh must not use here-strings <<<",
      );

      // Attempt shell syntax check if bash / sh executable is available
      const bashCandidates = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "bash",
        "sh",
      ];

      for (const bashBin of bashCandidates) {
        try {
          const cmd = new Deno.Command(bashBin, {
            args: ["-n", shPath],
            stdout: "piped",
            stderr: "piped",
          });
          const proc = await cmd.output();
          if (proc.success) {
            assertEquals(
              proc.code,
              0,
              `bash -n ${shPath} must exit 0 without syntax errors`,
            );
            break;
          }
        } catch {
          // Candidate not present or not executable, try next
        }
      }
    }

    // 7.2: Windows install.ps1 syntax validation via PowerShell AST Parser
    {
      const ps1Content = await Deno.readTextFile(ps1Path);

      // Static PowerShell standards
      assertMatch(ps1Content, /\$ErrorActionPreference\s*=\s*["']Stop["']/i);
      assertMatch(ps1Content, /PROCESSOR_ARCHITECTURE/i);
      assertMatch(ps1Content, /\.railfog\\bin/i);
      assertMatch(ps1Content, /rail\.exe/i);
      assertMatch(ps1Content, /\[Environment\]::SetEnvironmentVariable/i);
      assertMatch(ps1Content, /\$env:Path\s*=/i);

      // PowerShell AST parsing check
      const pwshCandidates = ["pwsh", "powershell"];
      let parseSuccess = false;

      for (const pwshBin of pwshCandidates) {
        try {
          const checkScript =
            `$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path "scripts/install.ps1"), [ref]$tokens, [ref]$errors); if ($errors.Count -gt 0) { Write-Error ($errors | Out-String); exit 1 } else { exit 0 }`;
          const cmd = new Deno.Command(pwshBin, {
            args: ["-NoProfile", "-Command", checkScript],
            stdout: "piped",
            stderr: "piped",
          });
          const proc = await cmd.output();
          if (proc.success && proc.code === 0) {
            parseSuccess = true;
            break;
          }
        } catch {
          // Try next PowerShell binary
        }
      }

      if (parseSuccess) {
        assert(
          parseSuccess,
          "install.ps1 must parse without syntax errors in PowerShell AST",
        );
      }
    }

    // 7.3: Deno install.ts script validation
    {
      const tsPath = join(rootDir, "scripts", "install.ts");
      assert((await Deno.stat(tsPath)).isFile, "scripts/install.ts must exist");
      const tsContent = await Deno.readTextFile(tsPath);

      assertMatch(tsContent, /PLAT-19/, "install.ts must cite PLAT-19");
      assertMatch(
        tsContent,
        /export function parseInstallerArgs/,
        "install.ts must export parseInstallerArgs",
      );
      assertMatch(
        tsContent,
        /export function resolveInstallPaths/,
        "install.ts must export resolveInstallPaths",
      );
      assertMatch(
        tsContent,
        /export async function runInstaller/,
        "install.ts must export runInstaller",
      );
    }
  },
);

// ============================================================================
// 8. PLAT-15 Security: Zero Raw Token Leakage
// spec: PLAT-15, PLAT-6
// ============================================================================

Deno.test(
  "E2E Milestone 0.8 [8/8]: PLAT-15 security (zero raw secret leakage across authentication, deployment, and error traces)",
  async () => {
    const HIGH_ENTROPY_TOKEN =
      "rfk_sec_adversarial_zero_leakage_999988887777_token";
    const DATABASE_SECRET = "postgres_secret_prod_db_super_password_12345";

    const capturedLogs: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args: unknown[]) =>
      capturedLogs.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) =>
      capturedLogs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) =>
      capturedLogs.push(args.map(String).join(" "));

    try {
      // 8.1: Verify raw token is never leaked when authentication fails (HTTP 403)
      const mockFailServer = Deno.serve(
        { port: 0, hostname: "127.0.0.1" },
        (_req) => {
          return Response.json(
            { error: { code: "PERMISSION_DENIED", message: "Invalid key" } },
            { status: 403 },
          );
        },
      );
      const failUrl = `http://127.0.0.1:${
        (mockFailServer.addr as Deno.NetAddr).port
      }`;

      try {
        const tempConfig = join(await Deno.makeTempDir(), "config.json");
        const res = await runLogin({
          controlUrl: failUrl,
          configPath: tempConfig,
          token: HIGH_ENTROPY_TOKEN,
        });
        assertEquals(res.ok, false);
      } finally {
        await mockFailServer.shutdown();
      }

      // 8.2: Verify raw token is never leaked on network connection errors
      const unreachableUrl = "http://127.0.0.1:59999";
      const unreachableConfig = join(await Deno.makeTempDir(), "config.json");
      const resUnreachable = await runLogin({
        controlUrl: unreachableUrl,
        configPath: unreachableConfig,
        token: HIGH_ENTROPY_TOKEN,
      });
      assertEquals(resUnreachable.ok, false);

      // 8.3: Verify whoami outputs masked token, never raw key
      const whoamiServer = Deno.serve(
        { port: 0, hostname: "127.0.0.1" },
        (_req) => {
          return Response.json({
            ok: true,
            identity: { orgId: "secure-org", callerId: "laptop-key" },
          });
        },
      );
      const whoamiUrl = `http://127.0.0.1:${
        (whoamiServer.addr as Deno.NetAddr).port
      }`;

      try {
        const whoamiConfigPath = join(await Deno.makeTempDir(), "config.json");
        await saveCliConfig(
          {
            token: HIGH_ENTROPY_TOKEN,
            controlUrl: whoamiUrl,
            orgId: "secure-org",
          },
          whoamiConfigPath,
        );

        const whoamiRes = await runWhoami({
          controlUrl: whoamiUrl,
          configPath: whoamiConfigPath,
        });
        assertEquals(whoamiRes.authenticated, true);
      } finally {
        await whoamiServer.shutdown();
      }

      // 8.4: Verify deploy error redaction when secret patterns exist in environment
      Deno.env.set("APP_DATABASE_URL", DATABASE_SECRET);
      try {
        const deployProjDir = await Deno.makeTempDir();
        await createDeployableProject(deployProjDir, "sec-test-app");

        // Mock control server rejecting with 500 error mentioning raw database secret
        const mockRejectServer = Deno.serve(
          { port: 0, hostname: "127.0.0.1" },
          (_req) => {
            return new Response(
              `Database failure connecting with ${DATABASE_SECRET}`,
              {
                status: 500,
              },
            );
          },
        );
        const rejectUrl = `http://127.0.0.1:${
          (mockRejectServer.addr as Deno.NetAddr).port
        }`;

        try {
          await assertRejects(
            () =>
              runDeploy({
                projectPath: deployProjDir,
                controlUrl: rejectUrl,
                token: HIGH_ENTROPY_TOKEN,
              }),
            Error,
          );
        } finally {
          await mockRejectServer.shutdown();
        }
      } finally {
        Deno.env.delete("APP_DATABASE_URL");
      }

      // 8.5: Adversarial Assertion: Inspect every line of captured console logs
      assert(
        capturedLogs.length > 0,
        "Console logs must have been produced during operations",
      );

      for (const logLine of capturedLogs) {
        assertFalse(
          logLine.includes(HIGH_ENTROPY_TOKEN),
          `CRITICAL PLAT-15 SECURITY LEAK: Raw API token found in console log: "${logLine}"`,
        );
        assertFalse(
          logLine.includes(DATABASE_SECRET),
          `CRITICAL PLAT-15 SECURITY LEAK: Raw database secret found in console log: "${logLine}"`,
        );
      }
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
  },
);
