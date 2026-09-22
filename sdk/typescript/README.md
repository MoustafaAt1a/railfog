# @railfog/sdk — RailFog TypeScript SDK

> [!NOTE]
> **Package**: `@railfog/sdk` &nbsp;|&nbsp; **Specification**:
> [LTS 1.0 (PLAT-19, FN-4)](../../docs/contracts/platform.contract.md)
> &nbsp;|&nbsp; **Documentation**:
> [SDK Developer Guide](../../docs/sdk-guide.md)

The official TypeScript SDK for developing functions and consumers on the
RailFog edge compute platform (`PLAT-19`).

---

## Installation

Install into any RailFog project with a single command:

```bash
rail add sdk
```

This injects `@railfog/sdk` into your `deno.json` imports map.

---

## Ergonomic Handlers (`handle()` & `api()`)

Write minimal functions with zero boilerplate.

### Ultra-Minimalist HTTP Handler: `handle()`

`handle()` automatically provides destructured context (`req`, `body()`,
`json()`, `text()`, `kv`, `objects`, `queues`, `env`) and automatically
serializes returned plain objects, arrays, and primitives into JSON responses
with HTTP status 200:

```typescript
import { handle } from "@railfog/sdk";

// 1-line counter endpoint with automatic JSON response
export default handle(async ({ kv }) => {
  const count = await kv.get(["counter"]) ?? 0;
  await kv.set(["counter"], count + 1);
  return { counter: count + 1 };
});
```

Web API `Response` instances are passed through verbatim:

```typescript
export default handle(async ({ req, env }) => {
  return new Response("Hello World", { status: 200 });
});
```

### Micro-Router: `api()`

Map multiple HTTP methods and parameterized routes in a single function with
automatic `404 RESOURCE_NOT_FOUND` handling and `PLAT-11` specificity matching:

```typescript
import { api } from "@railfog/sdk";

export default api({
  "GET /items": async ({ kv }) => {
    return await kv.get(["items"]) ?? [];
  },

  "POST /items": async ({ req, body, kv }) => {
    const item = await body();
    await kv.set(["items", item.id], item);
    return { ok: true, item };
  },

  "GET /items/:id": async ({ req, kv }) => {
    const id = new URL(req.url).pathname.split("/").pop();
    const item = await kv.get(["items", id]);
    return item ?? new Response("Item Not Found", { status: 404 });
  },
});
```

---

## Core Interfaces & Imports

The SDK exposes typed interfaces, capability bindings, and reliability helpers:

```typescript
import type {
  EnvBinding,
  FunctionHandler,
  KVBinding,
  ObjectBinding,
  QueueBinding,
  QueueConsumerHandler,
  QueueMessage,
  RailFogContext,
} from "@railfog/sdk";

import {
  api,
  handle,
  normalizeError,
  RailFogError,
  withIdempotency,
  withRetry,
} from "@railfog/sdk";
```

---

## Invocation Context: `RailFogContext` (`FN-4`)

Every invocation is supplied a `RailFogContext` instance containing metadata and
pre-scoped capability bindings (`PLAT-6`, `FN-4`):

```typescript
export interface RailFogContext {
  requestId: string; // ULID tracking request across platform logs and storage (PLAT-14)
  project: string; // Project name (PLAT-18)
  function: string; // Function name (FN-1)
  revision: string; // Deployment revision ULID (PLAT-3)
  deadline: number; // Epoch millisecond timestamp of termination deadline (FN-5)
  timeRemaining(): number; // Remaining execution time in milliseconds
  kv: KVBinding; // Capability-scoped Key-Value storage (KV-2)
  objects: ObjectBinding; // Capability-scoped Object storage (OBJ-2)
  queues: QueueBinding; // Capability-scoped Queue sender (Q-2)
  env: EnvBinding; // Capability-scoped secrets access (PLAT-15)
}
```

---

## Typed Handlers

RailFog functions are typed according to their trigger source:

### `FunctionHandler` (`FN-1`)

Entrypoint signature for HTTP-triggered functions accepting standard Web API
`Request` and returning `Response`:

