# T-0205 — Cloudflare Workers KV remote provider

Status: Done
Milestone: 0.2 Cloud Prototype
Depends on: T-0102, T-0104
Blocks: T-0211

## Spec references

`KV-1` `KV-2` `KV-4` `KV-5` `PLAT-12` `PLAT-15` `PLAT-16` `PLAT-17`

## Scope

**In scope:**
- `providers/kv/cloudflare-kv-provider.ts`: implement `KVProvider` interface (`primitives/kv/kv-provider.ts`) backing the `eventual` consistency tier (KV-5) using the Cloudflare Workers KV REST API.
- Methods: `get`, `set`, `delete`, `list`.
- TTL support in seconds per `docs/contracts/kv.contract.md` KV-2 (enforcing Cloudflare's 60-second minimum TTL).
- CAS rejection per KV-5: `atomic()` throws `VALIDATION_FAILED` because Workers KV cannot back linearizable compare-and-swap.
- Deploy-time consistency tier validator: `validateConsistencyTier(declaredTier, providerTier)`. Requesting `strong` against an `eventual`-backed namespace immediately throws `VALIDATION_FAILED` (KV-5).
- Enforce 256 KB value limit (KV-1) and key limits (KV-4).
- Redaction of `apiToken` in all error messages, stack traces, inspections, and serializations (PLAT-15).

**Out of scope:**
- Any attempt to fake compare-and-swap over eventual KV (banned per KV-5).
- Any silent downgrade from declared `strong` to `eventual` (banned per KV-5).
- Strong KV provider (handled by `DenoDeployKVProvider` in T-0204).

## Interface to implement

```typescript
import type {
  KVAtomicBuilder,
  KVProvider,
} from "../../primitives/kv/kv-provider.ts";

export interface CloudflareKVProviderOptions {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  baseUrl?: string; // allows local HTTP mock testing
}

export class CloudflareKVProvider implements KVProvider {
  readonly tier: "eventual";
  constructor(options: CloudflareKVProviderOptions);
  get(key: string[]): Promise<unknown | null>;
  set(key: string[], value: unknown, opts?: { ttl?: number }): Promise<void>;
  delete(key: string[]): Promise<void>;
  list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }>;
  atomic(): KVAtomicBuilder; // throws VALIDATION_FAILED per KV-5
}

export function validateConsistencyTier(
  declaredTier: "strong" | "eventual",
  providerTier: "strong" | "eventual",
): void;
```

## Acceptance criteria

1. Given a configured `CloudflareKVProvider`, when `set`, `get`, `delete`, and `list` are invoked, then standard Cloudflare Workers KV REST API requests are dispatched.
2. Given `atomic()` called on `CloudflareKVProvider`, then it throws `VALIDATION_FAILED` with an explicit message that linearizable CAS cannot be fulfilled on an eventual tier (KV-5).
3. Given `validateConsistencyTier("strong", "eventual")`, when evaluated at deploy time, then it throws `VALIDATION_FAILED` and refuses deployment (KV-5).
4. Given `validateConsistencyTier("strong", "strong")` or `validateConsistencyTier("eventual", "eventual")`, then it returns without error.
5. Given `set` called with `ttl` less than 60 seconds, then it throws `VALIDATION_FAILED` with an explanation of Cloudflare's minimum TTL requirement (KV-5).
6. Given a value exceeding 256 KB, when `set` is called, then it throws `PAYLOAD_TOO_LARGE` (KV-1, PLAT-12).

## Tests required

- [x] Unit — `validateConsistencyTier` rejection of mismatched tiers, `atomic()` failure enforcement, TTL bounds checking, key encoding
- [x] Integration — CRUD operations and prefix list pagination against an in-process mock HTTP server mimicking Cloudflare Workers KV REST API responses
- [x] Security — verify authorization header containing `apiToken` is redacted from error strings, traces, object inspection, and JSON parse errors (PLAT-15, KV-4)

## Definition of Done

- [x] Implementation matches cited clause IDs (`KV-1`, `KV-2`, `KV-4`, `KV-5`, `PLAT-12`, `PLAT-15`, `PLAT-16`, `PLAT-17`)
- [x] No silent downgrade logic exists anywhere in the provider or validator (KV-5 banned pattern)
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing (25/25 passing in task suite; 139/139 passing in repo suite)
- [x] `deno lint` run, real output attached, zero warnings
- [x] `deno fmt --check` run, real output attached, formatted
- [x] Independent review pass completed and approved
- [x] Security auditor pass completed and approved (`PLAT-15`, `KV-4`, `KV-5`)
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched

### Verified Tool Outputs

#### `deno check`
```
$ deno check providers/kv/cloudflare-kv-provider.ts providers/kv/cloudflare-kv-provider_test.ts tests/security/cloudflare_kv_adversarial_test.ts
Check providers/kv/cloudflare-kv-provider.ts
Check providers/kv/cloudflare-kv-provider_test.ts
Check tests/security/cloudflare_kv_adversarial_test.ts
```

#### `deno test`
```
$ deno test --allow-net providers/kv/cloudflare-kv-provider_test.ts tests/security/cloudflare_kv_adversarial_test.ts
running 7 tests from ./tests/security/cloudflare_kv_adversarial_test.ts
Adversarial PLAT-15: list() JSON parse error must not leak apiToken or bypass error taxonomy ... ok (346ms)
Adversarial PLAT-15: naive inspection via Deno.inspect/JSON.stringify must not leak apiToken ... ok (378µs)
Adversarial PLAT-15: upstream 4xx/5xx echoing token in body must be redacted across all methods ... ok (310ms)
Adversarial PLAT-15: network connection failure with token in exception must be redacted ... ok (2s)
Adversarial KV-4: Key injection, path traversal, null bytes, and malicious characters rejected ... ok (8ms)
Adversarial KV-4: URL-encoded traversal, query injection, and CRLF cannot escape REST path ... ok (324ms)
Adversarial KV-5: Reject silent tier downgrade and reject CAS (atomic) on eventual tier ... ok (583µs)
running 18 tests from ./providers/kv/cloudflare-kv-provider_test.ts
CloudflareKVProvider - unit: validateConsistencyTier enforces declared vs provider tier (KV-5, AC3, AC4) ... ok (1ms)
CloudflareKVProvider - unit: tier property is 'eventual' (KV-5) ... ok (228µs)
CloudflareKVProvider - unit: atomic() throws VALIDATION_FAILED rejecting CAS on eventual tier (KV-5, AC2) ... ok (291µs)
CloudflareKVProvider - unit: TTL bounds checking enforces Cloudflare 60s minimum (KV-5, KV-2, AC5) ... ok (1ms)
CloudflareKVProvider - unit: payload size checking enforces 256 KB limit (KV-1, PLAT-12, AC6) ... ok (2ms)
CloudflareKVProvider - unit: key segment counting and empty key validation (KV-4) ... ok (1ms)
CloudflareKVProvider - unit: key length calculation with multi-byte UTF-8 (KV-4) ... ok (946µs)
CloudflareKVProvider - integration: standard Cloudflare REST API requests dispatched for set, get, delete (KV-2, AC1) ... ok (346ms)
CloudflareKVProvider - integration: set with TTL dispatches expiration_ttl query param (KV-2, AC1, AC5) ... ok (313ms)
CloudflareKVProvider - integration: get non-existent key returns null (KV-2, AC1) ... ok (313ms)
CloudflareKVProvider - integration: round-trip CRUD for multiple data types (KV-2, PLAT-16) ... ok (338ms)
CloudflareKVProvider - integration: list with prefix, limit, and cursor pagination (KV-2, AC1) ... ok (337ms)
CloudflareKVProvider - integration: list default limit (100) and max limit (1000) (KV-2) ... ok (308ms)
CloudflareKVProvider - security: authorization header containing apiToken is redacted from error strings and traces (PLAT-15) ... ok (312ms)
CloudflareKVProvider - security: rejects path traversal and malicious key segments across all methods (KV-4) ... ok (867µs)
CloudflareKVProvider - security: enforces strict string segment typing (KV-4) ... ok (774µs)
CloudflareKVProvider - security: naive object inspection via Deno.inspect/JSON.stringify redacts apiToken (PLAT-15) ... ok (354µs)
CloudflareKVProvider - security: malformed JSON in list() response is redacted and mapped to InternalError (PLAT-15, PLAT-12) ... ok (311ms)

ok | 25 passed | 0 failed (5s)
```

#### `deno lint`
```
$ deno lint providers/kv/cloudflare-kv-provider.ts providers/kv/cloudflare-kv-provider_test.ts tests/security/cloudflare_kv_adversarial_test.ts
Checked 3 files
```

#### `deno fmt --check`
```
$ deno fmt --check providers/kv/cloudflare-kv-provider.ts providers/kv/cloudflare-kv-provider_test.ts tests/security/cloudflare_kv_adversarial_test.ts
Checked 3 files
```

## Assumptions made

Local integration tests run against an in-memory HTTP server mimicking Cloudflare's REST endpoints, ensuring zero third-party cloud credential requirements for test suites per PLAT-17.
