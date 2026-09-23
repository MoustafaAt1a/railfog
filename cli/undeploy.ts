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
import { colors, glyphs, renderCard, renderStatusBar } from "./ui.ts";

export interface UndeployCommandOptions {
  cwd?: string;
  controlPlaneUrl?: string;
  project?: string;
  deploymentService?: DeploymentService;
  token?: string;
  force?: boolean;
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

export function printUndeployHelp(): void {
  console.log(`RailFog CLI - Safely undeploy and remove a project

Usage:
  rail undeploy [options]

Options:
  -p, --project <name>     Target project name (defaults to railfog.toml, alias: -n, --name)
  -C, --dir <path>         Target project directory (alias: --project-dir, --cwd, default: current directory)
  --control-url <url>      Control Plane API URL (alias: --control-plane-url)
  --token <key>            API key for authorization (alias: --api-key)
  -f, --force              Force undeployment without interactive confirmation
  -h, --help               Show help for undeploy command`);
}

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

  // Destructive-action gate: `--force` is the documented skip; interactive
  // runs must type the project name, and non-interactive runs without --force
  // are refused rather than silently destroying the project
  const isInteractive = typeof Deno.stdin.isTerminal === "function" &&
    Deno.stdin.isTerminal();
  if (!options.force) {
    if (!isInteractive) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: undeploy permanently deletes project '${projectName}'. Re-run with --force to confirm.`,
      );
    }
    console.log(
      colors.red(
        `This will permanently delete project '${projectName}' and all of its revisions.`,
      ),
    );
    console.log(
      `Type the project name to confirm (or press Enter to abort): `,
    );
    const line = await readStdinLine();
    const confirmation = line.trim();
    if (confirmation !== projectName) {
      console.log("Aborted — project left intact.");
      return {
        project: projectName,
        deleted: false,
      };
    }
  }

  let deleted = false;

  if (options.deploymentService) {
    deleted = options.deploymentService.deleteProject(projectName);
  } else {
    const rawUrl = options.controlPlaneUrl ??
      Deno.env.get("RAILFOG_CONTROL_PLANE_URL") ??
      Deno.env.get("RAILFOG_CONTROL_URL") ??
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

  console.log();
  console.log(
    renderCard("Project Undeployment Complete", [
      `${glyphs.success}  ${
        colors.bold("Successfully undeployed from RailFog Control Plane")
      }`,
      "",
      `   ${colors.dim("Project:")}     ${
        colors.accent(colors.bold(projectName))
      }`,
      `   ${colors.dim("Status:")}      ${colors.emerald("DELETED / PURGED")}`,
      `   ${colors.dim("Routing:")}     ${
        colors.slate("All routes decoupled")
      }`,
    ], { borderColor: colors.emerald }),
  );
  console.log();
  console.log(
    renderStatusBar([
      { label: "Project", value: projectName },
      { label: "Status", value: "Undeployed" },
    ]),
  );

  return {
    project: projectName,
    deleted,
  };
}

export const runUndeploy = undeployCommand;

async function readStdinLine(): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  const buf = new Uint8Array(1024);
  while (true) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    out += decoder.decode(buf.subarray(0, n));
    if (out.includes("\n")) break;
  }
  return out;
}
