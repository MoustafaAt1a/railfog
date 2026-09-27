# Writing Functions

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`FN-1`](../contracts/functions.contract.md#FN-1),
> [`FN-2`](../contracts/functions.contract.md#FN-2),
> [`FN-4`](../contracts/functions.contract.md#FN-4) &nbsp;|&nbsp; **Package**:
> `@railfog/sdk`

Functions are the compute primitive of RailFog. They run in sandboxed V8
execution threads with zero ambient authority and receive scoped capability
bindings for each invocation.

---

## 1. Handler Signatures

RailFog supports standard Web API handlers as well as ergonomic helper wrappers
from `@railfog/sdk`.

### 1.1 Minimal Compute Handler (`compute` / `handle`)

The `compute` helper (aliasing `handle`) automatically wraps the function, parses JSON/body payloads,
sets content headers, and provides response helpers on `HandlerContext`:

```typescript
import { compute, type HandlerContext } from "@railfog/sdk";

export default compute(async (c: HandlerContext) => {
  const name = c.query.name ?? "World";
  return c.json({ message: `Hello, ${name}!` });
});
```

---

### 1.2 Micro-Router (`api`)

For functions handling multiple sub-paths and HTTP methods:

```typescript
import { api, type HandlerContext } from "@railfog/sdk";

export default api({
  "GET /items": async (c: HandlerContext) => {
    const items = await c.state.get(["items"]) ?? [];
    return c.json({ items });
  },

  "POST /items": async (c: HandlerContext) => {
    const body = await c.body<{ name: string }>();
    const id = crypto.randomUUID();
    await c.state.set(["items", id], { id, name: body.name });
    return c.json({ id, name: body.name }, 201);
  },
});
```

---

### 1.3 Asynchronous Queue Consumer (`consumer`)

For functions triggered by queue messages (`triggers.queue = "app:jobs"`):

```typescript
import { consumer, type ConsumerContext, type QueueMessage } from "@railfog/sdk";

interface JobPayload {
  fileKey: string;
}

export default consumer<JobPayload>(
  async (message: QueueMessage<JobPayload>, ctx: ConsumerContext) => {
    const { fileKey } = message.body;
    console.log(`Processing file: ${fileKey} (attempt ${message.attempts})`);

    // Perform background processing and commit state...
    await ctx.state.set(["processed", fileKey], { timestamp: Date.now() });
  },
  { idempotent: true, ttlSeconds: 86400 },
);
```

---

### 1.4 Raw Standard Handler (`FunctionHandler`)

If you prefer zero wrappers, export a standard `FunctionHandler`:

```typescript
import type { FunctionHandler, RailFogContext } from "@railfog/sdk";

const handler: FunctionHandler = async (
  req: Request,
  ctx: RailFogContext,
): Promise<Response> => {
  return Response.json({
    status: "ok",
    requestId: ctx.requestId,
    remainingMs: ctx.timeRemaining(),
  });
};

export default handler;
```

---

## 2. Injected Context & Capabilities

Every invocation receives a context object providing metadata and
capability-scoped client bindings:

| Property                  | Type            | Description                                                              |
| ------------------------- | --------------- | ------------------------------------------------------------------------ |
| `ctx.requestId`           | `string`        | Sortable ULID correlating Gateway, Runtime, and Storage logs (`PLAT-14`) |
| `ctx.project`             | `string`        | Project name declared in `railfog.toml` (`PLAT-18`)                      |
| `ctx.revision`            | `string`        | Deployed revision ULID (`FN-3`)                                          |
| `ctx.deadline`            | `number`        | Unix epoch millisecond timestamp when invocation will be killed (`FN-5`) |
| `ctx.timeRemaining()`     | `() => number`  | Milliseconds remaining before the hard timeout kill                      |
| `ctx.state` / `c.state` (`ctx.kv`)       | `StateBinding`  | Scoped State store declared in `permissions.state` (or `permissions.kv`) |
| `ctx.data` / `c.data` (`ctx.objects`)   | `DataBinding`   | Scoped Data store bucket declared in `permissions.data` (or `permissions.objects`) |
| `ctx.signal` / `c.signal` (`ctx.queues`) | `SignalBinding` | Scoped Signal channel declared in `permissions.signal` (or `permissions.queues`) |
| `ctx.env`                               | `EnvBinding`    | Scoped secret accessor declared in `permissions.secrets`                 |

---

## 3. Important: `c.req.signal` vs `c.signal`

RailFog strictly decouples client connection abort signals from asynchronous
queue signaling:

- `c.req.signal` is the standard WHATWG `AbortSignal` for the incoming HTTP
  request. Use it to cancel in-flight `fetch()` calls if the client disconnects
  early.
- `c.signal` is the `SignalBinding` (for asynchronous message dispatch). Use it to publish
  messages: `await c.signal.send({ taskId })`.

---

## 4. Trigger Configuration in `railfog.toml`

Functions declare how they are invoked under `[functions.<name>.triggers]`:

```toml
[functions.api]
entry = "functions/api.ts"
[functions.api.triggers]
http = true

[functions.worker]
entry = "functions/worker.ts"
[functions.worker.triggers]
queue = "app:jobs"

[functions.cleanup]
entry = "functions/cleanup.ts"
[functions.cleanup.triggers]
schedule = "0 0 * * *"
```

---

## Next Steps

- Learn about [Key-Value Storage](kv.md).
- Learn about [Direct Object Transfers](objects.md).
- Learn about [Asynchronous Queues](queues.md).
