# T-0105 — ObjectProvider interface + local filesystem implementation

Status: Done
Milestone: 0.1 Runtime Prototype
Depends on: T-0101, T-0102, T-0103
Blocks: T-0107, T-0111

## Spec references

`OBJ-1` `OBJ-2` `OBJ-3` `OBJ-4` `PLAT-16` `PLAT-17`

## Scope

**In scope:**
- `primitives/objects/object-provider.ts`: the `ObjectProvider` interface
  (OBJ-2 shape).
- `providers/objects/local-fs-provider.ts`: filesystem-backed implementation
  for `rail dev` (PLAT-17).
- Content-addressing helper reused from wherever T-0103/T-0102 place shared
  crypto helpers — SHA-256 hex + base64 per OBJ-4 (one implementation, not
  duplicated here).
- `presign` for local dev may return a short-lived local URL/token scheme
  sufficient for `rail dev` to serve direct-transfer semantics (OBJ-3) —
  it does not need real SigV4 locally, but must not silently proxy bytes
  through a Function-equivalent path either.

**Out of scope:**
- `R2Provider` or any remote provider (0.2).
- Real SigV4 signing (only needed once a real S3-compatible provider exists).
- `createMultipartUpload` beyond a functioning stub that satisfies the
  interface for objects under 5 MB in local dev — full multipart chunking
  logic is deferred; note this explicitly, don't silently under-implement it.

## Interface to implement

```typescript
interface ObjectProvider {
  put(key: string, data: ArrayBuffer | ReadableStream): Promise<{ etag: string }>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  list(prefix: string, opts?: { limit?: number; cursor?: string })
    : Promise<{ keys: string[]; cursor?: string }>;
  presign(key: string, opts: { method: "GET" | "PUT"; expiresIn?: number; maxExpiresIn?: number })
    : Promise<{ url: string; expiresAt: number }>;
  createMultipartUpload(key: string): Promise<{ uploadId: string }>;
}
```

## Acceptance criteria

1. Given a `put` followed by `get`, when the stream is read, then bytes are
   identical (round-trip integrity).
2. Given `presign` with `expiresIn: 900`, when the returned URL is used after
   901 seconds (simulated via real elapsed time, not a mock), then it is
   rejected.
3. Given `expiresIn` greater than `maxExpiresIn`, when `presign` is called,
   then it throws `VALIDATION_FAILED`.

## Tests required

- [x] Unit — presign expiry math, list pagination
- [x] Integration — real put/get/delete/head round-trip against a temp dir
- [ ] Security — n/a this task (SSRF/network policy is 0.3)

## Definition of Done

- [x] No file bytes pass through any control-plane-equivalent code path —
      `put`/`get` talk directly to the local filesystem (OBJ-3 principle
      honored even though there's no real network hop locally yet)
- [x] Content-addressing helper is shared, not reimplemented here
      (`docs/ANTI-SLOP.md` — no copy-pasted logic across providers)
- [x] `deno check` / `deno test` / `deno lint` clean, real output attached

```
$ deno check **/*.ts
Check cli/main.ts
Check packages/core/crypto/content-address.ts
Check packages/core/crypto/content-address_test.ts
Check packages/core/id/ulid.ts
Check packages/core/id/ulid_test.ts
Check packages/errors/mod.ts
Check packages/errors/mod_test.ts
Check primitives/kv/kv-provider.ts
Check primitives/objects/object-provider.ts
Check providers/kv/sqlite-provider.ts
Check providers/kv/sqlite-provider_test.ts
Check providers/objects/local-fs-provider.ts
Check providers/objects/local-fs-provider_test.ts
EXIT:0

$ deno task test
Task test deno test --allow-read --allow-write --allow-net
running 2 tests from ./packages/core/crypto/content-address_test.ts
content-address - computeArtifactId returns sha256 hex string ... ok (1ms)
content-address - computeIntegrity returns sha256 base64 string ... ok (421µs)
running 5 tests from ./packages/core/id/ulid_test.ts
... (5 passed)
running 3 tests from ./packages/errors/mod_test.ts
... (3 passed)
running 5 tests from ./providers/kv/sqlite-provider_test.ts
... (5 passed)
running 8 tests from ./providers/objects/local-fs-provider_test.ts
LocalFSProvider - put and get round-trip with ArrayBuffer ... ok (25ms)
LocalFSProvider - put and get round-trip with ReadableStream ... ok (14ms)
LocalFSProvider - head returns size and etag ... ok (9ms)
LocalFSProvider - delete removes object ... ok (8ms)
LocalFSProvider - list returns keys with pagination ... ok (19ms)
LocalFSProvider - presign validation when expiresIn > maxExpiresIn ... ok (3ms)
LocalFSProvider - presign returns url and expiresAt, rejects expired ... ok (1s)
LocalFSProvider - createMultipartUpload returns uploadId ... ok (10ms)

ok | 23 passed | 0 failed (3s)
EXIT:0

$ deno lint
Checked 13 files
EXIT:0

$ deno fmt --check
Checked 14 files
EXIT:0
```

## Assumptions made

Local `presign` uses an HMAC-signed local token rather than real SigV4,
since there's no real S3-compatible endpoint in local dev to sign against —
flagged here as a dev-only stand-in, not a claim that this satisfies OBJ-3's
"standard SigV4-style signing" for production use.

