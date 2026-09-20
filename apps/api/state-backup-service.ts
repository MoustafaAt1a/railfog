/**
 * State Backup and Disaster Recovery Service (T-0411).
 *
 * Implements full resource export and restore according to ADR-0002.
 * Serializes project resources (Functions, revisions, KV entries, Object records, Queues)
 * into a portable StateBackupArchive v1 JSON and restores it to target projects with strict
 * tenant isolation and conflict gating.
 *
 * Spec references:
 * - PLAT-7: Multi-tenant physical prefixing {org_id}/{project_id}/{resource}/{key}
 * - PLAT-12: Error model (VALIDATION_FAILED, CONFLICT, RESOURCE_NOT_FOUND)
 * - PLAT-14: ULID monotonic identifier format (bak_{ULID}, rev_{ULID})
 * - PLAT-18: Resource hierarchy Org -> Project -> { Function, KV, Object, Queue }
 * - OBJ-1: Durable binary storage for backups under backups/{backup_id}.json
 * - OBJ-4: Cryptographic content addressing (sha256 hex id and SRI integrity)
 * - FN-3: Function lifecycle, immutable revisions, pointer flip rollback
 * - ADR-0002: State backup and disaster recovery archive specification
 */

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type {
  DeploymentService,
  RevisionRecord,
} from "./deployment-service.ts";
import type { Manifest } from "../../packages/core/artifact/packager.ts";
import { computeSha256 } from "../../packages/core/crypto/content-address.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";
import {
  ConflictError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import {
  type BackupFunctionRecord,
  type BackupKvEntry,
  type BackupObjectRecord,
  type BackupRevisionRecord,
  serializeBackupArchive,
  type StateBackupArchive,
  validateBackupArchive,
} from "../../packages/core/backup/archive-schema.ts";

/** Maximum byte length for inlining object data directly in the archive per ADR-0002. */
const MAX_INLINE_OBJECT_BYTES = 256 * 1024;

export interface ExportProjectOptions {
  orgId: string;
  projectId: string;
  backupStorageKey?: string;
}

export interface ImportProjectOptions {
  targetOrgId: string;
  targetProjectId: string;
  archive: StateBackupArchive;
  overwriteKv?: boolean;
}

export interface ImportProjectResult {
  restoredRevisions: number;
  restoredKvKeys: number;
  restoredObjects: number;
  restoredQueues: number;
}

export interface StateBackupService {
  exportProject(options: ExportProjectOptions): Promise<StateBackupArchive>;
  importProject(options: ImportProjectOptions): Promise<ImportProjectResult>;
}

/**
 * Validates tenant and project identifiers against empty strings and path traversal.
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-7
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12
 */
function validateIdentifier(id: unknown, fieldName: string): void {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new ValidationFailedError(
      `VALIDATION_FAILED: ${fieldName} must be a non-empty string (PLAT-12)`,
    );
  }
  const trimmed = id.trim();
  const lower = trimmed.toLowerCase();
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed.includes("..") ||
    lower.includes("%2e%2e")
  ) {
    throw new ValidationFailedError(
      `VALIDATION_FAILED: ${fieldName} contains invalid characters or path traversal (PLAT-7, PLAT-12)`,
    );
  }
}

/**
 * Checks if a string contains path traversal characters or sequences.
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-7
 */
function hasPathTraversal(segment: string): boolean {
  const lower = segment.toLowerCase();
  return (
    segment.includes("..") ||
    segment.includes("\\") ||
    segment.includes("\0") ||
    lower.includes("%2e%2e")
  );
}

/**
 * Helper to drain a ReadableStream into a Uint8Array.
 */
