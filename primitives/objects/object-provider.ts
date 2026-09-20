/**
 * Object Provider Interface
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-2 (API shape)
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-16 (Provider abstraction)
 */

export interface ObjectProvider {
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