```typescript
import type { FunctionHandler } from "@railfog/sdk";

const handler: FunctionHandler = async (req, ctx) => {
  const data = await ctx.kv.get(["items", "item-1"]);
  return Response.json({ data, requestId: ctx.requestId });
};

export default handler;
```

### `QueueConsumerHandler` (`FN-2`, `Q-2`)

Entrypoint signature for asynchronous queue consumer functions accepting a typed
`QueueMessage`:

```typescript
import type { QueueConsumerHandler } from "@railfog/sdk";

interface OrderTask {
  orderId: string;
}

const consume: QueueConsumerHandler<OrderTask> = async (message, ctx) => {
  const { orderId } = message.body;
  await ctx.kv.set(["processed", orderId], {
    attempts: message.attempts,
    receivedAt: message.timestamp,
  });
};

export default consume;
```

### `ScheduleHandler` (`FN-2`)

Entrypoint signature for scheduled cron-triggered functions accepting a typed
`ScheduleEvent`:

```typescript
import type { ScheduleHandler } from "@railfog/sdk";

const schedule: ScheduleHandler = async (event, ctx) => {
  console.log(`Cron [${event.cron}] triggered at ${event.timestamp}`);
  await ctx.kv.set(["last_cron_run"], event.timestamp);
};

export default schedule;
```

---

## Reliability Helpers

### `withIdempotency` (`Q-4`, `KV-2`)

Composed idempotency helper over KV. Guards against duplicate message processing
under at-least-once delivery (`Q-1`). Writes dedupe keys with a mandatory TTL
(default: 14 days / `14 * 24 * 3600` seconds per `Q-4` to match maximum queue
message retention):

```typescript
import { withIdempotency } from "@railfog/sdk";

await withIdempotency(
  ctx.kv,
  ["processed_jobs", message.id],
  async () => {
    // Business logic executed exactly once
    await processJob(message.body);
  },
  { ttlSeconds: 14 * 24 * 3600 },
);
```

### `withRetry` (`Q-5`)

Executes transient operations using exponential backoff with decorrelated
jitter:

$$t_{\text{sleep}} = \min(\text{cap}, \text{random\_uniform}(\text{base}, t_{\text{prev}} \times 3))$$

Default configuration: `baseMs = 100`, `capMs = 20000`, `maxAttempts = 5`.
Rethrows original typed error upon exhaustion (`PLAT-12`).

```typescript
import { withRetry } from "@railfog/sdk";

const response = await withRetry(
  async () => {
    return await fetch("https://api.example.com/payment");
  },
  { maxAttempts: 5, baseMs: 100, capMs: 20000 },
);
```

### `withCircuitBreaker` (`Q-6`, `KV-2`)

Composed circuit breaker pattern over KV with mandatory TTL. Fails fast with
`UnavailableError` (503) when consecutive failures reach `failureThreshold`
(default: 5) during the `cooldownMs` window (default: 30,000ms / 30s).
Automatically resets failure count upon successful recovery:

```typescript
import { withCircuitBreaker } from "@railfog/sdk";

const result = await withCircuitBreaker(
  ctx.kv,
  ["circuits", "payment_api"],
  async () => {
    return await chargePaymentGateway();
  },
  { failureThreshold: 5, cooldownMs: 30_000 },
);
```

---

## Error Model (`PLAT-12`)

RailFog uses an exhaustive, 10-code error taxonomy across all services and
client SDKs. Errors inherit from `RailFogError` and expose a machine-readable
`code` and `requestId`:

