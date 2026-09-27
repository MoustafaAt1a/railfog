# Object Storage Guide

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`OBJ-1` to `OBJ-4`](../contracts/objects.contract.md) &nbsp;|&nbsp; **Core
> Invariant**: Zero-Bandwidth-Proxy Principle (`OBJ-3`)

The Object storage primitive provides durable binary storage for files, media,
and data exports. It is the infrastructure implementation of the **Data** concept (`persist`) ([`Data Concept`](../concepts/data.md)),
accessible in handlers via `ctx.data` (with `ctx.objects` supported for backwards compatibility) ([`CONCEPT-2`](../contracts/concepts.contract.md#CONCEPT-2)). It
is backed by S3-compatible cloud storage (Cloudflare R2, AWS S3) in production and
the local filesystem in development.

---

## 1. Declaring Objects in `railfog.toml`

Declare object store buckets under `[objects.<name>]` and grant capability
access via `permissions.objects`:

```toml
name = "media-service"

[functions.api]
entry = "functions/api.ts"
[functions.api.permissions]
objects = ["app:uploads"]

[objects."app:uploads"]
```

---

## 2. The Zero-Bandwidth-Proxy Principle (`OBJ-3`)

Streaming multi-megabyte files through serverless compute functions wastes
isolate memory, blocks worker threads, and inflates cloud egress costs.

RailFog strictly enforces the **Zero-Bandwidth-Proxy Principle** (`OBJ-3`):

1. The client requests an upload or download URL from the function.
2. The function generates a time-limited SigV4 presigned URL via
   `ctx.data.presign` (or `c.data.presign`).
3. The client transfers binary bytes directly to the object storage endpoint.

```
Direct Client-to-Storage Transfer (OBJ-3):

Client ─────────(1) Request Upload URL─────────► Function (api.ts)
Client ◄────────(2) Return Presigned PUT URL──── Function
Client ─────────(3) PUT Binary Bytes Direct────► Object Storage (S3 / R2)
```

---

## 3. Presigning Uploads & Downloads

```typescript
import { compute, type HandlerContext } from "@railfog/sdk";

export default compute(async (c: HandlerContext) => {
  const fileId = crypto.randomUUID();
  const fileKey = `uploads/${fileId}.png`;

  // Generate a direct PUT upload URL valid for 15 minutes (900 seconds) via Data primitive
  const storage = c.data;
  const { url, headers } = await storage.presign(fileKey, {
    method: "PUT",
    expiresIn: 900,
  });

  return c.json({
    uploadUrl: url,
    key: fileKey,
    headers,
  });
});
```

### Client-Side Direct Upload (Browser / Mobile)

```javascript
async function uploadToStorage(uploadUrl, fileBlob) {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: fileBlob,
    headers: {
      "Content-Type": fileBlob.type,
    },
  });

  if (!response.ok) {
    throw new Error(`Direct upload failed with status ${response.status}`);
  }
}
```

---

## 4. Direct Operations (`get`, `put`, `delete`)

When background workers need to transform or inspect stored files, use direct
stream access:

```typescript
import type { QueueConsumerHandler } from "@railfog/sdk";

export default (async (message, ctx) => {
  const { fileKey } = message.body as { fileKey: string };
  const storage = ctx.data;

  // 1. Read object stream via Data primitive
  const stream = await storage.get(fileKey);
  if (!stream) {
    console.warn(`Object ${fileKey} not found`);
    return;
  }

  // 2. Read bytes into memory
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  console.log(`Read ${bytes.length} bytes from ${fileKey}`);

  // 3. Write transformed result
  await storage.put(`thumbnails/${fileKey}`, bytes, {
    contentType: "image/jpeg",
  });

  // 4. Delete source if necessary
  // await storage.delete(fileKey);
}) as QueueConsumerHandler;
```

---

## Next Steps

- Learn about [Asynchronous Queues](queues.md).
- Learn about [Capability Permissions](secrets.md).
