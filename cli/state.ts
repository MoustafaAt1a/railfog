/**
 * CLI rail export and rail import command implementations (T-0411).
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

import { join, resolve } from "@std/path";
import { parse } from "@std/toml";
import type {
  ImportProjectResult,
  StateBackupService,
} from "../apps/api/state-backup-service.ts";
import {
  serializeBackupArchive,
  type StateBackupArchive,
  validateBackupArchive,
} from "../packages/core/backup/archive-schema.ts";
import {
  ConflictError,
  ResourceNotFoundError,
  ValidationFailedError,
} from "../packages/errors/mod.ts";
import { resolveAuthHeader } from "./auth-config.ts";
import { createTrackSpinner } from "./spinner.ts";
import { renderFreightExpressCard, renderStatusBar } from "./ui.ts";

export interface ExportCommandOptions {
  cwd?: string;
  outputFile?: string;
  project?: string;
  org?: string;
  controlPlaneUrl?: string;
  stateBackupService?: StateBackupService;
  token?: string;
}

export interface ImportCommandOptions {
  cwd?: string;
  inputFile: string;
  targetOrgId?: string;
  targetProject?: string;
  overwriteKv?: boolean;
  controlPlaneUrl?: string;
  stateBackupService?: StateBackupService;
  token?: string;
}

export const PRODUCTION_CONTROL_PLANE_URL =
  "https://railfog-control-production.up.railway.app";
export const DEFAULT_CONTROL_PLANE_URL = PRODUCTION_CONTROL_PLANE_URL;

/**
 * Exports a project's state into a portable disaster recovery archive JSON file.
 *
 * Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-18
 */
export async function exportCommand(
  options?: ExportCommandOptions,
): Promise<{
  backupId: string;
  outputFile: string;
  archive: StateBackupArchive;
}> {
  const cwd = resolve(options?.cwd ?? Deno.cwd());
  const tomlPath = join(cwd, "railfog.toml");

  let configuredName: string | undefined;
  let configuredOrg: string | undefined;

  try {
    const tomlContent = await Deno.readTextFile(tomlPath);
    const parsed = parse(tomlContent) as Record<string, unknown>;
    if (typeof parsed.name === "string" && parsed.name.trim() !== "") {
      configuredName = parsed.name.trim();
    }
    if (typeof parsed.org === "string" && parsed.org.trim() !== "") {
      configuredOrg = parsed.org.trim();
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }

  // spec: docs/contracts/platform.contract.md#PLAT-18 — Project name resolution
  const projectName = options?.project?.trim() || configuredName;
  if (!projectName) {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Project name must be defined in railfog.toml or via --project option",
    );
  }

  const orgId = options?.org?.trim() || configuredOrg || "default";

  let archive: StateBackupArchive;

  const spinner = (
      typeof Deno.stdout.isTerminal === "function" &&
      Deno.stdout.isTerminal() &&
      !Deno.env.get("CI") &&
      !Deno.env.get("NO_COLOR")
    )
    ? createTrackSpinner().start(
      `Exporting disaster recovery snapshot for '${projectName}'...`,
    )
    : null;

  try {
    if (options?.stateBackupService) {
      archive = await options.stateBackupService.exportProject({
        orgId,
        projectId: projectName,
      });
    } else {
      const rawUrl = options?.controlPlaneUrl ??
        Deno.env.get("RAILFOG_CONTROL_PLANE_URL") ??
        Deno.env.get("RAILFOG_CONTROL_URL") ??
        DEFAULT_CONTROL_PLANE_URL;
      const baseUrl = rawUrl.replace(/\/+$/, "");

      const url = new URL(`${baseUrl}/export`);
      url.searchParams.set("projectId", projectName);
      url.searchParams.set("project", projectName);
      url.searchParams.set("orgId", orgId);
      url.searchParams.set("org", orgId);
      const authHeaders = await resolveAuthHeader(options);

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: { "accept": "application/json", ...authHeaders },
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status === 400) {
          throw new ValidationFailedError(`VALIDATION_FAILED: ${text}`);
        }
        throw new Error(`Export failed: ${res.status} ${res.statusText}`);
      }

      archive = (await res.json()) as StateBackupArchive;
    }
  } finally {
    spinner?.stop();
  }

  const outputFile = options?.outputFile
    ? resolve(cwd, options.outputFile)
    : resolve(cwd, `${archive.backupId}.json`);

  await Deno.writeTextFile(outputFile, serializeBackupArchive(archive));

  const kvCount = archive.kv ? Object.keys(archive.kv).length : 0;
  const objCount = archive.objects ? Object.keys(archive.objects).length : 0;
  const queueCount = archive.queues ? Object.keys(archive.queues).length : 0;

  console.log(
    `Exported project '${projectName}' (Backup ID: ${archive.backupId}) to ${outputFile}`,
  );
  console.log();
  console.log(
    renderFreightExpressCard({
      mode: "export",
      projectName,
      backupId: archive.backupId,
      location: outputFile,
      stats: [
        ["• KV Keys:", `${kvCount} keys (Encrypted)`],
        ["• Objects:", `${objCount} objects (Encrypted)`],
        ["• Queues:", `${queueCount} in-flight (Drained)`],
      ],
    }),
  );
  console.log();
  console.log(
    renderStatusBar([
      { label: "Project", value: projectName },
      { label: "Backup ID", value: archive.backupId },
      { label: "Status", value: "Exported" },
    ]),
  );

  return {
    backupId: archive.backupId,
    outputFile,
    archive,
  };
}

