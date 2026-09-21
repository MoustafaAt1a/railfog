// spec: docs/contracts/platform.contract.md#PLAT-3 — Deployment pipeline (validation, packaging, upload, verification)
// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets (never leaked in errors, logs, traces, or terminal output)
// spec: docs/contracts/platform.contract.md#PLAT-19 — Repository structure and CLI interactive step indicators
// spec: docs/contracts/objects.contract.md#OBJ-4 — Content addressing & integrity
// spec: tasks/milestone-0.8-developer-experience-ux/T-0807-rich-deployment-progress.md

import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import {
  deployCommand,
  type DeployOptions,
  type DeployProgressCallbacks,
  type DeploySummary,
  runDeploy,
} from "../../cli/deploy.ts";

// ============================================================================
// Test Fixtures & Mock Helpers
// ============================================================================

/**
 * Creates a valid RailFog project structure in a temporary directory.
 */
async function createTestProject(
  dir: string,
  options?: {
    projectName?: string;
    entryFile?: string;
    handlerCode?: string;
    routes?: Array<{ pattern: string; function: string }>;
    permissions?: Record<string, unknown>;
    extraFunctions?: Record<string, { entry: string; route?: string }>;
  },
): Promise<void> {
  const projectName = options?.projectName ?? "progress-test-app";
  const entryFile = options?.entryFile ?? "functions/api.ts";
  const handlerCode = options?.handlerCode ??
    `export default async function handler(_req: Request): Promise<Response> {\n  return new Response("OK");\n}\n`;

  const fullEntryPath = join(dir, entryFile);
  await Deno.mkdir(dirname(fullEntryPath), { recursive: true });
  await Deno.writeTextFile(fullEntryPath, handlerCode);

  let tomlContent =
    `name = "${projectName}"\n\n[functions.api]\nentry = "${entryFile}"\n`;

  if (options?.permissions) {
    tomlContent += `\n[functions.api.permissions]\n`;
    for (const [k, v] of Object.entries(options.permissions)) {
      tomlContent += `${k} = ${JSON.stringify(v)}\n`;
    }
  }

  if (options?.extraFunctions) {
    for (const [fnName, fnCfg] of Object.entries(options.extraFunctions)) {
      const extraPath = join(dir, fnCfg.entry);
      await Deno.mkdir(dirname(extraPath), { recursive: true });
      await Deno.writeTextFile(extraPath, handlerCode);
      tomlContent += `\n[functions.${fnName}]\nentry = "${fnCfg.entry}"\n`;
    }
  }

  const routes = options?.routes ?? [{ pattern: "/api/*", function: "api" }];
  for (const r of routes) {
    tomlContent +=
      `\n[[routes]]\npattern = "${r.pattern}"\nfunction = "${r.function}"\n`;
  }

  await Deno.writeTextFile(join(dir, "railfog.toml"), tomlContent);
}

/**
 * Starts an in-process mock Control Plane server on an ephemeral port.
 */
