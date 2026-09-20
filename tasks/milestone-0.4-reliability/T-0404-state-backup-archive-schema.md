# T-0404 — State backup archive schema and validation

Status: Done
Milestone: 0.4 Reliability
Depends on: T-0102, T-0103
Blocks: T-0411, T-0412

## Spec references

`PLAT-18` `OBJ-1` `OBJ-4` `PLAT-14`

## Scope

**In scope** (be exact — file/module/interface level, not a feature area):
- `packages/core/backup/archive-schema.ts`: implement `StateBackupArchive` v1 schema and strict parser per `docs/adr/0002-state-backup-and-disaster-recovery-archive.md`.
- Capture full resource hierarchy defined in PLAT-18:
  - Organization and Project metadata (`orgId`, `projectId`, `name`).
  - Functions and Revisions: revision IDs (`rev_{ULID}`), state (`Deployed`, `Failed`, `Ready`), content-addressed `artifactId` (`sha256:{hex}`), and `integrity` (`sha256-{base64}`) per OBJ-4.
  - KV namespaces, hierarchical key segments (`string[]`), values, optional `ttl`, and version (KV-2, KV-4).
  - Object metadata: store name, key, `sizeBytes`, `sha256`, SRI `integrity`, optional inline base64 data for small files (<256 KB) per ADR-0002.
  - Queues: name, `visibilityTimeoutMs`, `maxReceives`, `retentionDays`, optional `dlqQueueName` (Q-3).
- Strict validator `validateBackupArchive(raw: unknown)`: throws `ValidationFailedError` (`VALIDATION_FAILED` per PLAT-12) on schema violations, invalid ULIDs, or malformed hashes.
- Serializer `serializeBackupArchive(archive: StateBackupArchive)`: serializes archive to standard JSON string.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Remote object store uploads and backup persistence service (T-0411).
- Physical tenant key re-scoping and database restore execution (T-0411).
- Proprietary or streaming archive formats (zip, tar, sqlite dump — rejected per ADR-0002).

## Interface to implement

```typescript
export interface BackupRevisionRecord {
  id: string; // rev_{ULID} (PLAT-14)
  artifactId: string; // sha256:... (OBJ-4)
  integrity: string; // sha256-... (OBJ-4)
  state: "Deployed" | "Failed" | "Ready";
  createdAt: number;
  manifest: unknown;
}

export interface BackupFunctionRecord {
  name: string;
  activeRevisionId: string | null;
  revisions: BackupRevisionRecord[];
}

export interface BackupKvEntry {
  namespace: string;
  key: string[];
  value: unknown;
  ttl?: number;
  version: number;
}

export interface BackupObjectRecord {
  store: string;
  key: string;
  sizeBytes: number;
  sha256: string;
  integrity: string;
  dataBase64?: string;
}

export interface BackupQueueRecord {
  name: string;
  visibilityTimeoutMs: number;
  maxReceives: number;
  retentionDays: number;
  dlqQueueName?: string;
}

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

export function validateBackupArchive(raw: unknown): StateBackupArchive;

export function serializeBackupArchive(archive: StateBackupArchive): string;
```

## Acceptance criteria (Given/When/Then)

1. Given a valid `StateBackupArchive` object with version 1, valid ULIDs (`bak_...`, `rev_...`), and OBJ-4 hashes, when passed to `validateBackupArchive`, then it returns the validated typed archive.
2. Given raw data with `version` other than 1, when `validateBackupArchive` is called, then it throws `ValidationFailedError` with error code `VALIDATION_FAILED`.
3. Given an archive with an invalid `backupId` that does not match `^bak_[0-9A-Z]{26}$`, when validated, then it throws `ValidationFailedError`.
4. Given a revision with an invalid `artifactId` that does not match `^sha256:[0-9a-f]{64}$`, when validated, then it throws `ValidationFailedError`.
5. Given an object record with an invalid `integrity` string that does not start with `sha256-`, when validated, then it throws `ValidationFailedError`.
6. Given a validated archive, when `serializeBackupArchive` is called, then it returns a valid JSON string that parses back into an identical `StateBackupArchive`.

## Tests required

- [x] Unit — valid archive parsing and structural type conformance
- [x] Unit — rejection of schema mutations, unknown versions, and missing required project fields
- [x] Unit — rejection of malformed ULID formats for backupId and revisionId
- [x] Unit — rejection of malformed OBJ-4 artifactId and integrity strings
- [x] Unit — round-trip serialize and validate verification

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

```
$ deno check packages/core/backup/archive-schema.ts packages/core/backup/archive-schema_test.ts
EXIT: 0

$ deno test packages/core/backup/archive-schema_test.ts
running 19 tests from ./packages/core/backup/archive-schema_test.ts
AC1 & Checklist (1): Valid StateBackupArchive passes validation with exact structural conformance ... ok (1ms)
AC1: Minimal valid archive with empty resource arrays parses successfully ... ok (355µs)
AC1: Function with activeRevisionId as null is valid when no active revision set ... ok (369µs)
AC2 & Checklist (2): Rejects non-object and null raw inputs with ValidationFailedError ... ok (1ms)
AC2: Rejects version other than 1 with ValidationFailedError (PLAT-12) ... ok (533µs)
AC2: Rejects missing required project fields (orgId, projectId, name) ... ok (578µs)
AC2: Rejects missing or non-array top-level resource sections ... ok (1ms)
AC3 & Checklist (3): Rejects invalid backupId that does not match ^bak_[0-9A-HJKMNP-TV-Z]{26}$ ... ok (530µs)
AC3 & Checklist (3): Rejects revision with invalid revisionId that does not match ^rev_[0-9A-HJKMNP-TV-Z]{26}$ ... ok (507µs)
AC4 & Checklist (4): Rejects revision with invalid artifactId not matching ^sha256:[0-9a-f]{64}$ ... ok (617µs)
AC5 & Checklist (4): Rejects object record with invalid integrity string not matching ^sha256-[A-Za-z0-9+/=]+$ ... ok (566µs)
Checklist (4): Rejects revision with invalid integrity string ... ok (212µs)
Checklist (4): Rejects object record with invalid sha256 field ... ok (333µs)
Checklist (5): Revisions must have valid state ('Deployed' | 'Failed' | 'Ready') ... ok (804µs)
Checklist (5): activeRevisionId must match one of the revisions in the function or be null ... ok (307µs)
Checklist (5): KV entries key must be non-empty string[] and version non-negative integer ... ok (514µs)
Checklist (5): Object record requires store, key, non-negative sizeBytes, and validates dataBase64 if present ... ok (962µs)
Checklist (5): Queue record requires name, positive visibilityTimeoutMs, maxReceives, retentionDays ... ok (372µs)
AC6 & Checklist (6): serializeBackupArchive returns JSON that validates back to identical archive ... ok (1ms)

ok | 19 passed | 0 failed (29ms)
EXIT: 0

$ deno lint packages/core/backup/archive-schema.ts packages/core/backup/archive-schema_test.ts
Checked 2 files
EXIT: 0

$ deno fmt --check packages/core/backup/archive-schema.ts packages/core/backup/archive-schema_test.ts
Checked 2 files
EXIT: 0
```

## Assumptions made

- `backupId` format follows `bak_{ULID}` using Crockford Base32 26-character ULID generation (PLAT-14).
- Inline base64 payload in `BackupObjectRecord` is optional and intended for small objects (<256 KB) per ADR-0002.
