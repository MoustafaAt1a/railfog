# T-0411 — State export and disaster recovery service

Status: Done
Milestone: 0.4 Reliability
Depends on: T-0104, T-0105, T-0106, T-0207, T-0404
Blocks: T-0412

## Spec references

`PLAT-18` `OBJ-1` `OBJ-4` `PLAT-7` `PLAT-12`

## Scope

**In scope** (be exact — file/module/interface level, not a feature area):
- `apps/api/state-backup-service.ts`: implement disaster recovery export and restore service per `docs/adr/0002-state-backup-and-disaster-recovery-archive.md`:
  - Export: serializes a project's resource hierarchy (Functions, revisions, KV namespaces, Object metadata, and Queues) into a `StateBackupArchive` v1 JSON payload (T-0404) and stores it in Object storage under `backups/{backup_id}.json` (OBJ-1, OBJ-4).
  - Import:
    - Validates archive against `validateBackupArchive` (T-0404); throws `ValidationFailedError` (`VALIDATION_FAILED` per PLAT-12) if malformed.
    - Tenant isolation re-scoping (PLAT-7): rewrites all KV and Object keys into the target project's physical prefix `{target_org_id}/{target_project_id}/{resource}/{key}` so an import can never overwrite another tenant's prefix.
    - Conflict resolution (ADR-0002): revisions are immutable (FN-3); if target has matching revision with conflicting artifact hash, rejects with `ConflictError` (`CONFLICT` per PLAT-12); restores active pointers via pointer flip. KV overwrites only when `overwriteKv: true` is passed.
- `cli/state.ts`: implement CLI commands `rail export` and `rail import`, wired into `cli/main.ts`.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Raw database engine dumps (SQLite .dump / pg_dump — rejected per ADR-0002).
- Multi-region live active-active database replication (PLAT-20).
- Automatic periodic cron backups (Milestone 0.5 DX).

## Interface to implement

```typescript
import type { StateBackupArchive } from "../../packages/core/backup/archive-schema.ts";
import type { DeploymentService } from "../api/deployment-service.ts";
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";

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

export function createStateBackupService(
  deploymentService: DeploymentService,
  kvProvider: KVProvider,
  objectProvider: ObjectProvider,
): StateBackupService;
```

## Acceptance criteria (Given/When/Then)

1. Given an existing project with revisions, KV records, and Object records, when `exportProject` is called, then it outputs a valid `StateBackupArchive` v1 and persists the content-addressed JSON under `backups/{backup_id}.json` (OBJ-1).
2. Given a tampered or invalid archive, when `importProject` is called, then it throws `ValidationFailedError` (`VALIDATION_FAILED` per PLAT-12) without applying partial state changes.
3. Given an archive exported from `org_a/proj_a`, when imported into `org_b/proj_b`, then all restored keys are strictly re-scoped under `{org_b}/{proj_b}/...` without touching `org_a` keys (PLAT-7).
4. Given a target project with an existing revision ID matching the archive but having a different artifact SHA256 hash, when `importProject` is called, then it rejects with `ConflictError` (`CONFLICT` per PLAT-12).
5. Given existing KV keys in target project, when `importProject` is called with `overwriteKv: false` and a duplicate key exists, then it rejects with `ConflictError`; when `overwriteKv: true` is passed, the target key is updated.
6. Given CLI commands `rail export` and `rail import`, when executed via the command-line interface, then they export to a local file and restore state to the target project.

## Tests required

- [x] Unit — export archive construction matching StateBackupArchive v1 schema
- [x] Unit — import conflict resolution: revision artifact mismatch rejection and KV overwrite gating
- [x] Integration — full round-trip export, target project import, and state verification
- [x] Security — verify import re-scopes all keys to target prefix and strictly prevents tenant directory traversal or overwrite of another tenant's data (PLAT-7)

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches PLAT-7)
- [x] Nothing outside "In scope" touched

```
$ deno check apps/api/state-backup-service.ts apps/api/deployment-service.ts cli/state.ts cli/main.ts apps/api/state-backup-service_test.ts cli/state_test.ts
Exit code: 0

$ deno test --allow-read --allow-write --allow-net --allow-run apps/api/state-backup-service_test.ts cli/state_test.ts
running 21 tests from ./apps/api/state-backup-service_test.ts ... ok | 21 passed | 0 failed
running 11 tests from ./cli/state_test.ts ... ok | 11 passed | 0 failed
ok | 32 passed | 0 failed (914ms)
Exit code: 0

$ deno lint apps/api/state-backup-service.ts apps/api/deployment-service.ts cli/state.ts cli/main.ts apps/api/state-backup-service_test.ts cli/state_test.ts
Checked 6 files
Exit code: 0

$ deno fmt --check apps/api/state-backup-service.ts apps/api/deployment-service.ts cli/state.ts cli/main.ts apps/api/state-backup-service_test.ts cli/state_test.ts
Checked 6 files
Exit code: 0
```

## Assumptions made

- Object binary payloads larger than 256 KB remain in content-addressed object storage (`OBJ-1`) and are referenced by hash (`OBJ-4`), whereas small payloads (<256 KB) are serialized inline as base64 per ADR-0002.
- Backup archive files in object storage are stored under `backups/bak_{ULID}.json` unless `backupStorageKey` is explicitly supplied.
- When `targetProject` is not passed to `importCommand`, the CLI first attempts to read `railfog.toml`, and falls back to the archived `project.projectId`.

