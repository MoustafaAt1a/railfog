// spec: contracts/platform.contract.md#PLAT-12 — Error model (VALIDATION_FAILED)
// spec: contracts/platform.contract.md#PLAT-18 — Resource hierarchy (Organization -> Project -> Function)
// spec: contracts/functions.contract.md#FN-5 — Resource limits (CPU, memory, timeout ceilings)
// spec: tasks/milestone-0.7-repo-consolidation/T-0702-configuration-package-extraction.md

import { parse } from "@std/toml";
import type {
  ConfigDiagnostic,
  ConfigValidationResult,
  FunctionConfig,
  FunctionLimitsConfig,
  FunctionPermissionsConfig,
  FunctionTriggersConfig,
  ProjectConfig,
  RailFogConfig,
} from "./schema.ts";

// spec: contracts/functions.contract.md#FN-5 — Resource limits ceilings
const MAX_MEMORY_MB = 1024;
const MAX_TIMEOUT_MS = 900_000;

/**
 * Validates raw configuration data against the RailFog configuration schema.
 *
 * Implements PLAT-18 resource hierarchy checks and FN-5 limit ceiling enforcements,
 * reporting structured diagnostics with code VALIDATION_FAILED per PLAT-12.
 */
export function validateRailFogConfig(raw: unknown): ConfigValidationResult {
  const diagnostics: ConfigDiagnostic[] = [];

  if (typeof raw !== "object" || raw === null) {
    diagnostics.push({
      severity: "error",
      code: "VALIDATION_FAILED",
      path: "",
      message: "Configuration must be an object",
    });
    return { valid: false, diagnostics };
  }

  const rawObj = raw as Record<string, unknown>;

  // Validate Project configuration (PLAT-18: Organization -> Project)
  let projectConfig: ProjectConfig | undefined;
  if (typeof rawObj.project !== "object" || rawObj.project === null) {
    diagnostics.push({
      severity: "error",
      code: "VALIDATION_FAILED",
      path: "project",
      message: "Missing project configuration table",
    });
    diagnostics.push({
      severity: "error",
      code: "VALIDATION_FAILED",
      path: "project.id",
      message: "Missing required property project.id",
    });
    diagnostics.push({
      severity: "error",
      code: "VALIDATION_FAILED",
      path: "project.orgId",
      message: "Missing required property project.orgId",
    });
  } else {
    const rawProject = rawObj.project as Record<string, unknown>;
    const id =
      typeof rawProject.id === "string" && rawProject.id.trim().length > 0
        ? rawProject.id.trim()
        : typeof rawProject.name === "string" &&
            rawProject.name.trim().length > 0
        ? rawProject.name.trim()
        : undefined;

    const orgId =
      typeof rawProject.orgId === "string" && rawProject.orgId.trim().length > 0
        ? rawProject.orgId.trim()
        : typeof rawProject.org_id === "string" &&
            rawProject.org_id.trim().length > 0
        ? rawProject.org_id.trim()
        : undefined;

    if (!id) {
      diagnostics.push({
        severity: "error",
        code: "VALIDATION_FAILED",
        path: "project.id",
        message: "Missing required property project.id",
      });
    }

    if (!orgId) {
      diagnostics.push({
        severity: "error",
        code: "VALIDATION_FAILED",
        path: "project.orgId",
        message: "Missing required property project.orgId",
      });
    }

    if (id && orgId) {
      projectConfig = {
        id,
        orgId,
        name: typeof rawProject.name === "string" ? rawProject.name : undefined,
      };
    }
  }

  // Validate Functions configuration (PLAT-18: Project -> Function)
  const functionsConfig: Record<string, FunctionConfig> = {};
  if (typeof rawObj.functions !== "object" || rawObj.functions === null) {
    diagnostics.push({
      severity: "error",
      code: "VALIDATION_FAILED",
      path: "functions",
      message: "Missing functions definition table",
    });
  } else {
    const rawFunctions = rawObj.functions as Record<string, unknown>;
    const functionEntries = Object.entries(rawFunctions);

    if (functionEntries.length === 0) {
      diagnostics.push({
        severity: "error",
        code: "VALIDATION_FAILED",
        path: "functions",
        message: "At least one function must be declared",
      });
    }

    for (const [fnName, rawFn] of functionEntries) {
      if (typeof rawFn !== "object" || rawFn === null) {
        diagnostics.push({
          severity: "error",
          code: "VALIDATION_FAILED",
          path: `functions.${fnName}`,
          message: `Function ${fnName} configuration must be an object`,
        });
        continue;
      }

      const rawFnObj = rawFn as Record<string, unknown>;
      const entrypoint = typeof rawFnObj.entrypoint === "string" &&
          rawFnObj.entrypoint.trim().length > 0
        ? rawFnObj.entrypoint.trim()
        : typeof rawFnObj.entry === "string" &&
            rawFnObj.entry.trim().length > 0
        ? rawFnObj.entry.trim()
        : undefined;

      if (!entrypoint) {
        diagnostics.push({
          severity: "error",
          code: "VALIDATION_FAILED",
          path: `functions.${fnName}.entrypoint`,
          message:
            `Missing required property entrypoint for function ${fnName}`,
        });
      }

      // Limits validation (FN-5)
      let limitsConfig: FunctionLimitsConfig | undefined;
      if (typeof rawFnObj.limits === "object" && rawFnObj.limits !== null) {
        const rawLimits = rawFnObj.limits as Record<string, unknown>;
        const cpuMs = typeof rawLimits.cpuMs === "number"
          ? rawLimits.cpuMs
          : typeof rawLimits.cpu_ms === "number"
          ? rawLimits.cpu_ms
          : undefined;

        const timeoutMs = typeof rawLimits.timeoutMs === "number"
          ? rawLimits.timeoutMs
          : typeof rawLimits.timeout_ms === "number"
          ? rawLimits.timeout_ms
          : undefined;

        const memoryMb = typeof rawLimits.memoryMb === "number"
          ? rawLimits.memoryMb
          : typeof rawLimits.memory_mb === "number"
          ? rawLimits.memory_mb
          : undefined;

        const concurrency = typeof rawLimits.concurrency === "number"
          ? rawLimits.concurrency
          : undefined;

        if (cpuMs !== undefined && cpuMs <= 0) {
          diagnostics.push({
            severity: "error",
            code: "VALIDATION_FAILED",
            path: `functions.${fnName}.limits.cpuMs`,
            message: `cpuMs must be a positive number for function ${fnName}`,
          });
        }

        if (
          timeoutMs !== undefined &&
          (timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)
        ) {
          diagnostics.push({
            severity: "error",
            code: "VALIDATION_FAILED",
            path: `functions.${fnName}.limits.timeoutMs`,
            message:
              `timeoutMs must be between 1 and ${MAX_TIMEOUT_MS} ms for function ${fnName}`,
          });
        }

        if (
          memoryMb !== undefined && (memoryMb <= 0 || memoryMb > MAX_MEMORY_MB)
        ) {
          diagnostics.push({
            severity: "error",
            code: "VALIDATION_FAILED",
            path: `functions.${fnName}.limits.memoryMb`,
            message:
              `memoryMb must be between 1 and ${MAX_MEMORY_MB} MB for function ${fnName}`,
          });
        }

        if (concurrency !== undefined && concurrency <= 0) {
          diagnostics.push({
            severity: "error",
            code: "VALIDATION_FAILED",
            path: `functions.${fnName}.limits.concurrency`,
            message:
              `concurrency must be a positive number for function ${fnName}`,
          });
        }

        limitsConfig = {
          cpuMs,
          timeoutMs,
          memoryMb,
          concurrency,
        };
      }

      // Triggers validation
      let triggersConfig: FunctionTriggersConfig | undefined;
      if (typeof rawFnObj.triggers === "object" && rawFnObj.triggers !== null) {
        const rawTriggers = rawFnObj.triggers as Record<string, unknown>;
        triggersConfig = {
          http: typeof rawTriggers.http === "string"
            ? rawTriggers.http
            : typeof rawTriggers.http === "boolean"
            ? String(rawTriggers.http)
            : undefined,
          queue: typeof rawTriggers.queue === "string"
            ? rawTriggers.queue
            : undefined,
          schedule: typeof rawTriggers.schedule === "string"
            ? rawTriggers.schedule
            : undefined,
          webhook: typeof rawTriggers.webhook === "string"
            ? rawTriggers.webhook
            : typeof rawTriggers.webhook === "boolean"
            ? String(rawTriggers.webhook)
            : undefined,
        };
      }

      // Permissions validation (PLAT-6, PLAT-15)
      let permissionsConfig: FunctionPermissionsConfig | undefined;
      if (
        typeof rawFnObj.permissions === "object" &&
        rawFnObj.permissions !== null
      ) {
        const rawPerms = rawFnObj.permissions as Record<string, unknown>;
        permissionsConfig = {
          kv: Array.isArray(rawPerms.kv)
            ? rawPerms.kv.filter((item): item is string =>
              typeof item === "string"
            )
            : undefined,
          objects: Array.isArray(rawPerms.objects)
            ? rawPerms.objects.filter((item): item is string =>
              typeof item === "string"
            )
            : undefined,
          queues: Array.isArray(rawPerms.queues)
            ? rawPerms.queues.filter((item): item is string =>
              typeof item === "string"
            )
            : undefined,
          network: Array.isArray(rawPerms.network)
            ? rawPerms.network.filter((item): item is string =>
              typeof item === "string"
            )
            : undefined,
          secrets: Array.isArray(rawPerms.secrets)
            ? rawPerms.secrets.filter((item): item is string =>
              typeof item === "string"
            )
            : undefined,
        };
      }

      if (entrypoint) {
        functionsConfig[fnName] = {
          entrypoint,
          limits: limitsConfig,
          triggers: triggersConfig,
          permissions: permissionsConfig,
        };
      }
    }
  }

  // Validate KV resource configuration (KV-5)
  let kvConfig:
    | Record<string, { consistency?: "strong" | "eventual" }>
    | undefined;
  if (typeof rawObj.kv === "object" && rawObj.kv !== null) {
    kvConfig = {};
    for (
      const [kvName, rawKv] of Object.entries(
        rawObj.kv as Record<string, unknown>,
      )
    ) {
      if (typeof rawKv === "object" && rawKv !== null) {
        const rawKvObj = rawKv as Record<string, unknown>;
        const consistency = rawKvObj.consistency;
        if (
          consistency !== undefined && consistency !== "strong" &&
          consistency !== "eventual"
        ) {
          diagnostics.push({
            severity: "error",
            code: "VALIDATION_FAILED",
            path: `kv.${kvName}.consistency`,
            message:
              `consistency must be 'strong' or 'eventual' for kv namespace ${kvName}`,
          });
        }
        kvConfig[kvName] = {
          consistency: consistency === "strong" || consistency === "eventual"
            ? consistency
            : undefined,
        };
      }
    }
  }

  // Validate Objects resource configuration
  let objectsConfig: Record<string, { public?: boolean }> | undefined;
  if (typeof rawObj.objects === "object" && rawObj.objects !== null) {
    objectsConfig = {};
    for (
      const [objName, rawStore] of Object.entries(
        rawObj.objects as Record<string, unknown>,
      )
    ) {
      if (typeof rawStore === "object" && rawStore !== null) {
        const rawStoreObj = rawStore as Record<string, unknown>;
        objectsConfig[objName] = {
          public: typeof rawStoreObj.public === "boolean"
            ? rawStoreObj.public
            : undefined,
        };
      }
    }
  }

  // Validate Queues resource configuration
  let queuesConfig:
    | Record<string, { maxDeliveryAttempts?: number; retryBackoffMs?: number }>
    | undefined;
  if (typeof rawObj.queues === "object" && rawObj.queues !== null) {
    queuesConfig = {};
    for (
      const [qName, rawQ] of Object.entries(
        rawObj.queues as Record<string, unknown>,
      )
    ) {
      if (typeof rawQ === "object" && rawQ !== null) {
        const rawQObj = rawQ as Record<string, unknown>;
        const maxDeliveryAttempts =
          typeof rawQObj.maxDeliveryAttempts === "number"
            ? rawQObj.maxDeliveryAttempts
            : typeof rawQObj.max_receives === "number"
            ? rawQObj.max_receives
            : undefined;

        const retryBackoffMs = typeof rawQObj.retryBackoffMs === "number"
          ? rawQObj.retryBackoffMs
          : typeof rawQObj.retry_backoff_ms === "number"
          ? rawQObj.retry_backoff_ms
          : undefined;

        queuesConfig[qName] = {
          maxDeliveryAttempts,
          retryBackoffMs,
        };
      }
    }
  }

  const valid = diagnostics.filter((d) => d.severity === "error").length === 0;

  if (valid && projectConfig) {
    const config: RailFogConfig = {
      project: projectConfig,
      functions: functionsConfig,
      kv: kvConfig,
      objects: objectsConfig,
      queues: queuesConfig,
    };
    return { valid: true, config, diagnostics };
  }

  return { valid: false, diagnostics };
}

/**
 * Parses raw TOML text into a validated RailFogConfig object.
 *
 * Implements PLAT-12 error reporting on syntax failure.
 */
export function parseRailFogConfig(
  tomlContent: string,
): ConfigValidationResult {
  try {
    const raw = parse(tomlContent);
    return validateRailFogConfig(raw);
  } catch (err) {
    return {
      valid: false,
      diagnostics: [
        {
          severity: "error",
          code: "VALIDATION_FAILED",
          path: "toml",
          message: `Invalid TOML syntax: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
    };
  }
}
