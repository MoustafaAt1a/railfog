# RailFog TypeScript SDK Overview

> [!NOTE]
> **Package**: `@railfog/sdk` &nbsp;|&nbsp; **Runtime**: Deno v2.0+ Native Web Standards &nbsp;|&nbsp; **Specification**: [`CONCEPT-1`](../contracts/concepts.contract.md#CONCEPT-1), [`CONCEPT-2`](../contracts/concepts.contract.md#CONCEPT-2), [`PLAT-19`](../contracts/platform.contract.md#PLAT-19)

`@railfog/sdk` is the official developer-facing TypeScript SDK for RailFog.

---

## 1. The Four Fundamental Concepts

RailFog presents four developer-facing concepts:

$$\text{RailFog} = \{\mathbf{Compute},\, \mathbf{State},\, \mathbf{Data},\, \mathbf{Signal}\}$$

| Developer Concept | Infrastructure Primitive | Fundamental Role | Action Verb | SDK Surface |
| :--- | :--- | :--- | :--- | :--- |
| **Compute** | Function | Execute application logic | `transform` | `compute()`, `handle()`, `api()`, `router()` |
| **State** | KV | Remember small mutable state | `remember` | `c.state.get/set/delete/atomic` |
| **Data** | Object | Persist durable bulk bytes | `persist` | `c.data.get/put/delete/presign` |
| **Signal** | Queue | Communicate asynchronously | `communicate` | `c.signal.send`, `consumer()` |

The developer layer exposes capabilities and concepts, keeping cloud infrastructure drivers and provider mechanics abstracted away (`CONCEPT-2`).

---

## 2. Zero-Boilerplate Handler Example

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ req, state, data, signal, json }) => {
  // 1. Transform / Compute: parse incoming request
  const body = await req.json();

  // 2. State: remember session / state record
  await state.set(["sessions", body.sessionId], { active: true });

  // 3. Data: generate presigned transfer for client upload
  const { url } = await data.presign(`uploads/${body.fileId}`, {
    method: "PUT",
    expiresIn: 3600,
  });

  // 4. Signal: dispatch asynchronous processing job
  await signal.send({ event: "upload.initialized", fileId: body.fileId });

  return json({ ok: true, uploadUrl: url });
});
```

---

## 3. Backward Compatibility & Dual Names

RailFog provides complete backward compatibility. Both the conceptual accessors and the infrastructure primitive bindings are accessible on the context object with zero performance overhead:

- `c.state === c.kv`
- `c.data === c.objects`
- `c.signal === c.queues`

Existing code using `({ kv, objects, queues })` continues to function with zero changes.

---

## 4. WHATWG `AbortSignal` vs. Asynchronous `c.signal`

RailFog strictly decouples HTTP request cancellation from asynchronous message dispatch (`CONCEPT-2`, `FN-5`):

- **`c.req.signal` (`AbortSignal`)**: Standard Web API `AbortSignal` reflecting request timeout or client disconnection.
- **`c.signal` (`SignalBinding`)**: The messaging capability used to dispatch events to queues.

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ req, signal, text }) => {
  if (req.signal.aborted) {
    return text("Client aborted", 499);
  }

  await signal.send({ action: "audit.log", timestamp: Date.now() });
  return text("OK");
});
```
