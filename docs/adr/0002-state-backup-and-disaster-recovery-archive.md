# ADR-0002 — State Backup & Disaster Recovery Archive Specification

Status: Proposed
Date: 2026-09-14
Raised by: architect

## Context

Milestone 0.4 ("Survive real failures") requires state backup and disaster recovery export/import capabilities across the RailFog resource hierarchy (`tasks/00-roadmap.md`, `platform.contract.md` PLAT-18).
`PLAT-18` defines the resource hierarchy as `Organization → Project → { Function, KV namespace, Object store, Queue }` and `Function → Revision`.
`OBJ-1` designates Object storage for "Durable binary storage: uploads, backups, build artifacts, datasets."
`OBJ-4` specifies cryptographic content addressing (`sha256:` hex format and Subresource Integrity string).
`PLAT-14` specifies ULID generation for monotonic entity identifiers.
`PLAT-7` mandates multi-tenant physical prefixing.
`PLAT-12` defines the platform error taxonomy (`RESOURCE_NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`).

However, `docs/contracts/` does not specify:
1. The portable archive format and schema for project state exports.
2. How hierarchical KV state, Function revision records, object manifests, and queue configs are structured during serialization.
3. The restore semantics and conflict resolution rules when importing into an existing target project or recovering after disaster.

## Decision

Project state backup and disaster recovery export/import must use an immutable, content-verifiable `StateBackupArchive` schema formatted as standard JSON, stored either locally or in durable object storage under `backups/{backup_id}.json` (OBJ-1).

1. **Archive Schema Structure (`StateBackupArchive`)**:
```typescript
export interface StateBackupArchive {
  version: 1;
  backupId: string; // bak_{ULID} (PLAT-14)
  createdAt: number; // Monotonic epoch ms
  project: {
    orgId: string;
    projectId: string;
    name: string;
  };
  functions: Array<{
    name: string;
    activeRevisionId: string | null;
    revisions: Array<{
      id: string; // rev_{ULID}
      artifactId: string; // sha256:... (OBJ-4)
      integrity: string; // sha256-... (OBJ-4)
      state: "Deployed" | "Failed" | "Ready";
      createdAt: number;
      manifest: unknown;
    }>;
  }>;
  kv: Array<{
    namespace: string;
    key: string[];
    value: unknown;
    ttl?: number;
    version: number;
  }>;
  objects: Array<{
    store: string;
    key: string;
    sizeBytes: number;
    sha256: string;
    integrity: string;
    dataBase64?: string; // Inline base64 for small objects (<256 KB); larger objects reference OBJ-1
  }>;
  queues: Array<{
    name: string;
    visibilityTimeoutMs: number;
    maxReceives: number;
    retentionDays: number;
    dlqQueueName?: string;
  }>;
}
```

2. **Integrity & Verification (OBJ-4, PLAT-12)**:
Every export archive is validated before persistence. Upon import, the payload must strictly validate against `StateBackupArchive`. Any malformed or tampered archive must immediately throw `ValidationFailedError` (PLAT-12).

3. **Tenant & Target Isolation (PLAT-7)**:
During import, all KV keys and Object keys are re-scoped to the target project's physical prefix `{target_org_id}/{target_project_id}/{resource}/{key}`. An import can never overwrite or bleed into another tenant's prefix.

4. **Conflict Resolution on Restore (PLAT-3, PLAT-12, FN-3)**:
- Revisions are immutable (FN-3). If an identical revision ID already exists in the target with matching content hash, it is preserved. If revision ID exists with conflicting artifact hashes, import rejects with `CONFLICT` (PLAT-12).
- Restoring active pointers executes via atomic pointer-flip without rebuild (FN-3, PLAT-3).
- KV entries overwrite existing keys only if `--overwrite` is specified; otherwise existing keys return `CONFLICT`.

## Alternatives considered

- **Streaming tar/zip archive with separate files**: Rejected for 1.0.0 because JSON serialization with base64 for small blobs leverages native Web APIs (`JSON.stringify`, `Uint8Array`, `btoa/atob`) without external binary decompression dependencies (Engineering Rule 3: glue, don't reinvent; Rule 7: no third-party dependencies outside PLAT-16). Large binary files remain in Object storage (OBJ-1) and are addressed by content hash (OBJ-4).
- **Control plane direct database dump (SQLite .dump / Postgres pg_dump)**: Rejected because it violates provider abstraction (PLAT-16, Principle 4: no lock-in). A database dump cannot be imported across different backing providers (e.g. SQLite -> Cloud KV/R2). The archive format must be provider-agnostic.

## Consequences

- `packages/core` will provide `StateBackupArchive` types and schema validation.
- Control plane / CLI gains export/import services capable of backing up and restoring projects cleanly.
- Tests will verify round-trip export and import fidelity across providers without data loss.

## Spec references

`PLAT-1`, `PLAT-3`, `PLAT-7`, `PLAT-12`, `PLAT-14`, `PLAT-16`, `PLAT-18`, `OBJ-1`, `OBJ-4`, `FN-3`.
