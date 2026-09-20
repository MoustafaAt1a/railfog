/**
 * Local Filesystem Object Provider
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-16 (Provider abstraction)
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-17 (Local/production parity)
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-2 (API)
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-3 (Direct transfer)
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-4 (Content addressing)
 */

import { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";
import { encodeHex } from "@std/encoding/hex";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { dirname, isAbsolute, join, relative, resolve } from "@std/path";
import { computeSha256 } from "../../packages/core/crypto/content-address.ts";

export class LocalFSProvider implements ObjectProvider {
  private readonly rootAbs: string;
  private readonly hmacSecret: string;

  constructor(
    private readonly rootDir: string,
    options?: { hmacSecret?: string },
  ) {
    this.rootAbs = resolve(rootDir);
    this.hmacSecret = options?.hmacSecret ??
      "railfog-local-fs-internal-secret-token";
  }

  private getPath(key: string): string {
    const fsKey = key
      .split("/")
      .map((seg) => seg.replace(/:/g, "%3A"))
      .join("/");
    const absPath = resolve(this.rootDir, fsKey);
    const rel = relative(this.rootAbs, absPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new ValidationFailedError(
        "Path traversal detected: path escapes root directory",
      );
    }
    return absPath;
  }

  async put(
    key: string,
    data: ArrayBuffer | ReadableStream,
  ): Promise<{ etag: string }> {
    const filePath = this.getPath(key);

    // Ensure parent directory exists
    const dir = dirname(filePath);
    await Deno.mkdir(dir, { recursive: true });

    let buffer: Uint8Array;
    if (data instanceof ReadableStream) {
      const chunks: Uint8Array[] = [];
      const reader = data.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
      buffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }
    } else {
      buffer = new Uint8Array(data);
    }

    await Deno.writeFile(filePath, buffer);
    const hashBuffer = await computeSha256(buffer);
    const etag = encodeHex(hashBuffer);

    return { etag };
  }

  async get(key: string): Promise<ReadableStream | null> {
    try {
      const file = await Deno.open(this.getPath(key), { read: true });
      return file.readable;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        return null;
      }
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await Deno.remove(this.getPath(key));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        throw e;
      }
    }
  }

  async head(key: string): Promise<{ size: number; etag: string } | null> {
    try {
      const filePath = this.getPath(key);
      const stat = await Deno.stat(filePath);
      if (stat.isDirectory) {
        return null;
      }
      const data = await Deno.readFile(filePath);
      const hashBuffer = await computeSha256(data);
      const etag = encodeHex(hashBuffer);
      return { size: stat.size, etag };
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        return null;
      }
      throw e;
    }
  }

  async list(
    prefix: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: string[]; cursor?: string }> {
    const limit = opts?.limit ?? 100;
    const allKeys: string[] = [];

    async function walk(dir: string, base: string) {
      try {
        for await (const entry of Deno.readDir(dir)) {
          // Normalize to forward slashes for keys
          const decodedName = entry.name.replace(/%3A/g, ":");
          const entryKey = base ? `${base}/${decodedName}` : decodedName;
          if (entry.isDirectory) {
            await walk(join(dir, entry.name), entryKey);
          } else {
            allKeys.push(entryKey);
          }
        }
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          throw e;
        }
      }
    }

    await walk(this.rootDir, "");

    let filtered = allKeys.filter((k) => k.startsWith(prefix));
    filtered.sort(); // Sort keys lexicographically

    if (opts?.cursor) {
      const idx = filtered.indexOf(opts.cursor);
      if (idx !== -1) {
        filtered = filtered.slice(idx + 1);
      }
    }

    const keys = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    const nextCursor = hasMore ? keys[keys.length - 1] : undefined;

    return { keys, cursor: nextCursor };
  }

  async presign(
    key: string,
    opts: { method: "GET" | "PUT"; expiresIn?: number; maxExpiresIn?: number },
  ): Promise<{ url: string; expiresAt: number }> {
    const max = opts.maxExpiresIn ?? 86400;
    const expiresIn = opts.expiresIn ?? 900;

    if (expiresIn > max) {
      throw new ValidationFailedError("VALIDATION_FAILED");
    }

    const expiresAt = Date.now() + expiresIn * 1000;

    const payload = JSON.stringify({ key, method: opts.method, expiresAt });
    const token = encodeBase64(new TextEncoder().encode(payload));
    const sigBytes = await computeSha256(
      new TextEncoder().encode(`${token}:${this.hmacSecret}`),
    );
    const sig = encodeHex(sigBytes);

    const url = `http://localhost/local-fs/${key}?token=${token}&sig=${sig}`;
    return { url, expiresAt };
  }

  async verifyPresignedUrl(
    url: string,
    expectedMethod?: "GET" | "PUT",
  ): Promise<boolean> {
    try {
      const urlObj = new URL(url);
      const token = urlObj.searchParams.get("token");
      if (!token) return false;

      const sig = urlObj.searchParams.get("sig");
      if (!sig) return false;

      const expectedSigBytes = await computeSha256(
        new TextEncoder().encode(`${token}:${this.hmacSecret}`),
      );
      const expectedSig = encodeHex(expectedSigBytes);
      if (sig !== expectedSig) {
        return false;
      }

      const payloadStr = new TextDecoder().decode(decodeBase64(token));
      const payload = JSON.parse(payloadStr);

      if (
        typeof payload.expiresAt !== "number" ||
        Date.now() > payload.expiresAt
      ) {
        return false;
      }

      // Verify that the key in the token matches the requested key
      const rawKey = urlObj.pathname.replace(/^\/local-fs\//, "");
      const requestedKey = decodeURIComponent(rawKey);
      if (payload.key !== requestedKey) {
        return false;
      }

      // Verify HTTP method if specified
      if (expectedMethod && payload.method !== expectedMethod) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  createMultipartUpload(_key: string): Promise<{ uploadId: string }> {
    // Deferred chunking logic for local dev, providing functioning stub for interface
    return Promise.resolve({ uploadId: generateUlid() });
  }
}