| Error Code            | Class Name               | Description                                                                       |
| --------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `RESOURCE_NOT_FOUND`  | `ResourceNotFoundError`  | Target project, function, or revision not found (`PLAT-12`).                      |
| `PERMISSION_DENIED`   | `PermissionDeniedError`  | Unpermitted resource access; capability missing from binding (`PLAT-6`).          |
| `VALIDATION_FAILED`   | `ValidationFailedError`  | Schema validation error in `railfog.toml` or request payload.                     |
| `RATE_LIMITED`        | `RateLimitedError`       | Concurrency or token bucket capacity exceeded (`PLAT-9`). Includes `Retry-After`. |
| `CALL_DEPTH_EXCEEDED` | `CallDepthExceededError` | Internal function recursion exceeded maximum call depth (`FN-7`).                 |
| `TIMEOUT`             | `TimeoutError`           | Wall-clock execution deadline exceeded (`FN-5`).                                  |
| `PAYLOAD_TOO_LARGE`   | `PayloadTooLargeError`   | Request body, KV value, or queue message exceeded size limit.                     |
| `CONFLICT`            | `ConflictError`          | Check-And-Set optimistic concurrency version mismatch in `kv.atomic()` (`KV-3`).  |
| `UNAVAILABLE`         | `UnavailableError`       | Control plane unreachable; data plane serves cached snapshot (`PLAT-8`).          |
| `INTERNAL`            | `InternalError`          | Unclassified platform or isolate failure.                                         |

```typescript
import {
  ConflictError,
  normalizeError,
  ValidationFailedError,
} from "@railfog/sdk";

try {
  const apiKey = ctx.env.require("STRIPE_KEY");
  const result = await ctx.kv.atomic().check(["key"], 1).set(["key"], 2)
    .commit();
  if (!result.ok) {
    throw new ConflictError("Version conflict on CAS update", ctx.requestId);
  }
} catch (err) {
  const normalized = normalizeError(err, ctx.requestId);
  console.error(`Operation failed [${normalized.code}]: ${normalized.message}`);
}
```

---

## Type-Safe RPC Client: `createRpcClient()`

Call deployed RailFog microservices or local dev servers with automatic JSON
serialization, query parameter formatting, AbortSignal timeout/cancellation, and
`PLAT-12` typed error normalization:

```typescript
import { createRpcClient } from "@railfog/sdk";

const client = createRpcClient("https://api.myproject.railfog.app", {
  headers: { "Authorization": "Bearer tok_123" },
});

// GET with typed return and query parameters
const user = await client.get<{ id: string; name: string }>("/users/usr_1", {
  query: { details: "full" },
  signal: AbortSignal.timeout(5000),
});

// POST, PUT, PATCH, DELETE
await client.post("/items", { name: "New Item" });
await client.patch("/items/itm_1", { status: "active" });
await client.delete("/items/itm_1");

// HEAD returns Response Headers directly
const headers = await client.head("/health");
console.log(headers.get("x-request-id"));
```

---

## Client Wrappers & Test Harnesses (`PLAT-6`, `PLAT-12`)

The SDK provides zero-overhead wrapper utilities that enforce typed error
normalization across all capability bindings:

```typescript
import {
  wrapContext,
  wrapEnvBinding,
  wrapKVBinding,
  wrapObjectBinding,
  wrapQueueBinding,
} from "@railfog/sdk";

// Wrap an entire RailFogContext for test harnesses or middleware
const safeCtx = wrapContext(rawCtx);
```

---

## Security & Safety Guarantees

1. **Zero Ambient Authority (`PLAT-6`)**: The SDK contains no ambient tokens,
   connection strings, or host handles (`Deno.env`). All access is purely
   capability-scoped through `ctx`.
2. **Dynamic Secret Isolation (`PLAT-15`)**: Secrets accessed via `ctx.env.get`
   or `ctx.env.require` are resolved at invocation time and strictly restricted
   to the function's manifest permissions. Enumeration methods (`keys()`,
   `entries()`) are omitted to prevent prototype pollution and credential
   enumeration.
3. **Audit-Finding #5 Compliance (`KV-2`, `Q-4`)**: `withIdempotency` strictly
   mandates and enforces positive finite TTL (default: 14 days matching queue
   retention). Zero, negative, null, or unbounded keys are prohibited.
4. **Audit-Finding #4 Compliance (`Q-5`)**: `withRetry` strictly bounds retry
   attempts and enforces non-negative jitter backoff capped at 20 seconds,
   preventing infinite loops.
5. **Portable & Minimalist**: Built entirely on native Web Standards (`Request`,
   `Response`, `ReadableStream`, `Uint8Array`). Zero external third-party
   dependencies.
