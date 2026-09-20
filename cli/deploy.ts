/**
 * CLI rail deploy command implementation.
 *
 * Spec references:
 * - PLAT-3: Deployment pipeline (validation, packaging, content-addressing, atomic cutover)
 * - PLAT-6: Capability injection (deploy-time permission validation and path traversal isolation)
 * - PLAT-14: ULID format for revision IDs
 * - PLAT-18: Resource hierarchy (Project -> Function -> Revision)
 * - PLAT-20: Out-of-scope banned patterns (no canary or gradual traffic splitting)
 */

import { isAbsolute, join, relative, resolve } from "@std/path";
import { parse } from "@std/toml";
import type { DeploymentService } from "../apps/api/deployment-service.ts";
import {
  type PackagedArtifact,
  packageFunctionArtifact,
} from "../packages/core/artifact/packager.ts";
import { DeployDiagnosticsAnalyzer } from "../packages/core/diagnostics/deploy-analyzer.ts";
import { ValidationFailedError } from "../packages/errors/mod.ts";

export interface DeployCommandOptions {
  cwd?: string;
  controlPlaneUrl?: string;
  project?: string;
  deploymentService?: DeploymentService;
}

export interface DeployCommandResult {
  revisionId: string;
  state: string;
}

interface FunctionConfig {
  entry?: string;
  permissions?: {
    kv?: string[];
    objects?: string[];
    queues?: string[];
    network?: string[];
    secrets?: string[];
  };
  limits?: {
    cpu_ms?: number;
    timeout_ms?: number;
    memory_mb?: number;
  };
}

interface RailfogToml {
  name?: string;
  functions?: Record<string, FunctionConfig>;
  routes?: Array<{ pattern?: string; function?: string }>;
}

const DEFAULT_CONTROL_PLANE_URL = "http://localhost:8000";

