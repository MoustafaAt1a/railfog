# TypeScript SDK Developer Guide (`@railfog/sdk`)

> [!NOTE]
> **Package**: `@railfog/sdk` &nbsp;|&nbsp;
> **Runtime**: Deno v2.0+ &nbsp;|&nbsp;
> **Dependencies**: Zero External (Native Web Standards Only) &nbsp;|&nbsp;
> **Types**: Strict Mode Compatible

This guide provides the complete developer reference for building functions, consumers, and services using `@railfog/sdk`.

---

## 1. Core Architecture & Invocation Model

RailFog strictly enforces the **Trigger -> Function** computational model ([`PLAT-2`](contracts/platform.contract.md#PLAT-2), [`FN-1`](contracts/functions.contract.md#FN-1), [`FN-2`](contracts/functions.contract.md#FN-2)). Workloads originating from HTTP routes, scheduled cron ticks, queue messages, or webhooks invoke isolated TypeScript function handlers.

### Capability Injection ([`PLAT-6`](contracts/platform.contract.md#PLAT-6), [`FN-4`](contracts/functions.contract.md#FN-4))
Functions do not import a global ambient SDK client. Instead, each invocation receives an isolated `RailFogContext` (`ctx`) carrying capability bindings physically scoped to the manifest declarations in `railfog.toml`:
- `ctx.kv`: Key-Value storage scoped to the declared namespace ([`KV-2`](contracts/kv.contract.md#KV-2)).
- `ctx.objects`: Object storage scoped to the declared bucket ([`OBJ-2`](contracts/objects.contract.md#OBJ-2)).
- `ctx.queues`: Queue sender scoped to the declared target queue ([`Q-2`](contracts/queues.contract.md#Q-2)).
- `ctx.env`: Environment secrets scoped to declared secret keys ([`PLAT-15`](contracts/platform.contract.md#PLAT-15)).

> [!IMPORTANT]
> If a capability is not declared in `railfog.toml`, the property on `ctx` is undefined. Undeclared resources cannot be accessed at runtime.

---

## 2. Invocation Context: `RailFogContext` ([`FN-4`](contracts/functions.contract.md#FN-4))

The `RailFogContext` interface provides invocation metadata and capability-scoped bindings:

```typescript
import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
  QueueMessage,
  RailFogContext,
} from "@railfog/sdk";

export default async function handler(
  req: Request,
  ctx: RailFogContext,
): Promise<Response> {
  // Invocation metadata (PLAT-14 ULID request tracking)
  const requestId = ctx.requestId;
  const project = ctx.project;
  const fnName = ctx.function;
  const revision = ctx.revision;

  // Deadline tracking and execution budget (FN-4, FN-5)
  const msRemaining = ctx.timeRemaining();
  if (msRemaining < 50) {
    return Response.json({ error: "Execution deadline imminent" }, { status: 504 });
  }

  // Access capability-scoped secrets (PLAT-15)
  const apiKey = ctx.env.require("API_KEY");

  return Response.json({ project, function: fnName, requestId });
}
```

### Context API Reference

| Member | Type | Spec Anchor | Description |
|---|---|---|---|
| `ctx.requestId` | `string` | [`PLAT-14`](contracts/platform.contract.md#PLAT-14) | Monotonically sortable ULID tracking the invocation across gateway, logs, and storage. |
| `ctx.project` | `string` | [`PLAT-18`](contracts/platform.contract.md#PLAT-18) | Project resource name declared in `railfog.toml`. |
| `ctx.function` | `string` | [`FN-1`](contracts/functions.contract.md#FN-1) | Name of the currently executing function. |
| `ctx.revision` | `string` | [`PLAT-3`](contracts/platform.contract.md#PLAT-3) | Immutable deployment revision identifier. |
| `ctx.deadline` | `number` | [`FN-5`](contracts/functions.contract.md#FN-5) | Epoch millisecond timestamp of the hard termination deadline. |
| `ctx.timeRemaining()` | `() => number` | [`FN-4`](contracts/functions.contract.md#FN-4) | Returns milliseconds remaining before hard termination. |
| `ctx.kv` | `KVBinding` | [`KV-2`](contracts/kv.contract.md#KV-2) | Capability-scoped Key-Value storage handle. |
| `ctx.objects` | `ObjectBinding` | [`OBJ-2`](contracts/objects.contract.md#OBJ-2) | Capability-scoped Object storage handle. |
| `ctx.queues` | `QueueBinding` | [`Q-2`](contracts/queues.contract.md#Q-2) | Capability-scoped Queue sender handle. |
| `ctx.env` | `EnvBinding` | [`PLAT-15`](contracts/platform.contract.md#PLAT-15) | Capability-scoped encrypted secret resolver. |

---

## 3. Storage Primitives

### 3.1 Key-Value Storage (`ctx.kv` / `KVBinding`) ([`KV-2`](contracts/kv.contract.md#KV-2), [`KV-5`](contracts/kv.contract.md#KV-5))
The KV primitive provides structured state management up to 256 KB per entry ([`KV-1`](contracts/kv.contract.md#KV-1)) using hierarchical string tuple keys and atomic Check-And-Set transactions ([`KV-3`](contracts/kv.contract.md#KV-3)).

```typescript
import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
  QueueMessage,
  RailFogContext,
} from "@railfog/sdk";

export async function demonstrateKV(kv: KVBinding): Promise<void> {
  // Set value with optional TTL in seconds (KV-2)
  await kv.set(["sessions", "user-123"], { authenticated: true }, { ttl: 3600 });

  // Retrieve typed value
  const session = await kv.get<{ authenticated: boolean }>(["sessions", "user-123"]);

  // Atomic Check-And-Set (CAS) transaction (KV-2, KV-3)
  const atomic = kv.atomic();
  atomic
    .check(["counters", "hits"], 10)
    .set(["counters", "hits"], 11);
  const commitResult = await atomic.commit();
  if (!commitResult.ok) {
    // CAS version conflict: caller re-reads and retries (KV-3)
    return;
  }

  // Prefix scan over hierarchical keys
  const { entries } = await kv.list(["sessions"], { limit: 50 });

  // Delete key
  await kv.delete(["sessions", "user-123"]);
}
```

---

### 3.2 Object Storage (`ctx.objects` / `ObjectBinding`) ([`OBJ-2`](contracts/objects.contract.md#OBJ-2), [`OBJ-3`](contracts/objects.contract.md#OBJ-3))
The Object primitive stores durable binary assets such as file uploads, media, and datasets ([`OBJ-1`](contracts/objects.contract.md#OBJ-1)).

#### Direct Client-to-Storage Transfer ([`OBJ-3`](contracts/objects.contract.md#OBJ-3) — Never a Bandwidth Proxy)
RailFog functions **never act as a bandwidth proxy**. Streaming large binary payloads through serverless functions consumes isolate memory, CPU cycles, and network bandwidth while degrading concurrency.

Instead, functions generate time-limited SigV4 presigned URLs via `ctx.objects.presign`, allowing clients to stream bytes directly to storage:

```typescript
import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
  QueueMessage,
  RailFogContext,
} from "@railfog/sdk";

export default async function handler(
  req: Request,
  ctx: RailFogContext,
): Promise<Response> {
  const uploadKey = crypto.randomUUID();

  // Generate presigned PUT URL for direct client upload (OBJ-3)
  const { url } = await ctx.objects.presign(uploadKey, {
    method: "PUT",
    expiresIn: 900, // 15 minutes expiration
  });

  // Client uploads directly to storage — Function never proxies bytes
  return Response.json({ uploadUrl: url, key: uploadKey });
}
```

```
Direct Client-Storage Transfer Sequence (OBJ-3):
Client ───────(1) Request Upload URL────────► Function (api.ts)
Client ◄──────(2) Presigned PUT URL────────── Function
Client ───────(3) PUT Binary Bytes Direct───► S3 / R2 Bucket (app:uploads)
```

---

### 3.3 Asynchronous Queues (`ctx.queues` / `QueueBinding`) ([`Q-2`](contracts/queues.contract.md#Q-2), [`Q-3`](contracts/queues.contract.md#Q-3))
Queues provide decoupled message processing with at-least-once delivery ([`Q-1`](contracts/queues.contract.md#Q-1)). Payloads are capped at 128 KB ([`Q-2`](contracts/queues.contract.md#Q-2)).

```typescript
import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
  QueueMessage,
  RailFogContext,
} from "@railfog/sdk";

export async function dispatchJobs(queues: QueueBinding): Promise<void> {
  // Send single message with optional delivery delay up to 15 minutes (Q-2)
  const { id } = await queues.send({ taskId: "task_456", action: "index" }, { delay: 60 });

  // Send batch of messages atomically
  const results = await queues.sendBatch([
    { taskId: "task_789", action: "thumbnail" },
    { taskId: "task_790", action: "transcode" },
  ]);
}
```

---

## 4. Reliability Helpers

RailFog provides standard reliability primitives in `@railfog/sdk` as library code built over KV ([`Q-6`](contracts/queues.contract.md#Q-6)), avoiding unnecessary platform complexity.

### 4.1 `withIdempotency` ([`Q-4`](contracts/queues.contract.md#Q-4), [`KV-2`](contracts/kv.contract.md#KV-2))
Guarantees exactly-once execution semantics for queue consumers under at-least-once delivery ([`Q-1`](contracts/queues.contract.md#Q-1)).

The deduplication marker is stored in KV with a mandatory TTL matching the queue's retention window (`14 * 24 * 3600` seconds / 14 days per [`Q-4`](contracts/queues.contract.md#Q-4)). Omission of TTL is strictly rejected to prevent unbounded database growth.

```typescript
import { withIdempotency } from "@railfog/sdk";
import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
  QueueMessage,
  RailFogContext,
} from "@railfog/sdk";

export async function processOrder(kv: KVBinding, orderId: string): Promise<void> {
  const dedupeKey = ["processed_orders", orderId];

  const { processed, result } = await withIdempotency(
    kv,
    dedupeKey,
    async () => {
      // Business logic executed exactly once within retention window
      return { status: "settled", timestamp: Date.now() };
    },
    { ttlSeconds: 14 * 24 * 3600 }, // Mandatory 14-day retention TTL (Q-4)
  );
}
```

---

### 4.2 `withRetry` ([`Q-5`](contracts/queues.contract.md#Q-5))
Executes transient network operations using exponential backoff with decorrelated jitter to prevent thundering herds:

$$t_{\text{sleep}} = \min(\text{cap}, \text{random\_uniform}(\text{base}, t_{\text{prev}} \times 3))$$

Default parameters: `baseMs = 100`, `capMs = 20000`, `maxAttempts = 5`. On exhaustion of retry attempts, the original error is preserved and rethrown unchanged ([`PLAT-12`](contracts/platform.contract.md#PLAT-12)).

```typescript
import { withRetry } from "@railfog/sdk";
import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
  QueueMessage,
  RailFogContext,
} from "@railfog/sdk";

export async function fetchWithBackoff(targetUrl: string): Promise<Response> {
  return await withRetry(
    async () => {
      const res = await fetch(targetUrl);
      if (!res.ok && res.status >= 500) {
        throw new Error(`Server returned ${res.status}`);
      }
      return res;
    },
    { maxAttempts: 5, baseMs: 100, capMs: 20000 },
  );
}
```

---

## 5. Machine-Readable Error Model ([`PLAT-12`](contracts/platform.contract.md#PLAT-12))

All RailFog platform exceptions inherit from `RailFogError` and map to one of 10 exhaustive, machine-readable error codes:

| Error Code | HTTP Status | Description |
|---|---|---|
| `RESOURCE_NOT_FOUND` | 404 | Target project, function, or revision not found. |
| `PERMISSION_DENIED` | 403 | Capability not present in resolved binding ([`PLAT-6`](contracts/platform.contract.md#PLAT-6)). |
| `VALIDATION_FAILED` | 400 | Configuration or payload failed schema validation. |
| `RATE_LIMITED` | 429 | Token bucket capacity exceeded (`PLAT-9`). Includes `Retry-After`. |
| `CALL_DEPTH_EXCEEDED`| 429 | Recursive function call depth exceeded limit (`FN-7`). |
| `TIMEOUT` | 504 | Wall-clock execution deadline exceeded ([`FN-5`](contracts/functions.contract.md#FN-5)). |
| `PAYLOAD_TOO_LARGE` | 413 | Request body, KV value, or queue message exceeded size ceiling. |
| `CONFLICT` | 409 | CAS version mismatch in `kv.atomic()` ([`KV-3`](contracts/kv.contract.md#KV-3)). |
| `UNAVAILABLE` | 503 | Control plane unreachable; serving from cached snapshot ([`PLAT-8`](contracts/platform.contract.md#PLAT-8)). |
| `INTERNAL` | 500 | Unclassified platform or isolate failure. |

---

## 6. Canonical Worked Example: `upload-demo`

The canonical worked example ([`docs/contracts/worked-example.md`](contracts/worked-example.md)) exercises all four platform primitives end-to-end:

### Project Configuration (`railfog.toml`)
```toml
name = "upload-demo"

[functions.api]
entry = "functions/api.ts"
[functions.api.permissions]
objects = ["app:uploads"]
queues  = ["app:jobs"]

[functions.processor]
entry = "functions/processor.ts"
[functions.processor.triggers]
queue = "app:jobs"
[functions.processor.permissions]
objects = ["app:uploads"]
kv      = ["app:files"]

[[routes]]
pattern = "/upload"
function = "api"
```

### Handler: `functions/api.ts`
```typescript
import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
  QueueMessage,
  RailFogContext,
} from "@railfog/sdk";

export default async function handler(
  _req: Request,
  ctx: RailFogContext,
): Promise<Response> {
  const key = crypto.randomUUID();
  // Generate presigned PUT URL for direct client-to-storage transfer (OBJ-2, OBJ-3)
  const { url } = await ctx.objects.presign(key, { method: "PUT" });
  // Enqueue async job message (Q-2)
  await ctx.queues.send({ key, uploadedAt: Date.now() });
  return Response.json({ uploadUrl: url, key });
}
```

### Queue Consumer: `functions/processor.ts`
```typescript
import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
  QueueMessage,
  RailFogContext,
} from "@railfog/sdk";

export default async function consume(
  message: QueueMessage,
  ctx: RailFogContext,
): Promise<void> {
  const { key } = message.body as { key: string };

  // Deduplication check with mandatory 14-day retention TTL (Q-4)
  const dedupeKey = ["processed", key];
  if (await ctx.kv.get(dedupeKey)) return;

  // Retrieve object stream from storage (OBJ-2)
  const stream = await ctx.objects.get(key);
  if (!stream) return; // Not yet uploaded; safe no-op for redelivery (Q-3)

  // Commit processing status to KV (KV-2) and record deduplication marker
  await ctx.kv.set(["files", key], { status: "processed" });
  await ctx.kv.set(dedupeKey, true, { ttl: 14 * 24 * 3600 });
}
```

---

## 7. Ergonomic Handlers & Utilities

### 7.1 Minimalist HTTP Handler (`handle`)
Eliminates boilerplate with auto-destructured context and automatic JSON response serialization:

```typescript
import { handle } from "@railfog/sdk";

export default handle(async ({ kv }) => {
  const count = (await kv.get<number>(["visitor_counter"])) ?? 0;
  await kv.set(["visitor_counter"], count + 1);
  return { visitors: count + 1 };
});
```

### 7.2 Micro-Router (`api`)
Handles multiple HTTP methods and paths in a single function file:

```typescript
import { api } from "@railfog/sdk";

export default api({
  "GET /items": async ({ kv }) => {
    return (await kv.get(["items"])) ?? [];
  },
  "POST /items": async ({ body, kv }) => {
    const item = await body<{ id: string }>();
    await kv.set(["items", item.id], item);
    return { ok: true, item };
  },
});
```

### 7.3 Streaming Responses (`c.stream`)
Emits chunked Web Streams responses:

```typescript
import { handle } from "@railfog/sdk";

export default handle((c) => {
  return c.stream(async (writer) => {
    await writer.write("Chunk 1\n");
    await writer.write("Chunk 2\n");
    await writer.close();
  });
});
```

### 7.4 Server-Sent Events (`c.sse`)
Streams real-time event frames:

```typescript
import { handle } from "@railfog/sdk";

export default handle((c) => {
  return c.sse(async (sse) => {
    await sse.send({ event: "update", data: { status: "ready" } });
    await sse.close();
  });
});
```

### 7.5 Type-Safe RPC Client (`createRpcClient`)
Enables end-to-end typed communication from frontend or external microservices:

```typescript
import { createRpcClient } from "@railfog/sdk";

const client = createRpcClient("https://api.example.com");
const data = await client.get<{ total: number }>("/api/metrics");
```
