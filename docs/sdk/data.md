# SDK: Data

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Package**: `@railfog/sdk` &nbsp;|&nbsp; **Conceptual Layer**: Data &nbsp;|&nbsp; **Specification**: [`CONCEPT-2`](../contracts/concepts.contract.md#CONCEPT-2), [`OBJ-2`](../contracts/objects.contract.md#OBJ-2), [`OBJ-3`](../contracts/objects.contract.md#OBJ-3)

Data represents durable bulk persistence accessed via `c.data` (or `c.objects`).

---

## 1. `DataBinding` Methods

```typescript
export interface DataBinding {
  put(key: string, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void>;
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<{ sizeBytes: number; sha256: string; integrity: string } | null>;
  list(prefix: string, options?: ListOptions): Promise<{
    keys: Array<{ key: string; sizeBytes: number; sha256: string }>;
    cursor?: string;
  }>;
  createMultipartUpload(key: string): Promise<{ uploadId: string }>;
  presign(key: string, options: PresignOptions): Promise<{ url: string; headers: Record<string, string> }>;
}
```

---

## 2. Presigned Transfers (`presign()`)

Generate SigV4 direct-to-storage presigned URLs to bypass Compute bandwidth bottlenecks (`OBJ-3`, `CONCEPT-7`):

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ data, json }) => {
  // Direct client-to-storage upload URL
  const upload = await data.presign("documents/contract.pdf", {
    method: "PUT",
    expiresIn: 1800,
  });

  return json({ uploadUrl: upload.url });
});
```

---

## 3. Streaming Reads and Writes

When reading or transforming Data inside Compute, use Web standard `ReadableStream`:

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ data, notFound }) => {
  const stream = await data.get("reports/export.csv");
  if (!stream) notFound("Report not found");

  return new Response(stream, {
    headers: { "content-type": "text/csv" },
  });
});
```
