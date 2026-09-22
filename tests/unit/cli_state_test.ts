/**
 * Tests for CLI rail export and rail import commands (T-0411).
 *
 * Spec references:
 * - PLAT-7: Multi-tenant data isolation and key re-scoping
 * - PLAT-12: Error model (VALIDATION_FAILED, CONFLICT, RESOURCE_NOT_FOUND)
 * - PLAT-14: ULID monotonic identifier format
 * - PLAT-18: Resource hierarchy (Org -> Project -> { Function, KV, Object, Queue })
 * - OBJ-1: Durable binary storage for backups
 * - OBJ-4: Content addressing and integrity verification
 * - FN-3: Function lifecycle, immutable revisions, pointer-flip restore
 * - ADR-0002: State backup and disaster recovery archive specification
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import type { StateBackupArchive } from "../../packages/core/backup/archive-schema.ts";
import type {
  ExportProjectOptions,
  ImportProjectOptions,
  ImportProjectResult,
  StateBackupService,
} from "../../apps/api/state-backup-service.ts";
import { exportCommand, importCommand } from "../../cli/state.ts";
import { main } from "../../cli/main.ts";

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

  // In-process execution fallback
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

/**
 * Creates a mock StateBackupService for isolated CLI unit testing.
 */
function createMockStateBackupService(
  overrides?: Partial<StateBackupService>,
): StateBackupService {
  return {
    exportProject: (options: ExportProjectOptions) => {
      if (overrides?.exportProject) {
        return overrides.exportProject(options);
      }
      const archive: StateBackupArchive = {
        version: 1,
        backupId: "bak_01J8Z000000000000000000010",
        createdAt: Date.now(),
        project: {
          orgId: options.orgId,
          projectId: options.projectId,
          name: options.projectId,
        },
        functions: [],
        kv: [],
        objects: [],
        queues: [],
      };
      return Promise.resolve(archive);
    },
    importProject: (options: ImportProjectOptions) => {
      if (overrides?.importProject) {
        return overrides.importProject(options);
      }
      return Promise.resolve({
        restoredRevisions: 1,
        restoredKvKeys: 2,
        restoredObjects: 3,
        restoredQueues: 0,
      });
    },
  };
}

// ============================================================================
// Unit Tests: rail export command
// ============================================================================

Deno.test({
  name:
    "exportCommand - AC6: exports project declared in railfog.toml to specified outputFile",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const configPath = join(tempDir, "railfog.toml");
    await Deno.writeTextFile(configPath, `name = "my-service"\n`);

    const outputFile = join(tempDir, "exported-backup.json");
    const mockService = createMockStateBackupService();

    const result = await exportCommand({
      cwd: tempDir,
      outputFile,
      stateBackupService: mockService,
    });

    assertEquals(result.backupId, "bak_01J8Z000000000000000000010");
    assertEquals(result.outputFile, outputFile);

    // Verify output file was written to disk
    const content = await Deno.readTextFile(outputFile);
    const parsed = JSON.parse(content) as StateBackupArchive;
    assertEquals(parsed.version, 1);
    assertEquals(parsed.project.projectId, "my-service");
  },
});

Deno.test({
  name:
    "exportCommand - AC6: uses default output file when outputFile is omitted",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const configPath = join(tempDir, "railfog.toml");
    await Deno.writeTextFile(configPath, `name = "auto-output"\n`);

    const mockService = createMockStateBackupService();
    const result = await exportCommand({
      cwd: tempDir,
      stateBackupService: mockService,
    });

    assertExists(result.outputFile);
    assert(result.outputFile.endsWith(".json"));

    // File should exist at returned path
    const stat = await Deno.stat(result.outputFile);
    assert(stat.isFile);
  },
});

Deno.test({
  name: "exportCommand - AC6: allows project override via options.project",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const configPath = join(tempDir, "railfog.toml");
    await Deno.writeTextFile(configPath, `name = "default-project"\n`);

    let exportedProjectId = "";
    const mockService = createMockStateBackupService({
      exportProject: (opts: ExportProjectOptions) => {
        exportedProjectId = opts.projectId;
        return Promise.resolve({
          version: 1,
          backupId: "bak_01J8Z000000000000000000011",
          createdAt: Date.now(),
          project: {
            orgId: opts.orgId,
            projectId: opts.projectId,
            name: opts.projectId,
          },
          functions: [],
          kv: [],
          objects: [],
          queues: [],
        });
      },
    });

    const outputFile = join(tempDir, "override.json");
    await exportCommand({
      cwd: tempDir,
      project: "override-project",
      outputFile,
      stateBackupService: mockService,
    });

    assertEquals(exportedProjectId, "override-project");
  },
});

Deno.test({
  name:
    "exportCommand - AC6: throws ValidationFailedError if railfog.toml is missing and no project override provided",
  fn: async () => {
    const emptyTempDir = await Deno.makeTempDir();
    const mockService = createMockStateBackupService();

    await assertRejects(
      () =>
        exportCommand({
          cwd: emptyTempDir,
          stateBackupService: mockService,
        }),
      ValidationFailedError,
    );
  },
});

// ============================================================================
// Unit Tests: rail import command
// ============================================================================

