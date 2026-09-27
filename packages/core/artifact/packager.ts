/**
 * Deployment Artifact Packager
 *
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-3 (Deployment pipeline)
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-4 (Content addressing)
 * Spec-anchor: docs/contracts/functions.contract.md FN-5 (Resource limits)
 */

import { ValidationFailedError } from "../../errors/mod.ts";
import {
  computeArtifactId,
  computeIntegrity,
} from "../crypto/content-address.ts";

/**
 * Manifest definition per PLAT-3 deployment pipeline contract.
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-3
 */
export interface Manifest {
  runtime: "railfog-deno";
  runtimeVersion: string;
  entrypoint: string;
  integrity: string;
  permissions: {
    kv?: string[];
    objects?: string[];
    queues?: string[];
    // spec: docs/contracts/platform.contract.md#PLAT-6 — the [permissions]
    // declaration also covers secret names and network hosts; only names
    // travel (PLAT-15: values resolve at invocation time from the store)
    secrets?: string[];
    network?: string[];
  };
  limits: {
    cpu_ms: number;
    timeout_ms: number;
    memory_mb: number;
  };
  dependencies: {
    lockfile?: string;
  };
}

/**
 * Self-contained deployment artifact bundle.
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-3
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-4
 */
export interface PackagedArtifact {
  id: string; // sha256:... (OBJ-4)
  integrity: string; // sha256-... (OBJ-4)
  bytes: Uint8Array;
  manifest: Manifest;
}

/**
 * Permissions declaration options when packaging an artifact.
 * Supports canonical primitive names (kv, objects, queues) as well as
 * developer conceptual aliases (state, data, signal) per CONCEPT-2 and CONCEPT-6.
 */
export interface PackagePermissionsOptions {
  kv?: string[];
  state?: string[];
  objects?: string[];
  data?: string[];
  queues?: string[];
  signal?: string[];
  secrets?: string[];
  network?: string[];
}

function validatePermissionIdentifier(id: string, capability: string): void {
  if (!id || id.trim() === "") {
    throw new ValidationFailedError(
      `VALIDATION_FAILED: Invalid empty permission identifier for ${capability} (PLAT-6); permission identifiers must be non-empty strings`,
    );
  }
  if (
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    throw new ValidationFailedError(
      `VALIDATION_FAILED: Invalid permission identifier "${id}" for ${capability}: path traversal characters and null bytes are forbidden (PLAT-7)`,
    );
  }
}

/**
 * Builds a packaged deployment artifact bundle and manifest from entrypoint and source code bytes.
 *
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-3 (Deployment pipeline & manifest shape)
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-4 (Content addressing)
 * Spec-anchor: docs/contracts/functions.contract.md FN-5 (Default resource limits)
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-6 (Mutual exclusivity enforcement)
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-7 (Path traversal prevention)
 * Spec-anchor: docs/contracts/concepts.contract.md CONCEPT-2 & CONCEPT-6 (Conceptual aliases)
 */
export async function packageFunctionArtifact(
  entrypoint: string,
  codeBytes: Uint8Array,
  options?: {
    permissions?: PackagePermissionsOptions;
    limits?: { cpu_ms?: number; timeout_ms?: number; memory_mb?: number };
    lockfileBytes?: Uint8Array;
  },
): Promise<PackagedArtifact> {
  if (!entrypoint || entrypoint.trim() === "") {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Function entrypoint cannot be empty or whitespace",
    );
  }

  if (!codeBytes || codeBytes.byteLength === 0) {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Function code bytes cannot be empty",
    );
  }

  if (options?.limits) {
    if (options.limits.cpu_ms !== undefined && options.limits.cpu_ms <= 0) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: cpu_ms limit must be positive",
      );
    }
    if (
      options.limits.timeout_ms !== undefined && options.limits.timeout_ms <= 0
    ) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: timeout_ms limit must be positive",
      );
    }
    if (
      options.limits.memory_mb !== undefined && options.limits.memory_mb <= 0
    ) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: memory_mb limit must be positive",
      );
    }
  }

  // Spec: PLAT-6 Mutual exclusivity & alias normalization (CONCEPT-2, CONCEPT-6)
  let normalizedKv: string[] | undefined = undefined;
  let normalizedObjects: string[] | undefined = undefined;
  let normalizedQueues: string[] | undefined = undefined;

  if (options?.permissions) {
    const p = options.permissions;
    if (p.kv !== undefined && p.state !== undefined) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Cannot declare both 'kv' and 'state' permissions (PLAT-6 mutual exclusivity violation)",
      );
    }
    if (p.objects !== undefined && p.data !== undefined) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Cannot declare both 'objects' and 'data' permissions (PLAT-6 mutual exclusivity violation)",
      );
    }
    if (p.queues !== undefined && p.signal !== undefined) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Cannot declare both 'queues' and 'signal' permissions (PLAT-6 mutual exclusivity violation)",
      );
    }

    const rawKv = p.state ?? p.kv;
    if (rawKv) {
      for (const id of rawKv) {
        validatePermissionIdentifier(id, p.state ? "state" : "kv");
      }
      normalizedKv = [...rawKv];
    }

    const rawObjects = p.data ?? p.objects;
    if (rawObjects) {
      for (const id of rawObjects) {
        validatePermissionIdentifier(id, p.data ? "data" : "objects");
      }
      normalizedObjects = [...rawObjects];
    }

    const rawQueues = p.signal ?? p.queues;
    if (rawQueues) {
      for (const id of rawQueues) {
        validatePermissionIdentifier(id, p.signal ? "signal" : "queues");
      }
      normalizedQueues = [...rawQueues];
    }
  }

  // Spec: OBJ-4 content addressing calculation
  const id = await computeArtifactId(codeBytes);
  const integrity = await computeIntegrity(codeBytes);

  let lockfileIntegrity: string | undefined = undefined;
  if (options?.lockfileBytes) {
    if (options.lockfileBytes.byteLength === 0) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Lockfile bytes cannot be empty if provided",
      );
    }
    // Spec: PLAT-3 dependencies.lockfile = sha256 hash (SRI convention)
    lockfileIntegrity = await computeIntegrity(options.lockfileBytes);
  }

  // Spec: PLAT-3 manifest construction + FN-5 defaults
  const manifest: Manifest = {
    runtime: "railfog-deno",
    runtimeVersion: "1.0",
    entrypoint: entrypoint.trim(),
    integrity,
    permissions: {
      ...(normalizedKv ? { kv: normalizedKv } : {}),
      ...(normalizedObjects ? { objects: normalizedObjects } : {}),
      ...(normalizedQueues ? { queues: normalizedQueues } : {}),
      ...(options?.permissions?.secrets
        ? { secrets: [...options.permissions.secrets] }
        : {}),
      ...(options?.permissions?.network
        ? { network: [...options.permissions.network] }
        : {}),
    },
    limits: {
      cpu_ms: options?.limits?.cpu_ms ?? 200,
      timeout_ms: options?.limits?.timeout_ms ?? 30000,
      memory_mb: options?.limits?.memory_mb ?? 128,
    },
    dependencies: {
      ...(lockfileIntegrity ? { lockfile: lockfileIntegrity } : {}),
    },
  };

  return {
    id,
    integrity,
    bytes: codeBytes,
    manifest,
  };
}
