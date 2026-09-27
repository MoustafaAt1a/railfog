# Data Providers

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Conceptual Layer**: Data &nbsp;|&nbsp; **Specification**:
> [`OBJ-1`](../contracts/objects.contract.md#OBJ-1) to [`OBJ-4`](../contracts/objects.contract.md#OBJ-4),
> [`PLAT-16`](../contracts/platform.contract.md#PLAT-16)

Data providers implement durable, bulk binary storage for RailFog applications.

In the infrastructure layer, Data maps to the **Object** primitive, managed via the `ObjectProvider` SPI.

---

## 1. The ObjectProvider SPI

All Data backends implement the `ObjectProvider` interface in `primitives/`:

```typescript
export interface ObjectProvider {
  /** Streams an object's binary bytes from durable storage. */
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;

  /** Writes a streaming or buffer payload into durable storage. */
  put(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options?: { contentType?: string },
  ): Promise<void>;

  /** Deletes an object by key. */
  delete(key: string): Promise<void>;

  /** Lists objects matching a prefix with pagination. */
  list(prefix: string, options?: ObjectListOptions): Promise<ObjectListResult>;

  /** Generates a time-limited presigned URL for direct client transfers. */
  presign(
    key: string,
    options: PresignOptions,
  ): Promise<{ url: string; headers?: Record<string, string> }>;
}
```

---

## 2. Supported Data Backends

### 2.1 Local Filesystem (`LocalFsObjectProvider`)
- **Use Case**: Default local development (`rail dev`).
- **Storage Location**: Stored under `.railfog/storage/objects/<bucket>/`.
- **Presigned Transfers**: Local gateway routes (`http://localhost:8080/__storage/...`) authenticated with signed HMAC tokens.

### 2.2 Cloudflare R2 (`R2ObjectProvider`)
- **Use Case**: Production deployments prioritizing zero egress fees and global low-latency distribution.
- **Protocol**: S3-compatible API using native AWS SigV4 request signatures.
- **Presigned URLs**: Signed SigV4 URLs delegating PUT/GET transfers directly to the R2 bucket.

### 2.3 AWS S3 (`S3ObjectProvider`)
- **Use Case**: Enterprise AWS deployments and S3-compatible systems (MinIO, Ceph, Google Cloud Storage).
- **Features**: Multipart upload coordination, server-side encryption, and lifecycle tiering.

---

## 3. The Zero-Bandwidth-Proxy Principle (`OBJ-3`)

Data providers enforce the architectural principle that **compute isolates never proxy large binary transfers**:

```
Direct Client-to-Storage Transfer (OBJ-3):

Client ─────────(1) Request Upload URL─────────► Compute Function (api.ts)
Client ◄────────(2) Return Presigned PUT URL──── Compute Function
Client ─────────(3) PUT Binary Bytes Direct────► Data Storage (S3 / R2)
```

1. Functions generate short-lived presigned URLs via `data.presign(key, { method: "PUT" })`.
2. Clients stream bytes directly to the object storage endpoint.
3. Compute resources remain lightweight and unblocked.
