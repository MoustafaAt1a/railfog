/**
 * Tests for CLI rail deploy command (T-0210).
 *
 * Spec references:
 * - PLAT-3: Deployment pipeline (validation, artifact packaging, content-addressing, atomic cutover)
 * - PLAT-6: Capability injection (deploy-time permission validation and path isolation)
 * - PLAT-14: ULID format for revision IDs (rev_{ULID})
 * - PLAT-18: Resource hierarchy (Project -> Function -> Revision)
 * - PLAT-20: Out-of-scope banned patterns (no canary / gradual rollout flags)
 * - OBJ-4: Content addressing and artifact integrity
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import {
  type DeploymentResult,
  DeploymentService,
} from "../../apps/api/deployment-service.ts";
import type { PackagedArtifact } from "../../packages/core/artifact/packager.ts";
import {
  deployCommand,
  type DeployCommandOptions,
  type DeployCommandResult,
} from "../../cli/deploy.ts";

/**
 * Extended options allowing direct injection of DeploymentService for tests.
 */
export interface ExtendedDeployOptions extends DeployCommandOptions {
  cwd?: string;
  controlPlaneUrl?: string;
  project?: string;
  deploymentService?: DeploymentService;
}

// spec: docs/contracts/platform.contract.md#PLAT-14 — Crockford Base32 26-char ULID
// spec: docs/contracts/platform.contract.md#PLAT-18 — Revision ID format rev_{ULID}
const REVISION_ID_REGEX = /^rev_[0-9A-HJKMNP-TV-Z]{26}$/;

const cliMainPath = fromFileUrl(new URL("../../cli/main.ts", import.meta.url));

/**
 * Helper to run the RailFog CLI as a subprocess.
 */
