# Consistency Tiers & Concurrency

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`KV-3`](../contracts/kv.contract.md#KV-3),
> [`KV-5`](../contracts/kv.contract.md#KV-5) &nbsp;|&nbsp; **Guarantees**:
> Linearizable Strong vs. Replicated Eventual

RailFog provides explicit control over storage consistency models, allowing
applications to balance low-latency global distribution with strict linearizable
correctness.

---

## 1. The Two Consistency Tiers (`KV-5`)

Every KV namespace declares its consistency model in `railfog.toml`:

```toml
[kv."app:sessions"]
consistency = "strong"

[kv."app:flags"]
consistency = "eventual"
```

| Dimension               | `strong` Consistency                                  | `eventual` Consistency                                   |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| **Semantics**           | Linearizable, single-record serializability           | Replicated convergence within seconds                    |
| **Read Guarantees**     | Always returns the most recent committed write        | Reads may reflect slightly stale replicas                |
| **Atomic CAS (`KV-3`)** | **Supported** via `kv.atomic().check().set()`         | **Prohibited** (throws `ValidationFailedError`)          |
| **Typical Use Cases**   | User sessions, billing counters, locks, deduplication | Feature flags, cached catalog data, static configuration |
| **Backing Adapters**    | PostgreSQL, SQLite, Redis                             | Cloudflare KV, distributed edge caches                   |

---

## 2. No Silent Downgrades (`KV-5`)

A critical reliability invariant in RailFog:

> **Requesting `strong` consistency on an eventual-backed provider is a
> deploy-time validation error, never a silent downgrade.**

If an application declares `consistency = "strong"` but the deployed
infrastructure only provides an eventual-consistency adapter (e.g. basic
distributed edge KV without consensus), the deployment is rejected at deploy
time by `rail check` and `rail deploy`. The platform never silently compromises
correctness for availability.

---

## 3. Optimistic Concurrency Control (OCC) (`KV-3`)

To prevent race conditions without acquiring distributed locks, RailFog
implements atomic Check-And-Set mutations:

1. **Read**: The handler reads a key's current value and versionstamp.
2. **Compute**: The handler computes the desired state change in local isolate
   memory.
3. **Commit**: The handler issues an atomic mutation pipeline:
   ```typescript
   const result = await kv.atomic()
     .check(key, currentVersion)
     .set(key, newValue)
     .commit();
   ```
4. **Outcome**:
   - If the key version matches `currentVersion`, the write succeeds atomically
     (`result.ok = true`).
   - If a concurrent invocation modified the key in the interim, the transaction
     aborts cleanly (`result.ok = false`), enabling caller retries.

---

## Next Steps

- Learn about the [Failure Model & Availability](failure-model.md).
- Review the [KV Storage Guide](../guides/kv.md).
