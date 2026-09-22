# Objects Primitive — Overview

> [!NOTE]
> **Documentation**: [Docs Home](../../README.md) &nbsp;|&nbsp;
> **Specification**: [OBJ-1, OBJ-2, OBJ-4](../../contracts/objects.contract.md)
> &nbsp;|&nbsp; **Compatibility**: Standard S3 / R2 API

The Objects primitive (`ctx.objects` / `ObjectBinding`) provides durable binary
asset storage for files, media, build artifacts, and database backups.

---

## 1. Object Operations

```typescript
import type { ObjectBinding } from "@railfog/sdk";

export async function demonstrateObjects(
  objects: ObjectBinding,
): Promise<void> {
  // 1. Write binary payload
  const data = new TextEncoder().encode("Hello Object Storage");
  await objects.put("reports/summary.txt", data, {
    contentType: "text/plain",
  });

  // 2. Read stream
  const stream = await objects.get("reports/summary.txt");
  if (stream) {
    const text = await new Response(stream).text();
    console.log("Read payload:", text);
  }

  // 3. Check existence & metadata
  const meta = await objects.head("reports/summary.txt");
  if (meta) {
    console.log("Size in bytes:", meta.size);
    console.log("ETag:", meta.etag);
  }

  // 4. Delete object
  await objects.delete("reports/summary.txt");
}
```

---

## 2. The Direct-Transfer Philosophy (`OBJ-3`)

Unlike legacy backends that proxy multi-megabyte file uploads through compute
containers, RailFog enforces direct client-to-storage transfer via SigV4
presigned URLs. Functions never proxy raw binary streams.

---

## Next Steps

- Read about [Direct Uploads & Presigned URLs](direct-uploads.md).
- Explore the [Queues Primitive](../queues/overview.md).