async function runCli(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-net",
      cliMainPath,
      ...args,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/**
 * Helper to scaffold a valid RailFog project in a directory.
 */
async function createValidProject(
  dir: string,
  options?: {
    appName?: string;
    entryFile?: string;
    handlerCode?: string;
    routes?: Array<{ pattern: string; function: string }>;
    permissions?: Record<string, unknown>;
  },
): Promise<void> {
  const appName = options?.appName ?? "test-deploy-app";
  const entryFile = options?.entryFile ?? "functions/api.ts";
  const handlerCode = options?.handlerCode ??
    `export default async function handler(_req: Request): Promise<Response> {\n  return new Response("Hello from deployed function!");\n}\n`;

  const fullEntryPath = join(dir, entryFile);
  await Deno.mkdir(dirname(fullEntryPath), { recursive: true });
  await Deno.writeTextFile(fullEntryPath, handlerCode);

  let tomlContent =
    `name = "${appName}"\n\n[functions.api]\nentry = "${entryFile}"\n`;

  if (options?.permissions) {
    tomlContent += `\n[functions.api.permissions]\n`;
    for (const [k, v] of Object.entries(options.permissions)) {
      tomlContent += `${k} = ${JSON.stringify(v)}\n`;
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
 * Helper to run an in-process HTTP mock Control Plane server for deployment.
 */
function startMockControlPlaneServer(options?: {
  onDeploy?: (req: Request, body: Record<string, unknown> | null) => void;
  revisionId?: string;
  state?: string;
  status?: number;
}): { url: string; close: () => Promise<void> } {
  const revId = options?.revisionId ?? "rev_01J8Z000000000000000000001";
  const state = options?.state ?? "Deployed";
  const status = options?.status ?? 200;

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req: Request) => {
      let body: Record<string, unknown> | null = null;
      try {
        const text = await req.text();
        body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        // body is empty or non-JSON
      }
      if (options?.onDeploy) {
        options.onDeploy(req, body);
      }
      return new Response(
        JSON.stringify({
          revisionId: revId,
          state,
        }),
        {
          status,
          headers: { "content-type": "application/json" },
        },
      );
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
 * Creates an in-memory or LocalFS-backed DeploymentService for testing.
 */
function createTestDeploymentService(
  storageDir: string,
): { service: DeploymentService; storage: LocalFSProvider } {
  const storage = new LocalFSProvider(storageDir);
  const service = new DeploymentService(storage);
  return { service, storage };
}

// =============================================================================
// Unit Tests: deployCommand options, config parsing, and validation
// =============================================================================

Deno.test(
  "Unit: AC2 - deployCommand rejects when railfog.toml does not exist in cwd",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-missing-",
    });
    try {
      await assertRejects(
        async () => {
          await deployCommand({ cwd: tempDir });
        },
        Error,
        "railfog.toml",
        "deployCommand must throw/reject indicating missing railfog.toml",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: AC3 - deployCommand aborts with ValidationFailedError when entrypoint file does not exist (PLAT-3)",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-nonexist-",
    });
    const storageDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-storage-",
    });
    try {
      const tomlContent =
        `name = "test-missing-entry"\n\n[functions.api]\nentry = "functions/non_existent.ts"\n`;
      await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

      const { service } = createTestDeploymentService(storageDir);
      const opts: ExtendedDeployOptions = {
        cwd: tempDir,
        deploymentService: service,
      };

      await assertRejects(
        async () => {
          await deployCommand(opts);
        },
        ValidationFailedError,
        undefined,
        "Must abort with ValidationFailedError when entry file does not exist",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: AC3 - deployCommand does not invoke control plane when entry validation fails (PLAT-3)",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-no-cp-call-",
    });
    try {
      const tomlContent =
        `name = "test-no-cp"\n\n[functions.api]\nentry = "functions/ghost.ts"\n`;
      await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

      let cpCalled = false;
      const fakeService = {
        deploy: () => {
          cpCalled = true;
          return Promise.resolve({
            revisionId: "rev_01J8Z000000000000000000001",
            state: "Deployed" as const,
            active: true,
          });
        },
      } as unknown as DeploymentService;

      const opts: ExtendedDeployOptions = {
        cwd: tempDir,
        deploymentService: fakeService,
      };

      await assertRejects(async () => {
        await deployCommand(opts);
      });

      assertEquals(
        cpCalled,
        false,
        "Control plane must NEVER be invoked if function entrypoint validation fails (PLAT-3)",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: AC5 - deployCommand defaults to project name defined in railfog.toml",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-proj-default-",
    });
    const storageDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-storage-",
    });
    try {
      const expectedProject = "my-toml-configured-app";
      await createValidProject(tempDir, { appName: expectedProject });

      let submittedProject: string | null = null;
      const trackingService = {
        deploy: (
          project: string,
          _fn: string,
          _art: PackagedArtifact,
        ): Promise<DeploymentResult> => {
          submittedProject = project;
          return Promise.resolve({
            revisionId: "rev_01J8Z000000000000000000001",
            state: "Deployed",
            active: true,
          });
        },
      } as unknown as DeploymentService;

      const opts: ExtendedDeployOptions = {
        cwd: tempDir,
        deploymentService: trackingService,
      };
      await deployCommand(opts);

      assertEquals(
        submittedProject,
        expectedProject,
        "deployCommand must use the project name from railfog.toml by default",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: AC5 - deployCommand options.project overrides project name from railfog.toml (PLAT-18)",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-proj-override-",
    });
    try {
      await createValidProject(tempDir, { appName: "default-app-name" });

      const overriddenProject = "custom-override-project";
      let submittedProject: string | null = null;
      const trackingService = {
        deploy: (
          project: string,
          _fn: string,
          _art: PackagedArtifact,
        ): Promise<DeploymentResult> => {
          submittedProject = project;
          return Promise.resolve({
            revisionId: "rev_01J8Z000000000000000000001",
            state: "Deployed",
            active: true,
          });
        },
      } as unknown as DeploymentService;

      const opts: ExtendedDeployOptions = {
        cwd: tempDir,
        project: overriddenProject,
        deploymentService: trackingService,
      };
      await deployCommand(opts);

      assertEquals(
        submittedProject,
        overriddenProject,
        "options.project must override the name declared in railfog.toml",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: syntax validation - deployCommand rejects malformed railfog.toml with ValidationFailedError",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-bad-toml-",
    });
    try {
      await Deno.writeTextFile(
        join(tempDir, "railfog.toml"),
        `name = "broken" \n[unclosed table`,
      );

      await assertRejects(
        async () => {
          await deployCommand({ cwd: tempDir });
        },
        ValidationFailedError,
        undefined,
        "Malformed TOML syntax must reject with ValidationFailedError",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: schema validation - deployCommand rejects railfog.toml missing functions table",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-deploy-no-fn-" });
    try {
      await Deno.writeTextFile(
        join(tempDir, "railfog.toml"),
        `name = "no-functions-app"\n`,
      );

      await assertRejects(
        async () => {
          await deployCommand({ cwd: tempDir });
        },
        ValidationFailedError,
        undefined,
        "Missing [functions] table must reject with ValidationFailedError",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: schema validation - deployCommand rejects empty entrypoint string",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-empty-entry-",
    });
    try {
      await Deno.writeTextFile(
        join(tempDir, "railfog.toml"),
        `name = "empty-entry-app"\n\n[functions.api]\nentry = "   "\n`,
      );

      await assertRejects(
        async () => {
          await deployCommand({ cwd: tempDir });
        },
        ValidationFailedError,
        undefined,
        "Empty or whitespace entry must reject with ValidationFailedError",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: PLAT-6 - deployCommand rejects ambiguous permission declarations with ValidationFailedError",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-ambiguous-perms-",
    });
    try {
      await createValidProject(tempDir, {
        permissions: {
          kv: ["namespace-1", "namespace-2"], // multiple KV namespaces violate PLAT-6 ambiguous scope
        },
      });

      await assertRejects(
        async () => {
          await deployCommand({ cwd: tempDir });
        },
        ValidationFailedError,
        "ambiguous",
        "Ambiguous scope with multiple KV namespaces must reject with ValidationFailedError (PLAT-6)",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// =============================================================================
// Integration Tests: deployCommand execution and CLI subshell
// =============================================================================

Deno.test(
  "Integration: AC1 - deployCommand packages artifact and submits to DeploymentService returning valid rev_{ULID} and state (PLAT-3, PLAT-14)",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-real-ac1-",
    });
    const storageDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-storage-",
    });
    try {
      await createValidProject(tempDir, { appName: "canonical-app" });
      const { service } = createTestDeploymentService(storageDir);

      const opts: ExtendedDeployOptions = {
        cwd: tempDir,
        deploymentService: service,
      };

      const result: DeployCommandResult = await deployCommand(opts);

      assertExists(result.revisionId, "Result must contain revisionId");
      assertMatch(
        result.revisionId,
        REVISION_ID_REGEX,
        `revisionId '${result.revisionId}' must match /^rev_[0-9A-HJKMNP-TV-Z]{26}$/ (PLAT-14)`,
      );
      assertEquals(
        result.state,
        "Deployed",
        "Result state must be 'Deployed' upon successful deployment (FN-3)",
      );

      // Verify the active pointer in the service points to this revision
      const active = await service.getActiveRevision("canonical-app", "api");
      assertExists(
        active,
        "Active revision record must exist in DeploymentService",
      );
      assertEquals(active.id, result.revisionId);
      assertEquals(active.state, "Deployed");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: AC1 - deployCommand artifact stored in ObjectProvider matches sha256 integrity (OBJ-4, PLAT-3)",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-deploy-obj4-" });
    const storageDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-storage-",
    });
    try {
      const handlerCode =
        `export default () => new Response("OBJ-4 integrity test");\n`;
      await createValidProject(tempDir, { handlerCode });
      const { service, storage } = createTestDeploymentService(storageDir);

      const opts: ExtendedDeployOptions = {
        cwd: tempDir,
        deploymentService: service,
      };
      await deployCommand(opts);

      const active = await service.getActiveRevision("test-deploy-app", "api");
      assertExists(active);
      assertMatch(active.artifactId, /^sha256:[0-9a-f]{64}$/);
      assertMatch(active.integrity, /^sha256-[A-Za-z0-9+/=]+$/);

      // Verify artifact bytes stored in storage match the content
      const storedStream = await storage.get(`artifacts/${active.artifactId}`);
      assertExists(
        storedStream,
        "Stored artifact must be present in ObjectProvider under artifacts/{artifact_id}",
      );
      const reader = storedStream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      const storedBytes = new Uint8Array(totalLen);
      let off = 0;
      for (const c of chunks) {
        storedBytes.set(c, off);
        off += c.length;
      }
      const text = new TextDecoder().decode(storedBytes);
      assert(
        text.includes("OBJ-4 integrity test"),
        "Stored artifact must contain original function code bytes",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: AC1 - deployCommand with controlPlaneUrl submits to running HTTP Control Plane (PLAT-3)",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-http-cp-",
    });
    let receivedPayload: Record<string, unknown> | null = null;
    const expectedRev = "rev_01J8Z999999999999999999999";

    const mockServer = startMockControlPlaneServer({
      revisionId: expectedRev,
      state: "Deployed",
      onDeploy: (_req, body) => {
        receivedPayload = body;
      },
    });

    try {
      await createValidProject(tempDir);
      const result = await deployCommand({
        cwd: tempDir,
        controlPlaneUrl: mockServer.url,
      });

      assertEquals(result.revisionId, expectedRev);
      assertEquals(result.state, "Deployed");
      assertExists(
        receivedPayload,
        "Mock Control Plane server must have received deployment HTTP request",
      );
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: AC1 - deployCommand handles project with multiple declared functions",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-multi-fn-",
    });
    const storageDir = await Deno.makeTempDir({
      prefix: "railfog-deploy-storage-",
    });
    try {
      const apiCode = `export default () => new Response("api");\n`;
      const healthCode = `export default () => new Response("health");\n`;

      await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
      await Deno.writeTextFile(join(tempDir, "functions", "api.ts"), apiCode);
      await Deno.writeTextFile(
        join(tempDir, "functions", "health.ts"),
        healthCode,
      );

      const tomlContent = `name = "multi-fn-app"

[functions.api]
entry = "functions/api.ts"

[functions.health]
entry = "functions/health.ts"

[[routes]]
pattern = "/api/*"
function = "api"

[[routes]]
pattern = "/health"
function = "health"
`;
      await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

      const { service } = createTestDeploymentService(storageDir);
      const opts: ExtendedDeployOptions = {
        cwd: tempDir,
        deploymentService: service,
      };

      const result = await deployCommand(opts);
      assertMatch(result.revisionId, REVISION_ID_REGEX);

      // Verify both functions are registered
      const activeApi = await service.getActiveRevision("multi-fn-app", "api");
      const activeHealth = await service.getActiveRevision(
        "multi-fn-app",
        "health",
      );
      assertExists(activeApi, "api function must be deployed");
      assertExists(activeHealth, "health function must be deployed");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: AC2 - rail deploy CLI in directory without railfog.toml exits with code 1 and logs error",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-cli-missing-toml-",
    });
    try {
      const res = await runCli(["deploy"], tempDir);
      assertEquals(
        res.code,
        1,
        `rail deploy in empty dir must exit with code 1. Stderr: ${res.stderr}, Stdout: ${res.stdout}`,
      );

      const combined = res.stdout + "\n" + res.stderr;
      assertMatch(
        combined,
        /railfog\.toml/i,
        `Error message must mention missing railfog.toml. Output was:\n${combined}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: AC3 - rail deploy CLI with missing function entry file exits non-zero and reports validation error (PLAT-3)",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-cli-missing-entry-",
    });
    try {
      const tomlContent =
        `name = "bad-entry-app"\n\n[functions.api]\nentry = "functions/does_not_exist.ts"\n`;
      await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

      const res = await runCli(["deploy"], tempDir);
      assertNotEquals(
        res.code,
        0,
        `rail deploy with missing entry must exit non-zero. Stderr: ${res.stderr}`,
      );

      const combined = res.stdout + "\n" + res.stderr;
      assertMatch(
        combined,
        /VALIDATION_FAILED|not found|does not exist/i,
        `Output must indicate entry validation failure. Output was:\n${combined}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: AC4 - rail --help lists deploy as an available command",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-cli-help-" });
    try {
      const res = await runCli(["--help"], tempDir);
      assertEquals(
        res.code,
        0,
        `rail --help should exit with code 0. Stderr: ${res.stderr}`,
      );
      assertMatch(
        res.stdout,
        /\bdeploy\b/,
        `rail --help must list 'deploy' command. Stdout was:\n${res.stdout}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: AC4 - rail -h lists deploy as an available command",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-cli-short-help-",
    });
    try {
      const res = await runCli(["-h"], tempDir);
      assertEquals(
        res.code,
        0,
        `rail -h should exit with code 0. Stderr: ${res.stderr}`,
      );
      assertMatch(
        res.stdout,
        /\bdeploy\b/,
        `rail -h must list 'deploy' command. Stdout was:\n${res.stdout}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: AC4 - rail deploy --help outputs options including --control-url and --project",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-cli-deploy-help-",
    });
    try {
      const res = await runCli(["deploy", "--help"], tempDir);
      assertEquals(
        res.code,
        0,
        `rail deploy --help should exit with code 0. Stderr: ${res.stderr}`,
      );
      assertMatch(
        res.stdout,
        /--control-url/i,
        `rail deploy --help must document --control-url flag. Stdout was:\n${res.stdout}`,
      );
      assertMatch(
        res.stdout,
        /--project/i,
        `rail deploy --help must document --project flag. Stdout was:\n${res.stdout}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: AC4 - rail deploy -h outputs options including --control-url and --project",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-cli-deploy-short-help-",
    });
    try {
      const res = await runCli(["deploy", "-h"], tempDir);
      assertEquals(
        res.code,
        0,
        `rail deploy -h should exit with code 0. Stderr: ${res.stderr}`,
      );
      assertMatch(
        res.stdout,
        /--control-url/i,
        `rail deploy -h must document --control-url flag. Stdout was:\n${res.stdout}`,
      );
      assertMatch(
        res.stdout,
        /--project/i,
        `rail deploy -h must document --project flag. Stdout was:\n${res.stdout}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: AC5 - rail deploy CLI with --project flag passes overridden project name",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-cli-flag-project-",
    });
    let receivedPayload: Record<string, unknown> | null = null;
    const mockServer = startMockControlPlaneServer({
      onDeploy: (_req, body) => {
        receivedPayload = body;
      },
    });

    try {
      await createValidProject(tempDir, { appName: "original-toml-project" });
      const res = await runCli(
        [
          "deploy",
          "--control-url",
          mockServer.url,
          "--project",
          "cli-override-project",
        ],
        tempDir,
      );

      assertEquals(
        res.code,
        0,
        `rail deploy should exit 0 with valid flags. Output:\n${res.stdout}\n${res.stderr}`,
      );

      const combined = res.stdout + "\n" +
        JSON.stringify(receivedPayload ?? {});
      assert(
        combined.includes("cli-override-project"),
        `Output or payload must reflect the overridden project name 'cli-override-project'. Combined:\n${combined}`,
      );
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: AC5 - rail deploy CLI with --control-url flag connects to specified control plane and outputs revision",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-cli-control-url-",
    });
    const expectedRev = "rev_01J8Z1234567890ABCDEFGHJKM";
    const mockServer = startMockControlPlaneServer({
      revisionId: expectedRev,
      state: "Deployed",
    });

    try {
      await createValidProject(tempDir);
      const res = await runCli(
        ["deploy", "--control-url", mockServer.url],
        tempDir,
      );

      assertEquals(
        res.code,
        0,
        `rail deploy with --control-url should exit 0. Output:\n${res.stdout}\n${res.stderr}`,
      );
      assertMatch(
        res.stdout,
        new RegExp(expectedRev),
        `rail deploy output must display the deployed revision ULID. Stdout was:\n${res.stdout}`,
      );
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: AC5 - rail deploy CLI supports --control-url=... and --project=... equal sign syntax",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-cli-equal-syntax-",
    });
    const expectedRev = "rev_01J8ZEQUALSYNTAX0000000000";
    const mockServer = startMockControlPlaneServer({
      revisionId: expectedRev,
      state: "Deployed",
    });

    try {
      await createValidProject(tempDir, { appName: "default-app" });
      const res = await runCli(
        [
          "deploy",
          `--control-url=${mockServer.url}`,
          `--project=project-via-equals`,
        ],
        tempDir,
      );

      assertEquals(
        res.code,
        0,
        `rail deploy with equal-sign syntax must succeed. Output:\n${res.stdout}\n${res.stderr}`,
      );
      assertMatch(
        res.stdout,
        new RegExp(expectedRev),
        `Output must show revision ULID. Stdout was:\n${res.stdout}`,
      );
    } finally {
      await mockServer.close();
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

// =============================================================================
// Security Tests: Path traversal, isolation, and banned patterns
// =============================================================================

Deno.test(
  "Security: AC6 - PLAT-6 / Path Traversal - entrypoint escaping project directory with relative path ('../') throws ValidationFailedError",
  async () => {
    const rootDir = await Deno.makeTempDir({ prefix: "railfog-sec-escape-" });
    const projectDir = join(rootDir, "app");
    await Deno.mkdir(projectDir);

    try {
      // Create a sensitive file outside project root
      const secretFile = join(rootDir, "sensitive.ts");
      await Deno.writeTextFile(
        secretFile,
        `export default () => new Response("leaked secrets");\n`,
      );

      // toml specifies entry escaping project directory
      const tomlContent =
        `name = "traversal-app"\n\n[functions.api]\nentry = "../sensitive.ts"\n`;
      await Deno.writeTextFile(join(projectDir, "railfog.toml"), tomlContent);

      await assertRejects(
        async () => {
          await deployCommand({ cwd: projectDir });
        },
        ValidationFailedError,
        undefined,
        "Relative path traversal escaping project directory must reject with ValidationFailedError (PLAT-6)",
      );
    } finally {
      await Deno.remove(rootDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: AC6 - PLAT-6 / Path Traversal - entrypoint with absolute path outside project root throws ValidationFailedError",
  async () => {
    const rootDir = await Deno.makeTempDir({ prefix: "railfog-sec-abs-" });
    const projectDir = join(rootDir, "app");
    await Deno.mkdir(projectDir);

    try {
      const secretFile = join(rootDir, "system.ts");
      await Deno.writeTextFile(
        secretFile,
        `export default () => new Response("leak");\n`,
      );

      // Using absolute path
      const absPath = resolve(secretFile).replace(/\\/g, "/");
      const tomlContent =
        `name = "abs-app"\n\n[functions.api]\nentry = "${absPath}"\n`;
      await Deno.writeTextFile(join(projectDir, "railfog.toml"), tomlContent);

      await assertRejects(
        async () => {
          await deployCommand({ cwd: projectDir });
        },
        ValidationFailedError,
        undefined,
        "Absolute path outside project directory must reject with ValidationFailedError (PLAT-6)",
      );
    } finally {
      await Deno.remove(rootDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: AC6 - PLAT-6 / Path Traversal - entrypoint with nested traversal tricks ('functions/../../outside.ts') throws ValidationFailedError",
  async () => {
    const rootDir = await Deno.makeTempDir({ prefix: "railfog-sec-tricks-" });
    const projectDir = join(rootDir, "app");
    await Deno.mkdir(projectDir);

    try {
      const secretFile = join(rootDir, "outside.ts");
      await Deno.writeTextFile(
        secretFile,
        `export default () => new Response("leak");\n`,
      );

      const tomlContent =
        `name = "tricks-app"\n\n[functions.api]\nentry = "functions/../../outside.ts"\n`;
      await Deno.writeTextFile(join(projectDir, "railfog.toml"), tomlContent);

      await assertRejects(
        async () => {
          await deployCommand({ cwd: projectDir });
        },
        ValidationFailedError,
        undefined,
        "Complex path traversal trick must reject with ValidationFailedError (PLAT-6)",
      );
    } finally {
      await Deno.remove(rootDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: AC6 - PLAT-6 / Path Traversal - control plane is never invoked when path traversal is detected",
  async () => {
    const rootDir = await Deno.makeTempDir({ prefix: "railfog-sec-no-cp-" });
    const projectDir = join(rootDir, "app");
    await Deno.mkdir(projectDir);

    try {
      const secretFile = join(rootDir, "secret.ts");
      await Deno.writeTextFile(
        secretFile,
        `export default () => new Response("secret");\n`,
      );

      const tomlContent =
        `name = "no-cp-app"\n\n[functions.api]\nentry = "../secret.ts"\n`;
      await Deno.writeTextFile(join(projectDir, "railfog.toml"), tomlContent);

      let cpInvoked = false;
      const trackingService = {
        deploy: () => {
          cpInvoked = true;
          return Promise.resolve({
            revisionId: "rev_01J8Z000000000000000000001",
            state: "Deployed" as const,
            active: true,
          });
        },
      } as unknown as DeploymentService;

      const opts: ExtendedDeployOptions = {
        cwd: projectDir,
        deploymentService: trackingService,
      };

      await assertRejects(async () => {
        await deployCommand(opts);
      });

      assertEquals(
        cpInvoked,
        false,
        "Control plane deploy must NEVER be called when path traversal is detected",
      );
    } finally {
      await Deno.remove(rootDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: AC7 - Packaging isolation - deploy CLI packages only explicit function source files, ignoring ambient files in project directory",
  async () => {
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-sec-isolation-",
    });
    const storageDir = await Deno.makeTempDir({
      prefix: "railfog-sec-storage-",
    });
    try {
      const functionCode =
        `export default () => new Response("authorized code only");\n`;
      await createValidProject(tempDir, { handlerCode: functionCode });

      // Create sensitive ambient files inside the project directory that should NOT be packaged
      const secretKeyContent =
        "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASC...\n-----END PRIVATE KEY-----";
      const envContent =
        "DATABASE_URL=postgres://admin:supersecret@db.internal:5432/prod\nAPI_KEY=sk_live_999999";
      await Deno.writeTextFile(join(tempDir, "private.key"), secretKeyContent);
      await Deno.writeTextFile(join(tempDir, ".env"), envContent);
      await Deno.writeTextFile(
        join(tempDir, "ambient_notes.txt"),
        "Internal development notes",
      );

      const { service, storage } = createTestDeploymentService(storageDir);
      const opts: ExtendedDeployOptions = {
        cwd: tempDir,
        deploymentService: service,
      };

      await deployCommand(opts);
      const active = await service.getActiveRevision("test-deploy-app", "api");
      assertExists(active);

      // Read stored artifact bytes from ObjectProvider
      const stream = await storage.get(`artifacts/${active.artifactId}`);
      assertExists(stream);
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      const artifactBytes = new Uint8Array(totalLen);
      let off = 0;
      for (const c of chunks) {
        artifactBytes.set(c, off);
        off += c.length;
      }

      const decodedArtifact = new TextDecoder().decode(artifactBytes);

      // Must contain function code
      assert(
        decodedArtifact.includes("authorized code only"),
        "Packaged artifact must contain function source code",
      );

      // Must NOT contain ambient private keys, .env, or unrelated files
      assertEquals(
        decodedArtifact.includes("BEGIN PRIVATE KEY"),
        false,
        "Packaged artifact must NEVER bundle private keys or ambient secrets",
      );
      assertEquals(
        decodedArtifact.includes("supersecret"),
        false,
        "Packaged artifact must NEVER bundle ambient .env file contents",
      );
      assertEquals(
        decodedArtifact.includes("Internal development notes"),
        false,
        "Packaged artifact must NEVER bundle ambient non-function files",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: AC7 - Parent directory isolation - deploy CLI never reads ambient files from parent directories outside project root",
  async () => {
    const parentDir = await Deno.makeTempDir({ prefix: "railfog-sec-parent-" });
    const projectDir = join(parentDir, "my-app");
    const storageDir = await Deno.makeTempDir({
      prefix: "railfog-sec-storage-",
    });
    await Deno.mkdir(projectDir);

    try {
      // Create sensitive file in parent
      const parentSecret =
        "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      await Deno.writeTextFile(
        join(parentDir, "root_secret.env"),
        parentSecret,
      );

      await createValidProject(projectDir);

      const { service, storage } = createTestDeploymentService(storageDir);
      const opts: ExtendedDeployOptions = {
        cwd: projectDir,
        deploymentService: service,
      };

      await deployCommand(opts);
      const active = await service.getActiveRevision("test-deploy-app", "api");
      assertExists(active);

      const stream = await storage.get(`artifacts/${active.artifactId}`);
      assertExists(stream);
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      const artifactBytes = new Uint8Array(totalLen);
      let off = 0;
      for (const c of chunks) {
        artifactBytes.set(c, off);
        off += c.length;
      }
      const decoded = new TextDecoder().decode(artifactBytes);

      assertEquals(
        decoded.includes("AWS_SECRET_ACCESS_KEY"),
        false,
        "Packaged artifact must never include files from parent directories",
      );
    } finally {
      await Deno.remove(parentDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: AC8 - Banned patterns - CLI rejects or does not accept canary and weight flags (PLAT-3, PLAT-20)",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-banned-flags-" });
    try {
      await createValidProject(tempDir);

      // Test --canary flag
      const canaryRes = await runCli(["deploy", "--canary", "10"], tempDir);
      const canaryOutput = canaryRes.stdout + "\n" + canaryRes.stderr;
      const canaryRejected = canaryRes.code !== 0 ||
        /unknown|unsupported|banned|invalid/i.test(canaryOutput);

      assert(
        canaryRejected,
        `--canary flag must be rejected per PLAT-3 and PLAT-20. Code: ${canaryRes.code}, Output:\n${canaryOutput}`,
      );

      // Test --weight flag
      const weightRes = await runCli(["deploy", "--weight", "20"], tempDir);
      const weightOutput = weightRes.stdout + "\n" + weightRes.stderr;
      const weightRejected = weightRes.code !== 0 ||
        /unknown|unsupported|banned|invalid/i.test(weightOutput);

      assert(
        weightRejected,
        `--weight flag must be rejected per PLAT-3 and PLAT-20. Code: ${weightRes.code}, Output:\n${weightOutput}`,
      );

      // Test boolean --canary flag
      const boolCanaryRes = await runCli(["deploy", "--canary"], tempDir);
      const boolCanaryOutput = boolCanaryRes.stdout + "\n" +
        boolCanaryRes.stderr;
      const boolCanaryRejected = boolCanaryRes.code !== 0 ||
        /unknown|unsupported|banned|invalid/i.test(boolCanaryOutput);

      assert(
        boolCanaryRejected,
        `Boolean --canary flag must be rejected per PLAT-3 and PLAT-20. Code: ${boolCanaryRes.code}, Output:\n${boolCanaryOutput}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "PLAT-6 & PLAT-15: Deploy succeeds when secrets in [env] are accessed via capabilities = ['env']",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-env-cap-test-" });
    const storageDir = await Deno.makeTempDir({
      prefix: "railfog-env-cap-storage-",
    });

    try {
      const toml = `
name = "env-cap-test"
[env]
WELCOME_MSG = "Hello World"

[[functions]]
name = "api"
entry = "api.ts"
route = "/api/hello"
capabilities = ["env"]
`;
      await Deno.writeTextFile(join(tempDir, "railfog.toml"), toml);
      await Deno.writeTextFile(
        join(tempDir, "api.ts"),
        `export default async function handle(req: Request, ctx: any): Promise<Response> {
  const msg = ctx.env.get("WELCOME_MSG");
  return new Response(msg);
}`,
      );

      const { service } = createTestDeploymentService(storageDir);
      const res = await deployCommand({
        cwd: tempDir,
        deploymentService: service,
      });

      assert(res.revisionId.startsWith("rev_"));
      assertEquals(res.state, "Deployed");
    } finally {
      await Deno.remove(tempDir, { recursive: true });
      await Deno.remove(storageDir, { recursive: true });
    }
  },
);