// spec: docs/contracts/platform.contract.md#PLAT-3 — Deployment pipeline
// spec: docs/contracts/platform.contract.md#PLAT-6 — Deploy-time capability validation
// spec: docs/contracts/platform.contract.md#PLAT-18 — Project -> Function hierarchy
export async function deployCommand(
  options?: DeployCommandOptions,
): Promise<DeployCommandResult> {
  const cwd = resolve(options?.cwd ?? Deno.cwd());
  const tomlPath = join(cwd, "railfog.toml");

  let tomlContent: string;
  try {
    tomlContent = await Deno.readTextFile(tomlPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error("railfog.toml not found in current directory");
    }
    throw err;
  }

  let parsed: RailfogToml;
  try {
    parsed = parse(tomlContent) as unknown as RailfogToml;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationFailedError(
      `VALIDATION_FAILED: Invalid railfog.toml syntax: ${msg}`,
    );
  }

  // spec: docs/contracts/platform.contract.md#PLAT-3 — Schema validation
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.functions ||
    typeof parsed.functions !== "object" ||
    Object.keys(parsed.functions).length === 0
  ) {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: railfog.toml must define at least one function in [functions]",
    );
  }

  // spec: docs/contracts/platform.contract.md#PLAT-18 — Resolve project name
  const configuredName =
    typeof parsed.name === "string" && parsed.name.trim() !== ""
      ? parsed.name.trim()
      : undefined;
  const projectName = options?.project?.trim() || configuredName;
  if (!projectName) {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Project name must be defined in railfog.toml or via --project option",
    );
  }

  // spec: docs/contracts/platform.contract.md#PLAT-6 — Deploy-time capability & path validation
  const packagedFunctions: Array<{
    name: string;
    artifact: PackagedArtifact;
    entry: string;
  }> = [];

  for (const [fnName, fnConfig] of Object.entries(parsed.functions)) {
    if (!fnConfig || typeof fnConfig !== "object") {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Function configuration for '${fnName}' must be an object (PLAT-3)`,
      );
    }

    if (typeof fnConfig.entry !== "string" || fnConfig.entry.trim() === "") {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Entrypoint for function '${fnName}' cannot be empty`,
      );
    }

    // spec: docs/contracts/platform.contract.md#PLAT-6 — Lexical path traversal validation
    const resolvedEntry = resolve(cwd, fnConfig.entry);
    const rel = relative(cwd, resolvedEntry);
    if (rel.startsWith("..") || isAbsolute(rel) || rel === "") {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Entrypoint '${fnConfig.entry}' escapes project directory (PLAT-6)`,
      );
    }

    // spec: docs/contracts/platform.contract.md#PLAT-3, PLAT-6 — Canonical path verification and symlink isolation
    let realEntry: string;
    try {
      realEntry = await Deno.realPath(resolvedEntry);
      const stat = await Deno.stat(realEntry);
      if (!stat.isFile) {
        throw new Error();
      }
    } catch {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Entrypoint file '${fnConfig.entry}' does not exist (PLAT-3)`,
      );
    }

    const realCwd = await Deno.realPath(cwd);
    const relReal = relative(realCwd, realEntry);
    if (relReal.startsWith("..") || isAbsolute(relReal) || relReal === "") {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Entrypoint '${fnConfig.entry}' escapes project directory (PLAT-6)`,
      );
    }

    // spec: docs/contracts/platform.contract.md#PLAT-6 — Strict permission schema validation & ambiguous scope rejection
    if (fnConfig.permissions !== undefined) {
      if (
        typeof fnConfig.permissions !== "object" ||
        fnConfig.permissions === null ||
        Array.isArray(fnConfig.permissions)
      ) {
        throw new ValidationFailedError(
          `VALIDATION_FAILED: Permissions configuration for '${fnName}' must be an object (PLAT-6)`,
        );
      }

      for (const key of ["kv", "objects", "queues"] as const) {
        const val = (fnConfig.permissions as Record<string, unknown>)[key];
        if (val !== undefined) {
          if (!Array.isArray(val)) {
            throw new ValidationFailedError(
              `VALIDATION_FAILED: Permission '${key}' for function '${fnName}' must be an array of strings (PLAT-6)`,
            );
          }
          if (val.length > 1) {
            throw new ValidationFailedError(
              `VALIDATION_FAILED: Ambiguous scope: multiple ${
                key === "kv"
                  ? "KV namespaces"
                  : key === "objects"
                  ? "Objects buckets"
                  : "Queues"
              } declared for function '${fnName}' (ambiguous per PLAT-6)`,
            );
          }
          for (const item of val) {
            if (typeof item !== "string" || item.trim() === "") {
              throw new ValidationFailedError(
                `VALIDATION_FAILED: Permission '${key}' entries for function '${fnName}' must be non-empty strings (PLAT-6)`,
              );
            }
          }
        }
      }
    }

    // spec: docs/contracts/platform.contract.md#PLAT-3 — Explicit function packaging isolation
    const codeBytes = await Deno.readFile(realEntry);
    const artifact = await packageFunctionArtifact(
      fnConfig.entry,
      codeBytes,
      {
        permissions: fnConfig.permissions,
        limits: fnConfig.limits,
      },
    );

    packagedFunctions.push({
      name: fnName,
      artifact,
      entry: fnConfig.entry,
    });
  }

  // spec: docs/contracts/platform.contract.md#PLAT-3 — Pre-deploy diagnostics & validation
  // spec: docs/contracts/platform.contract.md#PLAT-5 — SSRF network scanning
  // spec: docs/contracts/platform.contract.md#PLAT-6, PLAT-15 — Secret audit
  // spec: docs/contracts/objects.contract.md#OBJ-4 — Content addressing & integrity
  const analyzer = new DeployDiagnosticsAnalyzer();
  const preDeployReport = await analyzer.analyzeSource(cwd, parsed);

  for (const issue of preDeployReport.issues) {
    if (issue.severity === "error") {
      console.error(
        `Diagnostic Error [${issue.category}]: ${issue.message}${
          issue.sourceFile ? ` (${issue.sourceFile})` : ""
        }`,
      );
    } else if (issue.severity === "warning") {
      console.warn(
        `Diagnostic Warning [${issue.category}]: ${issue.message}${
          issue.sourceFile ? ` (${issue.sourceFile})` : ""
        }`,
      );
    }
  }

  if (!preDeployReport.passed) {
    const errorSummaries = preDeployReport.issues
      .filter((i) => i.severity === "error")
      .map((i) => i.message)
      .join("; ");
    throw new ValidationFailedError(
      `VALIDATION_FAILED: Pre-deploy security diagnostics failed (PLAT-5, PLAT-6, PLAT-15): ${errorSummaries}`,
    );
  }

  if (preDeployReport.artifactDigest) {
    console.log(`Artifact digest: ${preDeployReport.artifactDigest.sha256Hex}`);
    console.log(`Integrity: ${preDeployReport.artifactDigest.integrity}`);
  }

  console.log(`Deploying project '${projectName}'...`);

  let lastResult: DeployCommandResult = { revisionId: "", state: "" };

  if (options?.deploymentService) {
    for (const item of packagedFunctions) {
      const deployRes = await options.deploymentService.deploy(
        projectName,
        item.name,
        item.artifact,
      );
      lastResult = {
        revisionId: deployRes.revisionId,
        state: deployRes.state,
      };
      console.log(
        `Deployed function '${item.name}' -> ${lastResult.revisionId} (${lastResult.state})`,
      );
    }
  } else {
    const rawUrl = options?.controlPlaneUrl ??
      Deno.env.get("RAILFOG_CONTROL_PLANE_URL") ??
      DEFAULT_CONTROL_PLANE_URL;
    const baseUrl = rawUrl.replace(/\/+$/, "");

    for (const item of packagedFunctions) {
      const res = await fetch(`${baseUrl}/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: projectName,
          functionName: item.name,
          artifact: item.artifact,
        }),
      });

      if (!res.ok) {
        throw new Error(`Deployment failed: ${res.status} ${res.statusText}`);
      }

      const json = (await res.json()) as { revisionId: string; state: string };
      lastResult = {
        revisionId: json.revisionId,
        state: json.state,
      };
      console.log(
        `Deployed function '${item.name}' -> ${lastResult.revisionId} (${lastResult.state})`,
      );
    }
  }

  console.log(`Revision: ${lastResult.revisionId}`);
  console.log(`State: ${lastResult.state}`);

  const routes = parsed.routes ?? [];
  if (routes.length > 0) {
    console.log("Routes:");
    for (const route of routes) {
      if (route.pattern && route.function) {
        console.log(`  ${route.pattern} -> ${route.function}`);
      }
    }
  }

  return lastResult;
}
