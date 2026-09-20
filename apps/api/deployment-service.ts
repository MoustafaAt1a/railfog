/**
 * Control Plane Revision Deployment Pipeline
 *
 * Spec references:
 * - PLAT-1: Control plane vs data plane (never executes customer code, treats artifact as opaque binary)
 * - PLAT-3: Deployment pipeline (validation, content-addressed storage, health check gating, atomic cutover, instant rollback)
 * - PLAT-7: Multi-tenant data isolation
 * - PLAT-12: Error model (RESOURCE_NOT_FOUND, VALIDATION_FAILED)
 * - PLAT-14: ULID identifier format (monotonically sortable)
 * - PLAT-18: Resource hierarchy (Project -> Function -> Revision)
 * - FN-3: Function lifecycle (Created -> Building -> Ready -> Deployed / Failed, pointer-flip rollback)
 * - OBJ-4: Content addressing (artifacts/{artifact_id}, sha256 hex id, SRI integrity)
 */

import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import {
  executeHealthCheck,
  type HealthProbeOptions,
} from "./health-checker.ts";
import type {
  Manifest,
  PackagedArtifact,
} from "../../packages/core/artifact/packager.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";
import {
  ConflictError,
  ResourceNotFoundError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import {
  computeArtifactId,
  computeIntegrity,
} from "../../packages/core/crypto/content-address.ts";

/**
 * Revision lifecycle states per FN-3 contract.
 * Spec-anchor: docs/contracts/functions.contract.md#FN-3
 */
export type RevisionState =
  | "Created"
  | "Building"
  | "Ready"
  | "Deployed"
  | "Failed"
  | "Suspended";

/**
 * Revision record tracking metadata and state.
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-14 (ULID id)
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-18 (Project -> Function -> Revision)
 * Spec-anchor: docs/contracts/objects.contract.md#OBJ-4 (Content-addressed artifactId and integrity)
 */
export interface RevisionRecord {
  id: string; // rev_{ULID} (PLAT-14, PLAT-18)
  project: string;
  functionName: string;
  artifactId: string; // sha256:... (OBJ-4)
  integrity: string;
  state: RevisionState;
  createdAt: number;
  manifest: Manifest;
}

/**
 * Result returned upon deployment attempt.
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-3
 */
export interface DeploymentResult {
  revisionId: string;
  state: RevisionState;
  active: boolean;
}

// spec: contracts/objects.contract.md#OBJ-4 — Content addressing format: sha256:{64 hex chars}
const ARTIFACT_ID_REGEX = /^sha256:[0-9a-f]{64}$/;

// spec: contracts/platform.contract.md#PLAT-3 — 3 consecutive successes required before traffic cutover
const REQUIRED_HEALTHY_PROBES = 3;

// spec: contracts/platform.contract.md#PLAT-14 — ULID identifier format
// spec: contracts/platform.contract.md#PLAT-18 — Revision ID prefix rev_{ULID}
const REVISION_ID_PREFIX = "rev_";

// spec: contracts/objects.contract.md#OBJ-4 — Content-addressed artifact storage prefix
const ARTIFACT_STORAGE_PREFIX = "artifacts/";

/**
 * Control plane revision deployment pipeline service.
 * Manages revision lifecycle, health check gating, and atomic pointer cutovers.
 *
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-1 (Never executes customer code)
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-3 (Deployment pipeline & atomic cutover)
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-7 (Multi-tenant isolation)
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-18 (Resource hierarchy Project -> Function -> Revision)
 * Spec-anchor: docs/contracts/functions.contract.md#FN-3 (Lifecycle & instant pointer-flip rollback)
 */
export class DeploymentService {
  private readonly storage: ObjectProvider;

  // spec: contracts/platform.contract.md#PLAT-7 — Nested maps prevent delimiter collision attacks
  // spec: contracts/platform.contract.md#PLAT-18 — Project -> Function -> RevisionId -> RevisionRecord
  private readonly revisions = new Map<
    string,
    Map<string, Map<string, RevisionRecord>>
  >();

  // spec: contracts/platform.contract.md#PLAT-18 — Project -> Function -> ActiveRevisionId
  private readonly activePointers = new Map<string, Map<string, string>>();

  private lastTimestamp = 0;

  constructor(storage: ObjectProvider) {
    this.storage = storage;
  }

  /**
   * Monotonically advancing clock to ensure sequential ULIDs sort strictly by creation order.
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-14 (sort order = creation order)
   */
  private nextMonotonicTimestamp(): number {
    const now = Date.now();
    if (now <= this.lastTimestamp) {
      this.lastTimestamp += 1;
    } else {
      this.lastTimestamp = now;
    }
    return this.lastTimestamp;
  }

  /**
   * Safe active pointer getter without delimiter parsing.
   * Spec-anchor: contracts/platform.contract.md#PLAT-7
   * Spec-anchor: contracts/platform.contract.md#PLAT-18
   */
  private getActivePointer(
    project: string,
    functionName: string,
  ): string | null {
    return this.activePointers.get(project)?.get(functionName) ?? null;
  }

  /**
   * Safe active pointer setter without delimiter parsing.
   * Spec-anchor: contracts/platform.contract.md#PLAT-7
   * Spec-anchor: contracts/platform.contract.md#PLAT-18
   */
  private setActivePointer(
    project: string,
    functionName: string,
    revisionId: string,
  ): void {
    let fnMap = this.activePointers.get(project);
    if (!fnMap) {
      fnMap = new Map<string, string>();
      this.activePointers.set(project, fnMap);
    }
    fnMap.set(functionName, revisionId);
  }

  /**
   * Safe revision record persistence without delimiter parsing.
   * Spec-anchor: contracts/platform.contract.md#PLAT-7
   * Spec-anchor: contracts/platform.contract.md#PLAT-18
   */
  private saveRevisionRecord(
    project: string,
    functionName: string,
    revision: RevisionRecord,
  ): void {
    let fnMap = this.revisions.get(project);
    if (!fnMap) {
      fnMap = new Map<string, Map<string, RevisionRecord>>();
      this.revisions.set(project, fnMap);
    }
    let revMap = fnMap.get(functionName);
    if (!revMap) {
      revMap = new Map<string, RevisionRecord>();
      fnMap.set(functionName, revMap);
    }
    revMap.set(revision.id, { ...revision });
  }

  /**
   * Deploys a packaged artifact to a Function.
   * Stores the artifact in content-addressed storage, runs health check gating,
   * and atomically activates the new revision if healthy and not superseded.
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-1 (Never executes customer code)
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-3 (Deployment safety check & cutover)
   * Spec-anchor: docs/contracts/functions.contract.md#FN-3 (Created -> Building -> Ready -> Deployed/Failed)
   * Spec-anchor: docs/contracts/objects.contract.md#OBJ-4 (artifacts/{artifact_id}, integrity check)
   */
  async deploy(
    project: string,
    functionName: string,
    artifact: PackagedArtifact,
    healthCheck?: (() => Promise<boolean>) | HealthProbeOptions,
  ): Promise<DeploymentResult> {
    // spec: contracts/objects.contract.md#OBJ-4 — Validate artifact.id format to prevent path traversal
    if (!ARTIFACT_ID_REGEX.test(artifact.id)) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Invalid artifact ID format: ${artifact.id} (OBJ-4)`,
      );
    }

    // spec: contracts/objects.contract.md#OBJ-4 — Cryptographic verification of content address & integrity
    const computedId = await computeArtifactId(artifact.bytes);
    const computedIntegrity = await computeIntegrity(artifact.bytes);
    if (
      artifact.id !== computedId || artifact.integrity !== computedIntegrity
    ) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Artifact integrity or ID mismatch (OBJ-4)",
      );
    }

    // spec: contracts/platform.contract.md#PLAT-14 — Crockford Base32 26-char ULID
    // spec: contracts/platform.contract.md#PLAT-18 — Revision ID format rev_{ULID}
    const createdAt = this.nextMonotonicTimestamp();
    const ulid = generateUlid(() => createdAt);
    const revisionId = `${REVISION_ID_PREFIX}${ulid}`;

    // spec: contracts/functions.contract.md#FN-3 — Initial lifecycle state: Created
    const revision: RevisionRecord = {
      id: revisionId,
      project,
      functionName,
      artifactId: artifact.id,
      integrity: artifact.integrity,
      state: "Created",
      createdAt,
      manifest: artifact.manifest,
    };

    // spec: contracts/functions.contract.md#FN-3 — State transition: Created -> Building
    revision.state = "Building";

    // spec: contracts/platform.contract.md#PLAT-1 — Control plane treats artifact as passive opaque bytes
    // spec: contracts/objects.contract.md#OBJ-4 — Store content-addressed at artifacts/{artifact_id}
    const artifactStorageKey = `${ARTIFACT_STORAGE_PREFIX}${artifact.id}`;
    const artifactBuffer = artifact.bytes.byteOffset === 0 &&
        artifact.bytes.byteLength === artifact.bytes.buffer.byteLength
      ? artifact.bytes.buffer
      : artifact.bytes.buffer.slice(
        artifact.bytes.byteOffset,
        artifact.bytes.byteOffset + artifact.bytes.byteLength,
      );
    await this.storage.put(artifactStorageKey, artifactBuffer as ArrayBuffer);

    // spec: contracts/functions.contract.md#FN-3 — State transition: Building -> Ready
    revision.state = "Ready";

    // spec: contracts/platform.contract.md#PLAT-3 — Health check gate: 3 consecutive successes
    let healthy = true;
    if (
      healthCheck && typeof healthCheck === "object" &&
      "probeUrl" in healthCheck
    ) {
      const result = await executeHealthCheck(healthCheck);
      healthy = result.passed;
    } else {
      const probe = healthCheck ?? (() => Promise.resolve(true));
      for (let i = 0; i < REQUIRED_HEALTHY_PROBES; i++) {
        try {
          const success = await probe();
          // Strict boolean check: truthy non-booleans or numbers are NOT accepted as passing
          if (success !== true) {
            healthy = false;
            break;
          }
        } catch {
          healthy = false;
          break;
        }
      }
    }

    if (healthy) {
      // spec: contracts/platform.contract.md#PLAT-3 — pass: Activate (flip traffic pointer)
      // spec: contracts/functions.contract.md#FN-3 — Ready -> Deployed
      revision.state = "Deployed";
      this.saveRevisionRecord(project, functionName, revision);

      // spec: contracts/platform.contract.md#PLAT-3 — Atomic cutover race safety
      // spec: contracts/platform.contract.md#PLAT-14 — Only activate if not superseded by newer revision
      let active = false;
      const currentActiveId = this.getActivePointer(project, functionName);
      if (!currentActiveId || currentActiveId <= revisionId) {
        this.setActivePointer(project, functionName, revisionId);
        active = true;
      }

      return {
        revisionId,
        state: "Deployed",
        active,
      };
    } else {
      // spec: contracts/platform.contract.md#PLAT-3 — fail: revision stays inactive, previous keeps serving
      // spec: contracts/functions.contract.md#FN-3 — State transition to Failed
      revision.state = "Failed";
      this.saveRevisionRecord(project, functionName, revision);

      return {
        revisionId,
        state: "Failed",
        active: false,
      };
    }
  }

  /**
   * Instantly rolls back active pointer to a target revision without rebuilding.
   *
   * Spec-anchor: docs/contracts/functions.contract.md#FN-3 (Rollback is a pointer flip, never a rebuild)
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-3 (Instant pointer-flip rollback, cannot activate failed)
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12 (RESOURCE_NOT_FOUND, VALIDATION_FAILED)
   */
  async rollback(
    project: string,
    functionName: string,
    targetRevisionId: string,
  ): Promise<{ previousRevisionId: string; activeRevisionId: string }> {
    // spec: contracts/platform.contract.md#PLAT-18 — Verify revision exists for project and function
    const revision = await this.getRevision(
      project,
      functionName,
      targetRevisionId,
    );
    if (!revision) {
      // spec: contracts/platform.contract.md#PLAT-12 — RESOURCE_NOT_FOUND
      throw new ResourceNotFoundError(
        "RESOURCE_NOT_FOUND: Revision not found for project and function (PLAT-12)",
      );
    }

    // spec: contracts/platform.contract.md#PLAT-3 — Failed revision must never be activated via rollback
    if (revision.state !== "Deployed") {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Cannot rollback to a revision that is not Deployed (PLAT-3)",
      );
    }

    const previousRevisionId = this.getActivePointer(project, functionName) ??
      "";

    // spec: contracts/functions.contract.md#FN-3 — Instant pointer flip, never rebuilds
    // spec: contracts/platform.contract.md#PLAT-1 — Never evaluates customer code
    this.setActivePointer(project, functionName, targetRevisionId);

    return {
      previousRevisionId,
      activeRevisionId: targetRevisionId,
    };
  }

  /**
   * Retrieves the currently active RevisionRecord for a Function, or null if none active.
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-18
   */
  async getActiveRevision(
    project: string,
    functionName: string,
  ): Promise<RevisionRecord | null> {
    const activeRevisionId = this.getActivePointer(project, functionName);
    if (!activeRevisionId) {
      return null;
    }
    return await this.getRevision(project, functionName, activeRevisionId);
  }

  /**
   * Retrieves a specific RevisionRecord by revision ID, or null if not found.
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-7
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-18
   */
  getRevision(
    project: string,
    functionName: string,
    revisionId: string,
  ): Promise<RevisionRecord | null> {
    const record = this.revisions.get(project)?.get(functionName)?.get(
      revisionId,
    );
    if (!record) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ ...record });
  }

  /**
   * Lists all function names registered for a project.
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-18
   */
  listFunctions(project: string): string[] {
    const fnMap = this.revisions.get(project);
    if (!fnMap) {
      return [];
    }
    return Array.from(fnMap.keys());
  }

  /**
   * Lists all revisions for a given project and function.
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-18
   */
  listRevisions(project: string, functionName: string): RevisionRecord[] {
    const revMap = this.revisions.get(project)?.get(functionName);
    if (!revMap) {
      return [];
    }
    return Array.from(revMap.values()).map((rev) => ({ ...rev }));
  }

  /**
   * Retrieves the currently active revision ID for a function, or null if none active.
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-18
   */
  getActiveRevisionId(project: string, functionName: string): string | null {
    return this.getActivePointer(project, functionName);
  }

  /**
   * Restores a revision record into deployment state during disaster recovery.
   * Revisions are immutable per FN-3; throws ConflictError (PLAT-12) on artifactId mismatch.
   * Sets the active pointer if isActive is true.
   *
   * Spec-anchor: docs/contracts/functions.contract.md#FN-3
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-3
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-18
   */
  restoreRevision(
    project: string,
    functionName: string,
    revision: RevisionRecord,
    isActive?: boolean,
  ): void {
    const existing = this.revisions.get(project)?.get(functionName)?.get(
      revision.id,
    );
    if (existing) {
      // spec: docs/contracts/functions.contract.md#FN-3 — Revisions are immutable once created
      // spec: docs/contracts/platform.contract.md#PLAT-12 — CONFLICT
      if (existing.artifactId !== revision.artifactId) {
        throw new ConflictError(
          `CONFLICT: Revision '${revision.id}' already exists with conflicting artifactId '${existing.artifactId}' vs '${revision.artifactId}' (FN-3, PLAT-12)`,
        );
      }
      // Matching revision is preserved as-is
    } else {
      this.saveRevisionRecord(project, functionName, {
        ...revision,
        project,
        functionName,
      });
    }

    if (isActive) {
      // spec: docs/contracts/functions.contract.md#FN-3 — Instant pointer-flip activation
      this.setActivePointer(project, functionName, revision.id);
    }
  }
}

// spec: contracts/platform.contract.md#PLAT-1 — Container entrypoint fallback
if (import.meta.main) {
  const { startControlServer } = await import("./control-server.ts");
  const { LocalFSProvider } = await import(
    "../../providers/objects/local-fs-provider.ts"
  );
  const { SQLiteKVProvider } = await import(
    "../../providers/kv/sqlite-provider.ts"
  );
  const { createStateBackupService } = await import(
    "./state-backup-service.ts"
  );

  const port = parseInt(Deno.env.get("PORT") || "8081", 10);
  const host = Deno.env.get("HOST") || "0.0.0.0";
  const storageDir = Deno.env.get("RAILFOG_OBJECTS_DIR") || ".railfog/objects";
  const storage = new LocalFSProvider(storageDir);
  const kv = new SQLiteKVProvider();
  const deploymentService = new DeploymentService(storage);
  const stateBackupService = createStateBackupService(
    deploymentService,
    kv,
    storage,
  );

  const server = await startControlServer({
    port,
    host,
    deploymentService,
    stateBackupService,
  });

  console.log(`[railfog-control] listening on http://${host}:${server.port}`);
}
