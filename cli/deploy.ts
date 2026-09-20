/**
 * CLI rail deploy command implementation with rich progress feedback.
 *
 * Spec references:
 * - PLAT-1: Control plane vs data plane (never executes customer code, treats artifact as opaque binary)
 * - PLAT-3: Deployment pipeline (validation, packaging, content-addressing, verification health gate)
 * - PLAT-6: Capability injection (deploy-time permission validation and path traversal isolation)
 * - PLAT-8: Artifact upload to Control Plane storage
 * - PLAT-14: ULID format for revision IDs
 * - PLAT-15: Secrets management (zero raw secrets in errors, traces, or console output)
 * - PLAT-18: Resource hierarchy (Project -> Function -> Revision)
 * - PLAT-19: CLI interactive step indicators, spinner animations, and CI non-interactive fallback
 * - PLAT-20: Out-of-scope banned patterns (no canary or gradual traffic splitting)
 * - OBJ-4: Content addressing & integrity (sha256 digest and SRI)
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
import { SecretRedactor } from "../packages/logging/secret-redactor.ts";
import { resolveAuthHeader } from "./auth-config.ts";
import { bold, createSpinner, dim, green } from "./spinner.ts";

export interface DeployProgressCallbacks {
  onStepStart?: (step: string) => void;
  onStepSuccess?: (step: string, detail?: string) => void;
  onStepFail?: (step: string, error: string) => void;
}

export interface DeployOptions {
  controlUrl?: string;
  projectPath?: string;
  token?: string;
  json?: boolean; // Machine-readable JSON output mode
  progress?: DeployProgressCallbacks;
  cwd?: string;
  controlPlaneUrl?: string;
  project?: string;
  deploymentService?: DeploymentService;
  skipHealthCheck?: boolean;
}

export interface DeploySummary {
  ok: boolean;
  revision: string;
  project: string;
  elapsedMs: number;
  runtimeUrl: string;
  functions: { name: string; route?: string }[];
}

export interface DeployCommandOptions {
  cwd?: string;
  controlPlaneUrl?: string;
  project?: string;
  deploymentService?: DeploymentService;
  token?: string;
  json?: boolean;
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

// Stage identifiers matching test contract regexes
const STEP_PACKAGING =
  "Packaging function sources and calculating SHA-256 hashes";
const STEP_VALIDATION = "Validating configuration and capability permissions";
const STEP_UPLOAD = "Uploading snapshot bundle to Control Plane";
const STEP_VERIFICATION = "Verifying deployment activation and health check";

/**
 * Safely reads an environment variable without throwing on restricted permissions.
 */
function safeEnvGet(key: string): string | undefined {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
}

/**
 * Redacts bound secret values, auth tokens, and sensitive patterns from error traces.
 * spec: docs/contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage in errors/traces
 */
function sanitizeError(
  err: unknown,
  knownSecrets: string[] = [],
): string {
  const redactor = new SecretRedactor();
  let msg = err instanceof Error ? err.message : String(err);

  // 1. Literal known secrets (options.token, declared secrets from env)
  const allSecrets = [...knownSecrets];
  try {
    const envVars = Deno.env.toObject();
    for (const [k, v] of Object.entries(envVars)) {
      if (
        /key|token|secret|pass|auth/i.test(k) &&
        typeof v === "string" &&
        v.length >= 4
      ) {
        allSecrets.push(v);
      }
    }
  } catch {
    // If environment reading is not permitted, skip
  }

  msg = redactor.redact(msg, allSecrets);

  // 2. Pattern-based auto-redaction (PLAT-15)
  msg = msg.replace(/\bAKIA[0-9A-Z_]{16,}\b/g, "[REDACTED]");
  msg = msg.replace(/\brf_tok_[0-9a-zA-Z_]+\b/g, "[REDACTED]");
  msg = msg.replace(/\brf_sec_[0-9a-zA-Z_]+\b/g, "[REDACTED]");
  msg = msg.replace(/\bsk_live_[0-9a-zA-Z_]+\b/g, "[REDACTED]");
  msg = msg.replace(/\bpostgres_secret_[0-9a-zA-Z_]+\b/g, "[REDACTED]");
  msg = msg.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Bearer [REDACTED]");
  msg = msg.replace(
    /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/g,
    "[REDACTED]",
  );

  return msg;
}