/**
 * Imports and restores project state from a disaster recovery archive JSON file.
 *
 * Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-7
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12
 */
export async function importCommand(
  options: ImportCommandOptions,
): Promise<ImportProjectResult> {
  if (!options.inputFile || options.inputFile.trim() === "") {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Input file is required (--in <file>)",
    );
  }

  const cwd = resolve(options.cwd ?? Deno.cwd());
  const resolvedInputFile = resolve(cwd, options.inputFile);

  let fileContent: string;
  try {
    fileContent = await Deno.readTextFile(resolvedInputFile);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new ResourceNotFoundError(
        `RESOURCE_NOT_FOUND: Input file '${options.inputFile}' not found`,
      );
    }
    throw err;
  }

  let rawArchive: unknown;
  try {
    rawArchive = JSON.parse(fileContent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationFailedError(
      `VALIDATION_FAILED: Malformed JSON in backup file: ${msg}`,
    );
  }

  // spec: docs/contracts/platform.contract.md#PLAT-12 — Archive validation
  const archive = validateBackupArchive(rawArchive);

  let targetProject = options.targetProject?.trim();
  let targetOrgId = options.targetOrgId?.trim();

  if (!targetProject) {
    const tomlPath = join(cwd, "railfog.toml");
    try {
      const tomlContent = await Deno.readTextFile(tomlPath);
      const parsed = parse(tomlContent) as Record<string, unknown>;
      if (typeof parsed.name === "string" && parsed.name.trim() !== "") {
        targetProject = parsed.name.trim();
      }
      if (
        !targetOrgId && typeof parsed.org === "string" &&
        parsed.org.trim() !== ""
      ) {
        targetOrgId = parsed.org.trim();
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }
    }
  }

  if (!targetProject) {
    targetProject = archive.project.projectId;
  }
  if (!targetOrgId) {
    targetOrgId = archive.project.orgId || "default";
  }

  let result: ImportProjectResult;

  const spinner = (
      typeof Deno.stdout.isTerminal === "function" &&
      Deno.stdout.isTerminal() &&
      !Deno.env.get("CI") &&
      !Deno.env.get("NO_COLOR")
    )
    ? createTrackSpinner().start(
      `Importing state archive into '${targetProject}'...`,
    )
    : null;

  try {
    if (options.stateBackupService) {
      result = await options.stateBackupService.importProject({
        targetOrgId,
        targetProjectId: targetProject,
        archive,
        overwriteKv: options.overwriteKv,
      });
    } else {
      const rawUrl = options.controlPlaneUrl ??
        Deno.env.get("RAILFOG_CONTROL_PLANE_URL") ??
        Deno.env.get("RAILFOG_CONTROL_URL") ??
        DEFAULT_CONTROL_PLANE_URL;
      const baseUrl = rawUrl.replace(/\/+$/, "");
      const authHeaders = await resolveAuthHeader(options);

      const res = await fetch(`${baseUrl}/import`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({
          targetOrgId,
          targetProjectId: targetProject,
          archive,
          overwriteKv: options.overwriteKv,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status === 409) {
          throw new ConflictError(`CONFLICT: ${text}`);
        } else if (res.status === 400) {
          throw new ValidationFailedError(`VALIDATION_FAILED: ${text}`);
        }
        throw new Error(`Import failed: ${res.status} ${res.statusText}`);
      }

      result = (await res.json()) as ImportProjectResult;
    }
  } finally {
    spinner?.stop();
  }

  console.log(
    `Imported project '${targetProject}' (${result.restoredRevisions} revisions, ${result.restoredKvKeys} KV keys, ${result.restoredObjects} objects, ${result.restoredQueues} queues).`,
  );
  console.log();
  console.log(
    renderFreightExpressCard({
      mode: "restore",
      projectName: targetProject,
      stats: [
        ["• Revisions:", `${result.restoredRevisions} restored`],
        ["• KV Keys:", `${result.restoredKvKeys} restored`],
        ["• Objects:", `${result.restoredObjects} restored`],
        ["• Queues:", `${result.restoredQueues} restored`],
      ],
    }),
  );
  console.log();
  console.log(
    renderStatusBar([
      { label: "Project", value: targetProject },
      { label: "Revisions", value: String(result.restoredRevisions) },
      { label: "Status", value: "Restored" },
    ]),
  );

  return result;
}

export function printExportHelp(): void {
  console.log(`RailFog CLI - Export project state

Usage:
  rail export [options]

Options:
  --out <path>             Output backup archive JSON file path (default: <backup_id>.json)
  -p, --project <name>     Override project name declared in railfog.toml (alias: --name)
  --org <id>               Organization ID (default: default)
  -C, --dir <path>         Target project directory (alias: --project-dir, --cwd, default: current directory)
  --control-url <url>      Control Plane API URL (default: RAILFOG_CONTROL_PLANE_URL or https://railfog-control-production.up.railway.app)
  -h, --help               Show help for export command`);
}

export function printImportHelp(): void {
  console.log(`RailFog CLI - Import project state

Usage:
  rail import --in <file> [options]

Options:
  --in <path>              Input backup archive JSON file path (required)
  -p, --project <name>     Target project name (defaults to railfog.toml or archive, alias: --name)
  --org <id>               Target organization ID
  --overwrite-kv           Overwrite existing KV keys in target project
  -C, --dir <path>         Target project directory (alias: --project-dir, --cwd, default: current directory)
  --control-url <url>      Control Plane API URL (default: RAILFOG_CONTROL_PLANE_URL or https://railfog-control-production.up.railway.app)
  -h, --help               Show help for import command`);
}

