# Immutable Revisions & Deployments

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`FN-3`](../contracts/functions.contract.md#FN-3),
> [`PLAT-3`](../contracts/platform.contract.md#PLAT-3) &nbsp;|&nbsp; **Storage
> Model**: Content-Addressed Immutability

In RailFog, every deployment produces an **immutable revision record**. Once
deployed, code and configuration for a revision never change.

---

## 1. Revision Anatomy

A Revision encapsulates the complete state of an application release:

- **Revision ID**: A time-sortable ULID (e.g. `01J8G5E1M2R4K7W9P0X1Y2Z3A4`)
  (`PLAT-14`).
- **Artifact Hash**: The SHA-256 content digest of the packaged source code
  bundle (`OBJ-4`).
- **Compiled Manifest**: The frozen `railfog.toml` routing table, trigger
  declarations, resource permissions, and limits.
- **Timestamp & Author**: Metadata recording deployment creation.

---

## 2. Content-Addressed Artifacts (`OBJ-4`)

During deployment packaging, all source files are bundled and hashed:

```
Source Files ──► Canonical Tarball ──► SHA-256 Digest ──► Content-Addressed Storage
                                                               (s3://artifacts/d8b2e3...)
```

Because artifacts are content-addressed:

- Re-deploying identical code produces the exact same hash, preventing redundant
  storage.
- Corrupted or modified artifacts fail hash integrity checks before execution.
- Rollbacks simply point to an existing, verified artifact without rebuilding.

---

## 3. Traffic Pointer Flipping

In RailFog, deploying or rolling back does not stop containers, re-pull images,
or restart services.

1. **New Deploy**: The control plane builds the new revision, writes the record,
   and flips the project's active revision pointer in PostgreSQL/SQLite.
2. **Instant Rollback**: `rail rollback` updates the pointer back to a previous
   revision ULID.
3. **Data Plane Hot-Swap**: Data plane nodes detect the pointer change on their
   periodic background poll (default: 5s) and switch live route dispatch with
   zero dropped connections.

---

## 4. Disaster Recovery & State Migration (`rail export` / `rail import`)

Per ADR-0002, projects support complete state backup and disaster recovery:

- **`rail export`**: Packages project configuration, revision metadata, and all
  active KV data into an encrypted archive file (`.rfz`).
- **`rail import`**: Restores the complete project state, revisions, and storage
  into a clean RailFog instance.

---

## Next Steps

- Learn about [Provider Abstractions](providers.md).
- Learn about [Defense-in-Depth Isolation](isolation.md).