/**
 * Creates a sanitized Error instance preserving type and clean stack.
 * spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets suppressed in error objects
 */
function createSanitizedError(
  err: unknown,
  sanitizedMessage: string,
  knownSecrets: string[],
): Error {
  if (err instanceof ValidationFailedError) {
    return new ValidationFailedError(sanitizedMessage);
  }
  const result = new Error(sanitizedMessage);
  if (err instanceof Error && err.stack) {
    result.stack = sanitizeError(err.stack, knownSecrets);
  }
  return result;
}

/**
 * Prints the styled deployment summary card on terminal completion.
 * spec: docs/contracts/platform.contract.md#PLAT-18 — Project -> Function -> Revision summary
 * spec: docs/contracts/platform.contract.md#PLAT-19 — Completion card formatting
 */
function printSummaryCard(
  summary: DeploySummary,
  routes: Array<{ pattern?: string; function?: string }>,
): void {
  const durationStr = summary.elapsedMs < 1000
    ? `${summary.elapsedMs}ms`
    : `${(summary.elapsedMs / 1000).toFixed(2)}s`;

  console.log("");
  console.log(bold(green("Deployment complete!")));
  console.log("");
  console.log(`  ${bold("Project:")}   ${summary.project}`);
  console.log(`  ${bold("Revision:")}  ${summary.revision}`);
  console.log(`  ${bold("Duration:")}  ${durationStr}`);
  console.log(`  ${bold("Runtime:")}   ${summary.runtimeUrl}`);

  if (routes.length > 0) {
    console.log("");
    console.log(bold("Routes:"));
    for (const r of routes) {
      if (r.pattern && r.function) {
        console.log(`  ${r.pattern.padEnd(20)} ${dim("->")}  ${r.function}`);
      }
    }
  }
  console.log("");
}

/**
 * Executes the full RailFog deployment pipeline with rich progress indicators.
 *
 * Stages:
 * - Step 1: Packaging function sources and calculating SHA-256 hashes (OBJ-4).
 * - Step 2: Static validation of routes, schema, and capability permissions (PLAT-3, PLAT-6).
 * - Step 3: Uploading snapshot bundle to Control Plane (PLAT-1, PLAT-8).
 * - Step 4: Verifying deployment activation and health check (PLAT-3).
 *
 * spec: docs/contracts/platform.contract.md#PLAT-3 — Deployment pipeline
 * spec: docs/contracts/platform.contract.md#PLAT-15 — Zero secret leakage
 * spec: docs/contracts/platform.contract.md#PLAT-19 — Animated status spinners and CI fallback
 */
