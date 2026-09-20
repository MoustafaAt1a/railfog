// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
// spec: contracts/kv.contract.md#KV-5 — Consistency tiers: eventual tier backing
import type {
  KVAtomicBuilder,
  KVProvider,
} from "../../primitives/kv/kv-provider.ts";
import {
  InternalError,
  PayloadTooLargeError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

// spec: contracts/kv.contract.md#KV-4 — Key constraints: max 32 segments, max 512 bytes
const MAX_KEY_SEGMENTS = 32;
const MAX_KEY_BYTES = 512;

// spec: contracts/kv.contract.md#KV-1 — Payload limit 256 KB
const MAX_PAYLOAD_BYTES = 256 * 1024; // 262,144 bytes

// spec: contracts/kv.contract.md#KV-5 — Cloudflare Workers KV minimum TTL
const MIN_TTL_SECONDS = 60;

// spec: contracts/kv.contract.md#KV-2 — Default list limit 100, max 1000
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

const TEXT_ENCODER = new TextEncoder();

/**
 * Validates declared consistency tier against provider consistency tier.
 * Deploy-time validation: requesting "strong" against an "eventual" tier provider
 * must immediately throw VALIDATION_FAILED per KV-5.
 */
// spec: contracts/kv.contract.md#KV-5 — Consistency tiers: requesting strong against eventual is deploy-time error
export function validateConsistencyTier(
  declaredTier: "strong" | "eventual",
  providerTier: "strong" | "eventual",
): void {
  if (declaredTier === "strong" && providerTier === "eventual") {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Declared consistency tier 'strong' cannot be satisfied by provider tier 'eventual' (KV-5)",
    );
  }
}

/**
 * Options for configuring CloudflareKVProvider.
 */
// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
export interface CloudflareKVProviderOptions {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  baseUrl?: string; // allows local HTTP mock testing, defaults to "https://api.cloudflare.com/client/v4"
}

/**
 * Cloudflare Workers KV remote provider backing the eventual consistency tier.
 * Implements KVProvider interface using Cloudflare Workers KV REST API.
 */
// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
// spec: contracts/kv.contract.md#KV-5 — Eventual consistency tier backing
export class CloudflareKVProvider implements KVProvider {
  // spec: contracts/kv.contract.md#KV-5 — Eventual consistency tier
  readonly tier: "eventual" = "eventual";

  private readonly accountId: string;
  private readonly namespaceId: string;
  #apiToken: string;
  private readonly baseUrl: string;

  constructor(options: CloudflareKVProviderOptions) {
    // spec: contracts/platform.contract.md#PLAT-15 — Secrets: apiToken stored for Authorization header
    this.accountId = options.accountId;
    this.namespaceId = options.namespaceId;
    this.#apiToken = options.apiToken;

    let base = (options.baseUrl ?? "https://api.cloudflare.com/client/v4")
      .replace(
        /\/+$/,
        "",
      );
    if (!base.endsWith("/client/v4")) {
      base = `${base}/client/v4`;
    }
    this.baseUrl = base;
  }

  // spec: contracts/platform.contract.md#PLAT-15 — Secrets: custom inspection and serialization redaction
  [Symbol.for("Deno.customInspect")](): string {
    return `CloudflareKVProvider {\n  tier: "${this.tier}",\n  accountId: "${this.accountId}",\n  namespaceId: "${this.namespaceId}",\n  apiToken: "[REDACTED]",\n  baseUrl: "${this.baseUrl}"\n}`;
  }

  toJSON(): Record<string, unknown> {
    return {
      tier: this.tier,
      accountId: this.accountId,
      namespaceId: this.namespaceId,
      apiToken: "[REDACTED]",
      baseUrl: this.baseUrl,
    };
  }

