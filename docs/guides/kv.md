# Key-Value (KV) Storage Guide

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`KV-1` to `KV-5`](../contracts/kv.contract.md) &nbsp;|&nbsp; **Size
> Ceiling**: 256 KB per value

The Key-Value (KV) primitive provides low-latency structured state storage. It
is the infrastructure implementation of the **State** concept (`remember`) ([`State Concept`](../concepts/state.md)),
accessible in handlers via `ctx.state` (with `ctx.kv` supported for backwards compatibility) ([`CONCEPT-2`](../contracts/concepts.contract.md#CONCEPT-2)). It
uses hierarchical string tuple keys and supports atomic Check-And-Set (`CAS`)
optimistic concurrency.

---

## 1. Declaring KV in `railfog.toml`

KV namespaces are declared under `[kv.<name>]` and bound to functions via
`permissions.kv`:

```toml
name = "my-app"

[functions.api]
entry = "functions/api.ts"
[functions.api.permissions]
kv = ["app:sessions"]

[kv."app:sessions"]
consistency = "strong"
```

### Consistency Tiers (`KV-5`)

- **`strong`**: Linearizable, single-record consistency with atomic `CAS`
  support. Required for sessions, locks, deduplication markers, and counters.
- **`eventual`**: Replicated convergence across distributed edge nodes within
  seconds. Optimized for high-throughput reads (e.g. feature flags, cached
  metadata).

---

## 2. Basic CRUD Operations

```typescript
import type { FunctionHandler } from "@railfog/sdk";

const handler: FunctionHandler = async (req, ctx) => {
  const state = ctx.state;

  // 1. Set a value with 1-hour TTL (KV-2)
  await state.set(["users", "u_123"], { name: "Alice", role: "admin" }, {
    ttl: 3600,
  });

  // 2. Retrieve a typed value
  const user = await state.get<{ name: string; role: string }>(["users", "u_123"]);

  // 3. Prefix list scan (KV-2)
  const { entries, cursor } = await state.list(["users"], { limit: 20 });
  for (const entry of entries) {
    console.log(entry.key, entry.value, entry.versionstamp);
  }

  // 4. Delete an entry
  await state.delete(["users", "u_123"]);

  return Response.json({ user });
};

export default handler;
```

---

## 3. Atomic Check-And-Set (`CAS`) Mutations (`KV-3`)

To prevent lost updates under concurrent access, use `state.atomic()`:

```typescript
import type { FunctionHandler } from "@railfog/sdk";
import { ConflictError } from "@railfog/sdk";

const handler: FunctionHandler = async (req, ctx) => {
  const counterKey = ["counters", "signups"];
  const state = ctx.state;

  // Read current version and value
  const current = await state.get<number>(counterKey);
  const currentValue = current ?? 0;

  // Attempt atomic CAS mutation
  const result = await state.atomic()
    .check(counterKey, currentValue)
    .set(counterKey, currentValue + 1)
    .commit();

  if (!result.ok) {
    // Another concurrent invocation modified the key first
    throw new ConflictError(
      "Concurrent update detected; please retry",
      ctx.requestId,
    );
  }

  return Response.json({ count: currentValue + 1 });
};

export default handler;
```

Alternatively, use the high-level `mutate` helper from `@railfog/sdk`:

```typescript
import { compute, type HandlerContext, mutate } from "@railfog/sdk";

export default compute(async (c: HandlerContext) => {
  const updatedCount = await mutate<number>(
    c.state,
    ["counters", "signups"],
    (current) => (current ?? 0) + 1,
    { maxRetries: 5 },
  );

  return c.json({ count: updatedCount });
});
```

---

## 4. Key Rules & Constraints

1. **Tuple Keys**: Keys are arrays of strings, e.g.
   `["orgs", "123", "members", "456"]`. Strings must not contain null bytes.
2. **256 KB Value Ceiling (`KV-1`)**: Values exceeding 256 KB are rejected with
   `413 PAYLOAD_TOO_LARGE`. Store large binary assets in [Objects](objects.md)
   instead.
3. **Mandatory TTL on Ephemeral Data**: Keys used as deduplication markers must
   declare a TTL (`ttl: seconds`) to prevent unbounded storage growth.

---

## Next Steps

- Learn about [Direct Object Transfers](objects.md).
- Learn about [Queues & Deduplication](queues.md).
