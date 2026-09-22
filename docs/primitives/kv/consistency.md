# KV — Consistency Tiers & Atomic Operations

> [!NOTE]
> **Documentation**: [Docs Home](../../README.md) &nbsp;|&nbsp;
> **Specification**:
> [KV-3 (Atomic CAS), KV-5 (Consistency Tiers)](../../contracts/kv.contract.md)
> &nbsp;|&nbsp; **Enforcement**: Deploy-time validation (Zero silent downgrades)

RailFog KV provides two explicit consistency tiers: **`strong`** and
**`eventual`** (`KV-5`).

---

## 1. Consistency Tiers (`KV-5`)

Configured in `railfog.toml`:

```toml
[kv."app:sessions"]
consistency = "strong"

[kv."app:features"]
consistency = "eventual"
```

| Tier           | Guarantees                                                     | Atomic CAS (`KV-3`) | Typical Use Cases                                           | Backing Providers                         |
| -------------- | -------------------------------------------------------------- | ------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| **`strong`**   | Linearizable per-key consistency. Guaranteed read-your-writes. | **Supported**       | Sessions, financial balances, locks, deduplication markers. | SQLite (Local), Deno Deploy KV, Postgres. |
| **`eventual`** | Replicated convergence within seconds. No ordering guarantees. | Not Supported       | Feature flags, cached configurations, read-heavy catalogs.  | Edge KV, Cloudflare Workers KV.           |

> [!WARNING]
> Requesting `strong` consistency on an eventual-backed provider is a
> deploy-time validation error, never a silent downgrade (`KV-5`).

---

## 2. Atomic Check-And-Set (`CAS`) Transactions (`KV-3`)

Under `strong` consistency, callers perform atomic optimistic concurrency
mutations:

```typescript
import type { KVBinding } from "@railfog/sdk";

export async function incrementCounter(
  kv: KVBinding,
  key: string[],
): Promise<number> {
  while (true) {
    const entry = await kv.get<number>(key);
    const currentValue = entry ?? 0;
    const nextValue = currentValue + 1;

    // Check version/value before writing (KV-3)
    const result = await kv.atomic()
      .check(key, currentValue)
      .set(key, nextValue)
      .commit();

    if (result.ok) {
      return nextValue;
    }
    // Optimistic concurrency collision: loop and retry
  }
}
```

---

## Next Steps

- Explore the [Objects Primitive](../objects/overview.md).
- Learn about the [Queues Primitive](../queues/overview.md).