export async function runDeploy(
  options?: DeployOptions,
): Promise<DeploySummary> {
  const startTime = performance.now();
  const cwd = resolve(options?.projectPath ?? options?.cwd ?? Deno.cwd());
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

  // Collect secrets for PLAT-15 redaction across all lifecycle events
  const knownSecrets: string[] = [];
  if (options?.token) {
    knownSecrets.push(options.token);
  }

  for (const fnConfig of Object.values(parsed.functions)) {
    if (
      fnConfig?.permissions?.secrets &&
      Array.isArray(fnConfig.permissions.secrets)
    ) {
      for (const secretName of fnConfig.permissions.secrets) {
        if (typeof secretName === "string") {
          const val = safeEnvGet(secretName);
          if (val && val.length > 0) {
            knownSecrets.push(val);
          }
        }
      }
    }
  }

  const isJson = options?.json === true;
  const callbacks = options?.progress;

  // ---------------------------------------------------------------------------
  // Step 1: Packaging function sources and calculating SHA-256 hashes (OBJ-4)
  // ---------------------------------------------------------------------------
  callbacks?.onStepStart?.(STEP_PACKAGING);
  const step1Spinner = !isJson ? createSpinner() : null;
  step1Spinner?.start(STEP_PACKAGING);

  const packagedFunctions: Array<{
    name: string;
    artifact: PackagedArtifact;
    entry: string;
    codeBytes: Uint8Array;
  }> = [];

  try {
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

      // spec: docs/contracts/platform.contract.md#PLAT-6 — Strict permission schema type validation
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
          if (val !== undefined && !Array.isArray(val)) {
            throw new ValidationFailedError(
              `VALIDATION_FAILED: Permission '${key}' for function '${fnName}' must be an array of strings (PLAT-6)`,
            );
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
        codeBytes,
      });
    }

    step1Spinner?.succeed(STEP_PACKAGING);
    callbacks?.onStepSuccess?.(STEP_PACKAGING);
  } catch (err) {
    const sanitizedMsg = sanitizeError(err, knownSecrets);
    step1Spinner?.fail(sanitizedMsg);
    callbacks?.onStepFail?.(STEP_PACKAGING, sanitizedMsg);
    throw createSanitizedError(err, sanitizedMsg, knownSecrets);
  }

  // ---------------------------------------------------------------------------
  // Step 2: Static validation of routes, schema, and capability permissions (PLAT-3, PLAT-6)
  // ---------------------------------------------------------------------------
  callbacks?.onStepStart?.(STEP_VALIDATION);
  const step2Spinner = !isJson ? createSpinner() : null;
  step2Spinner?.start(STEP_VALIDATION);

  try {
    // spec: docs/contracts/platform.contract.md#PLAT-6 — Strict permission schema validation & ambiguous scope rejection
    for (const [fnName, fnConfig] of Object.entries(parsed.functions)) {
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
    }

    // spec: docs/contracts/platform.contract.md#PLAT-3 — Route schema validation
    if (parsed.routes !== undefined) {
      if (!Array.isArray(parsed.routes)) {
        throw new ValidationFailedError(
          "VALIDATION_FAILED: routes must be an array (PLAT-3)",
        );
      }
      for (const route of parsed.routes) {
        if (
          !route.pattern || typeof route.pattern !== "string" ||
          route.pattern.trim() === ""
        ) {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Route pattern cannot be empty (PLAT-3)",
          );
        }
        if (
          !route.function || typeof route.function !== "string" ||
          route.function.trim() === ""
        ) {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Route function cannot be empty (PLAT-3)",
          );
        }
        if (!parsed.functions[route.function]) {
          throw new ValidationFailedError(
            `VALIDATION_FAILED: Route '${route.pattern}' targets undefined function '${route.function}' (PLAT-3)`,
          );
        }
      }
    }

    // spec: docs/contracts/platform.contract.md#PLAT-15 — Scan source code for hardcoded secrets/credentials
    const textDecoder = new TextDecoder();
    for (const fn of packagedFunctions) {
      const codeText = textDecoder.decode(fn.codeBytes);
      if (/\bAKIA[0-9A-Z_]{16,}\b/.test(codeText)) {
        throw new ValidationFailedError(
          "VALIDATION_FAILED: Hardcoded secret pattern detected in source file (PLAT-15)",
        );
      }
    }

    // spec: docs/contracts/platform.contract.md#PLAT-3, PLAT-5, PLAT-6 — Pre-deploy diagnostics & security analyzer
    const analyzer = new DeployDiagnosticsAnalyzer();
    const preDeployReport = await analyzer.analyzeSource(cwd, parsed);

    if (!isJson) {
      for (const issue of preDeployReport.issues) {
        const sanitizedMsg = sanitizeError(issue.message, knownSecrets);
        if (issue.severity === "error") {
          console.error(
            `Diagnostic Error [${issue.category}]: ${sanitizedMsg}${
              issue.sourceFile ? ` (${issue.sourceFile})` : ""
            }`,
          );
        } else if (issue.severity === "warning") {
          console.warn(
            `Diagnostic Warning [${issue.category}]: ${sanitizedMsg}${
              issue.sourceFile ? ` (${issue.sourceFile})` : ""
            }`,
          );
        }
      }
    }

    if (!preDeployReport.passed) {
      const errorSummaries = preDeployReport.issues
        .filter((i) => i.severity === "error")
        .map((i) => sanitizeError(i.message, knownSecrets))
        .join("; ");
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Pre-deploy security diagnostics failed (PLAT-5, PLAT-6, PLAT-15): ${errorSummaries}`,
      );
    }

    if (preDeployReport.artifactDigest && !isJson) {
      console.log(
        `Artifact digest: ${preDeployReport.artifactDigest.sha256Hex}`,
      );
      console.log(`Integrity: ${preDeployReport.artifactDigest.integrity}`);
    }

    step2Spinner?.succeed(STEP_VALIDATION);
    callbacks?.onStepSuccess?.(STEP_VALIDATION);
  } catch (err) {
    const sanitizedMsg = sanitizeError(err, knownSecrets);
    step2Spinner?.fail(sanitizedMsg);
    callbacks?.onStepFail?.(STEP_VALIDATION, sanitizedMsg);
    throw createSanitizedError(err, sanitizedMsg, knownSecrets);
  }

  // ---------------------------------------------------------------------------
  // Step 3: Uploading snapshot bundle to Control Plane (PLAT-1, PLAT-8)
  // ---------------------------------------------------------------------------
  callbacks?.onStepStart?.(STEP_UPLOAD);
  const step3Spinner = !isJson ? createSpinner() : null;
  step3Spinner?.start(STEP_UPLOAD);

  let lastRevisionId = "";
  let lastState = "";
  const rawUrl = options?.controlUrl ??
    options?.controlPlaneUrl ??
    safeEnvGet("RAILFOG_CONTROL_PLANE_URL") ??
    safeEnvGet("RAILFOG_CONTROL_URL") ??
    DEFAULT_CONTROL_PLANE_URL;
  const baseUrl = rawUrl.replace(/\/+$/, "");

  let authHeaders: Record<string, string> = {};
  try {
    authHeaders = await resolveAuthHeader(options);
  } catch {
    if (options?.token) {
      authHeaders = { authorization: `Bearer ${options.token}` };
    }
  }

  try {
    if (options?.deploymentService) {
      for (const item of packagedFunctions) {
        const deployRes = await options.deploymentService.deploy(
          projectName,
          item.name,
          item.artifact,
        );
        if (deployRes.state === "Failed" || !deployRes.active) {
          throw new Error(
            `Deployment rejected for function '${item.name}': state is ${deployRes.state}`,
          );
        }
        lastRevisionId = deployRes.revisionId;
        lastState = deployRes.state;
      }
    } else {
      for (const item of packagedFunctions) {
        const res = await fetch(`${baseUrl}/deploy`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({
            project: projectName,
            functionName: item.name,
            artifact: item.artifact,
          }),
        });

        if (!res.ok) {
          let bodyText = "";
          try {
            bodyText = await res.text();
          } catch {
            // body read failure
          }
          let errorDetail = bodyText;
          try {
            const parsedJson = JSON.parse(bodyText);
            if (typeof parsedJson.error === "string") {
              errorDetail = parsedJson.error;
            }
          } catch {
            // non-JSON response body
          }
          throw new Error(
            `Deployment failed (${res.status}): ${
              errorDetail || res.statusText
            }`,
          );
        }

        const json = (await res.json()) as {
          revisionId: string;
          state: string;
        };
        lastRevisionId = json.revisionId;
        lastState = json.state;
      }
    }

    step3Spinner?.succeed(STEP_UPLOAD);
    callbacks?.onStepSuccess?.(STEP_UPLOAD);
  } catch (err) {
    const sanitizedMsg = sanitizeError(err, knownSecrets);
    step3Spinner?.fail(sanitizedMsg);
    callbacks?.onStepFail?.(STEP_UPLOAD, sanitizedMsg);
    throw createSanitizedError(err, sanitizedMsg, knownSecrets);
  }

  // ---------------------------------------------------------------------------
  // Step 4: Verifying deployment activation and health check (PLAT-3)
  // ---------------------------------------------------------------------------
  callbacks?.onStepStart?.(STEP_VERIFICATION);
  const step4Spinner = !isJson ? createSpinner() : null;
  step4Spinner?.start(STEP_VERIFICATION);

  try {
    if (options?.deploymentService) {
      if (lastState !== "Deployed") {
        throw new Error(
          `Deployment verification failed: Revision state is ${lastState}`,
        );
      }
    } else if (!options?.skipHealthCheck) {
      let healthRes: Response;
      try {
        healthRes = await fetch(`${baseUrl}/healthz`, {
          method: "GET",
          headers: { ...authHeaders },
        });
      } catch (err) {
        throw new Error(
          `Health check verification failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      if (!healthRes.ok) {
        let bodyText = "";
        try {
          bodyText = await healthRes.text();
        } catch {
          // body read failure
        }
        let reason = bodyText;
        try {
          const parsed = JSON.parse(bodyText);
          if (parsed && typeof parsed.reason === "string") {
            reason = parsed.reason;
          } else if (parsed && typeof parsed.status === "string") {
            reason = parsed.status;
          }
        } catch {
          // non-JSON health check response
        }
        throw new Error(
          `Health check verification failed (${healthRes.status}): ${
            reason || healthRes.statusText
          }`,
        );
      }
    } else {
      if (lastState !== "Deployed") {
        throw new Error(
          `Deployment verification failed: Revision state is ${lastState}`,
        );
      }
    }

    step4Spinner?.succeed(STEP_VERIFICATION);
    callbacks?.onStepSuccess?.(STEP_VERIFICATION);
  } catch (err) {
    const sanitizedMsg = sanitizeError(err, knownSecrets);
    step4Spinner?.fail(sanitizedMsg);
    callbacks?.onStepFail?.(STEP_VERIFICATION, sanitizedMsg);
    throw createSanitizedError(err, sanitizedMsg, knownSecrets);
  }

  // Final summary construction
  const elapsedMs = Math.max(1, Math.round(performance.now() - startTime));
  const runtimeUrl = baseUrl;

  const routes = parsed.routes ?? [];
  const summaryFunctions: Array<{ name: string; route?: string }> = [];
  for (const fnName of Object.keys(parsed.functions)) {
    const matchedRoute = routes.find((r) => r.function === fnName);
    summaryFunctions.push({
      name: fnName,
      route: matchedRoute?.pattern,
    });
  }

  const summary: DeploySummary = {
    ok: true,
    revision: lastRevisionId,
    project: projectName,
    elapsedMs,
    runtimeUrl,
    functions: summaryFunctions,
  };

  if (isJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printSummaryCard(summary, routes);
  }

  return summary;
}

/**
 * Backward-compatible entrypoint for rail deploy command invocation.
 * spec: docs/contracts/platform.contract.md#PLAT-3
 */
export async function deployCommand(
  options?: DeployCommandOptions,
): Promise<DeployCommandResult> {
  const summary = await runDeploy({
    controlUrl: options?.controlPlaneUrl,
    projectPath: options?.cwd,
    project: options?.project,
    deploymentService: options?.deploymentService,
    token: options?.token,
    json: options?.json,
    skipHealthCheck: !options?.json && !options?.deploymentService,
  });

  return {
    revisionId: summary.revision,
    state: summary.ok ? "Deployed" : "Failed",
  };
}
