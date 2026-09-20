// spec: contracts/platform.contract.md#PLAT-3 — Deployment pipeline validation
// spec: contracts/platform.contract.md#PLAT-5 — Network policy allowlist + mandatory SSRF block
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & deploy-time permission scoping
// spec: contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm score = (literal * 2) + (wildcard * 1)
// spec: contracts/platform.contract.md#PLAT-12 — Machine-readable error codes (VALIDATION_FAILED)
// spec: contracts/platform.contract.md#PLAT-15 — Secrets management & valid identifier naming
// spec: contracts/platform.contract.md#PLAT-18 — Resource hierarchy (Organization -> Project -> Function)
// spec: contracts/kv.contract.md#KV-5 — Consistency tier compatibility (reject strong on eventual)
// spec: contracts/functions.contract.md#FN-2 — Trigger declarations (HTTP, Queue, Schedule)
// spec: contracts/functions.contract.md#FN-5 — Resource limits (CPU, memory, timeout ceilings)
// spec: tasks/milestone-0.5-developer-experience/T-0504-cli-config-validator.md

import { dirname, isAbsolute, join, normalize, relative } from "@std/path";
import { parse } from "@std/toml";

// spec: contracts/functions.contract.md#FN-5 — Resource limits ceilings
export const DEFAULT_MEMORY_MB = 128;
export const MAX_MEMORY_MB = 1024;
export const HTTP_TIMEOUT_MAX_MS = 30_000;
export const BACKGROUND_TIMEOUT_MAX_MS = 900_000;

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string; // PLAT-12 VALIDATION_FAILED, KV-5, FN-5, etc.
  path: string; // e.g., "functions.api.permissions.kv[0]"
  message: string;
}

export interface CheckResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  routeSummary?: Array<
    { pattern: string; functionName: string; score: number }
  >;
}

/**
 * Checks whether a network host / IP falls into forbidden SSRF ranges.
 *
 * @spec contracts/platform.contract.md#PLAT-5 — Mandatory-block IP ranges (link-local, cloud metadata, RFC1918, loopback)
 */
