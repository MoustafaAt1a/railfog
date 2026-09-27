# State Concept

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Conceptual Layer**: State &nbsp;|&nbsp; **Verb**: `remember` &nbsp;|&nbsp; **Infrastructure Mapping**: KV ([`KV-1`](../contracts/kv.contract.md#KV-1)) &nbsp;|&nbsp; **Specification**: [`CONCEPT-1`](../contracts/concepts.contract.md#CONCEPT-1), [`CONCEPT-2`](../contracts/concepts.contract.md#CONCEPT-2)

State represents small, addressable, mutable application state in RailFog.

$$\text{key} \longrightarrow \mathbf{State} \longrightarrow \text{value}$$

---

## 1. Definition & Role

State is responsible for:
- **Remembering**: Preserving lightweight mutable data across stateless Compute invocations (`remember`).
- **Addressing**: Accessing entries via hierarchical tuple keys (e.g. `["users", userId, "settings"]`).
- **Coordinating**: Supporting atomic check-and-set transactions (`atomic()`, CAS) for concurrency control.
- **Expiring**: Supporting automatic entry eviction via time-to-live (`ttl`).

### Typical Uses
- User sessions and authentication tokens
- Atomic counters and rate limiting buckets
- Feature flags and configuration values
- Optimistic locks and distributed coordination
- Small structured application records (up to 256 KB per entry)

State **should not become a general-purpose relational or document database abstraction**. For durable bulk binary data, use Data (`persist`).

---

## 2. Conceptual vs. Infrastructure Mapping

| Layer | Terminology | Description |
| :--- | :--- | :--- |
| **Developer Concept** | **State** | The product abstraction representing mutable memory and coordination. |
| **Infrastructure Primitive** | **KV** | Key-Value storage engine (SQLite, Redis, Cloudflare KV, FoundationDB). |
| **Fundamental Verb** | **`remember`** | The singular action performed by State. |

The application interacts with State independently of whether the underlying provider is embedded SQLite in local development or a globally replicated KV cluster in production (`PLAT-16`, `CONCEPT-5`).

---

## 3. SDK Mental Model

The SDK exposes State through pre-scoped capabilities:

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ state, json }) => {
  // Read state
  const session = await state.get<{ userId: string }>(["sessions", "s_123"]);

  // Mutate state with TTL
  await state.set(["sessions", "s_123"], { userId: "usr_42" }, { ttl: 3600 });

  // Atomic check-and-set (optimistic concurrency)
  const tx = state.atomic();
  tx.set(["counter", "hits"], 1);
  const result = await tx.commit();

  return json({ ok: result.ok, session });
});
```

---

## 4. Semantic Integrity

Per `CONCEPT-5`, RailFog does not falsify State consistency guarantees:
- If the configured State provider is eventual (`KV-5`), linearizable reads are not promised.
- If the provider guarantees strong serializability, the application can rely on monotonic version increments.
- State access is scoped to a single namespace per function (`CONCEPT-6`).
