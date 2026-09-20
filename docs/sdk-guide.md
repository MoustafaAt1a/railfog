# RailFog TypeScript SDK Developer Guide

This guide covers building applications with `@railfog/sdk`, the TypeScript software development kit for RailFog.

---

## 1. Core Architecture & Invocation Model

RailFog's programming model is strictly **Trigger -> Function** (`PLAT-2`, `FN-1`, `FN-2`). All workloads (HTTP requests, queue messages, cron schedules, webhooks) invoke isolated TypeScript handlers.

### Capability Injection (`PLAT-6`, `FN-4`)
Functions do not access a global, unrestricted platform SDK. Instead, each invocation receives a `RailFogContext` (`ctx`) carrying capability bindings pre-scoped to exactly what was declared in `railfog.toml`:
- `ctx.kv`: Key-Value storage scoped to the declared namespace (`KV-2`).
- `ctx.objects`: Object storage scoped to the declared bucket (`OBJ-2`).
- `ctx.queues`: Queue binding scoped to the declared target queue (`Q-2`).
- `ctx.env`: Environment secrets scoped to declared secret names (`PLAT-15`).

Absence of a resource in `railfog.toml` means the capability does not exist on `ctx` at all (`PLAT-6`).

---

## 2. Invocation Context: `RailFogContext` (`FN-4`)

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

### Context Properties and Methods
- `ctx.requestId`: Unique ULID identifying this invocation across logs, gateway, and storage (`PLAT-14`).
- `ctx.project`: Declared project name (`PLAT-18`).
- `ctx.function`: Name of the currently executing function (`FN-1`).
- `ctx.revision`: Active deployment revision identifier (`PLAT-3`, `PLAT-14`).
- `ctx.deadline`: Epoch millisecond timestamp of the hard termination deadline (`FN-5`).
- `ctx.timeRemaining()`: Returns remaining wall-clock milliseconds before the hard kill deadline. Use this to configure downstream `AbortSignal.timeout(...)`.
- `ctx.kv`: Scoped `KVBinding` instance (`KV-2`).
- `ctx.objects`: Scoped `ObjectBinding` instance (`OBJ-2`).
- `ctx.queues`: Scoped `QueueBinding` instance (`Q-2`).
- `ctx.env`: Scoped `EnvBinding` instance (`PLAT-15`).

---

## 3. Storage Primitives

### Key-Value Storage (`ctx.kv` / `KVBinding`) (`KV-2`, `KV-5`)
The KV store manages structured state up to 256 KB per entry (`KV-1`). It supports hierarchical string tuple keys and atomic Check-And-Set transactions (`KV-3`).

```typescript
import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
  QueueMessage,
  RailFogContext,
} from "@railfog/sdk";

export async function demonstrateKV(kv: KVBinding): Promise<void> {
  // Set value with mandatory/optional TTL in seconds (KV-2)
  await kv.set(["sessions", "user-123"], { authenticated: true }, { ttl: 3600 });

  // Get typed value
  const session = await kv.get<{ authenticated: boolean }>(["sessions", "user-123"]);

  // Atomic Check-And-Set (CAS) transaction (KV-2, KV-3)
  const atomic = kv.atomic();
  atomic
    .check(["counters", "hits"], 10)
    .set(["counters", "hits"], 11);
  const commitResult = await atomic.commit();
  if (!commitResult.ok) {
    // CAS version mismatch; caller may re-read and retry (KV-3)
    return;
  }

  // List keys under a hierarchical prefix
  const { entries } = await kv.list(["sessions"], { limit: 50 });

  // Delete key
  await kv.delete(["sessions", "user-123"]);
}
```

### Object Storage (`ctx.objects` / `ObjectBinding`) (`OBJ-2`, `OBJ-3`)
The Object primitive stores durable binary assets such as file uploads, media, and datasets (`OBJ-1`).

#### Direct Client-to-Storage Transfer (`OBJ-3` — Never a Bandwidth Proxy)
RailFog functions **never proxy file bytes**. Streaming multi-megabyte payloads through a serverless function wastes function execution time, CPU, memory, and bandwidth while creating an availability bottleneck.

Instead, functions generate SigV4 presigned URLs via `ctx.objects.presign`, enabling clients to upload directly to object storage (`OBJ-3`):

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

Direct transfer sequence:
```
Client ----(1) Request upload URL----> Function (api.ts)
Client <---(2) Presigned PUT URL------ Function
Client ----(3) PUT file bytes direct-> Object Storage (app:uploads)
```

