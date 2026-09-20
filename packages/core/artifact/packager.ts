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
 * Builds a packaged deployment artifact bundle and manifest from entrypoint and source code bytes.
 *
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-3 (Deployment pipeline & manifest shape)
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-4 (Content addressing)
 * Spec-anchor: docs/contracts/functions.contract.md FN-5 (Default resource limits)
 */
export async function packageFunctionArtifact(
  entrypoint: string,
  codeBytes: Uint8Array,
  options?: {
    permissions?: { kv?: string[]; objects?: string[]; queues?: string[] };
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
      ...(options?.permissions?.kv ? { kv: [...options.permissions.kv] } : {}),
      ...(options?.permissions?.objects
        ? { objects: [...options.permissions.objects] }
        : {}),
      ...(options?.permissions?.queues
        ? { queues: [...options.permissions.queues] }
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
