# Data Concept

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Conceptual Layer**: Data &nbsp;|&nbsp; **Verb**: `persist` &nbsp;|&nbsp; **Infrastructure Mapping**: Object ([`OBJ-1`](../contracts/objects.contract.md#OBJ-1)) &nbsp;|&nbsp; **Specification**: [`CONCEPT-1`](../contracts/concepts.contract.md#CONCEPT-1), [`CONCEPT-2`](../contracts/concepts.contract.md#CONCEPT-2), [`CONCEPT-7`](../contracts/concepts.contract.md#CONCEPT-7)

Data represents durable or bulk application data in RailFog.

$$\text{key} \longrightarrow \mathbf{Data} \longrightarrow \text{bytes}$$

---

## 1. Definition & Role

Data is responsible for:
- **Persisting**: Storing durable payloads and bulk binary data safely across time (`persist`).
- **Streaming**: Transporting multi-megabyte and gigabyte objects without full in-memory buffering (`ReadableStream`).
- **Direct Transfers**: Providing presigned URLs (`presign()`) so clients upload and download directly to/from storage (`OBJ-3`).

### Typical Uses
- User files, documents, and media (images, audio, video)
- System backups, database snapshots, and disaster recovery archives
- Compiled build artifacts, code packages, and WASM modules
- Datasets, exports, and analytics dumps

Data **should not be forced into State**. Small metadata belongs in State; the raw bytes belong in Data.

---

## 2. Conceptual vs. Infrastructure Mapping

| Layer | Terminology | Description |
| :--- | :--- | :--- |
| **Developer Concept** | **Data** | The product abstraction representing durable bulk byte persistence. |
| **Infrastructure Primitive** | **Object** | Object storage system (Local filesystem, AWS S3, Cloudflare R2). |
| **Fundamental Verb** | **`persist`** | The singular action performed by Data. |

---

## 3. Data by Reference & Zero-Copy Flow (`CONCEPT-7`)

RailFog strictly enforces the **Zero-Proxy Rule** (`OBJ-3`, `CONCEPT-7`):
- Compute functions must **never proxy large payloads through V8 heap memory** when a direct transfer applies.
- Client uploads obtain a presigned `PUT` reference; client downloads obtain a presigned `GET` reference:

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ data, json }) => {
  // Generate presigned upload reference directly to storage bucket (OBJ-3)
  const { url } = await data.presign("uploads/report.pdf", {
    method: "PUT",
    expiresIn: 3600,
  });

  return json({ uploadUrl: url });
});
```

When Compute must inspect or transform Data, it processes streams directly:

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ data, text }) => {
  const stream = await data.get("logs/today.txt");
  if (!stream) return text("Not found", 404);

  // Stream-transform without buffering entire object in memory
  return new Response(stream, {
    headers: { "content-type": "text/plain" },
  });
});
```