function startMockControlPlane(options?: {
  revisionId?: string;
  state?: string;
  deployStatus?: number;
  deployResponseBody?: Record<string, unknown> | string;
  healthStatus?: number;
  healthResponseBody?: Record<string, unknown> | string;
  onDeploy?: (req: Request, body: Record<string, unknown> | null) => void;
  onHealthCheck?: (req: Request) => void;
}): { url: string; close: () => Promise<void> } {
  const revisionId = options?.revisionId ?? "rev_01J8Z000000000000000000001";
  const state = options?.state ?? "Deployed";
  const deployStatus = options?.deployStatus ?? 200;
  const healthStatus = options?.healthStatus ?? 200;

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req: Request) => {
      const url = new URL(req.url);

      if (url.pathname === "/healthz" || url.pathname.endsWith("/healthz")) {
        if (options?.onHealthCheck) {
          options.onHealthCheck(req);
        }
        if (options?.healthResponseBody) {
          const bodyStr = typeof options.healthResponseBody === "string"
            ? options.healthResponseBody
            : JSON.stringify(options.healthResponseBody);
          return new Response(bodyStr, {
            status: healthStatus,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ status: "ok" }), {
          status: healthStatus,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname === "/deploy" || url.pathname.endsWith("/deploy")) {
        let body: Record<string, unknown> | null = null;
        try {
          const text = await req.text();
          body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
        } catch {
          // body is non-JSON or empty
        }

        if (options?.onDeploy) {
          options.onDeploy(req, body);
        }

        if (options?.deployResponseBody) {
          const bodyStr = typeof options.deployResponseBody === "string"
            ? options.deployResponseBody
            : JSON.stringify(options.deployResponseBody);
          return new Response(bodyStr, {
            status: deployStatus,
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(
          JSON.stringify({ revisionId, state }),
          {
            status: deployStatus,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  );

  return {
    url: `http://localhost:${server.addr.port}`,
    close: async () => {
      await server.shutdown();
    },
  };
}

/**
 * Result structure returned by captureTerminalOutput.
 */
interface CapturedTerminalResult<T> {
  result?: T;
  error?: unknown;
  stdout: string;
  stderr: string;
}

/**
 * Executes a function while intercepting Deno.stdout/stderr and console methods,
 * simulating interactive terminal or CI environments.
 */
async function captureTerminalOutput<T>(
  options: {
    isTerminal?: boolean;
    env?: Record<string, string | undefined>;
  },
  fn: () => Promise<T>,
): Promise<CapturedTerminalResult<T>> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const decoder = new TextDecoder();

  const origStdoutWrite = Deno.stdout.writeSync?.bind(Deno.stdout);
  const origStderrWrite = Deno.stderr.writeSync?.bind(Deno.stderr);
  const origIsTerminal = Deno.stdout.isTerminal?.bind(Deno.stdout);
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  const originalEnv: Record<string, string | undefined> = {};
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      originalEnv[key] = Deno.env.get(key);
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }

  if (options.isTerminal !== undefined && Deno.stdout.isTerminal) {
    Deno.stdout.isTerminal = () => options.isTerminal!;
  }

  Deno.stdout.writeSync = (p: Uint8Array) => {
    stdoutChunks.push(decoder.decode(p));
    return p.length;
  };

  Deno.stderr.writeSync = (p: Uint8Array) => {
    stderrChunks.push(decoder.decode(p));
    return p.length;
  };

  console.log = (...args: unknown[]) => {
    stdoutChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ) +
        "\n",
    );
  };

  console.error = (...args: unknown[]) => {
    stderrChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ) +
        "\n",
    );
  };

  console.warn = (...args: unknown[]) => {
    stderrChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ) +
        "\n",
    );
  };

  let result: T | undefined;
  let error: unknown | undefined;

  try {
    result = await fn();
  } catch (err) {
    error = err;
  } finally {
    if (origStdoutWrite && Deno.stdout.writeSync) {
      Deno.stdout.writeSync = origStdoutWrite;
    }
    if (origStderrWrite && Deno.stderr.writeSync) {
      Deno.stderr.writeSync = origStderrWrite;
    }
    if (origIsTerminal && Deno.stdout.isTerminal) {
      Deno.stdout.isTerminal = origIsTerminal;
    }
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;

    if (options.env) {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          Deno.env.delete(key);
        } else {
          Deno.env.set(key, value);
        }
      }
    }
  }

  return {
    result,
    error,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

/**
 * Returns true if text contains any ANSI escape sequence.
 */
function hasAnsiEscape(text: string): boolean {
  // deno-lint-ignore no-control-regex
  return /\x1b\[[0-9;?]*[a-zA-Z]/.test(text);
}

/**
 * Returns true if text contains green styling or a checkmark symbol.
 */
function hasGreenOrCheckmark(text: string): boolean {
  // deno-lint-ignore no-control-regex
  return /\x1b\[(?:32|92)m/.test(text) || text.includes("✔") ||
    text.includes("√") || text.includes("[+]");
}

/**
 * Returns true if text contains red styling or a cross/fail symbol.
 */
function hasRedOrCross(text: string): boolean {
  // deno-lint-ignore no-control-regex
  return /\x1b\[(?:31|91)m/.test(text) || text.includes("✖") ||
    text.includes("×") || text.includes("[-]");
}

// ============================================================================
// Group 1: Progress Callbacks Dispatch Across Deployment Stages
// Spec: PLAT-3, PLAT-6, OBJ-4, PLAT-1, PLAT-8
// ============================================================================

Deno.test(
  "AC1 (PLAT-3): onStepStart and onStepSuccess are dispatched in order across packaging, validation, uploading, and verification stages",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-happy-",
    });
    const mockServer = startMockControlPlane({
      revisionId: "rev_01J8Z999999999999999999999",
      state: "Deployed",
    });

    try {
      await createTestProject(tempDir, { projectName: "orderly-deploy" });

      const startedSteps: string[] = [];
      const succeededSteps: Array<{ step: string; detail?: string }> = [];
      const failedSteps: Array<{ step: string; error: string }> = [];

      const callbacks: DeployProgressCallbacks = {
        onStepStart: (step: string) => startedSteps.push(step),
        onStepSuccess: (step: string, detail?: string) =>
          succeededSteps.push({ step, detail }),
        onStepFail: (step: string, error: string) =>
          failedSteps.push({ step, error }),
      };

      const options: DeployOptions = {
        projectPath: tempDir,
        controlUrl: mockServer.url,
        progress: callbacks,
      };

      const summary: DeploySummary = await runDeploy(options);

      // Verify return DeploySummary shape
      assertEquals(
        summary.ok,
        true,
        "DeploySummary.ok must be true on successful deployment",
      );
      assertEquals(summary.project, "orderly-deploy");
      assertEquals(summary.revision, "rev_01J8Z999999999999999999999");
      assert(summary.elapsedMs >= 0, "elapsedMs must be non-negative");
      assert(
        typeof summary.runtimeUrl === "string" && summary.runtimeUrl.length > 0,
      );
      assert(Array.isArray(summary.functions) && summary.functions.length >= 1);

      // Verify all 4 required stages were started
      assertEquals(
        startedSteps.length,
        4,
        "Must dispatch exactly 4 onStepStart events",
      );
      assertMatch(
        startedSteps[0],
        /packag/i,
        "Stage 1 must be packaging (OBJ-4)",
      );
      assertMatch(
        startedSteps[1],
        /validat|check/i,
        "Stage 2 must be validation (PLAT-3, PLAT-6)",
      );
      assertMatch(
        startedSteps[2],
        /upload/i,
        "Stage 3 must be uploading (PLAT-1, PLAT-8)",
      );
      assertMatch(
        startedSteps[3],
        /verif|health|activat/i,
        "Stage 4 must be verification",
      );

      // Verify all 4 stages succeeded
      assertEquals(
        succeededSteps.length,
        4,
        "Must dispatch exactly 4 onStepSuccess events",
      );
      assertEquals(
        failedSteps.length,
        0,
        "onStepFail must not be called during successful deployment",
      );

      // Verify step identity correlation between start and success
      for (let i = 0; i < 4; i++) {
        assertEquals(
          succeededSteps[i].step,
          startedSteps[i],
          `Step name mismatch at stage index ${i}`,
        );
      }
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC1 (PLAT-3): Step execution guarantees strictly sequential lifecycle ordering",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-order-",
    });
    const mockServer = startMockControlPlane();

    try {
      await createTestProject(tempDir);

      const events: Array<
        { type: "start" | "success" | "fail"; step: string }
      > = [];

      const callbacks: DeployProgressCallbacks = {
        onStepStart: (step: string) => events.push({ type: "start", step }),
        onStepSuccess: (step: string) => events.push({ type: "success", step }),
        onStepFail: (step: string) => events.push({ type: "fail", step }),
      };

      await runDeploy({
        projectPath: tempDir,
        controlUrl: mockServer.url,
        progress: callbacks,
      });

      // Strict pairwise order: start(0) -> success(0) -> start(1) -> success(1) ...
      assertEquals(events.length, 8, "Expected 4 start + 4 success events");
      for (let i = 0; i < 4; i++) {
        assertEquals(events[i * 2].type, "start");
        assertEquals(events[i * 2 + 1].type, "success");
        assertEquals(events[i * 2].step, events[i * 2 + 1].step);
      }
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC4 (PLAT-6): Packaging stage failure halts execution and skips subsequent validation, upload, and verification stages",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-packfail-",
    });
    const mockServer = startMockControlPlane();

    try {
      // Entry point file does not exist -> packaging must fail
      await Deno.writeTextFile(
        join(tempDir, "railfog.toml"),
        `name = "missing-entry"\n[functions.api]\nentry = "functions/non_existent.ts"\n`,
      );

      const startedSteps: string[] = [];
      const succeededSteps: string[] = [];
      const failedSteps: Array<{ step: string; error: string }> = [];

      const callbacks: DeployProgressCallbacks = {
        onStepStart: (step: string) => startedSteps.push(step),
        onStepSuccess: (step: string) => succeededSteps.push(step),
        onStepFail: (step: string, error: string) =>
          failedSteps.push({ step, error }),
      };

      await assertRejects(
        async () => {
          await runDeploy({
            projectPath: tempDir,
            controlUrl: mockServer.url,
            progress: callbacks,
          });
        },
        Error,
      );

      assertEquals(
        startedSteps.length,
        1,
        "Only packaging stage should have started",
      );
      assertMatch(startedSteps[0], /packag/i);
      assertEquals(
        succeededSteps.length,
        0,
        "Packaging stage should not have succeeded",
      );
      assertEquals(
        failedSteps.length,
        1,
        "Packaging stage should report onStepFail",
      );
      assertMatch(failedSteps[0].step, /packag/i);
      assert(
        failedSteps[0].error.length > 0,
        "Error description must be provided",
      );
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC4 (PLAT-3, PLAT-6): Static validation failure halts pipeline and prevents snapshot upload",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-valfail-",
    });
    let uploadAttempted = false;
    const mockServer = startMockControlPlane({
      onDeploy: () => {
        uploadAttempted = true;
      },
    });

    try {
      // Create project with ambiguous permissions (violates PLAT-6)
      await createTestProject(tempDir, {
        permissions: {
          kv: ["namespace1", "namespace2"], // Ambiguous scope per PLAT-6
        },
      });

      const startedSteps: string[] = [];
      const succeededSteps: string[] = [];
      const failedSteps: Array<{ step: string; error: string }> = [];

      const callbacks: DeployProgressCallbacks = {
        onStepStart: (step: string) => startedSteps.push(step),
        onStepSuccess: (step: string) => succeededSteps.push(step),
        onStepFail: (step: string, error: string) =>
          failedSteps.push({ step, error }),
      };

      await assertRejects(
        async () => {
          await runDeploy({
            projectPath: tempDir,
            controlUrl: mockServer.url,
            progress: callbacks,
          });
        },
        Error,
      );

      assertFalse(
        uploadAttempted,
        "Control Plane upload must never be called if validation fails (PLAT-3)",
      );
      assertMatch(
        startedSteps[0],
        /packag/i,
        "Stage 1 packaging must have run",
      );
      assertMatch(
        succeededSteps[0],
        /packag/i,
        "Packaging must have succeeded before validation",
      );
      assertMatch(
        startedSteps[1],
        /validat|check/i,
        "Stage 2 validation must have started",
      );
      assertEquals(
        failedSteps.length,
        1,
        "Validation stage must have called onStepFail",
      );
      assertMatch(failedSteps[0].step, /validat|check/i);
      assertEquals(
        startedSteps.length,
        2,
        "Uploading and verification must not have started",
      );
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC4 (PLAT-1, PLAT-8): Control Plane upload failure dispatches onStepFail and skips verification",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-upfail-",
    });
    let healthCheckAttempted = false;
    const mockServer = startMockControlPlane({
      deployStatus: 500,
      deployResponseBody: {
        error: "Internal storage error during bundle write",
      },
      onHealthCheck: () => {
        healthCheckAttempted = true;
      },
    });

    try {
      await createTestProject(tempDir);

      const startedSteps: string[] = [];
      const succeededSteps: string[] = [];
      const failedSteps: Array<{ step: string; error: string }> = [];

      const callbacks: DeployProgressCallbacks = {
        onStepStart: (step: string) => startedSteps.push(step),
        onStepSuccess: (step: string) => succeededSteps.push(step),
        onStepFail: (step: string, error: string) =>
          failedSteps.push({ step, error }),
      };

      await assertRejects(
        async () => {
          await runDeploy({
            projectPath: tempDir,
            controlUrl: mockServer.url,
            progress: callbacks,
          });
        },
        Error,
      );

      assertFalse(
        healthCheckAttempted,
        "Health check verification must not run if upload fails",
      );
      assertEquals(
        startedSteps.length,
        3,
        "Packaging, validation, and upload must have started",
      );
      assertEquals(
        succeededSteps.length,
        2,
        "Packaging and validation must have succeeded",
      );
      assertEquals(failedSteps.length, 1, "Upload stage must fail");
      assertMatch(failedSteps[0].step, /upload/i);
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC4 (PLAT-3): Verification health check failure halts activation and reports verification error",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-verfail-",
    });
    const mockServer = startMockControlPlane({
      deployStatus: 200,
      healthStatus: 503,
      healthResponseBody: { status: "unhealthy", reason: "cold start timeout" },
    });

    try {
      await createTestProject(tempDir);

      const startedSteps: string[] = [];
      const succeededSteps: string[] = [];
      const failedSteps: Array<{ step: string; error: string }> = [];

      const callbacks: DeployProgressCallbacks = {
        onStepStart: (step: string) => startedSteps.push(step),
        onStepSuccess: (step: string) => succeededSteps.push(step),
        onStepFail: (step: string, error: string) =>
          failedSteps.push({ step, error }),
      };

      await assertRejects(
        async () => {
          await runDeploy({
            projectPath: tempDir,
            controlUrl: mockServer.url,
            progress: callbacks,
          });
        },
        Error,
      );

      assertEquals(
        startedSteps.length,
        4,
        "All 4 stages must have started up to verification",
      );
      assertEquals(
        succeededSteps.length,
        3,
        "Packaging, validation, and upload must have succeeded",
      );
      assertEquals(failedSteps.length, 1, "Verification stage must fail");
      assertMatch(failedSteps[0].step, /verif|health|activat/i);
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// ============================================================================
// Group 2: Interactive Mode Spinners & Completion Summary Card
// Spec: PLAT-3, PLAT-14, PLAT-18, PLAT-19
// ============================================================================

Deno.test(
  "AC1 & AC2 (PLAT-19): Interactive terminal animates step spinners, prints checkmarks, and displays styled completion card",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-card-",
    });
    const mockServer = startMockControlPlane({
      revisionId: "rev_01J8Z1234567890ABCDEFGHJKM",
      state: "Deployed",
    });

    try {
      await createTestProject(tempDir, {
        projectName: "fancy-card-app",
        routes: [{ pattern: "/api/v1/*", function: "api" }],
      });

      const captured = await captureTerminalOutput(
        {
          isTerminal: true,
          env: { CI: undefined, NO_COLOR: undefined },
        },
        async () => {
          return await runDeploy({
            projectPath: tempDir,
            controlUrl: mockServer.url,
          });
        },
      );

      assertEquals(
        captured.error,
        undefined,
        "Interactive deployment must succeed",
      );
      const out = captured.stdout;

      // AC1: Spinner animation control characters must be emitted in interactive mode
      const hasCursorHide = out.includes("\x1b[?25l");
      const hasClearLine = out.includes("\x1b[2K") || out.includes("\r");
      assert(
        hasCursorHide,
        "Interactive mode must emit cursor hide (\\x1b[?25l)",
      );
      assert(hasClearLine, "Interactive mode must emit clear line sequences");

      // AC1: Completed steps must display checkmarks
      assert(
        hasGreenOrCheckmark(out),
        "Completed steps must display green checkmarks",
      );

      // AC2: Card must include Revision ID in rev_{ULID} format (PLAT-14, PLAT-18)
      assertStringIncludes(out, "rev_01J8Z1234567890ABCDEFGHJKM");

      // AC2: Card must include elapsed time with ms or s unit
      assertMatch(
        out,
        /\b\d+(\.\d+)?\s*(ms|s)\b/i,
        "Completion card must display elapsed time",
      );

      // AC2: Card must include public runtime URL
      assertStringIncludes(
        out,
        mockServer.url,
        "Completion card must include runtime URL",
      );

      // AC2: Card must include route mappings table
      assertStringIncludes(
        out,
        "/api/v1/*",
        "Completion card must include route pattern",
      );
      assertStringIncludes(
        out,
        "api",
        "Completion card must include target function name",
      );

      // Cursor must be restored on completion (PLAT-19)
      const hasCursorShow = out.includes("\x1b[?25h");
      assert(
        hasCursorShow,
        "Interactive completion must restore cursor (\\x1b[?25h)",
      );
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC2 (PLAT-18): Completion card outputs multi-function route table accurately",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-multi-",
    });
    const mockServer = startMockControlPlane({
      revisionId: "rev_01J8ZMULTI000000000000001",
    });

    try {
      await createTestProject(tempDir, {
        projectName: "multi-fn-app",
        routes: [
          { pattern: "/api/*", function: "api" },
          { pattern: "/auth/*", function: "auth" },
          { pattern: "/webhooks", function: "webhooks" },
        ],
        extraFunctions: {
          auth: { entry: "functions/auth.ts" },
          webhooks: { entry: "functions/webhooks.ts" },
        },
      });

      const captured = await captureTerminalOutput(
        {
          isTerminal: true,
          env: { CI: undefined, NO_COLOR: undefined },
        },
        async () => {
          return await runDeploy({
            projectPath: tempDir,
            controlUrl: mockServer.url,
          });
        },
      );

      const out = captured.stdout;
      assertStringIncludes(out, "/api/*");
      assertStringIncludes(out, "/auth/*");
      assertStringIncludes(out, "/webhooks");
      assertStringIncludes(out, "api");
      assertStringIncludes(out, "auth");
      assertStringIncludes(out, "webhooks");
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC2: Elapsed time in DeploySummary matches positive non-zero execution duration",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-elapsed-",
    });
    const mockServer = startMockControlPlane();

    try {
      await createTestProject(tempDir);

      const summary: DeploySummary = await runDeploy({
        projectPath: tempDir,
        controlUrl: mockServer.url,
      });

      assert(
        typeof summary.elapsedMs === "number",
        "elapsedMs must be a number",
      );
      assert(summary.elapsedMs >= 0, "elapsedMs must be >= 0");
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// ============================================================================
// Group 3: --json Mode and CI Non-interactive Fallback
// Spec: PLAT-19, tasks/milestone-0.8-developer-experience-ux/T-0807-rich-deployment-progress.md#AC3
// ============================================================================

Deno.test(
  "AC3 (PLAT-19): --json mode suppresses ANSI spinners and outputs parseable JSON DeploySummary",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-json-",
    });
    const mockServer = startMockControlPlane({
      revisionId: "rev_01J8ZJSON0000000000000001",
      state: "Deployed",
    });

    try {
      await createTestProject(tempDir, { projectName: "json-deploy-app" });

      const captured = await captureTerminalOutput(
        {
          isTerminal: true,
          env: { CI: undefined, NO_COLOR: undefined },
        },
        async () => {
          return await runDeploy({
            projectPath: tempDir,
            controlUrl: mockServer.url,
            json: true,
          });
        },
      );

      assertEquals(captured.error, undefined);
      const out = captured.stdout.trim();

      // AC3: ANSI spinner animations and cursor hides must NOT be emitted in json mode
      assertFalse(
        out.includes("\x1b[?25l"),
        "JSON mode must never emit cursor hide escape sequences",
      );
      assertFalse(
        hasAnsiEscape(out),
        "JSON mode output must not contain ANSI escape codes",
      );

      // AC3: Output must be valid JSON parseable as DeploySummary
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(out);
      } catch (e) {
        throw new Error(`Failed to parse json output: ${out} (${e})`);
      }

      assertEquals(parsed.ok, true);
      assertEquals(parsed.revision, "rev_01J8ZJSON0000000000000001");
      assertEquals(parsed.project, "json-deploy-app");
      assert(typeof parsed.elapsedMs === "number");
      assert(typeof parsed.runtimeUrl === "string");
      assert(Array.isArray(parsed.functions));
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC3 (PLAT-19): CI=true suppresses ANSI animated spinners and cursor controls",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-progress-ci-" });
    const mockServer = startMockControlPlane();

    try {
      await createTestProject(tempDir);

      const captured = await captureTerminalOutput(
        {
          isTerminal: true,
          env: { CI: "true", NO_COLOR: undefined },
        },
        async () => {
          return await runDeploy({
            projectPath: tempDir,
            controlUrl: mockServer.url,
          });
        },
      );

      assertEquals(captured.error, undefined);
      const out = captured.stdout;

      // In CI mode, animated cursor controls (\x1b[?25l) and braille frames must be omitted
      assertFalse(
        out.includes("\x1b[?25l"),
        "CI environment must suppress animated cursor controls",
      );
      assertFalse(
        /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(out),
        "CI environment must omit animated braille spinner frames",
      );
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC3 (PLAT-19): NO_COLOR=1 suppresses all ANSI color codes from progress and card output",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-nocolor-",
    });
    const mockServer = startMockControlPlane();

    try {
      await createTestProject(tempDir);

      const captured = await captureTerminalOutput(
        {
          isTerminal: true,
          env: { CI: undefined, NO_COLOR: "1" },
        },
        async () => {
          return await runDeploy({
            projectPath: tempDir,
            controlUrl: mockServer.url,
          });
        },
      );

      assertEquals(captured.error, undefined);
      // deno-lint-ignore no-control-regex
      const hasColorCode = /\x1b\[(?:3[0-7]|9[0-7]|4[0-7]|10[0-7])m/.test(
        captured.stdout,
      );
      assertFalse(
        hasColorCode,
        "NO_COLOR=1 must suppress ANSI color sequences",
      );
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC3 (PLAT-19): deployCommand supports json mode and passes through structured output",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-cli-json-",
    });
    const mockServer = startMockControlPlane({
      revisionId: "rev_01J8ZCMDJON00000000000001",
    });

    try {
      await createTestProject(tempDir, { projectName: "cmd-json-app" });

      const captured = await captureTerminalOutput(
        {
          isTerminal: false,
          env: { CI: "true" },
        },
        async () => {
          return await deployCommand({
            cwd: tempDir,
            controlPlaneUrl: mockServer.url,
            // deno-lint-ignore no-explicit-any
            ...({ json: true } as any),
          });
        },
      );

      assert(captured.error === undefined, "deployCommand must succeed");
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// ============================================================================
// Group 4: Step Failure, Error Cleanup & PLAT-15 Secret Suppression
// Spec: PLAT-15, PLAT-19, AC4
// ============================================================================

Deno.test(
  "AC4 (PLAT-19): Step failure halts spinner with red failure indicator and restores cursor",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-spinner-fail-",
    });
    const mockServer = startMockControlPlane({
      deployStatus: 502,
      deployResponseBody: "Bad Gateway",
    });

    try {
      await createTestProject(tempDir);

      const captured = await captureTerminalOutput(
        {
          isTerminal: true,
          env: { CI: undefined, NO_COLOR: undefined },
        },
        async () => {
          return await runDeploy({
            projectPath: tempDir,
            controlUrl: mockServer.url,
          });
        },
      );

      assert(
        captured.error !== undefined,
        "Expected deployment to throw on 502",
      );
      const out = captured.stdout + captured.stderr;

      // Spinner should halt with error indicator
      assert(
        hasRedOrCross(out),
        "Failure must output red indicator or cross symbol (✖)",
      );

      // Cursor must be restored on failure (PLAT-19)
      assert(
        out.includes("\x1b[?25h"),
        "Failure must restore cursor (\\x1b[?25h)",
      );
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC4 & Security (PLAT-15): Deployment error output redacts bound secret values from logs and error messages",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-sec-redact-",
    });

    // Bound secret values configured for the function
    const sensitiveSecrets = [
      "sk_live_SUPER_SECRET_PAYMENT_KEY_998877",
      "postgres_secret_password_DEADBEEF42",
      "rf_sec_auth_bearer_XYZ9876543210",
    ];

    // Mock control plane that echoes back the sensitive secret in its error response
    const mockServer = startMockControlPlane({
      deployStatus: 400,
      deployResponseBody: {
        error: `Deployment rejected: failed to bind secret with key ${
          sensitiveSecrets[0]
        } and db password ${sensitiveSecrets[1]}`,
      },
    });

    try {
      await createTestProject(tempDir, {
        permissions: {
          secrets: ["STRIPE_KEY", "DB_PASS"],
        },
      });

      let callbackErrorText = "";
      const callbacks: DeployProgressCallbacks = {
        onStepFail: (_step: string, error: string) => {
          callbackErrorText = error;
        },
      };

      const captured = await captureTerminalOutput(
        {
          isTerminal: true,
          env: {
            CI: undefined,
            NO_COLOR: undefined,
            STRIPE_KEY: sensitiveSecrets[0],
            DB_PASS: sensitiveSecrets[1],
          },
        },
        async () => {
          return await runDeploy({
            projectPath: tempDir,
            controlUrl: mockServer.url,
            progress: callbacks,
          });
        },
      );

      assert(captured.error !== undefined, "Deployment must fail");
      const combinedOutput = captured.stdout + captured.stderr +
        callbackErrorText;

      // PLAT-15: Bound secrets must NEVER appear in stdout, stderr, or callbacks
      for (const secret of sensitiveSecrets) {
        assertFalse(
          combinedOutput.includes(secret),
          `Adversarial Security Violation (PLAT-15): Plaintext secret "${secret}" was leaked in deployment error output!`,
        );
      }
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC4 & Security (PLAT-15): Control plane auth token in DeployOptions is suppressed in error traces",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-token-redact-",
    });
    const secretToken = "rf_tok_super_secret_management_bearer_token_12345";

    // Control server echoes token in error trace
    const mockServer = startMockControlPlane({
      deployStatus: 401,
      deployResponseBody: `Unauthorized: token ${secretToken} has expired`,
    });

    try {
      await createTestProject(tempDir);

      let stepFailError = "";
      const callbacks: DeployProgressCallbacks = {
        onStepFail: (_step: string, error: string) => {
          stepFailError = error;
        },
      };

      const captured = await captureTerminalOutput(
        {
          isTerminal: true,
        },
        async () => {
          return await runDeploy({
            projectPath: tempDir,
            controlUrl: mockServer.url,
            token: secretToken,
            progress: callbacks,
          });
        },
      );

      assert(captured.error !== undefined, "Deployment must fail with 401");
      const totalOutput = captured.stdout + captured.stderr + stepFailError;

      // PLAT-15: Token must be redacted
      assertFalse(
        totalOutput.includes(secretToken),
        `Adversarial Security Violation (PLAT-15): Deploy token "${secretToken}" was leaked in error traces!`,
      );
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "AC4 & Security (PLAT-15): Pre-deploy diagnostic secret scanner failures do not reflect raw secrets in progress failures",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-progress-diag-sec-",
    });
    const hardcodedSecret = "AKIAIOSFODNN7EXAMPLE_SECRET_KEY_123456";
    const mockServer = startMockControlPlane();

    try {
      // Function file contains hardcoded AWS-style secret key that triggers diagnostic analyzer
      await createTestProject(tempDir, {
        handlerCode: `// Bad code leaking secret
const AWS_SECRET = "${hardcodedSecret}";
export default async function handler(_req: Request) {
  return new Response("leak: " + AWS_SECRET);
}
`,
      });

      let reportedError = "";
      const callbacks: DeployProgressCallbacks = {
        onStepFail: (_step: string, error: string) => {
          reportedError = error;
        },
      };

      const captured = await captureTerminalOutput(
        { isTerminal: true },
        async () => {
          return await runDeploy({
            projectPath: tempDir,
            controlUrl: mockServer.url,
            progress: callbacks,
          });
        },
      );

      // Deployment should fail during diagnostics/validation
      assert(
        captured.error !== undefined,
        "Pre-deploy security scan must fail",
      );
      const output = captured.stdout + captured.stderr + reportedError;

      assertFalse(
        output.includes(hardcodedSecret),
        `Adversarial Security Violation (PLAT-15): Hardcoded secret "${hardcodedSecret}" was reflected in diagnostic error output!`,
      );
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);
