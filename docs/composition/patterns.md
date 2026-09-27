# Composition Patterns

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Architecture**: Composition Patterns &nbsp;|&nbsp; **Specification**: [`CONCEPT-4`](../contracts/concepts.contract.md#CONCEPT-4), [`CONCEPT-8`](../contracts/concepts.contract.md#CONCEPT-8)

This guide documents canonical architectural compositions implemented with RailFog's four primitives.

---

## 1. Pattern: Cache & Session Store (`Compute + State`)

Instead of requiring an external Redis service or memory cache primitive:

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ req, state, json }) => {
  const url = new URL(req.url);
  const cacheKey = ["cache", url.pathname];

  // 1. Cache hit check
  const cached = await state.get<Record<string, unknown>>(cacheKey);
  if (cached) {
    return json({ ...cached, source: "cache" });
  }

  // 2. Compute heavy result
  const fresh = { computedAt: Date.now(), data: "computed-value" };

  // 3. Populate state cache with TTL (5 minutes)
  await state.set(cacheKey, fresh, { ttl: 300 });

  return json({ ...fresh, source: "origin" });
});
```

---

## 2. Pattern: Background Job Processing (`Compute + Signal`)

Instead of deploying a dedicated background worker infrastructure:

```typescript
// Producer: Ingress HTTP endpoint
import { compute } from "@railfog/sdk";

export default compute(async ({ req, signal, json }) => {
  const jobPayload = await req.json();

  const { id } = await signal.send({
    jobType: "generate_invoice",
    payload: jobPayload,
  });

  return json({ accepted: true, jobId: id }, 202);
});
```

```typescript
// Consumer: Asynchronous queue worker
import { consumer, type QueueMessage } from "@railfog/sdk";

interface InvoiceJob {
  jobType: string;
  payload: { customerId: string; amount: number };
}

export default consumer<InvoiceJob>(
  async (message: QueueMessage<InvoiceJob>, { state }) => {
    // Perform processing and store state
    await state.set(["invoices", message.id], {
      status: "GENERATED",
      customerId: message.body.payload.customerId,
    });
  },
  { idempotent: true, ttlSeconds: 86400 },
);
```

---

## 3. Pattern: Direct Media Ingest & Streaming Processing (`Data + Compute`)

Enforcing the zero-proxy rule (`OBJ-3`, `CONCEPT-7`):

```typescript
// Direct Upload Presigning
import { compute } from "@railfog/sdk";

export default compute(async ({ data, json }) => {
  const upload = await data.presign("avatars/user-42.png", {
    method: "PUT",
    expiresIn: 900,
  });

  return json({ uploadUrl: upload.url });
});
```

---

## 4. Pattern: End-to-End Orchestrated Pipeline

$$\text{Data} \longrightarrow \text{Compute} \longrightarrow \text{State} \longrightarrow \text{Signal} \longrightarrow \text{Compute} \longrightarrow \text{Data}$$

See the formal [Worked Example](../contracts/worked-example.md) for the end-to-end multi-stage reference implementation.
