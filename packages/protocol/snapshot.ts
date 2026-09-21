/**
 * Immutable Routing and Function Snapshot Protocol
 *
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-1 (Control plane produces snapshots, data plane consumes fail-static)
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8 (Immutable, versioned snapshot of routes and active function metadata)
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12 (Validation error model)
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-14 (ULID identifier format: snap_{ULID})
 */

import type { RevisionRecord } from "../../apps/api/deployment-service.ts";
import { generateUlid } from "../core/id/ulid.ts";
import { ValidationFailedError } from "../errors/mod.ts";

// spec: contracts/platform.contract.md#PLAT-14 — ULID identifier prefix
const SNAPSHOT_ID_PREFIX = "snap_";
const SNAPSHOT_ID_REGEX = /^snap_[0-9A-HJKMNP-TV-Z]{26}$/;

// spec: contracts/platform.contract.md#PLAT-3 — Default resource limits
const DEFAULT_LIMIT_CPU_MS = 200;
const DEFAULT_LIMIT_TIMEOUT_MS = 30000;
const DEFAULT_LIMIT_MEMORY_MB = 128;

export interface FunctionSnapshot {
  functionName: string;
  revisionId: string;
  artifactId: string;
  permissions: {
    kv?: string[];
    objects?: string[];
    queues?: string[];
  };
  limits: {
    cpu_ms: number;
    timeout_ms: number;
    memory_mb: number;
    rate?: number;
    burst?: number;
  };
  auth?: "bearer" | "none";
  triggers?: {
    http?: string;
    queue?: string;
    schedule?: string;
    webhook?: string;
  };
}

export interface RoutingSnapshot {
  snapshotId: string; // snap_{ULID} (PLAT-14)
  version: number;
  routes: Array<{ pattern: string; function: string }>;
  functions: Record<string, FunctionSnapshot>;
  generatedAt: number;
  environment?: string;
  domains?: string[];
}

/**
 * Recursively freezes an object and its nested properties to guarantee immutability.
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (
      value !== null && typeof value === "object" && !Object.isFrozen(value)
    ) {
      deepFreeze(value);
    }
  }
  return obj;
}

/**
 * Validates that an arbitrary payload conforms to the RoutingSnapshot contract.
 * Deeply freezes and returns the validated snapshot.
 *
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-14
 */
export function validateRoutingSnapshot(data: unknown): RoutingSnapshot {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Snapshot payload must be a non-null object",
    );
  }

  const record = data as Record<string, unknown>;

  if (
    typeof record.snapshotId !== "string" ||
    !SNAPSHOT_ID_REGEX.test(record.snapshotId)
  ) {
    throw new ValidationFailedError(
      `VALIDATION_FAILED: Invalid snapshotId format: ${record.snapshotId} (PLAT-14)`,
    );
  }

  if (
    typeof record.version !== "number" ||
    !Number.isSafeInteger(record.version) ||
    record.version <= 0
  ) {
    throw new ValidationFailedError(
      `VALIDATION_FAILED: Snapshot version must be a positive safe integer: ${record.version}`,
    );
  }

  if (!Array.isArray(record.routes)) {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Snapshot routes must be an array",
    );
  }

  for (const route of record.routes) {
    if (
      typeof route !== "object" ||
      route === null ||
      typeof (route as Record<string, unknown>).pattern !== "string" ||
      typeof (route as Record<string, unknown>).function !== "string"
    ) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Each route must contain pattern and function strings",
      );
    }
  }

  if (
    typeof record.functions !== "object" ||
    record.functions === null ||
    Array.isArray(record.functions)
  ) {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Snapshot functions must be an object",
    );
  }

  for (const [fnKey, fnVal] of Object.entries(record.functions)) {
    if (typeof fnVal !== "object" || fnVal === null || Array.isArray(fnVal)) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Function ${fnKey} metadata must be an object`,
      );
    }
    const fnRecord = fnVal as Record<string, unknown>;

    if (
      typeof fnRecord.functionName !== "string" ||
      fnRecord.functionName.trim() === ""
    ) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Function ${fnKey} missing functionName`,
      );
    }

    if (
      typeof fnRecord.revisionId !== "string" ||
      fnRecord.revisionId.trim() === ""
    ) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Function ${fnKey} missing revisionId`,
      );
    }

    if (
      typeof fnRecord.artifactId !== "string" ||
      fnRecord.artifactId.trim() === ""
    ) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Function ${fnKey} missing artifactId`,
      );
    }

    if (
      typeof fnRecord.permissions !== "object" ||
      fnRecord.permissions === null ||
      Array.isArray(fnRecord.permissions)
    ) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Function ${fnKey} permissions must be an object`,
      );
    }

    const perms = fnRecord.permissions as Record<string, unknown>;
    if (
      perms.kv !== undefined &&
      (!Array.isArray(perms.kv) ||
        !perms.kv.every((item) => typeof item === "string"))
    ) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Function ${fnKey} permissions.kv must be an array of strings`,
      );
    }
    if (
      perms.objects !== undefined &&
      (!Array.isArray(perms.objects) ||
        !perms.objects.every((item) => typeof item === "string"))
    ) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Function ${fnKey} permissions.objects must be an array of strings`,
      );
    }
    if (
      perms.queues !== undefined &&
      (!Array.isArray(perms.queues) ||
        !perms.queues.every((item) => typeof item === "string"))
    ) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Function ${fnKey} permissions.queues must be an array of strings`,
      );
    }

    if (
      typeof fnRecord.limits !== "object" ||
      fnRecord.limits === null ||
      Array.isArray(fnRecord.limits)
    ) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Function ${fnKey} limits must be an object`,
      );
    }

    const limits = fnRecord.limits as Record<string, unknown>;
    if (
      typeof limits.cpu_ms !== "number" ||
      !Number.isFinite(limits.cpu_ms) ||
      typeof limits.timeout_ms !== "number" ||
      !Number.isFinite(limits.timeout_ms) ||
      typeof limits.memory_mb !== "number" ||
      !Number.isFinite(limits.memory_mb)
    ) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Function ${fnKey} limits must contain numeric cpu_ms, timeout_ms, memory_mb`,
      );
    }
  }

  if (
    typeof record.generatedAt !== "number" ||
    !Number.isFinite(record.generatedAt)
  ) {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Snapshot generatedAt must be a finite number",
    );
  }

  return deepFreeze(data as RoutingSnapshot);
}

