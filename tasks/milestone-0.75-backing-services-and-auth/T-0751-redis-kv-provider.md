# T-0751 — Implement Redis KV and Cache Provider

Status: Done
Milestone: 0.75 Backing Services and Auth
Depends on: none
Blocks: T-0753, T-0755

## Spec references

`KV-1`, `KV-2`, `KV-3`, `KV-4`, `KV-5`, `PLAT-16`

## Scope

**In scope**:
- `providers/kv/redis-provider.ts` — Redis-backed implementation of `KVProvider`.
- `tests/unit/providers_kv_redis_provider_test.ts` — Unit and mock-backed tests verifying KV interface conformance.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- PostgreSQL provider (`providers/kv/postgres-provider.ts` — covered in `T-0752`).
- Auth store and token validation (`packages/auth/store.ts` — covered in `T-0753`).
- HTTP daemon server modifications (`apps/api/control-server.ts`, `apps/runtime/runtime-server.ts`).
- Modifying `primitives/kv/kv-provider.ts` interface signatures.

## Interface to implement

```typescript
import type { KVAtomicBuilder, KVProvider } from "../../primitives/kv/kv-provider.ts";

export interface RedisKVOptions {
  url?: string;
  keyPrefix?: string;
  connectionTimeoutMs?: number;
}

export class RedisKVProvider implements KVProvider {
  constructor(options?: RedisKVOptions);
  get(key: string[]): Promise<unknown | null>;
  set(key: string[], value: unknown, opts?: { ttl?: number }): Promise<void>;
  delete(key: string[]): Promise<void>;
  list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: string[][]; cursor?: string }>;
  atomic(): KVAtomicBuilder;
  close(): Promise<void>;
}
```

## Acceptance criteria (Given/When/Then)

1. Given a hierarchical key `["users", "123"]` within 32 segments and 512 bytes (`KV-4`), when `set(key, value, { ttl: 60 })` is invoked, then the value is serialized with metadata and stored with an exact Redis TTL of 60 seconds (`KV-2`).
2. Given a non-existent key, when `get(key)` is invoked, then `null` is returned without error (`KV-2`).
3. Given an existing key with stored version `N`, when an atomic transaction checks `expectedVersion == N` and commits changes, then the commit succeeds, version increments to `N + 1`, and `{ ok: true, version: N + 1 }` is returned (`KV-3`).
4. Given an existing key with stored version `N`, when an atomic transaction checks `expectedVersion == N - 1`, then the commit aborts with `{ ok: false }` (`KV-3`).
5. Given a key prefix `["sessions"]`, when `list(prefix, { limit: 10 })` is called, then matching keys are returned with pagination cursor (`KV-2`).
6. Given a key exceeding 32 segments or 512 bytes, when any operation is called, then a `ValidationFailedError` is thrown (`KV-4`).

## Tests required

- [x] Unit — `tests/unit/providers_kv_redis_provider_test.ts`: Key encoding/validation, GET/SET with TTL, DELETE, SCAN-based LIST with cursor, and optimistic atomic transaction execution.
- [x] Integration — Real Redis connection or wire-level mock verifying RESP command exchange.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`KV-1`..`KV-5`, `PLAT-16`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

## Assumptions made

- Redis commands are executed over standard Redis client protocol (`REDIS_URL`).
- Redis transactions use `WATCH`/`MULTI`/`EXEC` or transactional scripting to implement atomic version checks.