async function streamToBytes(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * State backup and disaster recovery service implementation.
 *
 * Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-7
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-18
 */
class DefaultStateBackupService implements StateBackupService {
  constructor(
    private readonly deploymentService: DeploymentService,
    private readonly kvProvider: KVProvider,
    private readonly objectProvider: ObjectProvider,
  ) {}

  /**
   * Exports an entire project's resource hierarchy into a StateBackupArchive v1 payload.
   * Persists the content-addressed JSON into object storage under backups/{backup_id}.json.
   *
   * Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-7
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-14
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-18
   * Spec-anchor: docs/contracts/objects.contract.md#OBJ-1
   * Spec-anchor: docs/contracts/objects.contract.md#OBJ-4
   */
  async exportProject(
    options: ExportProjectOptions,
  ): Promise<StateBackupArchive> {
    // spec: docs/contracts/platform.contract.md#PLAT-7 — Tenant and project validation
    validateIdentifier(options.orgId, "orgId");
    validateIdentifier(options.projectId, "projectId");

    // 1. Gather Functions and Revisions
    // spec: docs/contracts/platform.contract.md#PLAT-18 — Project -> Function -> Revision
    const fnNames = this.deploymentService.listFunctions(options.projectId);
    const functions: BackupFunctionRecord[] = [];

    for (const fnName of fnNames) {
      const activeRevisionId = this.deploymentService.getActiveRevisionId(
        options.projectId,
        fnName,
      );
      const revisions = this.deploymentService.listRevisions(
        options.projectId,
        fnName,
      );

      const backupRevisions: BackupRevisionRecord[] = revisions.map((rev) => ({
        id: rev.id,
        artifactId: rev.artifactId,
        integrity: rev.integrity,
        state: rev.state as "Deployed" | "Failed" | "Ready",
        createdAt: rev.createdAt,
        manifest: rev.manifest,
      }));

      functions.push({
        name: fnName,
        activeRevisionId,
        revisions: backupRevisions,
      });
    }

    // 2. Gather KV entries scoped to tenant prefix [orgId, projectId]
    // spec: docs/contracts/platform.contract.md#PLAT-7 — Tenant prefix scoping
    const kvEntries: BackupKvEntry[] = [];
    let kvCursor: string | undefined = undefined;

    do {
      const page = await this.kvProvider.list(
        [options.orgId, options.projectId],
        { limit: 1000, cursor: kvCursor },
      );

      for (const item of page.keys) {
        // Physical key structure: [orgId, projectId, namespace, ...keySegments]
        if (item.key.length >= 4) {
          const namespace = item.key[2];
          const key = item.key.slice(3);
          kvEntries.push({
            namespace,
            key,
            value: item.value,
            version: 1,
          });
        }
      }
      kvCursor = page.cursor;
    } while (kvCursor !== undefined);

    // 3. Gather Objects scoped to tenant prefix `${orgId}/${projectId}/`
    // spec: docs/contracts/platform.contract.md#PLAT-7 — Tenant prefix scoping
    // spec: docs/contracts/objects.contract.md#OBJ-4 — Content addressing and integrity
    const objectRecords: BackupObjectRecord[] = [];
    const objPrefix = `${options.orgId}/${options.projectId}/`;
    let objCursor: string | undefined = undefined;

    do {
      const page = await this.objectProvider.list(objPrefix, {
        limit: 1000,
        cursor: objCursor,
      });

      for (const fullKey of page.keys) {
        if (!fullKey.startsWith(objPrefix)) {
          continue;
        }
        const rel = fullKey.slice(objPrefix.length);
        const slashIdx = rel.indexOf("/");
        if (slashIdx === -1) {
          continue;
        }
        const store = rel.slice(0, slashIdx);
        const callerKey = rel.slice(slashIdx + 1);

        const stream = await this.objectProvider.get(fullKey);
        if (!stream) {
          continue;
        }
        const bytes = await streamToBytes(stream);
        const hashBytes = await computeSha256(bytes);
        const sha256 = encodeHex(hashBytes);
        const integrity = "sha256-" + encodeBase64(hashBytes);
        const sizeBytes = bytes.byteLength;

        const record: BackupObjectRecord = {
          store,
          key: callerKey,
          sizeBytes,
          sha256,
          integrity,
        };

        // spec: docs/adr/0002-state-backup-and-disaster-recovery-archive.md — Inline small payloads (<256 KB)
        if (sizeBytes < MAX_INLINE_OBJECT_BYTES) {
          record.dataBase64 = encodeBase64(bytes);
        } else {
          // spec: docs/contracts/objects.contract.md#OBJ-1
          // spec: docs/contracts/objects.contract.md#OBJ-4
          // Large object (>256KB): persist payload in content-addressed storage
          await this.objectProvider.put(
            `artifacts/${sha256}`,
            bytes.buffer as ArrayBuffer,
          );
        }

        objectRecords.push(record);
      }
      objCursor = page.cursor;
    } while (objCursor !== undefined);

    // 4. Assemble and validate StateBackupArchive
    // spec: docs/contracts/platform.contract.md#PLAT-14 — bak_{ULID} format
    const backupId = `bak_${generateUlid()}`;
    const archivePayload: StateBackupArchive = {
      version: 1,
      backupId,
      createdAt: Date.now(),
      project: {
        orgId: options.orgId,
        projectId: options.projectId,
        name: options.projectId,
      },
      functions,
      kv: kvEntries,
      objects: objectRecords,
      queues: [],
    };

    const validatedArchive = validateBackupArchive(archivePayload);

    // 5. Persist archive to object storage
    // spec: docs/contracts/objects.contract.md#OBJ-1 — Durable storage for backups
    const storageKey = options.backupStorageKey ??
      `backups/${validatedArchive.backupId}.json`;
    const serialized = serializeBackupArchive(validatedArchive);
    const archiveBytes = new TextEncoder().encode(serialized);
    await this.objectProvider.put(
      storageKey,
      archiveBytes.buffer as ArrayBuffer,
    );

    return validatedArchive;
  }

  /**
   * Imports and restores project state from a StateBackupArchive.
   * Re-scopes all resource keys under target tenant prefix, pre-checks for conflicts,
   * and executes safe atomic restore.
   *
   * Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-7
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12
   * Spec-anchor: docs/contracts/functions.contract.md#FN-3
   */
  async importProject(
    options: ImportProjectOptions,
  ): Promise<ImportProjectResult> {
    // spec: docs/contracts/platform.contract.md#PLAT-7 — Target tenant validation
    validateIdentifier(options.targetOrgId, "targetOrgId");
    validateIdentifier(options.targetProjectId, "targetProjectId");

    // spec: docs/contracts/platform.contract.md#PLAT-12 — Archive schema validation
    const archive = validateBackupArchive(options.archive);

    // spec: docs/contracts/platform.contract.md#PLAT-7 — Validate source archive project identifiers
    validateIdentifier(archive.project.orgId, "archive.project.orgId");
    validateIdentifier(archive.project.projectId, "archive.project.projectId");

    // ========================================================================
    // Security & Conflict Pre-checks (Fail-safe: zero state modified on error)
    // ========================================================================

    // spec: docs/contracts/platform.contract.md#PLAT-7 — Path traversal check for KV
    for (const entry of archive.kv) {
      if (hasPathTraversal(entry.namespace)) {
        throw new ValidationFailedError(
          `VALIDATION_FAILED: Path traversal detected in KV namespace '${entry.namespace}' (PLAT-7, PLAT-12)`,
        );
      }
      for (const seg of entry.key) {
        if (hasPathTraversal(seg)) {
          throw new ValidationFailedError(
            `VALIDATION_FAILED: Path traversal detected in KV key segment '${seg}' (PLAT-7, PLAT-12)`,
          );
        }
      }
    }

    // spec: docs/contracts/platform.contract.md#PLAT-7 — Path traversal check for Objects
    for (const obj of archive.objects) {
      if (
        hasPathTraversal(obj.store) ||
        obj.store.includes("/") ||
        obj.store.includes("\\")
      ) {
        throw new ValidationFailedError(
          `VALIDATION_FAILED: Path traversal or slash detected in Object store '${obj.store}' (PLAT-7, PLAT-12)`,
        );
      }
      if (
        hasPathTraversal(obj.key) ||
        obj.key.startsWith("/") ||
        obj.key.startsWith("\\")
      ) {
        throw new ValidationFailedError(
          `VALIDATION_FAILED: Path traversal or leading slash detected in Object key '${obj.key}' (PLAT-7, PLAT-12)`,
        );
      }
    }

    // spec: docs/contracts/objects.contract.md#OBJ-4 — Verify large objects exist in content-addressed storage
    for (const obj of archive.objects) {
      if (obj.dataBase64 === undefined) {
        const casKey = `artifacts/${obj.sha256}`;
        const stream = await this.objectProvider.get(casKey);
        if (!stream) {
          throw new ValidationFailedError(
            `VALIDATION_FAILED: Large object '${obj.store}/${obj.key}' (${obj.sha256}) payload not found in content-addressed storage (OBJ-4, PLAT-12)`,
          );
        }
      }
    }

    // spec: docs/contracts/functions.contract.md#FN-3 — Revisions immutable; pre-check artifact conflicts
    for (const fn of archive.functions) {
      for (const rev of fn.revisions) {
        const existing = await this.deploymentService.getRevision(
          options.targetProjectId,
          fn.name,
          rev.id,
        );
        if (existing && existing.artifactId !== rev.artifactId) {
          throw new ConflictError(
            `CONFLICT: Revision '${rev.id}' already exists in target project with conflicting artifactId '${existing.artifactId}' vs '${rev.artifactId}' (FN-3, PLAT-12)`,
          );
        }
      }
    }

    // spec: docs/adr/0002-state-backup-and-disaster-recovery-archive.md — Pre-check KV overwrite gating
    if (!options.overwriteKv) {
      const seenKeys = new Set<string>();
      for (const entry of archive.kv) {
        const targetKey = [
          options.targetOrgId,
          options.targetProjectId,
          entry.namespace,
          ...entry.key,
        ];
        const keyStr = targetKey.join("/");
        if (seenKeys.has(keyStr)) {
          throw new ConflictError(
            `CONFLICT: Duplicate KV key in archive without overwrite: ${keyStr} (PLAT-12, ADR-0002)`,
          );
        }
        seenKeys.add(keyStr);

        const existingVal = await this.kvProvider.get(targetKey);
        if (existingVal !== null) {
          throw new ConflictError(
            `CONFLICT: Target KV key already exists: ${keyStr} (PLAT-12, ADR-0002)`,
          );
        }
      }
    }

    // ========================================================================
    // Restore Execution Phase
    // ========================================================================

    // 1. Restore function revisions and active pointers
    // spec: docs/contracts/functions.contract.md#FN-3 — Instant pointer flip rollback
    let restoredRevisions = 0;
    for (const fn of archive.functions) {
      for (const rev of fn.revisions) {
        const isActive = fn.activeRevisionId === rev.id;
        const record: RevisionRecord = {
          id: rev.id,
          project: options.targetProjectId,
          functionName: fn.name,
          artifactId: rev.artifactId,
          integrity: rev.integrity,
          state: rev.state,
          createdAt: rev.createdAt,
          manifest: rev.manifest as Manifest,
        };
        this.deploymentService.restoreRevision(
          options.targetProjectId,
          fn.name,
          record,
          isActive,
        );
        restoredRevisions++;
      }
    }

    // 2. Restore KV entries under target prefix
    // spec: docs/contracts/platform.contract.md#PLAT-7 — Rescoping to target prefix
    let restoredKvKeys = 0;
    for (const entry of archive.kv) {
      const targetKey = [
        options.targetOrgId,
        options.targetProjectId,
        entry.namespace,
        ...entry.key,
      ];
      await this.kvProvider.set(
        targetKey,
        entry.value,
        entry.ttl !== undefined ? { ttl: entry.ttl } : undefined,
      );
      restoredKvKeys++;
    }

    // 3. Restore Objects under target prefix
    // spec: docs/contracts/platform.contract.md#PLAT-7 — Rescoping to target prefix
    let restoredObjects = 0;
    for (const obj of archive.objects) {
      const targetKey =
        `${options.targetOrgId}/${options.targetProjectId}/${obj.store}/${obj.key}`;
      if (obj.dataBase64 !== undefined) {
        const decodedBytes = decodeBase64(obj.dataBase64);
        await this.objectProvider.put(
          targetKey,
          decodedBytes.buffer as ArrayBuffer,
        );
        restoredObjects++;
      } else {
        // Large object (>256KB): pull strictly from content-addressed storage (OBJ-1, OBJ-4)
        // Never pull from another tenant's prefix (PLAT-7)
        const casKey = `artifacts/${obj.sha256}`;
        const stream = await this.objectProvider.get(casKey);
        if (!stream) {
          throw new ValidationFailedError(
            `VALIDATION_FAILED: Large object '${obj.store}/${obj.key}' payload not found in content-addressed storage (OBJ-4, PLAT-12)`,
          );
        }
        const bytes = await streamToBytes(stream);
        const hashBytes = await computeSha256(bytes);
        const computedSha256 = encodeHex(hashBytes);
        if (computedSha256 !== obj.sha256) {
          throw new ValidationFailedError(
            `VALIDATION_FAILED: Large object '${obj.store}/${obj.key}' integrity verification failed (OBJ-4, PLAT-12)`,
          );
        }
        await this.objectProvider.put(targetKey, bytes.buffer as ArrayBuffer);
        restoredObjects++;
      }
    }

    // 4. Record restored queues count
    const restoredQueues = archive.queues.length;

    return {
      restoredRevisions,
      restoredKvKeys,
      restoredObjects,
      restoredQueues,
    };
  }
}

/**
 * Factory function creating a StateBackupService instance.
 *
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-18
 * Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
 */
export function createStateBackupService(
  deploymentService: DeploymentService,
  kvProvider: KVProvider,
  objectProvider: ObjectProvider,
): StateBackupService {
  return new DefaultStateBackupService(
    deploymentService,
    kvProvider,
    objectProvider,
  );
}