/**
 * Snapshot distributor responsible for generating immutable RoutingSnapshots.
 *
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-1
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-14
 */
export class SnapshotDistributor {
  private currentVersion = 0;

  /**
   * Creates an immutable, versioned RoutingSnapshot from routes and active revisions.
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-14
   */
  createSnapshot(
    routes: Array<{ pattern: string; function: string }>,
    activeRevisions: Record<string, RevisionRecord>,
    metadata?: { environment?: string; domains?: string[] },
  ): RoutingSnapshot {
    this.currentVersion += 1;
    const snapshotId = `${SNAPSHOT_ID_PREFIX}${generateUlid()}`;
    const generatedAt = Date.now();

    // spec: contracts/platform.contract.md#PLAT-8 — Defensive copy of routes
    const clonedRoutes = routes.map((r) => ({
      pattern: r.pattern,
      function: r.function,
    }));

    // spec: contracts/platform.contract.md#PLAT-8 — Map active revisions into FunctionSnapshot records
    const functions: Record<string, FunctionSnapshot> = {};
    for (const [key, rev] of Object.entries(activeRevisions)) {
      const manifestPerms = rev.manifest?.permissions;
      const permissions: FunctionSnapshot["permissions"] = {};
      if (manifestPerms?.kv) {
        permissions.kv = [...manifestPerms.kv];
      }
      if (manifestPerms?.objects) {
        permissions.objects = [...manifestPerms.objects];
      }
      if (manifestPerms?.queues) {
        permissions.queues = [...manifestPerms.queues];
      }

      const manifestRec = rev.manifest as unknown as
        | Record<string, unknown>
        | undefined;
      const manifestLimits = rev.manifest?.limits as unknown as
        | Record<string, unknown>
        | undefined;
      const limits: FunctionSnapshot["limits"] = {
        cpu_ms: (manifestLimits?.cpu_ms as number) ?? DEFAULT_LIMIT_CPU_MS,
        timeout_ms: (manifestLimits?.timeout_ms as number) ??
          DEFAULT_LIMIT_TIMEOUT_MS,
        memory_mb: (manifestLimits?.memory_mb as number) ??
          DEFAULT_LIMIT_MEMORY_MB,
        rate: manifestLimits?.rate as number | undefined,
        burst: manifestLimits?.burst as number | undefined,
      };

      functions[key] = {
        functionName: rev.functionName,
        revisionId: rev.id,
        artifactId: rev.artifactId,
        permissions,
        limits,
        auth: manifestRec?.auth as FunctionSnapshot["auth"],
        triggers: manifestRec?.triggers as FunctionSnapshot["triggers"],
      };
    }

    const snapshot: RoutingSnapshot = {
      snapshotId,
      version: this.currentVersion,
      routes: clonedRoutes,
      functions,
      generatedAt,
      environment: metadata?.environment,
      domains: metadata?.domains ? [...metadata.domains] : undefined,
    };

    // spec: contracts/platform.contract.md#PLAT-8 — Guarantee immutability against data-plane tampering
    return deepFreeze(snapshot);
  }
}
