/**
 * State Backup & Disaster Recovery Archive Schema and Validation
 *
 * Spec references:
 * - docs/adr/0002-state-backup-and-disaster-recovery-archive.md (StateBackupArchive v1 schema)
 * - docs/contracts/platform.contract.md#PLAT-18 (Resource hierarchy: Org -> Project -> { Function, KV, Object, Queue })
 * - docs/contracts/platform.contract.md#PLAT-14 (Crockford Base32 26-char ULID format: bak_{ULID}, rev_{ULID})
 * - docs/contracts/platform.contract.md#PLAT-12 (Error model: VALIDATION_FAILED)
 * - docs/contracts/objects.contract.md#OBJ-1 (Object store durable storage for backups)
 * - docs/contracts/objects.contract.md#OBJ-4 (Content addressing: artifactId and SRI integrity)
 * - docs/contracts/queues.contract.md#Q-3 (Queue redelivery: visibilityTimeoutMs, maxReceives, retentionDays)
 */

import { ValidationFailedError } from "../../errors/mod.ts";

/**
 * Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
 * Supported archive schema version.
 */
export const ARCHIVE_SCHEMA_VERSION = 1;

/**
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-14
 * ULID identifiers using Crockford Base32 26-character format.
 */
const BACKUP_ID_REGEX = /^bak_[0-9A-HJKMNP-TV-Z]{26}$/;
const REVISION_ID_REGEX = /^rev_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-4
 * Content addressing format: "sha256:" + 64 hex characters.
 */
const ARTIFACT_ID_REGEX = /^sha256:[0-9a-f]{64}$/;

/**
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-4
 * Standard 64-character lowercase SHA-256 hexadecimal hash.
 */
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

/**
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-4
 * Subresource Integrity (SRI) format: "sha256-" + base64 string.
 */
const INTEGRITY_SRI_REGEX = /^sha256-[A-Za-z0-9+/=]+$/;

/**
 * Valid base64 character string.
 */
const BASE64_REGEX = /^[A-Za-z0-9+/=]+$/;

/**
 * Spec-anchor: docs/contracts/queues.contract.md Q-3
 * Queue retention window maximum is 14 days.
 */
const MAX_QUEUE_RETENTION_DAYS = 14;

/**
 * Valid revision states per ADR-0002.
 */
const VALID_REVISION_STATES = new Set(["Deployed", "Failed", "Ready"]);

/**
 * Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-14, PLAT-18
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-4
 */
export interface BackupRevisionRecord {
  id: string; // rev_{ULID} (PLAT-14)
  artifactId: string; // sha256:... (OBJ-4)
  integrity: string; // sha256-... (OBJ-4)
  state: "Deployed" | "Failed" | "Ready";
  createdAt: number;
  manifest: unknown;
}

/**
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-18
 */
export interface BackupFunctionRecord {
  name: string;
  activeRevisionId: string | null;
  revisions: BackupRevisionRecord[];
}

/**
 * Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-18
 */
export interface BackupKvEntry {
  namespace: string;
  key: string[];
  value: unknown;
  ttl?: number;
  version: number;
}

/**
 * Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-1, OBJ-4
 */
export interface BackupObjectRecord {
  store: string;
  key: string;
  sizeBytes: number;
  sha256: string;
  integrity: string;
  dataBase64?: string;
}

/**
 * Spec-anchor: docs/contracts/queues.contract.md Q-3
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-18
 */
export interface BackupQueueRecord {
  name: string;
  visibilityTimeoutMs: number;
  maxReceives: number;
  retentionDays: number;
  dlqQueueName?: string;
}

/**
 * Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-18
 */
