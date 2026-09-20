# T-0203 — R2 remote object storage provider

Status: Done
Milestone: 0.2 Cloud Prototype
Depends on: T-0102, T-0105
Blocks: T-0207, T-0211

## Spec references

`OBJ-1` `OBJ-2` `OBJ-3` `OBJ-4` `PLAT-16` `PLAT-17`

## Scope

**In scope:**
- `providers/objects/r2-provider.ts`: implement `ObjectProvider` interface (`primitives/objects/object-provider.ts`) for Cloudflare R2 / S3-compatible object storage backends.
- Implement methods: `put`, `get`, `delete`, `head`, `list`, `createMultipartUpload`, `presign`.
- Standard AWS SigV4 presigned URL generation per `docs/contracts/objects.contract.md` OBJ-3 (direct client-to-storage transfer).
- Presign validation per OBJ-2: default `expiresIn = 900`, `maxExpiresIn = 86400`; throw `VALIDATION_FAILED` if `expiresIn > maxExpiresIn`.
- Pagination support for `list` with cursor and limit.

**Out of scope:**
- Any custom non-SigV4 signing scheme (banned per OBJ-3).
- Proxying object bytes through any intermediary Function or control-plane endpoint (strictly banned per OBJ-3).
- Local filesystem storage (covered by `LocalFSProvider` in Milestone 0.1).

## Interface to implement

```typescript
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";

export interface R2ProviderOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string; // defaults to "auto"
}

export class R2Provider implements ObjectProvider {
  constructor(options: R2ProviderOptions);
  put(
    key: string,
    data: ArrayBuffer | ReadableStream,
  ): Promise<{ etag: string }>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  list(
    prefix: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: string[]; cursor?: string }>;
  presign(
    key: string,
    opts: { method: "GET" | "PUT"; expiresIn?: number; maxExpiresIn?: number },
  ): Promise<{ url: string; expiresAt: number }>;
  createMultipartUpload(key: string): Promise<{ uploadId: string }>;
}
```

## Acceptance criteria

1. Given a configured `R2Provider`, when `put` is called with an ArrayBuffer, then it transmits an S3 HTTP PUT request and returns the resulting `{ etag }` (OBJ-2).
2. Given an existing object, when `get` is called, then it streams the exact stored bytes back as a `ReadableStream` (OBJ-2).
3. Given a key, when `presign(key, { method: "PUT" })` is called, then it returns a URL formatted with standard SigV4 query parameters (`X-Amz-Algorithm=AWS4-HMAC-SHA256`, `X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires`) pointing directly to the object store endpoint (OBJ-3).
4. Given `presign` called with `expiresIn` greater than `maxExpiresIn` (default 86400), then it throws `VALIDATION_FAILED` (OBJ-2, PLAT-12).
5. Given more objects than `limit` under a prefix, when `list` is called, then it returns a cursor, and the next call with that cursor resumes without repeating items.

## Tests required

- [x] Unit — SigV4 canonical request creation, HMAC-SHA256 string-to-sign derivation, query parameter serialization, expiration bounds check
- [x] Integration — put, get, head, delete, list, and createMultipartUpload round-trip against a local S3-compatible test server (e.g., local mock or HTTP server verifying standard S3 wire protocol)
- [x] Security — verify presigned URLs address the remote storage bucket directly and contain no intermediate proxy route (OBJ-3)

## Definition of Done

- [x] Implementation matches cited clause IDs (`OBJ-1`, `OBJ-2`, `OBJ-3`, `OBJ-4`, `PLAT-16`, `PLAT-17`)
- [x] SigV4 signing implementation uses standard Web Crypto (`crypto.subtle`) without proprietary native addons
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched

```
$ deno check providers/objects/r2-provider.ts providers/objects/r2-provider_test.ts
Check providers/objects/r2-provider.ts
Check providers/objects/r2-provider_test.ts
EXIT:0

$ deno test --allow-net providers/objects/r2-provider_test.ts
running 4 tests from ./providers/objects/r2-provider_test.ts
Unit: Presign URL formatting with SigV4 query parameters and OBJ-3 direct addressing ... ok (16ms)
Unit: AC4 - Presign validation bounds check (OBJ-2, PLAT-12) ... ok (1ms)
Integration: Put, get, head, delete, list, and createMultipartUpload round-trip against local S3 wire server ... ok (363ms)
Security: OBJ-3 Presigned URLs point directly to object store and never an intermediary proxy route ... ok (709µs)

ok | 4 passed | 0 failed (392ms)
EXIT:0

$ deno task test
Task test deno test --allow-read --allow-write --allow-net --allow-run
...
ok | 93 passed | 0 failed (14s)
EXIT:0

$ deno task check
Task check deno check **/*.ts
EXIT:0

$ deno lint
Checked 38 files
EXIT:0

$ deno fmt --check
Checked 39 files
EXIT:0
```

## Assumptions made

Local integration tests run against a lightweight in-process S3 wire-compatible HTTP server rather than requiring live Cloudflare credentials, preserving local development autonomy per PLAT-17.
