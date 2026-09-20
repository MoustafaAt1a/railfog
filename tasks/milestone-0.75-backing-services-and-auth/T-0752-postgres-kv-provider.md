# T-0752 — Implement PostgreSQL KV Provider with Transactional CAS

Status: Done
Milestone: 0.75 Backing Services and Auth
Depends on: none
Blocks: T-0753, T-0755

## Spec references

`KV-1`, `KV-2`, `KV-3`, `KV-4`, `KV-5`, `PLAT-16`

## Scope

**In scope**:
- `providers/kv/postgres-provider.ts` — PostgreSQL-backed implementation of `KVProvider` with ACID transactional CAS.
- `tests/unit/providers_kv_postgres_provider_test.ts` — Unit and mock SQL driver tests verifying schema initialization, CRUD, TTL expiration, pagination, and atomic rollback/commit.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Redis provider (`providers/kv/redis-provider.ts` — covered in `T-0751`).
- Auth store and token validation (`packages/auth/store.ts` — covered in `T-0753`).
- HTTP daemon server modifications (`apps/api/control-server.ts`, `apps/runtime/runtime-server.ts`).
- Object storage or queue providers.

## Interface to implement

```typescript
import type { KVAtomicBuilder, KVProvider } from "../../primitives/kv/kv-provider.ts";

export interface PostgresKVOptions {
  connectionString?: string;
  tableName?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
}

export class PostgresKVProvider implements KVProvider {
  constructor(options?: PostgresKVOptions);
  initSchema(): Promise<void>;
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

1. Given a PostgreSQL connection, when `initSchema()` is called, then the table `kv_entries` is created with columns `key_path TEXT PRIMARY KEY`, `key_json JSONB`, `value_json JSONB`, `version BIGINT`, and `expires_at TIMESTAMPTZ` with appropriate indexes.
2. Given a key and value, when `set(key, value, { ttl: 300 })` is called, then the record is upserted with `version = version + 1` and `expires_at = NOW() + INTERVAL '300 seconds'` (`KV-2`).
3. Given an expired key in the database, when `get(key)` is invoked, then `null` is returned and the expired record is lazily cleaned or ignored (`KV-2`).
4. Given an atomic batch checking version `N`, when the version matches, then the updates are executed in a single transaction with `version = N + 1` and commit returns `{ ok: true, version: N + 1 }` (`KV-3`, `KV-5`).
5. Given an atomic batch checking version `N`, when a concurrent update modified the version to `N + 1`, then the transaction aborts and commit returns `{ ok: false }` (`KV-3`).
6. Given a key prefix, when `list(prefix, { limit: 50, cursor: ... })` is called, then keys are returned in lexicographical order up to the specified limit (`KV-2`).

## Tests required

- [x] Unit — `tests/unit/providers_kv_postgres_provider_test.ts`: Key validation, SQL generation, statement parameterization, TTL expiration logic, and atomic CAS simulation.
- [x] Integration — PostgreSQL wire protocol test verifying queries against real or test database instance.

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

- Connection uses `DATABASE_URL` standard PostgreSQL connection URI.
- SQL queries use parameterized statements (`$1`, `$2`, etc.) to prevent SQL injection vulnerabilities.