export function isSsrfBlockedIp(host: string): boolean {
  let clean = host.trim().toLowerCase();

  // Strip URL scheme if present (e.g. http://, https://, ws://, wss://, ftp://)
  clean = clean.replace(/^[a-z0-9+.-]+:\/\//i, "");

  // Strip URL path, query, fragment
  const pathIdx = clean.search(/[/?#]/);
  if (pathIdx !== -1) {
    clean = clean.slice(0, pathIdx);
  }

  // Strip userinfo (e.g. user:pass@host)
  const atIdx = clean.lastIndexOf("@");
  if (atIdx !== -1) {
    clean = clean.slice(atIdx + 1);
  }

  let hostname = clean;
  // Handle bracketed IPv6 with optional port, e.g. [::1]:8080 or [fd00:ec2::254]
  if (hostname.startsWith("[") && hostname.includes("]")) {
    hostname = hostname.slice(1, hostname.indexOf("]"));
  } else if (hostname.includes(":") && !hostname.includes("::")) {
    // IPv4 with port, e.g. 127.0.0.1:8080
    const parts = hostname.split(":");
    if (parts.length === 2) {
      hostname = parts[0];
    }
  }

  // Loopback (IPv4 & IPv6)
  if (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname === "::"
  ) {
    return true;
  }
  if (hostname.startsWith("127.")) {
    return true;
  }
  if (hostname.startsWith("0.")) {
    return true;
  }

  // Link-local / Cloud metadata (AWS / GCP / Azure)
  if (hostname.startsWith("169.254.")) {
    return true;
  }

  // RFC1918 Class A (10.0.0.0/8)
  if (hostname.startsWith("10.")) {
    return true;
  }

  // RFC1918 Class C (192.168.0.0/16)
  if (hostname.startsWith("192.168.")) {
    return true;
  }

  // RFC1918 Class B (172.16.0.0/12: 172.16.x.x - 172.31.x.x)
  const match172 = hostname.match(/^172\.(\d+)\./);
  if (match172) {
    const secondOctet = parseInt(match172[1], 10);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }

  // IPv6 Link-local (fe80::) and AWS / cloud metadata (fd00:ec2::)
  if (hostname.startsWith("fe80:") || hostname.startsWith("fd00:")) {
    return true;
  }

  return false;
}

/**
 * Calculates specificity score for a route pattern per PLAT-11:
 * score(route) = (literal_segments * 2) + (wildcard_or_named_segments * 1)
 *
 * @spec contracts/platform.contract.md#PLAT-11 — Route specificity algorithm
 */
function calculateRouteScore(pattern: string): number {
  const segments = pattern.split("/").filter((s) => s.length > 0);
  let score = 0;
  for (const seg of segments) {
    if (
      seg.includes("*") || seg.includes(":") || seg.includes("(") ||
      seg.includes("{")
    ) {
      score += 1;
    } else {
      score += 2;
    }
  }
  return score;
}

/**
 * Statically validates a railfog.toml configuration file and its declared resources.
 *
 * @spec contracts/platform.contract.md#PLAT-3 — Schema and entrypoint validation
 * @spec contracts/platform.contract.md#PLAT-11 — Route specificity and conflict analysis
 * @spec contracts/kv.contract.md#KV-5 — Consistency tier compatibility validation
 * @spec contracts/functions.contract.md#FN-5 — Resource limit ceilings
 */
export async function checkProject(configPath: string): Promise<CheckResult> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  let projectRoot: string;
  let configFile: string;

  try {
    const stat = await Deno.stat(configPath);
    if (stat.isDirectory) {
      projectRoot = configPath;
      configFile = join(configPath, "railfog.toml");
    } else {
      configFile = configPath;
      projectRoot = dirname(configPath);
    }
  } catch (_err) {
    // spec: contracts/platform.contract.md#PLAT-12 — Configuration file does not exist
    return {
      valid: false,
      errors: [{
        severity: "error",
        code: "VALIDATION_FAILED",
        path: "config",
        message: `Configuration file does not exist: ${configPath}`,
      }],
      warnings: [],
    };
  }

  let content: string;
  try {
    content = await Deno.readTextFile(configFile);
  } catch (_err) {
    return {
      valid: false,
      errors: [{
        severity: "error",
        code: "VALIDATION_FAILED",
        path: "config",
        message: `Configuration file does not exist: ${configFile}`,
      }],
      warnings: [],
    };
  }

  // spec: contracts/platform.contract.md#PLAT-12 — Parse TOML syntax
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(content) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [{
        severity: "error",
        code: "VALIDATION_FAILED",
        path: "config",
        message: `Failed to parse TOML configuration: ${message}`,
      }],
      warnings: [],
    };
  }

  // spec: contracts/platform.contract.md#PLAT-18 — Project resource name required
  if (typeof parsed.name !== "string" || parsed.name.trim() === "") {
    errors.push({
      severity: "error",
      code: "VALIDATION_FAILED",
      path: "name",
      message:
        "Project 'name' is required and must be a non-empty string (PLAT-18)",
    });
  }

  // spec: contracts/platform.contract.md#PLAT-3 — At least one function must be declared
  const functionsRaw = parsed.functions;
  const hasFunctions = typeof functionsRaw === "object" &&
    functionsRaw !== null &&
    !Array.isArray(functionsRaw) && Object.keys(functionsRaw).length > 0;

  if (!hasFunctions) {
    errors.push({
      severity: "error",
      code: "VALIDATION_FAILED",
      path: "functions",
      message:
        "Project must declare at least one function in 'functions' table (PLAT-3)",
    });
  }

  // spec: contracts/platform.contract.md#PLAT-3 — Routing table required
  const routesRaw = parsed.routes;
  if (!Array.isArray(routesRaw)) {
    errors.push({
      severity: "error",
      code: "VALIDATION_FAILED",
      path: "routes",
      message: "Project must declare 'routes' array (PLAT-3)",
    });
  }

  const declaredFnNames = hasFunctions
    ? Object.keys(functionsRaw as Record<string, unknown>)
    : [];

  // spec: contracts/kv.contract.md#KV-5 — Consistency tier compatibility validation
  if (typeof parsed.kv === "object" && parsed.kv !== null) {
    for (
      const [kvName, kvConfigRaw] of Object.entries(
        parsed.kv as Record<string, unknown>,
      )
    ) {
      if (typeof kvConfigRaw !== "object" || kvConfigRaw === null) continue;
      const kvConfig = kvConfigRaw as Record<string, unknown>;

      if (kvConfig.consistency !== undefined) {
        if (
          kvConfig.consistency !== "strong" &&
          kvConfig.consistency !== "eventual"
        ) {
          errors.push({
            severity: "error",
            code: "KV-5",
            path: `kv.${kvName}.consistency`,
            message:
              `Invalid consistency tier '${kvConfig.consistency}'. Allowed tiers: 'strong', 'eventual' (KV-5)`,
          });
        } else if (kvConfig.consistency === "strong") {
          const provider = typeof kvConfig.provider === "string"
            ? kvConfig.provider.toLowerCase().trim().replace(/[_\s]/g, "-")
            : "";
          const providerTier = typeof kvConfig.provider_tier === "string"
            ? kvConfig.provider_tier.toLowerCase().trim().replace(/[_\s]/g, "-")
            : "";
          if (
            provider === "cloudflare" ||
            provider === "workers-kv" ||
            provider === "cloudflare-kv" ||
            provider === "cf-kv" ||
            provider === "cf-workers-kv" ||
            provider === "eventual" ||
            providerTier === "eventual"
          ) {
            errors.push({
              severity: "error",
              code: "KV-5",
              path: `kv.${kvName}`,
              message:
                `Declared consistency tier 'strong' cannot be satisfied by provider tier 'eventual' (KV-5)`,
            });
          }
        }
      }
    }
  }

  // Validate declared functions
  if (hasFunctions) {
    for (
      const [fnName, fnConfigRaw] of Object.entries(
        functionsRaw as Record<string, unknown>,
      )
    ) {
      if (typeof fnConfigRaw !== "object" || fnConfigRaw === null) {
        errors.push({
          severity: "error",
          code: "VALIDATION_FAILED",
          path: `functions.${fnName}`,
          message:
            `Function '${fnName}' configuration must be a table (PLAT-3)`,
        });
        continue;
      }

      const fn = fnConfigRaw as Record<string, unknown>;

      // spec: contracts/platform.contract.md#PLAT-3, PLAT-6 — Entrypoint existence and traversal isolation
      if (typeof fn.entry !== "string" || fn.entry.trim() === "") {
        errors.push({
          severity: "error",
          code: "VALIDATION_FAILED",
          path: `functions.${fnName}.entry`,
          message:
            `Function '${fnName}' must declare an 'entry' file path (PLAT-3)`,
        });
      } else {
        const entry = fn.entry;
        const normRoot = normalize(projectRoot);
        const resolvedPath = normalize(
          isAbsolute(entry) ? entry : join(normRoot, entry),
        );
        const rel = relative(normRoot, resolvedPath);

        const isOutside = rel.startsWith("..") ||
          rel === ".." ||
          isAbsolute(rel) ||
          (!resolvedPath.startsWith(normRoot + "/") &&
            !resolvedPath.startsWith(normRoot + "\\") &&
            resolvedPath !== normRoot);

        if (isOutside) {
          errors.push({
            severity: "error",
            code: "VALIDATION_FAILED",
            path: `functions.${fnName}.entry`,
            message:
              `Entrypoint escapes project root directory: "${entry}" (PLAT-6)`,
          });
        } else {
          try {
            const stat = await Deno.stat(resolvedPath);
            if (!stat.isFile) {
              errors.push({
                severity: "error",
                code: "VALIDATION_FAILED",
                path: `functions.${fnName}.entry`,
                message: `Entrypoint file "${entry}" does not exist (PLAT-3)`,
              });
            }
          } catch (_err) {
            errors.push({
              severity: "error",
              code: "VALIDATION_FAILED",
              path: `functions.${fnName}.entry`,
              message: `Entrypoint file "${entry}" does not exist (PLAT-3)`,
            });
          }
        }
      }

      // spec: contracts/functions.contract.md#FN-5 — Resource limits
      const limitsObj = (typeof fn.limits === "object" && fn.limits !== null
        ? fn.limits
        : {}) as Record<string, unknown>;

      const memoryMb = limitsObj.memory_mb ?? fn.memory_mb;
      const timeoutMs = limitsObj.timeout_ms ?? fn.timeout_ms;
      const cpuMs = limitsObj.cpu_ms ?? fn.cpu_ms;
      const concurrency = limitsObj.concurrency ?? fn.concurrency;

      if (memoryMb !== undefined) {
        if (
          typeof memoryMb !== "number" || !Number.isFinite(memoryMb) ||
          memoryMb <= 0 || !Number.isInteger(memoryMb)
        ) {
          errors.push({
            severity: "error",
            code: "FN-5",
            path: `functions.${fnName}.limits.memory_mb`,
            message: `memory_mb must be a positive integer (FN-5)`,
          });
        } else if (memoryMb > MAX_MEMORY_MB) {
          errors.push({
            severity: "error",
            code: "FN-5",
            path: `functions.${fnName}.limits.memory_mb`,
            message:
              `memory_mb (${memoryMb}) exceeds maximum allowed ceiling of ${MAX_MEMORY_MB} MB (FN-5)`,
          });
        }
      }

      const triggers = typeof fn.triggers === "object" && fn.triggers !== null
        ? (fn.triggers as Record<string, unknown>)
        : undefined;
      const isBackground = Boolean(triggers?.queue || triggers?.schedule);

      if (timeoutMs !== undefined) {
        if (
          typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) ||
          timeoutMs <= 0
        ) {
          errors.push({
            severity: "error",
            code: "FN-5",
            path: `functions.${fnName}.limits.timeout_ms`,
            message: `timeout_ms must be a positive integer (FN-5)`,
          });
        } else if (isBackground && timeoutMs > BACKGROUND_TIMEOUT_MAX_MS) {
          errors.push({
            severity: "error",
            code: "FN-5",
            path: `functions.${fnName}.limits.timeout_ms`,
            message:
              `Background trigger timeout_ms (${timeoutMs}) exceeds maximum ceiling of ${BACKGROUND_TIMEOUT_MAX_MS} ms (15 minutes) (FN-5)`,
          });
        } else if (!isBackground && timeoutMs > HTTP_TIMEOUT_MAX_MS) {
          errors.push({
            severity: "error",
            code: "FN-5",
            path: `functions.${fnName}.limits.timeout_ms`,
            message:
              `HTTP trigger timeout_ms (${timeoutMs}) exceeds maximum ceiling of ${HTTP_TIMEOUT_MAX_MS} ms (30 seconds) (FN-5)`,
          });
        }
      }

      if (cpuMs !== undefined) {
        if (
          typeof cpuMs !== "number" || !Number.isFinite(cpuMs) || cpuMs <= 0
        ) {
          errors.push({
            severity: "error",
            code: "FN-5",
            path: `functions.${fnName}.limits.cpu_ms`,
            message: `cpu_ms must be a positive integer (FN-5)`,
          });
        }
      }

      if (concurrency !== undefined) {
        if (
          typeof concurrency !== "number" || !Number.isFinite(concurrency) ||
          concurrency <= 0 || !Number.isInteger(concurrency)
        ) {
          errors.push({
            severity: "error",
            code: "FN-5",
            path: `functions.${fnName}.limits.concurrency`,
            message: `concurrency must be a positive integer (FN-5)`,
          });
        }
      }

      // spec: contracts/functions.contract.md#FN-2 — Trigger declarations
      if (triggers) {
        if (triggers.schedule !== undefined) {
          if (typeof triggers.schedule !== "string") {
            errors.push({
              severity: "error",
              code: "FN-2",
              path: `functions.${fnName}.triggers.schedule`,
              message: `Schedule trigger must be a 5-field cron string (FN-2)`,
            });
          } else {
            const fields = triggers.schedule.trim().split(/\s+/);
            if (fields.length !== 5) {
              errors.push({
                severity: "error",
                code: "FN-2",
                path: `functions.${fnName}.triggers.schedule`,
                message:
                  `Cron schedule '${triggers.schedule}' must have exactly 5 fields (FN-2)`,
              });
            } else {
              const cronRegex = /^[\d\*\/\-,]+$/;
              if (
                !fields.every((f) =>
                  cronRegex.test(f)
                )
              ) {
                errors.push({
                  severity: "error",
                  code: "FN-2",
                  path: `functions.${fnName}.triggers.schedule`,
                  message:
                    `Invalid cron schedule syntax '${triggers.schedule}' (FN-2)`,
                });
              }
            }
          }
        }

        if (triggers.queue !== undefined) {
          if (
            typeof triggers.queue !== "string" || triggers.queue.trim() === ""
          ) {
            errors.push({
              severity: "error",
              code: "FN-2",
              path: `functions.${fnName}.triggers.queue`,
              message:
                `Queue trigger must be a non-empty string identifier (FN-2)`,
            });
          }
        }
      }

      // spec: contracts/platform.contract.md#PLAT-5, PLAT-6, PLAT-15 — Permissions
      const permissions =
        typeof fn.permissions === "object" && fn.permissions !== null
          ? (fn.permissions as Record<string, unknown>)
          : undefined;

      if (permissions) {
        // KV namespace scoping: exactly one declared namespace allowed (PLAT-6)
        if (permissions.kv !== undefined) {
          if (!Array.isArray(permissions.kv)) {
            errors.push({
              severity: "error",
              code: "PLAT-6",
              path: `functions.${fnName}.permissions.kv`,
              message: `KV permissions must be an array of strings (PLAT-6)`,
            });
          } else if (permissions.kv.length > 1) {
            errors.push({
              severity: "error",
              code: "PLAT-6",
              path: `functions.${fnName}.permissions.kv`,
              message:
                `Ambiguous scope: function cannot declare multiple KV namespaces (PLAT-6)`,
            });
          } else {
            for (let i = 0; i < permissions.kv.length; i++) {
              const k = permissions.kv[i];
              if (typeof k !== "string" || k.trim() === "") {
                errors.push({
                  severity: "error",
                  code: "PLAT-6",
                  path: `functions.${fnName}.permissions.kv[${i}]`,
                  message:
                    `KV permission entry must be a non-empty string identifier (PLAT-6)`,
                });
              }
            }
          }
        }

        // Objects bucket scoping: exactly one declared bucket allowed (PLAT-6)
        if (permissions.objects !== undefined) {
          if (!Array.isArray(permissions.objects)) {
            errors.push({
              severity: "error",
              code: "PLAT-6",
              path: `functions.${fnName}.permissions.objects`,
              message:
                `Objects permissions must be an array of strings (PLAT-6)`,
            });
          } else if (permissions.objects.length > 1) {
            errors.push({
              severity: "error",
              code: "PLAT-6",
              path: `functions.${fnName}.permissions.objects`,
              message:
                `Ambiguous scope: function cannot declare multiple Object stores (PLAT-6)`,
            });
          } else {
            for (let i = 0; i < permissions.objects.length; i++) {
              const o = permissions.objects[i];
              if (typeof o !== "string" || o.trim() === "") {
                errors.push({
                  severity: "error",
                  code: "PLAT-6",
                  path: `functions.${fnName}.permissions.objects[${i}]`,
                  message:
                    `Objects permission entry must be a non-empty string identifier (PLAT-6)`,
                });
              }
            }
          }
        }

        // Queues capability scoping: exactly one declared target queue allowed (PLAT-6, FN-4)
        if (permissions.queues !== undefined) {
          if (!Array.isArray(permissions.queues)) {
            errors.push({
              severity: "error",
              code: "PLAT-6",
              path: `functions.${fnName}.permissions.queues`,
              message:
                `Queues permissions must be an array of strings (PLAT-6)`,
            });
          } else if (permissions.queues.length > 1) {
            errors.push({
              severity: "error",
              code: "PLAT-6",
              path: `functions.${fnName}.permissions.queues`,
              message:
                `Ambiguous scope: function cannot declare multiple Queues (PLAT-6)`,
            });
          } else {
            for (let i = 0; i < permissions.queues.length; i++) {
              const q = permissions.queues[i];
              if (typeof q !== "string" || q.trim() === "") {
                errors.push({
                  severity: "error",
                  code: "PLAT-6",
                  path: `functions.${fnName}.permissions.queues[${i}]`,
                  message:
                    `Queue permission entry must be a non-empty string identifier (PLAT-6)`,
                });
              }
            }
          }
        }

        // Network permissions: SSRF block verification (PLAT-5)
        if (permissions.network !== undefined) {
          if (!Array.isArray(permissions.network)) {
            errors.push({
              severity: "error",
              code: "PLAT-5",
              path: `functions.${fnName}.permissions.network`,
              message:
                `Network permissions must be an array of hostnames or IP addresses (PLAT-5)`,
            });
          } else {
            for (let i = 0; i < permissions.network.length; i++) {
              const net = permissions.network[i];
              if (typeof net !== "string") {
                errors.push({
                  severity: "error",
                  code: "PLAT-5",
                  path: `functions.${fnName}.permissions.network[${i}]`,
                  message: `Network permission item must be a string`,
                });
              } else if (isSsrfBlockedIp(net)) {
                errors.push({
                  severity: "error",
                  code: "PLAT-5",
                  path: `functions.${fnName}.permissions.network[${i}]`,
                  message: `SSRF blocked IP address or range: ${net} (PLAT-5)`,
                });
              }
            }
          }
        }

        // Secrets permissions: valid C-style identifier verification (PLAT-15)
        if (permissions.secrets !== undefined) {
          if (!Array.isArray(permissions.secrets)) {
            errors.push({
              severity: "error",
              code: "PLAT-15",
              path: `functions.${fnName}.permissions.secrets`,
              message:
                `Secrets permissions must be an array of string identifiers (PLAT-15)`,
            });
          } else {
            const secretRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;
            for (let i = 0; i < permissions.secrets.length; i++) {
              const sec = permissions.secrets[i];
              if (typeof sec !== "string" || !secretRegex.test(sec)) {
                errors.push({
                  severity: "error",
                  code: "PLAT-15",
                  path: `functions.${fnName}.permissions.secrets[${i}]`,
                  message: `Invalid secret name identifier: '${sec}' (PLAT-15)`,
                });
              }
            }
          }
        }
      }
    }
  }

  // spec: contracts/platform.contract.md#PLAT-11 — Route evaluation & specificity analysis
  let routeSummary:
    | Array<{ pattern: string; functionName: string; score: number }>
    | undefined;

  if (Array.isArray(routesRaw)) {
    const validRoutes: Array<
      { pattern: string; functionName: string; score: number }
    > = [];
    const seenPatterns = new Set<string>();

    for (let i = 0; i < routesRaw.length; i++) {
      const route = routesRaw[i];
      if (typeof route !== "object" || route === null) {
        errors.push({
          severity: "error",
          code: "VALIDATION_FAILED",
          path: `routes[${i}]`,
          message: `Route at index ${i} must be a table (PLAT-3)`,
        });
        continue;
      }

      const r = route as Record<string, unknown>;

      if (typeof r.pattern !== "string" || r.pattern.trim() === "") {
        errors.push({
          severity: "error",
          code: "VALIDATION_FAILED",
          path: `routes[${i}].pattern`,
          message:
            `Route at index ${i} must have a non-empty 'pattern' (PLAT-3)`,
        });
      }

      if (typeof r.function !== "string" || r.function.trim() === "") {
        errors.push({
          severity: "error",
          code: "VALIDATION_FAILED",
          path: `routes[${i}].function`,
          message:
            `Route at index ${i} must declare a 'function' target (PLAT-3)`,
        });
      } else if (!declaredFnNames.includes(r.function)) {
        errors.push({
          severity: "error",
          code: "VALIDATION_FAILED",
          path: `routes[${i}].function`,
          message: `Route targets undeclared function "${r.function}" (PLAT-3)`,
        });
      }

      if (typeof r.pattern === "string" && typeof r.function === "string") {
        const score = calculateRouteScore(r.pattern);
        validRoutes.push({
          pattern: r.pattern,
          functionName: r.function,
          score,
        });

        // Warn on duplicate or shadowed route pattern (PLAT-11)
        if (seenPatterns.has(r.pattern)) {
          warnings.push({
            severity: "warning",
            code: "PLAT-11",
            path: `routes[${i}]`,
            message:
              `Duplicate or shadowed route pattern: "${r.pattern}" (PLAT-11)`,
          });
        } else {
          seenPatterns.add(r.pattern);
        }
      }
    }

    // Sort descending by specificity score; Array.prototype.sort is stable and preserves declaration order for ties
    validRoutes.sort((a, b) => b.score - a.score);
    routeSummary = validRoutes;
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    routeSummary,
  };
}

