# T-0204 — Deno Deploy remote strong KV provider

Status: Done
Milestone: 0.2 Cloud Prototype
Depends on: T-0102, T-0104
Blocks: T-0211

## Spec references

`KV-1` `KV-2` `KV-3` `KV-4` `KV-5` `PLAT-16` `PLAT-17`

## Scope

**In scope:**
- `providers/kv/deno-deploy-provider.ts`: implement `KVProvider` interface (`primitives/kv/kv-provider.ts`) backing the `strong` linearizable consistency tier (KV-5) using `Deno.openKv`.
- Connect via remote URL and access token (or local path in tests).
- Methods: `get`, `set`, `delete`, `list`, and `atomic`.
- TTL support in seconds per `docs/contracts/kv.contract.md` KV-2.
- Linearizable compare-and-swap (CAS) via `atomic()` per KV-3: `check`, `set`, `delete`, `commit`.
- Key constraints per KV-4: max key length 512 bytes, max 32 segments (throw `VALIDATION_FAILED` if exceeded).
- Value size limit per KV-1: 256 KB (throw `PAYLOAD_TOO_LARGE` if exceeded).

**Out of scope:**
- Eventual consistency tier (handled by `CloudflareKVProvider` in T-0205).
- Multi-region replication or distributed consensus protocols (RailFog is single-region single-writer for 1.0.0 per KV-3).
- SQLite provider (covered in Milestone 0.1).

## Interface to implement

```typescript
import type {
  KVAtomicBuilder,
  KVProvider,
} from "../../primitives/kv/kv-provider.ts";

export interface DenoDeployKVProviderOptions {
  url?: string;
  accessToken?: string;
  path?: string; // for local testing with Deno.openKv(path)
}

export class DenoDeployKVProvider implements KVProvider {
  constructor(options?: DenoDeployKVProviderOptions);
  get(key: string[]): Promise<unknown | null>;
  set(key: string[], value: unknown, opts?: { ttl?: number }): Promise<void>;
  delete(key: string[]): Promise<void>;
  list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }>;
  atomic(): KVAtomicBuilder;
  close(): Promise<void>;
}
```

## Acceptance criteria

1. Given a key stored with `ttl: 1` (seconds), when read again after expiration, then `get` returns `null` (KV-2).
2. Given `atomic().check(key, expectedVersion).set(key, value).commit()`, when the version matches, then `commit()` returns `{ ok: true, version }` and stores the new value (KV-3).
3. Given `atomic().check(key, expectedVersion).set(key, value).commit()`, when the version does not match, then `commit()` returns `{ ok: false }` and leaves stored state unchanged (KV-3).
4. Given a key exceeding 512 bytes or 32 segments, when `set` is called, then it throws `VALIDATION_FAILED` (KV-4).
5. Given a value exceeding 256 KB, when `set` is called, then it throws `PAYLOAD_TOO_LARGE` (KV-1, PLAT-12).

## Tests required

- [x] Unit — key segment counting, key length calculation, TTL option translation, payload size checking
- [x] Integration — CRUD operations, pagination via cursor, and atomic CAS conflict vs success against `Deno.openKv`
- [x] Security — verify key validation prevents path traversal or segment injection

## Definition of Done

- [x] Implementation matches cited clause IDs (`KV-1`, `KV-2`, `KV-3`, `KV-4`, `KV-5`, `PLAT-16`, `PLAT-17`)
- [x] Provider strictly delivers `strong` tier guarantees per KV-5
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched

```
$ deno check providers/kv/deno-deploy-provider.ts providers/kv/deno-deploy-provider_test.ts
Check providers/kv/deno-deploy-provider.ts
Check providers/kv/deno-deploy-provider_test.ts
EXIT:0

$ deno test --allow-read --allow-write providers/kv/deno-deploy-provider_test.ts
running 16 tests from ./providers/kv/deno-deploy-provider_test.ts
DenoDeployKVProvider - unit: key segment counting and empty key validation (KV-4) ... ok (44ms)
DenoDeployKVProvider - unit: key length calculation with multi-byte UTF-8 (KV-4) ... ok (19ms)
DenoDeployKVProvider - unit: TTL option translation and validation (KV-2) ... ok (20ms)
DenoDeployKVProvider - unit: payload size checking at 256 KB boundary (KV-1, PLAT-12) ... ok (28ms)
DenoDeployKVProvider - integration: basic CRUD operations and data types ... ok (35ms)
DenoDeployKVProvider - integration: AC1 TTL expiry (KV-2) ... ok (1s)
DenoDeployKVProvider - integration: AC2 atomic CAS success (KV-3) ... ok (21ms)
DenoDeployKVProvider - integration: AC3 atomic CAS conflict (KV-3) ... ok (28ms)
DenoDeployKVProvider - integration: atomic CAS check on non-existent keys (KV-3) ... ok (24ms)
DenoDeployKVProvider - integration: atomic delete with version check (KV-3) ... ok (22ms)
DenoDeployKVProvider - integration: list with prefix, limit, and cursor pagination (KV-2) ... ok (67ms)
DenoDeployKVProvider - integration: list default limit (100) per KV-2 ... ok (138ms)
DenoDeployKVProvider - security: rejects path traversal segments across all methods (KV-4) ... ok (16ms)
DenoDeployKVProvider - security: rejects null-byte poison and empty segment injection (KV-4) ... ok (19ms)
DenoDeployKVProvider - security: enforces strict string segment typing (KV-4) ... ok (21ms)
DenoDeployKVProvider - security: enforces key and payload validation inside atomic operations (KV-1, KV-4) ... ok (20ms)

ok | 16 passed | 0 failed (2s)
EXIT:0

$ deno task test
Task test deno test --allow-read --allow-write --allow-net --allow-run
...
ok | 114 passed | 0 failed (18s)
EXIT:0

$ deno task check
Task check deno check **/*.ts
EXIT:0

$ deno lint
Checked 40 files
EXIT:0

$ deno fmt --check
Checked 41 files
EXIT:0
```

## Assumptions made

- Enabled `"unstable": ["kv"]` in `deno.json` so Deno KV standard runtime features and types are available project-wide.
- Values exceeding Deno KV's single-entry limit (64 KiB) up to RailFog's 256 KB limit (KV-1) are transparently chunked across internal subkeys prefixed with `\0rf_chunks` (inaccessible to user keys due to null-byte segment rejection).
- Envelope carries monotonic `version` and `expiresAt` timestamp so TTL and version monotonicity are honored with parity between local SQLite-backed `Deno.openKv` and remote Deno Deploy KV.

