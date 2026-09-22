# Key-Value (KV) Storage — Overview

> [!NOTE]
> **Documentation**: [Docs Home](../../README.md) &nbsp;|&nbsp;
> **Specification**: [KV-1, KV-2, KV-3](../../contracts/kv.contract.md)
> &nbsp;|&nbsp; **Payload Limit**: 256 KB per value

The Key-Value primitive (`ctx.kv` / `KVBinding`) provides ultra-low-latency
structured state storage using hierarchical string tuple keys and atomic
Check-And-Set (`CAS`) transactions.

---

## 1. Key Concepts

- **Hierarchical Tuple Keys**: Keys are arrays of strings (e.g.
  `["users", "123", "settings"]`), enabling structured prefix queries.
- **Atomic Operations (`KV-3`)**: Atomic mutation pipelines
  (`atomic().check().set().commit()`) allow safe concurrent updates without
  locks.
- **TTL Expiration**: Keys support time-to-live expiration in seconds, required
  for deduplication markers and ephemeral sessions.
- **Size Ceilings (`KV-1`)**: Values are capped at 256 KB. For multi-megabyte
  payloads, use the [Objects Primitive](../objects/overview.md).

---

## 2. API Usage

```typescript
import type { KVBinding } from "@railfog/sdk";

export async function demonstrateKV(kv: KVBinding): Promise<void> {
  // 1. Set key with 1-hour TTL (KV-2)
  await kv.set(["sessions", "user_123"], { role: "admin" }, { ttl: 3600 });

  // 2. Retrieve typed entry
  const session = await kv.get<{ role: string }>(["sessions", "user_123"]);

  // 3. Prefix list scan
  const { entries } = await kv.list(["sessions"], { limit: 50 });
  for (const entry of entries) {
    console.log(entry.key, entry.value);
  }

  // 4. Delete entry
  await kv.delete(["sessions", "user_123"]);
}
```

---

## Next Steps

- Learn about [Consistency Tiers & Atomic CAS](consistency.md).
- Explore the [Objects Primitive](../objects/overview.md).
