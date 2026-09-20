# Contract — KV

Source: `railfog-v1_0_0-lts.md` §4.2 and Appendix A (CAS formula). Audit
Finding #1 and #5 both live here — read the "Banned patterns" section at the
bottom before implementing anything.

## KV-1 — Purpose and non-purpose

For: configuration, sessions, feature flags, counters, small indexes.
Not for: relational data, analytics, a document database. Value limit is
256 KB precisely so it can't drift into being those things by accident —
anything bigger belongs in Objects, referenced by key.

## KV-2 — API

```typescript
await kv.get(key);
await kv.set(key, value, { ttl?: number });   // ttl in SECONDS
await kv.delete(key);
await kv.list(prefix, { limit?: number; cursor?: string });  // default limit 100, max 1000

await kv.atomic()
  .check(key, expectedVersion)
  .set(key, value)
  .delete(otherKey)
  .commit();   // returns { ok: boolean, version?: number }
```

`ttl` is **required**, not optional in practice, for any key used as an
idempotency/dedupe marker (see queues.contract.md Q-4). A dedupe key written
without a `ttl` is Audit Finding #5 reopened — reject this in review on sight.

## KV-3 — Optimistic concurrency (CAS)

```
write succeeds iff stored_version(key) == expected_version
on success: stored_version += 1
on mismatch: return CONFLICT — caller re-reads and retries
```

`strong` is the default consistency requirement for any `kv.atomic()` call.
RailFog is explicitly single-region, single-writer-per-key for 1.0.0 — no
consensus protocol is needed or should be built.

## KV-4 — Key model

Hierarchical, e.g. `["users", "123"]`. Internally namespaced per
`platform.contract.md` PLAT-7 as
`{org_id}/{project_id}/{resource_name}/{caller_key}`. Max key length 512
bytes, max 32 segments. A Function never sees or constructs this physical
prefix — `ctx.kv` closes over it at injection time.

## KV-5 — Consistency tiers (provider-verified, not aspirational)

| Tier | Guarantee | Backing provider (MVP) | Use for |
|---|---|---|---|
| `strong` | Linearizable per key, CAS-backed | Deno Deploy KV (`consistency: "strong"`) or a Durable-Object/Postgres-CAS adapter | sessions, counters, locks, idempotency keys, circuit-breaker state |
| `eventual` | Propagates within seconds, no ordering guarantee | Cloudflare Workers KV | feature flags, config cache, read-heavy staleness-tolerant data |

Requesting `strong` against an `eventual`-backed namespace is a **deploy-time
validation error** — never a silent downgrade. Never implement a fallback that
quietly serves eventual consistency where `strong` was declared.

Cloudflare Workers KV's free tier allows only ~1,000 writes/day — this is a
provider fact from the spec itself, document it, don't paper over it with a
retry loop that just burns the quota faster.

## Banned patterns (do not implement, do not review-approve)

- Claiming a KV namespace is `strong` without the backing provider verified
  against KV-5 (Audit Finding #1 — the original, uncorrected bug).
- `kv.set` used as a dedupe/idempotency marker with no `ttl` (Audit Finding #5).
- Any "eventual is close enough" substitution for a declared `strong` namespace.
- A `kv.list` implementation with no cursor/limit — unbounded scans were never
  part of this contract.
