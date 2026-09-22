# Functions Primitive — Overview

> [!NOTE]
> **Documentation**: [Docs Home](../../README.md) &nbsp;|&nbsp;
> **Specification**: [FN-1, FN-2, FN-4](../../contracts/functions.contract.md)
> &nbsp;|&nbsp; **Handler Signature**:
> `(req: Request, ctx: RailFogContext) => Promise<Response>`

Functions are the primary compute primitive of RailFog. They are stateless,
isolated TypeScript execution units invoked by triggers.

---

## 1. Handler Signatures

### 1.1 HTTP Function Handler (`FN-1`)

HTTP-triggered functions accept standard Web API `Request` objects and return
standard Web API `Response` objects:

```typescript
import type { FunctionHandler } from "@railfog/sdk";

const handler: FunctionHandler = async (req, ctx) => {
  const url = new URL(req.url);
  return Response.json({
    pathname: url.pathname,
    project: ctx.project,
    requestId: ctx.requestId,
  });
};

export default handler;
```

### 1.2 Queue Consumer Handler (`FN-2`, `Q-2`)

Queue-triggered functions receive typed `QueueMessage` objects:

```typescript
import type { QueueConsumerHandler } from "@railfog/sdk";

interface TaskPayload {
  jobId: string;
}

const consume: QueueConsumerHandler<TaskPayload> = async (message, ctx) => {
  const { jobId } = message.body;
  await ctx.kv.set(["jobs", jobId], { status: "completed" });
};

export default consume;
```

---

## 2. Trigger Types (`FN-2`)

Functions declare triggers in `railfog.toml`:

```toml
[functions.processor]
entry = "functions/processor.ts"

[functions.processor.triggers]
http = true
queue = "app:jobs"
schedule = "*/15 * * * *"
webhook = true
```

| Trigger    | Description                                        | Payload Delivery                                          |
| ---------- | -------------------------------------------------- | --------------------------------------------------------- |
| `http`     | Invoked on matching HTTP requests (`[[routes]]`).  | Web API `Request` instance.                               |
| `queue`    | Invoked for messages delivered by the queue.       | `QueueMessage<T>` instance with `body`, `id`, `attempts`. |
| `schedule` | Invoked on standard cron ticks.                    | Synthetic `Request` with cron execution timestamp.        |
| `webhook`  | Invoked by authenticated external webhook callers. | Web API `Request` with signature validation headers.      |

---

## Next Steps

- Learn about [Resource Limits & Quotas](limits.md).
- Explore the [Key-Value Primitive](../kv/overview.md).