### Queues (`ctx.queues` / `QueueBinding`) (`Q-2`, `Q-3`)
Queues provide asynchronous message passing with at-least-once delivery (`Q-1`). Payloads are capped at 128 KB (`Q-2`); larger assets store the object key in the queue message while the binary payload resides in object storage.

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

  // Send batch of messages
  const results = await queues.sendBatch([
    { taskId: "task_789", action: "thumbnail" },
    { taskId: "task_790", action: "transcode" },
  ]);
}
```

---

## 4. Reliability Helpers

RailFog provides reliability helpers in `@railfog/sdk` as library code built over KV (`Q-6`), avoiding redundant platform primitives.

### `withIdempotency` (`Q-4`, `KV-2`)
Queue consumption guarantees at-least-once delivery (`Q-1`). To ensure duplicate deliveries are safely ignored without redundant work, consumers employ `withIdempotency`.

The dedupe key is stored in KV with a mandatory TTL matching the queue's retention window (`14 * 24 * 3600` seconds / 14 days per `Q-4`). Omission of TTL is strictly forbidden to prevent unbounded storage leaks (`KV-2`).

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
      // Executed exactly once per orderId within the retention window
      return { status: "settled", timestamp: Date.now() };
    },
    { ttlSeconds: 14 * 24 * 3600 }, // Mandatory 14-day retention TTL (Q-4)
  );
}
```

### `withRetry` (`Q-5`)
Implements exponential backoff with decorrelated jitter to avoid the thundering-herd problem when retrying transient operations:

$$t_{\text{sleep}} = \min(\text{cap}, \text{random\_uniform}(\text{base}, t_{\text{prev}} \times 3))$$

Default parameters: `baseMs = 100`, `capMs = 20000`, `maxAttempts = 5`. On exhaustion of attempts, the original error is preserved and rethrown unchanged (`PLAT-12`).

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

## 5. Machine-Readable Error Model (`PLAT-12`)

Every failure on RailFog maps to one of the 10 exhaustive, machine-readable error codes defined in `PLAT-12`. Clients check the error code rather than parsing human-readable error strings:

| Error Code | HTTP Status | Meaning |
|---|---|---|
| `RESOURCE_NOT_FOUND` | 404 | Target project, function, or revision does not exist. |
| `PERMISSION_DENIED` | 403 | Capability not present in the resolved binding (`PLAT-6`). |
| `VALIDATION_FAILED` | 400 | Configuration or payload failed schema validation. |
| `RATE_LIMITED` | 429 | Token bucket exhausted (`PLAT-9`). Includes `Retry-After`. |
| `CALL_DEPTH_EXCEEDED`| 429 | Internal recursive invocation depth exceeded limit (`FN-7`). |
| `TIMEOUT` | 504 | Invocation deadline exceeded (`FN-5`). |
| `PAYLOAD_TOO_LARGE` | 413 | Body or message exceeded stated size limit. |
| `CONFLICT` | 409 | `kv.atomic()` CAS version mismatch (`KV-3`). |
| `UNAVAILABLE` | 503 | Control plane unreachable; data plane serves cached snapshot (`PLAT-8`). |
| `INTERNAL` | 500 | Unclassified platform fault. |

---

## 6. Canonical Worked Example: `upload-demo`

The canonical worked example (`docs/contracts/worked-example.md`) exercises all four primitives end-to-end:
1. Client requests an upload URL via `POST /upload`.
2. `functions/api.ts` generates a presigned URL (`OBJ-3`) and enqueues a processing job (`Q-2`).
3. Client uploads directly to the `app:uploads` bucket.
4. `functions/processor.ts` consumes the queue message (`FN-2`), validates the dedupe marker with mandatory 14-day retention TTL (`Q-4`), reads the object (`OBJ-2`), and writes file status to KV namespace `app:files` (`KV-2`).

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
  const { url } = await ctx.objects.presign(key, { method: "PUT" }); // OBJ-2, OBJ-3
  await ctx.queues.send({ key, uploadedAt: Date.now() });             // Q-2
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

  const dedupeKey = ["processed", key];                               // Q-4
  if (await ctx.kv.get(dedupeKey)) return;

  const stream = await ctx.objects.get(key);                          // OBJ-2
  if (!stream) return;                                                // Object not yet uploaded; safe no-op for redelivery (Q-3)

  await ctx.kv.set(["files", key], { status: "processed" });          // KV-2
  await ctx.kv.set(dedupeKey, true, { ttl: 14 * 24 * 3600 });          // Q-4, mandatory 14-day retention TTL
}
```
