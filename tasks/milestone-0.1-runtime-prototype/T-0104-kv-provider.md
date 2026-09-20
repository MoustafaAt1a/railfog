# T-0104 — KVProvider interface + local SQLite implementation

Status: Done
Milestone: 0.1 Runtime Prototype
Depends on: T-0101, T-0102, T-0103
Blocks: T-0107, T-0111

## Spec references

`KV-1` `KV-2` `KV-3` `KV-4` `PLAT-16` `PLAT-17`

## Scope

**In scope:**
- `primitives/kv/kv-provider.ts`: the `KVProvider` interface (PLAT-16 shape,
  parameters per KV-2).
- `providers/kv/sqlite-provider.ts`: one implementation for local dev,
  backing the `strong` tier only (PLAT-17 — local has no eventual-tier
  distinction; document that explicitly rather than faking a second tier).
- CAS (`atomic()`) implemented per KV-3's exact algorithm.
- Cursor pagination for `list` per KV-2 (default limit 100, max 1000).
- TTL support on `set` (seconds), expiry enforced by the SQLite adapter.

**Out of scope:**
- Any remote provider (`DenoDeployKVProvider`, `CloudflareKVProvider` — 0.2).
- Physical key namespacing (`{org_id}/{project_id}/...`, PLAT-7) — that's
  T-0107's job (capability injection wraps this provider, the provider itself
  just stores whatever key it's given).
- Deploy-time validation that rejects `strong` on an `eventual` namespace
  (KV-5) — there is only one tier locally, so this rule has nothing to
  validate yet; revisit when a second (eventual) local-dev tier is added, if
  ever.

## Interface to implement

```typescript
interface KVProvider {
  get(key: string[]): Promise<unknown | null>;
  set(key: string[], value: unknown, opts?: { ttl?: number }): Promise<void>;
  delete(key: string[]): Promise<void>;
  list(prefix: string[], opts?: { limit?: number; cursor?: string })
    : Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }>;
  atomic(): KVAtomicBuilder;
}
interface KVAtomicBuilder {
  check(key: string[], expectedVersion: number): KVAtomicBuilder;
  set(key: string[], value: unknown): KVAtomicBuilder;
  delete(key: string[]): KVAtomicBuilder;
  commit(): Promise<{ ok: boolean; version?: number }>;
}
```

## Acceptance criteria

1. Given a key set with `ttl: 1`, when read again after 1.5s, then `get`
   returns `null` (KV-2).
2. Given `atomic().check(key, v).set(...).commit()` where the stored version
   is not `v`, when committed, then it returns `{ ok: false }` and does not
   write (KV-3) — no partial writes on conflict.
3. Given more than `limit` keys under a prefix, when `list` is called, then
   the response includes a `cursor` and a second call with that cursor
   returns the next page, not a repeat (KV-2).
4. Given a key over 512 bytes or more than 32 segments, when `set` is called,
   then it throws `VALIDATION_FAILED` (KV-4, using T-0102's error taxonomy).

## Tests required

- [x] Unit — key validation, CAS success/conflict, pagination boundary
- [x] Integration — TTL expiry against real SQLite (fake clocks banned per
      `docs/ANTIHALLUCINATION.md` Rule 5 — use a real short TTL and real wait,
      or an injected clock the adapter actually reads, not a mocked timer)
- [ ] Security — n/a this task (namespacing/isolation is T-0107)

## Definition of Done

- [x] `KVProvider` interface lives in `primitives/`, SQLite adapter in
      `providers/` — dependency direction per `docs/CONSTITUTION.md` (D)
- [x] Every clause above has a spec-anchor comment at its implementation site
- [x] `deno check` / `deno test` / `deno lint` clean, real output attached
- [x] No copy-pasted logic anticipating a second provider — one provider,
      write only what it needs (`docs/ANTI-SLOP.md` — no speculative generality)

```
$ deno check **/*.ts
Check cli/main.ts
Check packages/core/id/ulid.ts
Check packages/core/id/ulid_test.ts
Check packages/errors/mod.ts
Check packages/errors/mod_test.ts
Check primitives/kv/kv-provider.ts
Check providers/kv/sqlite-provider.ts
Check providers/kv/sqlite-provider_test.ts
EXIT:0

$ deno test providers/kv
running 5 tests from ./providers/kv/sqlite-provider_test.ts
KVProvider - basic CRUD ... ok (1ms)
KVProvider - TTL expiry (KV-2) ... ok (1s)
KVProvider - CAS atomic operations (KV-3) ... ok (1ms)
KVProvider - list and pagination (KV-2) ... ok (13ms)
KVProvider - key validation (KV-4) ... ok (2ms)

ok | 5 passed | 0 failed (1s)
EXIT:0

$ deno task test
Task test deno test --allow-read --allow-write --allow-net
running 5 tests from ./packages/core/id/ulid_test.ts
... (5 passed)
running 3 tests from ./packages/errors/mod_test.ts
... (3 passed)
running 5 tests from ./providers/kv/sqlite-provider_test.ts
... (5 passed)

ok | 13 passed | 0 failed (1s)
EXIT:0

$ deno lint
Checked 8 files
EXIT:0

$ deno fmt --check
Checked 9 files
EXIT:0
```

## Assumptions made

Value serialization format for SQLite storage (JSON text vs. a binary
encoding) is an implementation choice — using JSON text for local-dev
simplicity and human-inspectable debugging; not a spec claim.

- `key_path` uses URL-encoded strings separated by slashes to allow for predictable prefix `LIKE` queries.
- Used `await Promise.resolve()` inside async interface methods as a workaround for Deno's `require-await` linter rule while preserving Promise return semantics and catching synchronous thrown exceptions (like ValidationFailedError) inside rejection wrappers correctly.
- Expired rows are cleaned up during `get()` and at the start of `commit()` transactions to ensure clean version resets on subsequent `set()` operations.

