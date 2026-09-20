/**
 * R2 Remote Object Storage Provider
 *
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-16 (Provider abstraction)
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-17 (Local/production parity)
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-1 (Purpose)
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-2 (API shape & limits)
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-3 (Direct client-to-storage transfer)
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-4 (Content addressing)
 */

import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import { encodeHex } from "@std/encoding/hex";
import { computeSha256 } from "../../packages/core/crypto/content-address.ts";

export interface R2ProviderOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string; // defaults to "auto"
}

/**
 * Standard AWS SigV4 cryptographic signing helpers using Web Crypto.
 */
async function hmacSha256(
  key: Uint8Array,
  data: string,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(data),
  );
  return new Uint8Array(signature);
}

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  regionName: string,
  serviceName: string,
): Promise<Uint8Array> {
  const kDate = await hmacSha256(
    new TextEncoder().encode("AWS4" + secretKey),
    dateStamp,
  );
  const kRegion = await hmacSha256(kDate, regionName);
  const kService = await hmacSha256(kRegion, serviceName);
  const kSigning = await hmacSha256(kService, "aws4_request");
  return kSigning;
}

export class R2Provider implements ObjectProvider {
  private readonly region: string;

  constructor(private readonly options: R2ProviderOptions) {
    this.region = options.region ?? "auto";
  }

