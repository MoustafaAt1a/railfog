# Control Plane Architecture Internals

> [!NOTE]
> **Documentation**: [Architecture Home](overview.md) &nbsp;|&nbsp;
> **Specification**: [`PLAT-1`](../contracts/platform.contract.md#PLAT-1),
> [`PLAT-3`](../contracts/platform.contract.md#PLAT-3) &nbsp;|&nbsp; **Daemon**:
> `apps/api`

The Control Plane (`apps/api`) owns administrative identity, project
configuration, deployment compilation, revision storage, secrets management, and
telemetry accounting. It never executes untrusted customer code.

---

## 1. Responsibilities & Physical Boundary

The Control Plane exposes an administrative REST API on TCP port `8082`:

```
CLI / Admin ──(HTTP / Bearer Auth)──► Control Plane (apps/api)
                                           │
       ┌───────────────────────────────────┼───────────────────────────────────┐
       ▼                                   ▼                                   ▼
Deployment Compilation             Secrets Vault               State Backup & Telemetry
(Manifest -> Artifact -> Revision) (Encryption & Scoping)      (ADR-0002 Archive Exporter)
```

---

## 2. Deployment Compilation Pipeline (`PLAT-3`)

When a developer runs `rail deploy`:

1. **Manifest Validation**: Parses `railfog.toml` against strict TOML schema
   rules.
2. **Capability Matrix Resolution**: Cross-references function resource
   declarations against project-level resources.
3. **Artifact Packaging**: Bundles TypeScript sources into a content-addressed
   tarball addressed by its SHA-256 digest (`OBJ-4`).
4. **Revision Registration**: Stores an immutable `Revision` record in
   PostgreSQL/SQLite metadata tables.
5. **Snapshot Distribution (`PLAT-8`)**: Serializes the new active revision into
   a versioned snapshot for edge data planes.

---

## 3. Disaster Recovery Service (`StateBackupService`)

Per ADR-0002, the Control Plane provides automated and on-demand disaster
recovery:

- **`exportState()`**: Iterates project metadata, revision history, and KV
  namespaces, packaging them into an encrypted, portable `.rfz` archive.
- **`importState()`**: Reads an archive, verifies cryptographic integrity, and
  restores project state into a clean database.