  // spec: contracts/platform.contract.md#PLAT-15 — Secrets redaction
  private redact(str: string): string {
    if (!this.#apiToken) return str;
    return str.replaceAll(this.#apiToken, "[REDACTED]");
  }

  // spec: contracts/kv.contract.md#KV-4 — Key validation
  private validateKey(key: string[]): void {
    if (!Array.isArray(key) || key.length === 0) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Key must be a non-empty array of strings (KV-4)",
      );
    }
    if (key.length > MAX_KEY_SEGMENTS) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Key segment count ${key.length} exceeds maximum of ${MAX_KEY_SEGMENTS} (KV-4)`,
      );
    }

    let totalBytes = 0;
    for (let i = 0; i < key.length; i++) {
      const seg = key[i];
      if (typeof seg !== "string") {
        throw new ValidationFailedError(
          `VALIDATION_FAILED: Key segment at index ${i} must be a string, got ${typeof seg} (KV-4)`,
        );
      }
      if (seg.length === 0) {
        throw new ValidationFailedError(
          `VALIDATION_FAILED: Key segment at index ${i} cannot be empty (KV-4)`,
        );
      }
      if (seg === "." || seg === "..") {
        throw new ValidationFailedError(
          `VALIDATION_FAILED: Key segment at index ${i} cannot be '.' or '..' (KV-4)`,
        );
      }
      if (seg.includes("/") || seg.includes("\\")) {
        throw new ValidationFailedError(
          `VALIDATION_FAILED: Key segment at index ${i} cannot contain '/' or '\\' (KV-4)`,
        );
      }
      if (seg.includes("\0")) {
        throw new ValidationFailedError(
          `VALIDATION_FAILED: Key segment at index ${i} contains null bytes (KV-4)`,
        );
      }
      totalBytes += TEXT_ENCODER.encode(seg).length;
    }

    if (totalBytes > MAX_KEY_BYTES) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Key total UTF-8 byte length ${totalBytes} exceeds maximum of ${MAX_KEY_BYTES} bytes (KV-4)`,
      );
    }
  }

  // spec: contracts/kv.contract.md#KV-4 — Key encoding
  private encodeKey(key: string[]): string {
    return key.map(encodeURIComponent).join(":");
  }

  // spec: contracts/kv.contract.md#KV-4 — Key decoding
  private decodeKey(raw: string): string[] {
    return raw.split(":").map(decodeURIComponent);
  }

  // spec: contracts/kv.contract.md#KV-4 — Prefix encoding
  private encodePrefix(prefix: string[]): string {
    return (
      prefix.map(encodeURIComponent).join(":") +
      (prefix.length > 0 ? ":" : "")
    );
  }

  // spec: contracts/platform.contract.md#PLAT-12 — Error model
  // spec: contracts/platform.contract.md#PLAT-15 — Secrets redaction in errors and traces
  private async request(
    url: string | URL,
    init: RequestInit,
    operation: string,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const sanitizedMsg = this.redact(msg);
      const internalErr = new InternalError(
        `Cloudflare KV ${operation} network request failed: ${sanitizedMsg}`,
      );
      if (err instanceof Error && err.stack) {
        internalErr.stack = this.redact(err.stack);
      } else if (internalErr.stack) {
        internalErr.stack = this.redact(internalErr.stack);
      }
      throw internalErr;
    }

    if (!res.ok) {
      if (res.status === 404 && operation === "GET") {
        return res;
      }
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        // body unreadable, retain empty string
      }

      let errorDetails = bodyText;
      try {
        const parsed = JSON.parse(bodyText);
        if (
          parsed &&
          Array.isArray(parsed.errors) &&
          parsed.errors.length > 0
        ) {
          errorDetails = parsed.errors
            .map(
              (e: { message?: string; code?: number }) =>
                `[${e.code ?? "UNKNOWN"}]: ${e.message ?? ""}`,
            )
            .join("; ");
        }
      } catch {
        // retain bodyText
      }

      const message = this.redact(
        `Cloudflare KV ${operation} failed with status ${res.status}: ${errorDetails}`,
      );
      const internalErr = new InternalError(message);
      if (internalErr.stack) {
        internalErr.stack = this.redact(internalErr.stack);
      }
      throw internalErr;
    }

    return res;
  }

  // spec: contracts/kv.contract.md#KV-2 — API shape: get
  async get(key: string[]): Promise<unknown | null> {
    this.validateKey(key);
    const encodedKey = this.encodeKey(key);
    const url =
      `${this.baseUrl}/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}/values/${
        encodeURIComponent(encodedKey)
      }`;

    const res = await this.request(
      url,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.#apiToken}`,
        },
      },
      "GET",
    );

    if (res.status === 404) {
      return null;
    }

    const contentType = res.headers.get("content-type") ?? "";
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const sanitizedMsg = this.redact(msg);
      const internalErr = new InternalError(
        `Cloudflare KV GET response body reading failed: ${sanitizedMsg}`,
      );
      if (err instanceof Error && err.stack) {
        internalErr.stack = this.redact(err.stack);
      } else if (internalErr.stack) {
        internalErr.stack = this.redact(internalErr.stack);
      }
      throw internalErr;
    }

    if (contentType.includes("application/json")) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  // spec: contracts/kv.contract.md#KV-2 — API shape: set
  // spec: contracts/kv.contract.md#KV-1 — Payload size limit (256 KB)
  // spec: contracts/kv.contract.md#KV-5 — Minimum TTL (60s)
  async set(
    key: string[],
    value: unknown,
    opts?: { ttl?: number },
  ): Promise<void> {
    this.validateKey(key);

    if (opts?.ttl !== undefined) {
      if (
        typeof opts.ttl !== "number" ||
        Number.isNaN(opts.ttl) ||
        opts.ttl < MIN_TTL_SECONDS
      ) {
        throw new ValidationFailedError(
          "VALIDATION_FAILED: Cloudflare Workers KV requires a minimum TTL of 60 seconds (KV-5)",
        );
      }
    }

    let bodyText: string;
    let contentType: string;
    let byteLength: number;

    if (typeof value === "string") {
      bodyText = value;
      contentType = "text/plain; charset=utf-8";
      byteLength = TEXT_ENCODER.encode(value).length;
    } else {
      bodyText = JSON.stringify(value) ?? "null";
      contentType = "application/json; charset=utf-8";
      byteLength = TEXT_ENCODER.encode(bodyText).length;
    }

    if (byteLength > MAX_PAYLOAD_BYTES) {
      throw new PayloadTooLargeError(
        "PAYLOAD_TOO_LARGE: Value exceeds 256 KB limit (KV-1)",
      );
    }

    const encodedKey = this.encodeKey(key);
    let url =
      `${this.baseUrl}/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}/values/${
        encodeURIComponent(encodedKey)
      }`;
    if (opts?.ttl !== undefined) {
      url += `?expiration_ttl=${Math.floor(opts.ttl)}`;
    }

    await this.request(
      url,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${this.#apiToken}`,
          "Content-Type": contentType,
        },
        body: bodyText,
      },
      "PUT",
    );
  }

  // spec: contracts/kv.contract.md#KV-2 — API shape: delete
  async delete(key: string[]): Promise<void> {
    this.validateKey(key);
    const encodedKey = this.encodeKey(key);
    const url =
      `${this.baseUrl}/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}/values/${
        encodeURIComponent(encodedKey)
      }`;

    await this.request(
      url,
      {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${this.#apiToken}`,
        },
      },
      "DELETE",
    );
  }

  // spec: contracts/kv.contract.md#KV-2 — API shape: list
  async list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }> {
    this.validateKey(prefix);

    const limit = opts?.limit !== undefined
      ? Math.min(Math.max(Math.floor(opts.limit), 1), MAX_LIST_LIMIT)
      : DEFAULT_LIST_LIMIT;

    const encodedPrefix = this.encodePrefix(prefix);
    const url = new URL(
      `${this.baseUrl}/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}/keys`,
    );
    url.searchParams.set("prefix", encodedPrefix);
    url.searchParams.set("limit", String(limit));
    if (opts?.cursor) {
      url.searchParams.set("cursor", opts.cursor);
    }

    const res = await this.request(
      url.toString(),
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.#apiToken}`,
        },
      },
      "GET",
    );

    let data: {
      result?: { name: string }[];
      result_info?: { cursor?: string; count?: number };
    };
    try {
      data = (await res.json()) as {
        result?: { name: string }[];
        result_info?: { cursor?: string; count?: number };
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const sanitizedMsg = this.redact(msg);
      const internalErr = new InternalError(
        `Cloudflare KV list response JSON parsing failed: ${sanitizedMsg}`,
      );
      if (err instanceof Error && err.stack) {
        internalErr.stack = this.redact(err.stack);
      } else if (internalErr.stack) {
        internalErr.stack = this.redact(internalErr.stack);
      }
      throw internalErr;
    }

    const items = data.result ?? [];
    const keysWithValues = await Promise.all(
      items.map(async (item) => {
        const decoded = this.decodeKey(item.name);
        const value = await this.get(decoded);
        return { key: decoded, value };
      }),
    );

    const nextCursor = data.result_info?.cursor
      ? data.result_info.cursor
      : undefined;

    return {
      keys: keysWithValues,
      cursor: nextCursor,
    };
  }

  // spec: contracts/kv.contract.md#KV-5 — CAS rejection on eventual tier
  atomic(): KVAtomicBuilder {
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Linearizable compare-and-swap (atomic) cannot be fulfilled on eventual consistency tier (KV-5)",
    );
  }
}
