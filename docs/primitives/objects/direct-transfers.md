# Objects — Direct Transfers & Presigning

> [!NOTE]
> **Documentation**: [Docs Home](../../README.md) &nbsp;|&nbsp;
> **Specification**: [OBJ-3 (Direct Client Transfers)](../../contracts/objects.contract.md#OBJ-3) &nbsp;|&nbsp;
> **Invariant**: Functions never act as bandwidth proxies

RailFog strictly enforces the **Zero-Bandwidth-Proxy Principle** (`OBJ-3`). Streaming multi-megabyte payloads through compute functions wastes isolate memory, CPU cycles, and network bandwidth while degrading concurrency.

---

## 1. Direct Transfer Architecture

Functions generate time-limited SigV4 presigned URLs via `ctx.objects.presign`, allowing web and mobile clients to upload and download directly to durable storage:

```
Direct Client-to-Storage Transfer Sequence (OBJ-3):

Client ─────────(1) Request Upload URL─────────► Function (api.ts)
Client ◄────────(2) Return Presigned PUT URL──── Function
Client ─────────(3) PUT Binary Bytes Direct────► Object Storage (app:uploads)
```

---

## 2. Generating Presigned URLs

```typescript
import type { FunctionHandler } from "@railfog/sdk";

const handler: FunctionHandler = async (req, ctx) => {
  const fileKey = `uploads/${crypto.randomUUID()}.jpg`;

  // Generate a presigned PUT URL valid for 15 minutes (OBJ-3)
  const { url } = await ctx.objects.presign(fileKey, {
    method: "PUT",
    expiresIn: 900,
  });

  return Response.json({
    uploadUrl: url,
    key: fileKey,
  });
};

export default handler;
```

---

## 3. Client-Side Direct Upload

From the browser or mobile application:

```javascript
// Browser upload directly to storage bucket without passing through function
async function uploadFile(uploadUrl, fileBlob) {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    body: fileBlob,
    headers: {
      "Content-Type": fileBlob.type,
    },
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.statusText}`);
  }
}
```

---

## Next Steps

- Explore the [Queues Primitive](../queues/overview.md).
- Learn about [Idempotency & Dead-Letter Queues](../queues/dead-letter-queues.md).
