/**
 * CLI rail rollback command implementation.
 *
 * Spec references:
 * - PLAT-3: Deployment pipeline (validation, atomic cutover)
 * - PLAT-12: Error model (RESOURCE_NOT_FOUND, VALIDATION_FAILED)
 * - PLAT-18: Resource hierarchy (Project -> Function -> Revision)
 * - FN-3: Function lifecycle (pointer-flip rollback)
 */

import { join, resolve } from "@std/path";
import { parse } from "@std/toml";
import type { DeploymentService } from "../apps/api/deployment-service.ts";
import {
  ResourceNotFoundError,
  ValidationFailedError,
} from "../packages/errors/mod.ts";
import { resolveAuthHeader } from "./auth-config.ts";
import { colors, glyphs, renderCard, renderStatusBar } from "./ui.ts";

export interface RollbackCommandOptions {
  cwd?: string;
  controlPlaneUrl?: string;
  project?: string;
  functionName: string;
  targetRevisionId: string;
  deploymentService?: DeploymentService;
  token?: string;
}

export interface RollbackCommandResult {
  project: string;
  functionName: string;
  previousRevisionId: string;
  activeRevisionId: string;
}

interface RailfogToml {
  name?: string;
}

export const PRODUCTION_CONTROL_PLANE_URL =
  "https://railfog-control-production.up.railway.app";
export const DEFAULT_CONTROL_PLANE_URL = PRODUCTION_CONTROL_PLANE_URL;

export function printRollbackHelp(): void {
  console.log(`RailFog CLI - Rollback function revision

Usage:
  rail rollback <functionName> --to <revisionId> [options]

Arguments:
  <functionName>         Name of the function to rollback

Options:
  --to <revisionId>        The target revision ID to rollback to (required)
  -C, --dir <path>         Project directory (alias: --project-dir, --cwd, default: current directory)
  --control-url <url>      Control Plane API URL (alias: --control-plane-url)
  -p, --project <name>     Override project name declared in railfog.toml (alias: --name)
  -h, --help               Show help for rollback command`);
}

// spec: docs/contracts/platform.contract.md#PLAT-3 — Deployment pipeline (pointer-flip rollback)
// spec: docs/contracts/platform.contract.md#PLAT-12 — Error model
// spec: docs/contracts/platform.contract.md#PLAT-18 — Project -> Function hierarchy
// spec: docs/contracts/functions.contract.md#FN-3 — pointer-flip rollback
export async function rollbackCommand(
  options: RollbackCommandOptions,
): Promise<RollbackCommandResult> {
  if (!options.functionName || options.functionName.trim() === "") {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: functionName cannot be empty",
    );
  }

  if (!options.targetRevisionId || options.targetRevisionId.trim() === "") {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: targetRevisionId cannot be empty",
    );
  }

  const cwd = resolve(options.cwd ?? Deno.cwd());
  const tomlPath = join(cwd, "railfog.toml");

  let projectName = options.project?.trim();

  if (!projectName) {
    try {
      const tomlContent = await Deno.readTextFile(tomlPath);
      const parsed = parse(tomlContent) as unknown as RailfogToml;
      if (typeof parsed.name === "string" && parsed.name.trim() !== "") {
        projectName = parsed.name.trim();
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }
    }
  }

  if (!projectName) {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Project name must be defined in railfog.toml or via --project option",
    );
  }

  let previousRevisionId = "";
  let activeRevisionId = "";

  if (options.deploymentService) {
    const result = await options.deploymentService.rollback(
      projectName,
      options.functionName,
      options.targetRevisionId,
    );
    previousRevisionId = result.previousRevisionId;
    activeRevisionId = result.activeRevisionId;
  } else {
    const rawUrl = options.controlPlaneUrl ??
      Deno.env.get("RAILFOG_CONTROL_PLANE_URL") ??
      Deno.env.get("RAILFOG_CONTROL_URL") ??
      DEFAULT_CONTROL_PLANE_URL;
    const baseUrl = rawUrl.replace(/\/+$/, "");
    const authHeaders = await resolveAuthHeader(options);

    const res = await fetch(`${baseUrl}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        project: projectName,
        functionName: options.functionName,
        targetRevisionId: options.targetRevisionId,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404) {
        throw new ResourceNotFoundError(`RESOURCE_NOT_FOUND: ${text}`);
      } else if (res.status === 400) {
        throw new ValidationFailedError(`VALIDATION_FAILED: ${text}`);
      }
      throw new Error(`Rollback failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as {
      previousRevisionId: string;
      activeRevisionId: string;
    };
    previousRevisionId = json.previousRevisionId;
    activeRevisionId = json.activeRevisionId;
  }

  console.log();
  console.log(
    renderCard("Function Rollback Complete", [
      `${glyphs.success}  ${colors.bold("Pointer flipped successfully (Instant cutover)")}`,
      "",
      `   ${colors.dim("Project:")}     ${colors.accent(projectName)}`,
      `   ${colors.dim("Function:")}    ${colors.brand(options.functionName)}`,
      `   ${colors.dim("Active Rev:")}  ${
        colors.emerald(colors.bold(activeRevisionId))
      }`,
      `   ${colors.dim("Prior Rev:")}   ${colors.slate(previousRevisionId)}`,
    ], { borderColor: colors.emerald }),
  );
  console.log();
  console.log(
    renderStatusBar([
      { label: "Project", value: projectName },
      { label: "Function", value: options.functionName },
      { label: "Revision", value: activeRevisionId },
      { label: "Status", value: "Active" },
    ]),
  );

  return {
    project: projectName,
    functionName: options.functionName,
    previousRevisionId,
    activeRevisionId,
  };
}

export const runRollback = rollbackCommand;

