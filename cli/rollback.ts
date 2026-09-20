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

export interface RollbackCommandOptions {
  cwd?: string;
  controlPlaneUrl?: string;
  project?: string;
  functionName: string;
  targetRevisionId: string;
  deploymentService?: DeploymentService;
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

const DEFAULT_CONTROL_PLANE_URL = "http://localhost:8000";

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
      DEFAULT_CONTROL_PLANE_URL;
    const baseUrl = rawUrl.replace(/\/+$/, "");

    const res = await fetch(`${baseUrl}/rollback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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

  console.log(
    `Rolled back function '${options.functionName}' in project '${projectName}' to revision ${activeRevisionId}.`,
  );

  return {
    project: projectName,
    functionName: options.functionName,
    previousRevisionId,
    activeRevisionId,
  };
}
