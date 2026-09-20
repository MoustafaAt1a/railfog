# T-0309 — Storage provider tenant prefix defense-in-depth guard

Status: Done
Milestone: 0.3 Security
Depends on: T-0104, T-0105, T-0106
Blocks: T-0313

## Spec references

`PLAT-7`

## Scope

**In scope:**
- `providers/guard/tenant-guard.ts`:
  - Enforce physical key tenant boundaries directly at the storage provider layer per PLAT-7: `physical_key = {org_id}/{project_id}/{resource_name}/{caller_key}`.
  - Implement defense-in-depth wrappers for `KVProvider`, `ObjectProvider`, and `QueueProvider`.
  - Validate every storage method call (`get`, `set`, `delete`, `list`, `atomic`, `put`, `head`, `presign`, `createMultipartUpload`, `send`, `sendBatch`, `receive`, `ack`) to ensure keys and queue names strictly begin with the assigned `{org_id}/{project_id}/` prefix.
  - Intercept and reject path traversal attempts (e.g. `../`, `..\`), empty segments, or cross-tenant prefixes by throwing `PermissionDeniedError` (`PLAT-12`).

**Out of scope:**
- Deploy-time capability injection closures inside `packages/policy/permission-resolver.ts` (T-0107).
- Cloud provider network adapters (T-0203, T-0204, T-0205, T-0206).
- Database migration schemas.

## Interface to implement

```typescript
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type { QueueProvider } from "../../primitives/queues/queue-provider.ts";

export interface TenantContext {
  orgId: string;
  projectId: string;
}

export function createGuardedKVProvider(
  provider: KVProvider,
  tenant: TenantContext,
): KVProvider;

export function createGuardedObjectProvider(
  provider: ObjectProvider,
  tenant: TenantContext,
): ObjectProvider;

export function createGuardedQueueProvider(
  provider: QueueProvider,
  tenant: TenantContext,
  queueName?: string,
): QueueProvider;
```

## Acceptance criteria (Given/When/Then)

1. Given a guarded `KVProvider` scoped to `org_1/proj_1`, when an operation passes a key starting with `["org_1", "proj_1", "app:sessions", "session_abc"]`, then the operation succeeds.
2. Given a guarded `KVProvider` scoped to `org_1/proj_1`, when a caller attempts to access `["org_2", "proj_2", "other"]` or `["..", "escape"]`, then the guard intercepts the call and throws `PermissionDeniedError`.
3. Given a guarded `ObjectProvider`, when a key without the `{org_id}/{project_id}/` prefix or attempting path traversal (`../`) is passed, then it throws `PermissionDeniedError`.
4. Given a guarded `QueueProvider`, when a queue name not prefixed with `{org_id}_{project_id}_` is addressed, then it throws `PermissionDeniedError`.

## Tests required

- [x] Unit — prefix verification for all methods across KV, Object, and Queue providers; rejection of prefix tampering, mismatched org/project IDs, and traversal patterns
- [x] Integration — wrapping real SQLite and LocalFS providers with tenant guards under concurrent operations
- [x] Security — attempt cross-tenant key leakage, empty prefix, path traversal escapes, and sub-namespace spoofing (PLAT-7)

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches PLAT-7)
- [x] Nothing outside "In scope" touched

## Verification

```shell
$ deno check providers/guard/tenant-guard.ts providers/guard/tenant-guard_test.ts
Check providers/guard/tenant-guard.ts
Check providers/guard/tenant-guard_test.ts

$ deno test --allow-read --allow-write providers/guard/tenant-guard_test.ts
Check providers/guard/tenant-guard_test.ts
running 20 tests from ./providers/guard/tenant-guard_test.ts
TenantContext Validation - rejects invalid orgId and projectId ... ok (1ms)
AC1 / PLAT-7: Guarded KVProvider allows valid tenant-prefixed keys across all methods ... ok (1ms)
AC2 / PLAT-7 / PLAT-12: Guarded KVProvider rejects cross-tenant prefixes across all methods ... ok (1ms)
AC2 / PLAT-7 / PLAT-12: Guarded KVProvider rejects path traversal and empty segments ... ok (2ms)
AC2 / PLAT-7: Guarded KVProvider rejects empty or incomplete list prefixes ... ok (543µs)
Security / PLAT-7: Guarded KVProvider rejects sub-namespace spoofing ... ok (230µs)
AC3 / PLAT-7: Guarded ObjectProvider allows valid tenant-prefixed keys across all methods ... ok (7ms)
AC3 / PLAT-7 / PLAT-12: Guarded ObjectProvider rejects un-prefixed, cross-tenant, and traversal keys ... ok (2ms)
AC3 / PLAT-7: Guarded ObjectProvider rejects invalid list prefixes ... ok (2ms)
AC4 / PLAT-7: Guarded QueueProvider allows operations on valid tenant-prefixed queue name ... ok (853µs)
AC4 / PLAT-7 / PLAT-12: Guarded QueueProvider rejects cross-tenant queue name at bind/creation ... ok (508µs)
AC4 / PLAT-7 / PLAT-12: Guarded QueueProvider dynamically checks queue name on send, sendBatch, receive, and ack ... ok (579µs)
Integration / PLAT-17: Guarded SQLiteKVProvider enforces tenant isolation in real SQLite engine ... ok (3ms)
Integration / PLAT-17: Guarded LocalFSProvider enforces tenant isolation in real filesystem ... ok (23ms)
Integration / PLAT-17: Guarded SQLiteQueueProvider enforces tenant isolation in real SQLite queue ... ok (2ms)
Concurrency / PLAT-7: Multiple tenant guards on shared backend maintain strict isolation under concurrent load ... ok (6ms)
Security Adversarial / PLAT-7: KV Key TOCTOU Getter & Proxy Smuggling is blocked ... ok (3ms)
Security Adversarial / PLAT-7: KV Atomic Post-Validation Array Reference Mutation is blocked ... ok (1ms)
Security Adversarial / PLAT-7: TenantContext reference mutation attack is blocked across all providers ... ok (3ms)
Security Adversarial / PLAT-7 / PLAT-12: Tenant identifiers with untrimmed whitespace are rejected ... ok (474µs)

ok | 20 passed | 0 failed (89ms)

$ deno lint providers/guard/tenant-guard.ts providers/guard/tenant-guard_test.ts
Checked 2 files

$ deno fmt --check providers/guard/tenant-guard.ts providers/guard/tenant-guard_test.ts
Checked 2 files

$ deno test -A
ok | 535 passed | 0 failed (57s)
```

## Assumptions made

Validates physical keys at provider method entrypoints before underlying storage engine execution.
Tenant context and key arrays are defensively copied and frozen to prevent TOCTOU and post-validation reference mutation attacks.