  private getObjectUrl(key: string, queryParams?: Record<string, string>): URL {
    const cleanEndpoint = this.options.endpoint.replace(/\/$/, "");
    const cleanKey = key.replace(/^\//, "");
    const path = cleanKey
      ? `/${this.options.bucket}/${cleanKey}`
      : `/${this.options.bucket}`;
    const url = new URL(`${cleanEndpoint}${path}`);

    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) {
        url.searchParams.set(k, v);
      }
    }
    return url;
  }

  private async signedFetch(
    method: string,
    key: string,
    queryParams?: Record<string, string>,
    bodyBytes?: Uint8Array,
    customHeaders?: HeadersInit,
  ): Promise<Response> {
    const url = this.getObjectUrl(key, queryParams);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;

    const payloadHash = bodyBytes
      ? encodeHex(await computeSha256(bodyBytes))
      : encodeHex(await computeSha256(new Uint8Array(0)));

    // Canonical query string
    const queryEntries = Array.from(url.searchParams.entries()).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    const canonicalQueryString = queryEntries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    // Canonical headers
    const headersToSign = new Map<string, string>();
    headersToSign.set("host", url.host);
    headersToSign.set("x-amz-content-sha256", payloadHash);
    headersToSign.set("x-amz-date", amzDate);

    const sortedHeaderKeys = Array.from(headersToSign.keys()).sort();
    const canonicalHeaders = sortedHeaderKeys
      .map((h) => `${h}:${headersToSign.get(h)!.trim()}\n`)
      .join("");
    const signedHeaders = sortedHeaderKeys.join(";");

    // Canonical request
    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      encodeHex(
        await computeSha256(new TextEncoder().encode(canonicalRequest)),
      ),
    ].join("\n");

    const signingKey = await getSignatureKey(
      this.options.secretAccessKey,
      dateStamp,
      this.region,
      "s3",
    );
    const signature = encodeHex(await hmacSha256(signingKey, stringToSign));

    const authHeader =
      `AWS4-HMAC-SHA256 Credential=${this.options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers = new Headers(customHeaders);
    headers.set("Authorization", authHeader);
    headers.set("x-amz-date", amzDate);
    headers.set("x-amz-content-sha256", payloadHash);
    if (bodyBytes) {
      headers.set("content-length", bodyBytes.byteLength.toString());
    }

    return await fetch(url.toString(), {
      method,
      headers,
      body: bodyBytes ? (bodyBytes as unknown as BodyInit) : undefined,
    });
  }

  async put(
    key: string,
    data: ArrayBuffer | ReadableStream,
  ): Promise<{ etag: string }> {
    let buffer: Uint8Array;
    if (data instanceof ReadableStream) {
      const chunks: Uint8Array[] = [];
      const reader = data.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
      buffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const c of chunks) {
        buffer.set(c, offset);
        offset += c.length;
      }
    } else {
      buffer = new Uint8Array(data);
    }

    const res = await this.signedFetch(
      "PUT",
      key,
      undefined,
      buffer,
      { "content-type": "application/octet-stream" },
    );

    if (!res.ok) {
      throw new Error(
        `R2 put failed with HTTP ${res.status}: ${res.statusText}`,
      );
    }

    const etagHeader = res.headers.get("etag") ?? res.headers.get("ETag") ?? "";
    const etag = etagHeader.replace(/^"|"$/g, "");
    return { etag };
  }

  async get(key: string): Promise<ReadableStream | null> {
    const res = await this.signedFetch("GET", key);
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(
        `R2 get failed with HTTP ${res.status}: ${res.statusText}`,
      );
    }
    return res.body;
  }

  async delete(key: string): Promise<void> {
    const res = await this.signedFetch("DELETE", key);
    if (res.status === 404 || res.status === 204 || res.status === 200) {
      return;
    }
    if (!res.ok) {
      throw new Error(
        `R2 delete failed with HTTP ${res.status}: ${res.statusText}`,
      );
    }
  }

  async head(key: string): Promise<{ size: number; etag: string } | null> {
    const res = await this.signedFetch("HEAD", key);
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(
        `R2 head failed with HTTP ${res.status}: ${res.statusText}`,
      );
    }

    const size = parseInt(res.headers.get("content-length") ?? "0", 10);
    const etag = (res.headers.get("etag") ?? res.headers.get("ETag") ?? "")
      .replace(/^"|"$/g, "");
    return { size, etag };
  }

  async list(
    prefix: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: string[]; cursor?: string }> {
    const queryParams: Record<string, string> = {
      "list-type": "2",
      prefix,
    };
    if (opts?.limit !== undefined) {
      queryParams["max-keys"] = opts.limit.toString();
    }
    if (opts?.cursor !== undefined) {
      queryParams["continuation-token"] = opts.cursor;
    }

    const res = await this.signedFetch("GET", "", queryParams);
    if (!res.ok) {
      throw new Error(
        `R2 list failed with HTTP ${res.status}: ${res.statusText}`,
      );
    }

    const text = await res.text();
    const keys: string[] = [];
    const keyRegex = /<Key>([\s\S]*?)<\/Key>/g;
    let match: RegExpExecArray | null;
    while ((match = keyRegex.exec(text)) !== null) {
      keys.push(match[1]);
    }

    const nextTokenMatch =
      /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(text);
    const cursor = nextTokenMatch ? nextTokenMatch[1] : undefined;

    return { keys, cursor };
  }

  async presign(
    key: string,
    opts: { method: "GET" | "PUT"; expiresIn?: number; maxExpiresIn?: number },
  ): Promise<{ url: string; expiresAt: number }> {
    const maxExpiresIn = opts.maxExpiresIn ?? 86400;
    const expiresIn = opts.expiresIn ?? 900;

    // Spec: OBJ-2 validation (default maxExpiresIn 86400, default expiresIn 900)
    if (expiresIn > maxExpiresIn) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: expiresIn (${expiresIn}) exceeds maxExpiresIn (${maxExpiresIn})`,
      );
    }
    if (expiresIn <= 0) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: expiresIn must be positive",
      );
    }

    const url = this.getObjectUrl(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;

    url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
    url.searchParams.set(
      "X-Amz-Credential",
      `${this.options.accessKeyId}/${credentialScope}`,
    );
    url.searchParams.set("X-Amz-Date", amzDate);
    url.searchParams.set("X-Amz-Expires", expiresIn.toString());
    url.searchParams.set("X-Amz-SignedHeaders", "host");

    // Canonical query string sorted alphabetically
    const queryEntries = Array.from(url.searchParams.entries()).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    const canonicalQueryString = queryEntries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const canonicalHeaders = `host:${url.host}\n`;
    const signedHeaders = "host";
    const hashedPayload = "UNSIGNED-PAYLOAD";

    const canonicalRequest = [
      opts.method,
      url.pathname,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      hashedPayload,
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      encodeHex(
        await computeSha256(new TextEncoder().encode(canonicalRequest)),
      ),
    ].join("\n");

    const signingKey = await getSignatureKey(
      this.options.secretAccessKey,
      dateStamp,
      this.region,
      "s3",
    );
    const signature = encodeHex(await hmacSha256(signingKey, stringToSign));

    url.searchParams.set("X-Amz-Signature", signature);

    const expiresAt = Date.now() + expiresIn * 1000;
    return { url: url.toString(), expiresAt };
  }

  async createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    const res = await this.signedFetch("POST", key, { uploads: "" });
    if (!res.ok) {
      throw new Error(
        `R2 createMultipartUpload failed with HTTP ${res.status}: ${res.statusText}`,
      );
    }

    const text = await res.text();
    const uploadIdMatch = /<UploadId>([\s\S]*?)<\/UploadId>/.exec(text);
    if (!uploadIdMatch) {
      throw new Error(
        "Invalid createMultipartUpload response: missing UploadId element",
      );
    }

    return { uploadId: uploadIdMatch[1] };
  }
}
