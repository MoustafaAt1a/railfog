# Instant Rollback Guide

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-3`](../contracts/platform.contract.md#PLAT-3),
> [`FN-3`](../contracts/functions.contract.md#FN-3) &nbsp;|&nbsp; **CLI
> Command**: `rail rollback`

Because every deployment produces an immutable, content-addressed revision
(`FN-3`), rolling back in RailFog does not rebuild or repackage code. It
atomically updates the live traffic pointer in the database, restoring a prior
known-good state in milliseconds.

---

## 1. Inspecting Revision History

Before executing a rollback, inspect active and previous revisions using
`rail status`:

```bash
rail status
```

Sample output:

```text
Project: upload-demo
Active Revision: 01J8G5E1M2R4K7W9P0X1Y2Z3A4 (Deployed 2m ago)

Recent Revisions:
  01J8G5E1M2R4K7W9P0X1Y2Z3A4  (Active)  2026-09-27 07:15 UTC  sha256:d8b2e3...
  01J8G3R8N5M2K1W4P9X0Y8Z7B1  (Prior)   2026-09-27 06:40 UTC  sha256:a1f9c4...
  01J8F9T2Q4M1K8W7P3X6Y5Z2C0  (Prior)   2026-09-26 22:10 UTC  sha256:7c8b21...
```

---

## 2. Executing an Atomic Rollback

Roll back a function to a previous revision:

```bash
rail rollback api --to 01J8G3R8N5M2K1W4P9X0Y8Z7B1
```

Sample output:

```text
Rolling back function 'api'...
  Target revision: 01J8G3R8N5M2K1W4P9X0Y8Z7B1
  Verified immutable artifact: sha256:a1f9c4...
  Flipping live traffic pointer...

Rollback successful! Live traffic switched in 12ms.
```

---

## 3. How Rollback Works Under the Hood

1. **No Rebuilds**: The target revision artifact was already hashed, packaged,
   and stored in object storage during its initial deployment.
2. **Atomic Pointer Flip**: The Control Plane updates the revision pointer in
   PostgreSQL/metadata storage in a single transaction.
3. **Data Plane Hot-Swap**: Data plane runtime nodes receive the pointer update
   on their background sync and immediately route new requests to the target
   revision's isolate.
4. **Zero Downtime**: In-flight requests on the old revision finish gracefully
   up to their execution deadline.

---

## 4. Deactivating Traffic (`rail undeploy`)

If a project needs to be completely suspended or taken offline:

```bash
rail undeploy
```

This deactivates the live traffic pointer, pauses queue consumption, and
releases allocated isolate memory while preserving revision history and storage
data.

---

## Next Steps

- Learn about [Troubleshooting & Diagnostics](troubleshooting.md).
- Review [Architecture & Process Topology](../architecture/overview.md).