/**
 * Runs the configuration check CLI command, logging errors, warnings, and route summary.
 * Returns 0 if validation succeeds, 1 if validation fails.
 *
 * @spec contracts/platform.contract.md#PLAT-3
 * @spec contracts/platform.contract.md#PLAT-11
 */
export async function runCheck(
  configPath: string = Deno.cwd(),
): Promise<number> {
  const result = await checkProject(configPath);

  if (result.valid) {
    if (result.routeSummary && result.routeSummary.length > 0) {
      console.log("\nRoute Specificity Summary (PLAT-11):");
      console.log("  SCORE  ROUTE PATTERN                  FUNCTION");
      console.log("  -----  -----------------------------  --------");
      for (const r of result.routeSummary) {
        const scoreStr = String(r.score).padStart(5);
        const patternStr = r.pattern.padEnd(29);
        console.log(`  ${scoreStr}  ${patternStr}  ${r.functionName}`);
      }
    }

    if (result.warnings.length > 0) {
      console.log("\nWarnings:");
      for (const w of result.warnings) {
        console.warn(`  [WARN] [${w.code}] ${w.path}: ${w.message}`);
      }
    }

    console.log("\nConfiguration valid. Zero errors found.");
    return 0;
  } else {
    console.error("\nConfiguration validation failed:");
    for (const e of result.errors) {
      console.error(`  [ERROR] [${e.code}] ${e.path}: ${e.message}`);
    }

    if (result.warnings.length > 0) {
      console.log("\nWarnings:");
      for (const w of result.warnings) {
        console.warn(`  [WARN] [${w.code}] ${w.path}: ${w.message}`);
      }
    }

    return 1;
  }
}