export interface StateBackupArchive {
  version: 1;
  backupId: string; // bak_{ULID} (PLAT-14)
  createdAt: number;
  project: {
    orgId: string;
    projectId: string;
    name: string;
  };
  functions: BackupFunctionRecord[];
  kv: BackupKvEntry[];
  objects: BackupObjectRecord[];
  queues: BackupQueueRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProject(project: unknown): void {
  // Spec-anchor: docs/contracts/platform.contract.md PLAT-18 (Org -> Project)
  if (!isRecord(project)) {
    throw new ValidationFailedError("project must be a non-null object");
  }
  if (typeof project.orgId !== "string" || project.orgId.length === 0) {
    throw new ValidationFailedError("project.orgId must be a non-empty string");
  }
  if (typeof project.projectId !== "string" || project.projectId.length === 0) {
    throw new ValidationFailedError(
      "project.projectId must be a non-empty string",
    );
  }
  if (typeof project.name !== "string" || project.name.length === 0) {
    throw new ValidationFailedError("project.name must be a non-empty string");
  }
}

function validateFunctions(functions: unknown): void {
  // Spec-anchor: docs/contracts/platform.contract.md PLAT-18 (Function -> Revision)
  if (!Array.isArray(functions)) {
    throw new ValidationFailedError("functions must be an array");
  }

  for (const fn of functions) {
    if (!isRecord(fn)) {
      throw new ValidationFailedError("Function record must be an object");
    }
    if (typeof fn.name !== "string" || fn.name.length === 0) {
      throw new ValidationFailedError(
        "Function name must be a non-empty string",
      );
    }
    if (!Array.isArray(fn.revisions)) {
      throw new ValidationFailedError(
        `Revisions for function '${fn.name}' must be an array`,
      );
    }

    const revisionIds = new Set<string>();
    for (const rev of fn.revisions) {
      if (!isRecord(rev)) {
        throw new ValidationFailedError("Revision record must be an object");
      }
      // Spec-anchor: docs/contracts/platform.contract.md PLAT-14
      if (typeof rev.id !== "string" || !REVISION_ID_REGEX.test(rev.id)) {
        throw new ValidationFailedError(
          `Invalid revision id: expected 'rev_{ULID}', received '${
            String(rev.id)
          }'`,
        );
      }
      // Spec-anchor: docs/contracts/objects.contract.md OBJ-4
      if (
        typeof rev.artifactId !== "string" ||
        !ARTIFACT_ID_REGEX.test(rev.artifactId)
      ) {
        throw new ValidationFailedError(
          `Invalid revision artifactId: expected 'sha256:{hex}', received '${
            String(rev.artifactId)
          }'`,
        );
      }
      // Spec-anchor: docs/contracts/objects.contract.md OBJ-4
      if (
        typeof rev.integrity !== "string" ||
        !INTEGRITY_SRI_REGEX.test(rev.integrity)
      ) {
        throw new ValidationFailedError(
          `Invalid revision integrity: expected 'sha256-{base64}', received '${
            String(rev.integrity)
          }'`,
        );
      }
      if (
        typeof rev.state !== "string" ||
        !VALID_REVISION_STATES.has(rev.state)
      ) {
        throw new ValidationFailedError(
          `Invalid revision state: expected 'Deployed' | 'Failed' | 'Ready', received '${
            String(rev.state)
          }'`,
        );
      }
      if (
        typeof rev.createdAt !== "number" || !Number.isFinite(rev.createdAt)
      ) {
        throw new ValidationFailedError(
          "Revision createdAt must be a finite number",
        );
      }
      if (!("manifest" in rev) || rev.manifest === undefined) {
        throw new ValidationFailedError("Revision manifest must be present");
      }
      revisionIds.add(rev.id);
    }

    if (fn.activeRevisionId !== null) {
      if (
        typeof fn.activeRevisionId !== "string" ||
        !REVISION_ID_REGEX.test(fn.activeRevisionId) ||
        !revisionIds.has(fn.activeRevisionId)
      ) {
        throw new ValidationFailedError(
          `Invalid activeRevisionId '${
            String(fn.activeRevisionId)
          }' for function '${fn.name}': must be null or match a revision in the function`,
        );
      }
    }
  }
}

function validateKvEntries(kv: unknown): void {
  // Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
  if (!Array.isArray(kv)) {
    throw new ValidationFailedError("kv must be an array");
  }

  for (const entry of kv) {
    if (!isRecord(entry)) {
      throw new ValidationFailedError("KV entry must be an object");
    }
    if (typeof entry.namespace !== "string" || entry.namespace.length === 0) {
      throw new ValidationFailedError(
        "KV entry namespace must be a non-empty string",
      );
    }
    if (
      !Array.isArray(entry.key) ||
      entry.key.length === 0 ||
      !entry.key.every(
        (segment: unknown) => typeof segment === "string" && segment.length > 0,
      )
    ) {
      throw new ValidationFailedError(
        "KV entry key must be a non-empty array of non-empty strings",
      );
    }
    if (!("value" in entry)) {
      throw new ValidationFailedError("KV entry must have a value property");
    }
    if (entry.ttl !== undefined) {
      if (
        typeof entry.ttl !== "number" ||
        !Number.isFinite(entry.ttl) ||
        entry.ttl <= 0
      ) {
        throw new ValidationFailedError(
          "KV entry ttl must be a positive number",
        );
      }
    }
    if (
      typeof entry.version !== "number" ||
      !Number.isInteger(entry.version) ||
      entry.version < 0
    ) {
      throw new ValidationFailedError(
        "KV entry version must be a non-negative integer",
      );
    }
  }
}

function validateObjects(objects: unknown): void {
  // Spec-anchor: docs/contracts/objects.contract.md OBJ-1, OBJ-4
  if (!Array.isArray(objects)) {
    throw new ValidationFailedError("objects must be an array");
  }

  for (const obj of objects) {
    if (!isRecord(obj)) {
      throw new ValidationFailedError("Object record must be an object");
    }
    if (typeof obj.store !== "string" || obj.store.length === 0) {
      throw new ValidationFailedError(
        "Object record store must be a non-empty string",
      );
    }
    if (typeof obj.key !== "string" || obj.key.length === 0) {
      throw new ValidationFailedError(
        "Object record key must be a non-empty string",
      );
    }
    if (
      typeof obj.sizeBytes !== "number" ||
      !Number.isInteger(obj.sizeBytes) ||
      obj.sizeBytes < 0
    ) {
      throw new ValidationFailedError(
        "Object record sizeBytes must be a non-negative integer",
      );
    }
    if (typeof obj.sha256 !== "string" || !SHA256_HEX_REGEX.test(obj.sha256)) {
      throw new ValidationFailedError(
        `Invalid object sha256: expected 64-character lowercase hex string, received '${
          String(obj.sha256)
        }'`,
      );
    }
    if (
      typeof obj.integrity !== "string" ||
      !INTEGRITY_SRI_REGEX.test(obj.integrity)
    ) {
      throw new ValidationFailedError(
        `Invalid object integrity: expected 'sha256-{base64}', received '${
          String(obj.integrity)
        }'`,
      );
    }
    if (obj.dataBase64 !== undefined) {
      if (
        typeof obj.dataBase64 !== "string" ||
        !BASE64_REGEX.test(obj.dataBase64)
      ) {
        throw new ValidationFailedError(
          "Object record dataBase64 must be a valid base64-encoded string",
        );
      }
    }
  }
}

function validateQueues(queues: unknown): void {
  // Spec-anchor: docs/contracts/queues.contract.md Q-3
  if (!Array.isArray(queues)) {
    throw new ValidationFailedError("queues must be an array");
  }

  for (const q of queues) {
    if (!isRecord(q)) {
      throw new ValidationFailedError("Queue record must be an object");
    }
    if (typeof q.name !== "string" || q.name.length === 0) {
      throw new ValidationFailedError(
        "Queue record name must be a non-empty string",
      );
    }
    if (
      typeof q.visibilityTimeoutMs !== "number" ||
      !Number.isFinite(q.visibilityTimeoutMs) ||
      q.visibilityTimeoutMs <= 0
    ) {
      throw new ValidationFailedError(
        "Queue record visibilityTimeoutMs must be a positive number",
      );
    }
    if (
      typeof q.maxReceives !== "number" ||
      !Number.isFinite(q.maxReceives) ||
      q.maxReceives <= 0
    ) {
      throw new ValidationFailedError(
        "Queue record maxReceives must be a positive number",
      );
    }
    if (
      typeof q.retentionDays !== "number" ||
      !Number.isFinite(q.retentionDays) ||
      q.retentionDays <= 0 ||
      q.retentionDays > MAX_QUEUE_RETENTION_DAYS
    ) {
      throw new ValidationFailedError(
        `Queue record retentionDays must be between 1 and ${MAX_QUEUE_RETENTION_DAYS} days`,
      );
    }
    if (q.dlqQueueName !== undefined) {
      if (typeof q.dlqQueueName !== "string" || q.dlqQueueName.length === 0) {
        throw new ValidationFailedError(
          "Queue record dlqQueueName must be a non-empty string when specified",
        );
      }
    }
  }
}

/**
 * Validates a raw input against the StateBackupArchive schema.
 * Throws ValidationFailedError (PLAT-12) if any validation fails.
 *
 * Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-12
 */
export function validateBackupArchive(raw: unknown): StateBackupArchive {
  if (!isRecord(raw)) {
    throw new ValidationFailedError(
      "StateBackupArchive root must be a non-null object",
    );
  }

  // Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
  if (raw.version !== ARCHIVE_SCHEMA_VERSION) {
    throw new ValidationFailedError(
      `Unsupported archive version: ${
        String(raw.version)
      }. Expected ${ARCHIVE_SCHEMA_VERSION}`,
    );
  }

  // Spec-anchor: docs/contracts/platform.contract.md PLAT-14
  if (
    typeof raw.backupId !== "string" ||
    !BACKUP_ID_REGEX.test(raw.backupId)
  ) {
    throw new ValidationFailedError(
      `Invalid backupId: expected 'bak_{ULID}', received '${
        String(raw.backupId)
      }'`,
    );
  }

  if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) {
    throw new ValidationFailedError(
      "createdAt must be a finite number timestamp",
    );
  }

  validateProject(raw.project);
  validateFunctions(raw.functions);
  validateKvEntries(raw.kv);
  validateObjects(raw.objects);
  validateQueues(raw.queues);

  return raw as unknown as StateBackupArchive;
}

/**
 * Serializes a StateBackupArchive to a formatted JSON string.
 *
 * Spec-anchor: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
 */
export function serializeBackupArchive(archive: StateBackupArchive): string {
  return JSON.stringify(archive, null, 2);
}
