# Contract — Queues

Source: `railfog-v1_0_0-lts.md` §4.4, §6.2–6.3, Appendix A. Audit Findings
#4, #5, #6 all live here — this is the highest-bug-density part of the
original draft, so treat every clause below as load-bearing.

## Q-1 — Guarantee

At-least-once delivery. Exactly-once is deliberately not built — Principle 5
(don't build the expensive thing when the cheap thing composes into it, via
idempotency, Q-4).

## Q-2 — API

```typescript
await queue.send(message, { delay?: seconds });   // delay ≤ 900 (15 min); beyond that, use a schedule trigger (functions.contract.md FN-2)
await queue.sendBatch(messages);

export default async function consume(message: QueueMessage, ctx: RailFogContext) {
  // message.attempts, message.id, message.body
}
```

Max message size 128 KB. Larger payloads go in Objects; the queue message
carries the Object key, not the bytes — composition (Principle 2), not a
bigger queue.

## Q-3 — Redelivery model (this did not exist in the original draft)

```
Message sent → Visible in queue
  → Consumer receives → invisible for visibility_timeout_ms
    → acked/deleted before timeout?
       yes → Removed
       no (crash, timeout, error) → attempts ≥ max_receives?
          no  → back to Visible
          yes → Dead-letter queue
```

| Setting | Default |
|---|---|
| `visibility_timeout_ms` | 30,000 |
| `max_receives` before DLQ | 5 |
| `retention_days` | 4 (max 14) |

Any consumer implementation with no visibility timeout, no max-receive count,
or no DLQ trigger is Audit Finding #6 reopened.

## Q-4 — Idempotency (composed from KV, not a platform feature)

```typescript
export default async function consume(message: QueueMessage, ctx: RailFogContext) {
  const dedupeKey = ["processed", message.id];
  if (await ctx.kv.get(dedupeKey)) return;                          // already handled
  await process(message);
  await ctx.kv.set(dedupeKey, true, { ttl: 14 * 24 * 3600 });       // matches max retention_days — never grows unbounded
}
```

The `ttl` must match the queue's retention window, not be omitted or set to
"forever." A dedupe key with no expiry is Audit Finding #5 reopened
(kv.contract.md KV-2 already states the general rule; this is the specific
instance for queue consumers).

## Q-5 — Retries: exponential backoff with decorrelated jitter

```
sleep_0 = base
sleep_n = min(cap, random_uniform(base, sleep_(n-1) × 3))
```

| Setting | Default |
|---|---|
| base | 100 ms |
| cap | 20 s |
| max attempts | 5, then DLQ / surfaced failure |

Infinite retries are never implemented. Only operations with a defined
idempotency strategy are safe to retry automatically: `GET`/`HEAD`, `PUT` with
an `Idempotency-Key`, and queue consumption (idempotent by construction via
Q-4). A bare `POST` without an idempotency key is retried by the *caller's*
choice only, never silently by RailFog.

## Q-6 — Composed reliability patterns are library code, not platform features

Circuit breakers, backoff, and idempotency are ~10-line Function patterns
built entirely on `kv.atomic()` (kv.contract.md KV-3) — proof, not assertion,
that composition beats adding a fifth primitive. If a task seems to need a
new platform-level "reliability primitive," it almost certainly means "write
this pattern as library code over KV instead," not "add a service."

## Banned patterns

- Check-then-set idempotency with no `ttl` (Audit Finding #5).
- Consumer logic with no visibility timeout / max-receive / DLQ path (#6).
- Fixed (non-jittered) exponential backoff, or unbounded retry attempts (#4).
- Automatically retrying a bare `POST` with no idempotency key.
- A message payload carrying large binary data instead of an Object key.
