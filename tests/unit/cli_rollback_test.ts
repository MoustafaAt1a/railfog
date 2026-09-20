/**
 * Tests for CLI rail rollback command (T-0406).
 *
 * Spec references:
 * - PLAT-3: Deployment pipeline (instant pointer-flip rollback)
 * - PLAT-12: Error model (RESOURCE_NOT_FOUND, VALIDATION_FAILED)
 * - PLAT-18: Resource hierarchy (Project -> Function -> Revision)
 * - FN-3: Function lifecycle (pointer-flip rollback)
 */

import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  ResourceNotFoundError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { DeploymentService } from "../../apps/api/deployment-service.ts";
import {
  rollbackCommand,
  type RollbackCommandOptions,
} from "../../cli/rollback.ts";
import { packageFunctionArtifact } from "../../packages/core/artifact/packager.ts";

import { main } from "../../cli/main.ts";

export interface ExtendedRollbackOptions extends RollbackCommandOptions {
  deploymentService?: DeploymentService;
}

const cliMainPath = fromFileUrl(new URL("../../cli/main.ts", import.meta.url));

/**
 * Helper to run the RailFog CLI as a subprocess or in-process.
 */
async function runCli(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const hasRun = (await Deno.permissions.query({ name: "run" })).state ===
    "granted";
  if (hasRun) {
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

  // In-process execution fallback when run permission is not granted
  const origCwd = Deno.cwd();
  const origExit = Deno.exit;
  const origLog = console.log;
  const origErr = console.error;
  let exitCode = 0;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  console.log = (...msg: unknown[]) =>
    stdoutChunks.push(msg.map(String).join(" ") + "\n");
  console.error = (...msg: unknown[]) =>
    stderrChunks.push(msg.map(String).join(" ") + "\n");

  (Deno as { exit: (code?: number) => never }).exit = (c = 0) => {
    exitCode = c;
    throw new Error(`__EXIT_${c}__`);
  };

  try {
    Deno.chdir(cwd);
    await main(args);
  } catch (err: unknown) {
    if (!(err instanceof Error && err.message.startsWith("__EXIT_"))) {
      stderrChunks.push(String(err) + "\n");
      exitCode = 1;
    }
  } finally {
    Deno.chdir(origCwd);
    (Deno as { exit: typeof origExit }).exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }

  return {
    code: exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

Deno.test({
  name:
    "rollbackCommand - AC1: successfully rolls back to prior deployed revision",
  fn: async () => {
    const objectProvider = new LocalFSProvider(await Deno.makeTempDir());
    const deploymentService = new DeploymentService(objectProvider);
    const project = "test-project";
    const functionName = "api";

    // Deploy rev 1
    const artifact1 = await packageFunctionArtifact("a", new Uint8Array([1]));
    const res1 = await deploymentService.deploy(
      project,
      functionName,
      artifact1,
    );

    // Deploy rev 2
    const artifact2 = await packageFunctionArtifact("b", new Uint8Array([2]));
    const res2 = await deploymentService.deploy(
      project,
      functionName,
      artifact2,
    );

    assertEquals(
      (await deploymentService.getActiveRevision(project, functionName))?.id,
      res2.revisionId,
    );

    const result = await rollbackCommand({
      project,
      functionName,
      targetRevisionId: res1.revisionId,
      deploymentService,
    } as ExtendedRollbackOptions);

    assertEquals(result.project, project);
    assertEquals(result.functionName, functionName);
    assertEquals(result.previousRevisionId, res2.revisionId);
    assertEquals(result.activeRevisionId, res1.revisionId);

    assertEquals(
      (await deploymentService.getActiveRevision(project, functionName))?.id,
      res1.revisionId,
    );
  },
});

Deno.test({
  name:
    "rollbackCommand - AC2: rejects targeting non-existent revision with ResourceNotFoundError",
  fn: async () => {
    const objectProvider = new LocalFSProvider(await Deno.makeTempDir());
    const deploymentService = new DeploymentService(objectProvider);

    await assertRejects(
      () =>
        rollbackCommand({
          project: "test-project",
          functionName: "api",
          targetRevisionId: "rev_01XYZNONEXISTENT000000000",
          deploymentService,
        } as ExtendedRollbackOptions),
      ResourceNotFoundError,
      "RESOURCE_NOT_FOUND",
    );
  },
});

Deno.test({
  name:
    "rollbackCommand - AC3: rejects targeting Failed revision with ValidationFailedError",
  fn: async () => {
    const objectProvider = new LocalFSProvider(await Deno.makeTempDir());
    const deploymentService = new DeploymentService(objectProvider);
    const project = "test-project";
    const functionName = "api";

    // Deploy rev 1
    const artifact1 = await packageFunctionArtifact("a", new Uint8Array([1]));
    const res1 = await deploymentService.deploy(
      project,
      functionName,
      artifact1,
    );

    // Deploy rev 2 (Failed)
    const artifact2 = await packageFunctionArtifact("b", new Uint8Array([2]));
    const res2 = await deploymentService.deploy(
      project,
      functionName,
      artifact2,
      () => Promise.resolve(false),
    );

    assertEquals(res2.state, "Failed");

    await assertRejects(
      () =>
        rollbackCommand({
          project,
          functionName,
          targetRevisionId: res2.revisionId,
          deploymentService,
        } as ExtendedRollbackOptions),
      ValidationFailedError,
      "VALIDATION_FAILED",
    );

    // Active pointer remains unchanged
    assertEquals(
      (await deploymentService.getActiveRevision(project, functionName))?.id,
      res1.revisionId,
    );
  },
});

Deno.test({
  name:
    "rollbackCommand - AC5: enforces project and function isolation, rejects mismatched tenant",
  fn: async () => {
    const objectProvider = new LocalFSProvider(await Deno.makeTempDir());
    const deploymentService = new DeploymentService(objectProvider);
    const project = "tenant-a";
    const functionName = "api";

    const artifact1 = await packageFunctionArtifact("a", new Uint8Array([1]));
    const res1 = await deploymentService.deploy(
      project,
      functionName,
      artifact1,
    );

    await assertRejects(
      () =>
        rollbackCommand({
          project: "tenant-b",
          functionName: "api",
          targetRevisionId: res1.revisionId,
          deploymentService,
        } as ExtendedRollbackOptions),
      ResourceNotFoundError,
      "RESOURCE_NOT_FOUND",
    );

    await assertRejects(
      () =>
        rollbackCommand({
          project: "tenant-a",
          functionName: "worker",
          targetRevisionId: res1.revisionId,
          deploymentService,
        } as ExtendedRollbackOptions),
      ResourceNotFoundError,
      "RESOURCE_NOT_FOUND",
    );
  },
});

Deno.test({
  name:
    "CLI rollback - arg validation fails on missing functionName or --to flag",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const configPath = join(tempDir, "railfog.toml");
    await Deno.writeTextFile(configPath, `name = "test-proj"\n`);

    const resultMissingBoth = await runCli(["rollback"], tempDir);
    assertNotEquals(resultMissingBoth.code, 0);
    assertMatch(resultMissingBoth.stderr, /Missing functionName/i);

    const resultMissingTo = await runCli(["rollback", "api"], tempDir);
    assertNotEquals(resultMissingTo.code, 0);
    assertMatch(resultMissingTo.stderr, /Missing --to revision flag/i);
  },
});

Deno.test({
  name: "CLI rollback - AC4: e2e test executing rollback command",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const configPath = join(tempDir, "railfog.toml");
    await Deno.writeTextFile(configPath, `name = "test-proj"\n`);

    const result = await runCli([
      "rollback",
      "api",
      "--to",
      "rev_01XYZNONEXISTENT000000000",
    ], tempDir);

    assertNotEquals(result.code, 0);
  },
});
