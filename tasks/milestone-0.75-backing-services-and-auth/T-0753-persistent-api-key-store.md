# T-0753 — Implement Persistent API Key Store with Redis Caching

Status: Done
Milestone: 0.75 Backing Services and Auth
Depends on: T-0751, T-0752
Blocks: T-0754, T-0755

## Spec references

`PLAT-6`, `PLAT-9`, `PLAT-15`, `KV-2`

## Scope

**In scope**:
- `packages/auth/store.ts` — Persistent API key management with PostgreSQL backend and Redis caching layer.
- `packages/auth/mod.ts` — Export store and API key lifecycle types.
- `tests/unit/packages_auth_store_test.ts` — Unit tests for token creation, hashing, lookup, caching, and revocation.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- HTTP request parsing or middleware handler (`packages/auth/middleware.ts` — covered in `T-0754`).
- Modifying `packages/auth/token.ts` hashing algorithm.
- Direct database connection management inside the auth store (uses `KVProvider` or dedicated client abstraction).

## Interface to implement

```typescript
import type { IdentityContext } from "./verifier.ts";
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";

export interface StoredApiKeyRecord {
  id: string;             // Monotonic ULID (PLAT-14)
  tokenHash: string;      // Deterministic SHA-256 hex digest (PLAT-15)
  name: string;           // Human label for key (e.g. "ci-deploy-token")
  orgId: string;
  projectId?: string;
  createdAt: string;      // ISO-8601
  revokedAt?: string;     // ISO-8601 if revoked
}

export interface CreateApiKeyResult {
  id: string;
  rawToken: string;       // Returned ONLY once at creation (PLAT-15)
  record: StoredApiKeyRecord;
}

export interface ApiKeyStoreOptions {
  storageProvider: KVProvider;
  cacheProvider?: KVProvider; // Optional fast Redis cache (PLAT-16)
  cacheTtlSeconds?: number;   // Default: 300s (5 minutes)
}

export class ApiKeyStore {
  constructor(options: ApiKeyStoreOptions);
  createKey(params: { name: string; orgId: string; projectId?: string }): Promise<CreateApiKeyResult>;
  verifyRawToken(rawToken: string): Promise<IdentityContext | null>;
  revokeKey(keyId: string): Promise<boolean>;
  listKeys(orgId: string): Promise<StoredApiKeyRecord[]>;
}
```

## Acceptance criteria (Given/When/Then)

1. Given a new API key request with name and orgId, when `createKey` is called, then a fresh cryptographically secure random token (`rfk_...`) is generated, hashed via `hashApiToken` (`PLAT-15`), stored persistently with its ULID, and the raw token is returned once in the result.
2. Given a stored API key, when `verifyRawToken(rawToken)` is called, then the token is hashed, checked against the cache or primary store, and returns a valid `IdentityContext` (`PLAT-6`, `PLAT-9`).
3. Given a cached token record in Redis, when `verifyRawToken` is called subsequently, then the lookup is served directly from cache without hitting primary persistent storage.
4. Given a revoked API key, when `verifyRawToken` is called, then `null` is returned and any cached entry in Redis is invalidated.
5. Given any error or log emission within `ApiKeyStore`, then raw tokens are never logged or stored in plain text per `PLAT-15`.

## Tests required

- [x] Unit — `tests/unit/packages_auth_store_test.ts`: Key creation, deterministic hashing, verification, cache hit/miss behavior, revocation, and listing.
- [x] Security — Verify that raw secrets are never present in stored KV values or serialized cache records (`PLAT-15`).

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-6`, `PLAT-9`, `PLAT-15`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Security-auditor pass complete for PLAT-6 and PLAT-15 compliance
- [x] Nothing outside "In scope" touched

## Assumptions made

- API tokens use standard prefix `rfk_` followed by base64url or hex cryptographically random characters.
- Only SHA-256 hashes (`tokenHash`) are stored in the database and cache.
