# T-0755 — Wire PostgreSQL, Redis, and Auth Middleware into Daemon Servers

Status: Done
Milestone: 0.75 Backing Services and Auth
Depends on: T-0751, T-0752, T-0753, T-0754
Blocks: T-0756

## Spec references

`PLAT-1`, `PLAT-6`, `PLAT-8`, `PLAT-16`, `PLAT-17`

## Scope

**In scope**:
- `apps/api/control-server.ts` — Wire PostgreSQL persistence, Redis cache, and API key auth middleware to the control plane daemon.
- `apps/runtime/runtime-server.ts` — Wire Redis caching, PostgreSQL KV injection, and auth verification to the runtime data plane daemon.
- `tests/unit/apps_daemon_provider_resolution_test.ts` — Unit tests verifying dynamic provider resolution from environment variables (`DATABASE_URL`, `REDIS_URL`, `RAILFOG_API_KEY`).

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Rewriting the internal HTTP router (`runtime/router/route-matcher.ts`).
- Modifying SDK client (`sdk/typescript/client.ts`).
- Adding external CLI flags outside standard RailFog configuration (`railfog.toml` / env vars).

## Interface to implement

```typescript
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import type { ApiKeyStore } from "../../packages/auth/store.ts";

export interface ResolvedBackingServices {
  kv: KVProvider;
  cache?: KVProvider;
  authStore: ApiKeyStore;
}

export async function resolveBackingServices(env?: {
  get(key: string): string | undefined;
}): Promise<ResolvedBackingServices>;
```

## Acceptance criteria (Given/When/Then)

1. Given `DATABASE_URL` is set in the environment, when `resolveBackingServices` runs, then `PostgresKVProvider` is initialized and used as the primary storage provider for KV and API keys (`PLAT-16`).
2. Given `REDIS_URL` is set in the environment, when `resolveBackingServices` runs, then `RedisKVProvider` is initialized and configured as the fast caching layer for snapshots and auth lookups (`PLAT-16`).
3. Given neither `DATABASE_URL` nor `REDIS_URL` is configured, when starting locally (`rail dev`), then `SQLiteKVProvider` and in-memory caching are used automatically, ensuring full local/production parity without external dependencies (`PLAT-17`).
4. Given `railfog-control` starts with an initialized `ApiKeyStore`, when a deploy or rollback request arrives, then it requires a valid API key and rejects unauthenticated attempts with `403 PERMISSION_DENIED` (`PLAT-1`, `PLAT-6`, `PLAT-12`).
5. Given `railfog-runtime` starts, when an incoming customer request arrives, then caller authentication is validated if enabled, and request execution proceeds inside the isolated sandbox with properly bound capabilities (`PLAT-4`, `PLAT-6`).

## Tests required

- [x] Unit — `tests/unit/apps_control_server_login_test.ts`: Environment-based provider resolution, fallback to SQLite, and auth middleware invocation on daemon endpoints.
- [x] Integration — Daemon startup and health check verification under varying environment configurations.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-6`, `PLAT-8`, `PLAT-16`, `PLAT-17`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

## Assumptions made

- `DATABASE_URL` and `REDIS_URL` are provided by Railway or the hosting platform.
- When `RAILFOG_API_KEY` is present in the environment at startup, it is automatically bootstrapped into the `ApiKeyStore` if no keys exist.
