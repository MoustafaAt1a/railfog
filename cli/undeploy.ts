/**
 * CLI rail undeploy command implementation.
 *
 * Spec references:
 * - PLAT-18: Resource hierarchy (Project -> Function -> Revision)
 * - PLAT-12: Error model
 */

import { join, resolve } from "@std/path";
import { parse } from "@std/toml";
import type { DeploymentService } from "../apps/api/deployment-service.ts";
import {
  ResourceNotFoundError,
  ValidationFailedError,
} from "../packages/errors/mod.ts";
import { resolveAuthHeader } from "./auth-config.ts";
import { colors, glyphs } from "./ui.ts";

export interface UndeployCommandOptions {
  cwd?: string;
  controlPlaneUrl?: string;
  project?: string;
  deploymentService?: DeploymentService;
  token?: string;
}

export interface UndeployCommandResult {
  project: string;
  deleted: boolean;
}

interface RailfogToml {
  name?: string;
}

export const PRODUCTION_CONTROL_PLANE_URL =
  "https://railfog-control-production.up.railway.app";
export const DEFAULT_CONTROL_PLANE_URL = PRODUCTION_CONTROL_PLANE_URL;

export async function undeployCommand(
  options: UndeployCommandOptions,
): Promise<UndeployCommandResult> {
  const cwd = options.cwd ? resolve(options.cwd) : Deno.cwd();

  let projectName = options.project;
  if (!projectName) {
    const tomlPath = join(cwd, "railfog.toml");
    try {
      const text = await Deno.readTextFile(tomlPath);
      const parsed = parse(text) as RailfogToml;
      if (parsed.name) {
        projectName = parsed.name;
      }
    } catch {
      // Ignored if file doesn't exist
    }
  }

  if (!projectName) {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Project name must be defined in railfog.toml or via --project option",
    );
  }

  let deleted = false;

  if (options.deploymentService) {
    deleted = options.deploymentService.deleteProject(projectName);
  } else {
    const rawUrl = options.controlPlaneUrl ??
      Deno.env.get("RAILFOG_CONTROL_PLANE_URL") ??
      DEFAULT_CONTROL_PLANE_URL;
    const baseUrl = rawUrl.replace(/\/+$/, "");
    let authHeaders = {};
    try {
      authHeaders = await resolveAuthHeader(options);
    } catch {
      // ignore
    }

    const res = await fetch(
      `${baseUrl}/v1/projects/${encodeURIComponent(projectName)}/undeploy`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
      },
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404) {
        throw new ResourceNotFoundError(`RESOURCE_NOT_FOUND: ${text}`);
      }
      throw new Error(`Undeploy failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as {
      deleted: boolean;
    };
    deleted = json.deleted;
  }

  console.log(
    `\n${glyphs.success}  ${
      colors.bold(colors.emerald("Successfully undeployed"))
    } project '${colors.bold(projectName)}' from RailFog control plane.\n`,
  );

  return {
    project: projectName,
    deleted,
  };
}