Deno.test({
  name:
    "importCommand - AC6: restores project state from input file into target project",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const backupData: StateBackupArchive = {
      version: 1,
      backupId: "bak_01J8Z000000000000000000020",
      createdAt: Date.now(),
      project: { orgId: "org_src", projectId: "proj_src", name: "proj_src" },
      functions: [],
      kv: [],
      objects: [],
      queues: [],
    };

    const inputFile = join(tempDir, "backup-to-import.json");
    await Deno.writeTextFile(inputFile, JSON.stringify(backupData, null, 2));

    let importedTargetOrg = "";
    let importedTargetProj = "";
    const mockService = createMockStateBackupService({
      importProject: (opts: ImportProjectOptions) => {
        importedTargetOrg = opts.targetOrgId;
        importedTargetProj = opts.targetProjectId;
        return Promise.resolve({
          restoredRevisions: 3,
          restoredKvKeys: 5,
          restoredObjects: 2,
          restoredQueues: 1,
        });
      },
    });

    const result: ImportProjectResult = await importCommand({
      cwd: tempDir,
      inputFile,
      targetOrgId: "org_custom",
      targetProject: "proj_custom",
      stateBackupService: mockService,
    });

    assertEquals(importedTargetOrg, "org_custom");
    assertEquals(importedTargetProj, "proj_custom");
    assertEquals(result.restoredRevisions, 3);
    assertEquals(result.restoredKvKeys, 5);
    assertEquals(result.restoredObjects, 2);
    assertEquals(result.restoredQueues, 1);
  },
});

Deno.test({
  name:
    "importCommand - AC5, AC6: passes overwriteKv flag through to StateBackupService",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const backupData: StateBackupArchive = {
      version: 1,
      backupId: "bak_01J8Z000000000000000000021",
      createdAt: Date.now(),
      project: { orgId: "org_src", projectId: "proj_src", name: "proj_src" },
      functions: [],
      kv: [],
      objects: [],
      queues: [],
    };

    const inputFile = join(tempDir, "backup-overwrite.json");
    await Deno.writeTextFile(inputFile, JSON.stringify(backupData));

    let passedOverwriteKv: boolean | undefined = undefined;
    const mockService = createMockStateBackupService({
      importProject: (opts: ImportProjectOptions) => {
        passedOverwriteKv = opts.overwriteKv;
        return Promise.resolve({
          restoredRevisions: 0,
          restoredKvKeys: 1,
          restoredObjects: 0,
          restoredQueues: 0,
        });
      },
    });

    await importCommand({
      cwd: tempDir,
      inputFile,
      targetProject: "target-p",
      overwriteKv: true,
      stateBackupService: mockService,
    });

    assertEquals(passedOverwriteKv, true);
  },
});

Deno.test({
  name:
    "importCommand - AC6: rejects when inputFile does not exist with ResourceNotFoundError or ValidationFailedError",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const nonExistentFile = join(tempDir, "does-not-exist.json");
    const mockService = createMockStateBackupService();

    await assertRejects(
      () =>
        importCommand({
          cwd: tempDir,
          inputFile: nonExistentFile,
          targetProject: "target-p",
          stateBackupService: mockService,
        }),
    );
  },
});

Deno.test({
  name:
    "importCommand - AC6: uses project from railfog.toml when targetProject is omitted",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    await Deno.writeTextFile(
      join(tempDir, "railfog.toml"),
      `name = "toml-project"\n`,
    );

    const backupData: StateBackupArchive = {
      version: 1,
      backupId: "bak_01J8Z000000000000000000022",
      createdAt: Date.now(),
      project: { orgId: "org_src", projectId: "proj_src", name: "proj_src" },
      functions: [],
      kv: [],
      objects: [],
      queues: [],
    };

    const inputFile = join(tempDir, "backup-toml.json");
    await Deno.writeTextFile(inputFile, JSON.stringify(backupData));

    let resolvedTargetProject = "";
    const mockService = createMockStateBackupService({
      importProject: (opts: ImportProjectOptions) => {
        resolvedTargetProject = opts.targetProjectId;
        return Promise.resolve({
          restoredRevisions: 0,
          restoredKvKeys: 0,
          restoredObjects: 0,
          restoredQueues: 0,
        });
      },
    });

    await importCommand({
      cwd: tempDir,
      inputFile,
      stateBackupService: mockService,
    });

    assertEquals(resolvedTargetProject, "toml-project");
  },
});

// ============================================================================
// CLI Integration Tests: rail export and rail import via CLI invocation
// ============================================================================

Deno.test({
  name: "CLI state - rail export --help prints help information",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const result = await runCli(["export", "--help"], tempDir);
    assertEquals(result.code, 0);
    assertMatch(result.stdout, /export/i);
    assertMatch(result.stdout, /--out/i);
  },
});

Deno.test({
  name: "CLI state - rail import --help prints help information",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const result = await runCli(["import", "--help"], tempDir);
    assertEquals(result.code, 0);
    assertMatch(result.stdout, /import/i);
    assertMatch(result.stdout, /--in/i);
  },
});

Deno.test({
  name:
    "CLI state - rail import requires input file and exits non-zero if missing",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    await Deno.writeTextFile(
      join(tempDir, "railfog.toml"),
      `name = "cli-test"\n`,
    );

    const result = await runCli(["import"], tempDir);
    assertNotEquals(result.code, 0);
    assertMatch(result.stderr, /input|--in/i);
  },
});

Deno.test({
  name:
    "CLI state - rail import --dry-run validates archive without mutating state",
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const backupId = "bak_01J8Z000000000000000000010";
    const archivePath = join(tempDir, `${backupId}.json`);
    const archive: StateBackupArchive = {
      version: 1,
      backupId,
      createdAt: Date.now(),
      project: {
        orgId: "default",
        projectId: "import-dry-run",
        name: "import-dry-run",
      },
      functions: [],
      kv: [],
      objects: [],
      queues: [],
    };
    await Deno.writeTextFile(archivePath, JSON.stringify(archive));

    const result = await runCli(
      ["import", "--in", archivePath, "--dry-run"],
      tempDir,
    );
    assertEquals(result.code, 0);
    assertMatch(result.stdout, /\[DRY RUN\]/i);
    assertMatch(result.stdout, /Zero mutations applied/i);
  },
});
