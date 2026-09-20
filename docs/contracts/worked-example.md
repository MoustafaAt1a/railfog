# Worked Example — The Canonical End-to-End Flow

Source: `railfog-v1_0_0-lts.md`'s own "first real application" example. This
is the one flow every milestone's local-dev-loop task should be able to run,
because it's the smallest possible exercise of all four primitives together.
Referenced directly by `tasks/milestone-0.1-runtime-prototype/T-0111-local-dev-server.md`
— use this file, not a paraphrase of it, when a task needs "the worked
example" as its acceptance-criteria fixture.

## The flow

```
POST /upload
     │
     ▼
  Function (api)
     │
     ├── objects.presign(key, { method: "PUT" })   → OBJ-2
     │        (client uploads directly to storage — OBJ-3, never through this Function)
     │
     └── queues.send({ key, uploadedAt })          → Q-2
                  │
                  ▼
            Function (processor)   ← queue trigger, FN-2
                  │
                  ├── objects.get(key)              → OBJ-2
                  ├── kv.set(["processed", key], true, { ttl: 14*24*3600 })  → Q-4 idempotency pattern
                  └── kv.set(["files", key], { status: "processed" })        → KV-2
```

## Minimal reference implementation shape

```typescript
// functions/api.ts
export default async function handler(req: Request, ctx: RailFogContext) {
  const key = crypto.randomUUID();
  const { url } = await ctx.objects.presign(key, { method: "PUT" });   // OBJ-2
  await ctx.queues.send({ key, uploadedAt: Date.now() });               // Q-2
  return Response.json({ uploadUrl: url, key });
}

// functions/processor.ts — triggers: [{ queue: "app:jobs" }]  (FN-2)
export default async function consume(message: QueueMessage, ctx: RailFogContext) {
  const { key } = message.body as { key: string };

  const dedupeKey = ["processed", key];                                 // Q-4
  if (await ctx.kv.get(dedupeKey)) return;

  const stream = await ctx.objects.get(key);                            // OBJ-2
  if (!stream) return;                                                  // object not yet uploaded — safe no-op, will redeliver (Q-3)

  await ctx.kv.set(["files", key], { status: "processed" });            // KV-2
  await ctx.kv.set(dedupeKey, true, { ttl: 14 * 24 * 3600 });            // Q-4, ttl matches retention_days
}
```

## railfog.toml for this example

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

## Why this is the right fixture, not just an example

Every clause it touches is one that's easy to get subtly wrong in isolation
but obviously wrong once wired end-to-end:

- If `presign` proxied bytes instead of returning a direct-upload URL
  (violating OBJ-3), this flow would still "work" in a unit test but silently
  become the bandwidth-proxy anti-pattern in production.
- If the dedupe key in `processor` had no `ttl` (violating Q-4 / KV-2),
  this flow would still pass a single-run test and only reveal the bug after
  running long enough for the KV namespace to grow unbounded.
- If capability injection (PLAT-6) had a gap, `processor`'s `ctx.kv` could
  reach outside `app:files` — invisible in a single-tenant local run,
  catastrophic multi-tenant.

Use this flow as the integration/e2e test target for any task whose
Definition of Done asks for proof the milestone's stated goal actually
works, not just that its unit tests pass.
