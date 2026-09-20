# Contract — Objects

Source: `railfog-v1_0_0-lts.md` §4.3, §7.2 (content addressing), Appendix A.

## OBJ-1 — Purpose

Durable binary storage: uploads, backups, build artifacts, datasets.
S3-compatible substrate by default (Principle 3 — reuse, don't rebuild).

## OBJ-2 — API

```typescript
await objects.put(key, data);
await objects.get(key);
await objects.delete(key);
await objects.head(key);
await objects.list(prefix, { limit?: number; cursor?: string });
await objects.createMultipartUpload(key);   // required above 5 MB (S3 convention)
await objects.presign(key, { method, expiresIn = 900, maxExpiresIn = 86400 });
```

## OBJ-3 — Direct client↔storage transfer (never a bandwidth proxy)

Presigned URLs use standard SigV4-style signing — reuse the existing standard,
never invent a signing scheme. Uploads and downloads must go client ↔ storage
directly:

```
Client → (1) request presigned URL → Function
Function → (2) presigned URL → Client
Client → (3) PUT directly → Object Storage
```

Never implement an upload/download path that streams file bytes through a
Function or through the control plane — this is exactly the "RailFog as
bandwidth proxy" anti-pattern the spec rejects (bandwidth, latency, CPU,
memory, failure surface, and cost all get worse for no benefit).

## OBJ-4 — Content addressing

```
artifact_id = "sha256:" + hex(sha256(bytes))
integrity   = "sha256-" + base64(sha256(bytes))   // Subresource Integrity convention — reuse, don't invent
```

Applies to deployment artifacts (`platform.contract.md` PLAT-3) and should be
the same primitive used anywhere else content-addressing is needed — one hash
function, one encoding convention, not two.

## Banned patterns

- Proxying object bytes through a Function or the control-plane API for
  ordinary upload/download (OBJ-3 exists specifically to prevent this).
- Inventing a custom URL-signing scheme instead of SigV4-style presigning.
- Using a hash function or encoding other than SHA-256 / hex / base64 for
  content addressing, "for performance" or otherwise, without an ADR.
