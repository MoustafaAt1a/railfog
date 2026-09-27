# SDK: State

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Package**: `@railfog/sdk` &nbsp;|&nbsp; **Conceptual Layer**: State &nbsp;|&nbsp; **Specification**: [`CONCEPT-2`](../contracts/concepts.contract.md#CONCEPT-2), [`KV-2`](../contracts/kv.contract.md#KV-2)

State represents lightweight mutable memory accessed via `c.state` (or `c.kv`).

---

## 1. `StateBinding` Methods

```typescript
export interface StateBinding {
  get<T = unknown>(key: string[]): Promise<T | null>;
  set(key: string[], value: unknown, options?: { ttl?: number }): Promise<void>;
  delete(key: string[]): Promise<void>;
  list<T = unknown>(prefix: string[], options?: ListOptions): Promise<{
    entries: Array<{ key: string[]; value: T; version: number }>;
    cursor?: string;
  }>;
  atomic(): KVAtomicOperation;
}
```

---

## 2. Hierarchical Tuple Keys (`KV-4`)

Keys are arrays of strings representing logical namespaces and entity identifiers:

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ state, json }) => {
  // Store user record
  await state.set(["org_1", "users", "usr_42"], {
    name: "Alex",
    role: "admin",
  });

  // Query user record
  const user = await state.get<{ name: string }>(["org_1", "users", "usr_42"]);

  return json({ user });
});
```

---

## 3. Optimistic Concurrency Control (`atomic()`)

`state.atomic()` provides atomic check-and-set transactions:

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ state, json }) => {
  const existing = await state.get<{ version: number }>(["accounts", "acc_1"]);

  const tx = state.atomic();
  tx.set(["accounts", "acc_1"], { balance: 500 });
  const result = await tx.commit();

  return json({ ok: result.ok });
});
```
