// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
// spec: contracts/queues.contract.md#Q-1 — Guarantee (at-least-once)
// spec: contracts/queues.contract.md#Q-2 — API (delay <= 900s, max size 128 KB)
// spec: contracts/queues.contract.md#Q-3 — Redelivery model (visibility timeout, attempts counter)
// spec: contracts/platform.contract.md#PLAT-12 — Error model
// spec: contracts/platform.contract.md#PLAT-15 — Secrets redaction in errors and traces
// spec: contracts/platform.contract.md#PLAT-17 — Local/production parity

import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";
import {
  InternalError,
  PayloadTooLargeError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

// spec: contracts/queues.contract.md#Q-2 — Max message size 128 KB
const MAX_PAYLOAD_BYTES = 128 * 1024; // 131,072 bytes

// spec: contracts/queues.contract.md#Q-2 — Max delay 900 seconds (15 min)
const MAX_DELAY_SECONDS = 900;

// spec: contracts/queues.contract.md#Q-3 — Default visibility timeout 30,000 ms
const DEFAULT_VISIBILITY_TIMEOUT_MS = 30000;

const TEXT_ENCODER = new TextEncoder();

/**
 * Options for configuring CloudflareQueueProvider.
 */
// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
export interface CloudflareQueueProviderOptions {
  accountId: string;
  queueId: string;
  apiToken: string;
  baseUrl?: string; // allows local HTTP mock testing, defaults to "https://api.cloudflare.com/client/v4"
  defaultVisibilityTimeoutMs?: number; // default 30000 (Q-3)
}

/**
 * Cloudflare Queues remote provider implementing the QueueProvider interface.
 * Connects to Cloudflare Queues REST API endpoints per Q-1, Q-2, Q-3.
 */
// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
export class CloudflareQueueProvider implements QueueProvider {
  readonly accountId: string;
  readonly queueId: string;
  #apiToken: string;
  #leaseMap = new Map<string, string>();
  readonly baseUrl: string;
  readonly defaultVisibilityTimeoutMs: number;

  constructor(options: CloudflareQueueProviderOptions) {
    if (!options || typeof options !== "object") {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Options must be an object",
      );
    }
    if (
      typeof options.accountId !== "string" ||
      options.accountId.trim() === ""
    ) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: accountId is required and must be a non-empty string",
      );
    }
    if (
      typeof options.queueId !== "string" ||
      options.queueId.trim() === ""
    ) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: queueId is required and must be a non-empty string",
      );
    }
    if (
      typeof options.apiToken !== "string" ||
      options.apiToken.trim() === ""
    ) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: apiToken is required and must be a non-empty string",
      );
    }

    if (options.defaultVisibilityTimeoutMs !== undefined) {
      if (
        typeof options.defaultVisibilityTimeoutMs !== "number" ||
        Number.isNaN(options.defaultVisibilityTimeoutMs) ||
        !Number.isFinite(options.defaultVisibilityTimeoutMs) ||
        options.defaultVisibilityTimeoutMs <= 0
      ) {
        throw new ValidationFailedError(
          "VALIDATION_FAILED: defaultVisibilityTimeoutMs must be a positive number per Q-3",
        );
      }
    }

    // spec: contracts/platform.contract.md#PLAT-15 — Secrets: apiToken stored in private field
    this.accountId = options.accountId;
    this.queueId = options.queueId;
    this.#apiToken = options.apiToken;
    this.baseUrl = (options.baseUrl ?? "https://api.cloudflare.com/client/v4")
      .replace(/\/+$/, "");
    this.defaultVisibilityTimeoutMs = options.defaultVisibilityTimeoutMs ??
      DEFAULT_VISIBILITY_TIMEOUT_MS;
  }

  // spec: contracts/platform.contract.md#PLAT-15 — Secrets: custom inspection and serialization redaction
  [Symbol.for("Deno.customInspect")](): string {
    return `CloudflareQueueProvider { accountId: "${this.accountId}", queueId: "${this.queueId}", apiToken: "[REDACTED]", baseUrl: "${this.baseUrl}", defaultVisibilityTimeoutMs: ${this.defaultVisibilityTimeoutMs} }`;
  }

  toJSON(): Record<string, unknown> {
    return {
      accountId: this.accountId,
      queueId: this.queueId,
      apiToken: "[REDACTED]",
      baseUrl: this.baseUrl,
      defaultVisibilityTimeoutMs: this.defaultVisibilityTimeoutMs,
    };
  }

  // spec: contracts/platform.contract.md#PLAT-15 — Secrets redaction
  private redact(text: string): string {
    if (!text || !this.#apiToken) return text;
    return text.replaceAll(this.#apiToken, "[REDACTED]");
  }

  // spec: contracts/queues.contract.md#Q-2 — Payload size calculation
  private getPayloadByteLength(body: unknown): number {
    if (typeof body === "string") {
      return TEXT_ENCODER.encode(body).length;
    }
    try {
      const str = JSON.stringify(body) ?? "null";
      return TEXT_ENCODER.encode(str).length;
    } catch (err) {
      throw new ValidationFailedError(
        `VALIDATION_FAILED: Failed to serialize message body: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
        `Cloudflare Queue ${operation} network request failed: ${sanitizedMsg}`,
      );
      if (err instanceof Error && err.stack) {
        internalErr.stack = this.redact(err.stack);
      } else if (internalErr.stack) {
        internalErr.stack = this.redact(internalErr.stack);
      }
      throw internalErr;
    }

    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch {
        // body unreadable, retain empty string
      }

      const sanitizedBodyText = this.redact(bodyText);
      let errorDetails = sanitizedBodyText;
      try {
        const parsed = JSON.parse(sanitizedBodyText);
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
        // retain sanitizedBodyText
      }

      const message = this.redact(
        `Cloudflare Queue ${operation} failed with status ${res.status}: ${errorDetails}`,
      );
      const internalErr = new InternalError(message);
      if (internalErr.stack) {
        internalErr.stack = this.redact(internalErr.stack);
      }
      throw internalErr;
    }

    return res;
  }

  // spec: contracts/platform.contract.md#PLAT-12 — Error model
  // spec: contracts/platform.contract.md#PLAT-15 — Secrets redaction in errors and traces
  private async parseJsonResponse<T>(
    res: Response,
    operation: string,
  ): Promise<T> {
    let text = "";
    try {
      text = await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const sanitizedMsg = this.redact(msg);
      const internalErr = new InternalError(
        `Cloudflare Queue ${operation} response body reading failed: ${sanitizedMsg}`,
      );
      if (err instanceof Error && err.stack) {
        internalErr.stack = this.redact(err.stack);
      } else if (internalErr.stack) {
        internalErr.stack = this.redact(internalErr.stack);
      }
      throw internalErr;
    }

    const sanitizedText = this.redact(text);
    try {
      return JSON.parse(sanitizedText) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const sanitizedMsg = this.redact(msg);
      const internalErr = new InternalError(
        `Cloudflare Queue ${operation} response JSON parsing failed: ${sanitizedMsg}`,
      );
      if (err instanceof Error && err.stack) {
        internalErr.stack = this.redact(err.stack);
      } else if (internalErr.stack) {
        internalErr.stack = this.redact(internalErr.stack);
      }
      throw internalErr;
    }
  }

  // spec: contracts/queues.contract.md#Q-2 — API: send message
  async send(
    body: unknown,
    opts?: { delay?: number },
  ): Promise<{ id: string }> {
    // spec: contracts/queues.contract.md#Q-2 — Delay capped at 900 seconds
    if (opts?.delay !== undefined) {
      if (
        typeof opts.delay !== "number" ||
        Number.isNaN(opts.delay) ||
        !Number.isFinite(opts.delay) ||
        opts.delay < 0 ||
        opts.delay > MAX_DELAY_SECONDS
      ) {
        throw new ValidationFailedError(
          "VALIDATION_FAILED: Delay must be between 0 and 900 seconds per Q-2",
        );
      }
    }

    // spec: contracts/queues.contract.md#Q-2 — Max message size 128 KB
    const byteLength = this.getPayloadByteLength(body);
    if (byteLength > MAX_PAYLOAD_BYTES) {
      throw new PayloadTooLargeError(
        "PAYLOAD_TOO_LARGE: Payload exceeds 128KB limit per Q-2",
      );
    }

    const url =
      `${this.baseUrl}/accounts/${this.accountId}/queues/${this.queueId}/messages`;
    const payload: { body: unknown; delay_seconds?: number } = { body };
    if (opts?.delay !== undefined) {
      payload.delay_seconds = opts.delay;
    }

    const res = await this.request(
      url,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.#apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      "send",
    );

    const data = await this.parseJsonResponse<{
      success: boolean;
      result?: { id?: string; metadata?: unknown };
    }>(res, "send");

    const messageId = (data.result && typeof data.result.id === "string")
      ? data.result.id
      : crypto.randomUUID();

    return { id: messageId };
  }

  // spec: contracts/queues.contract.md#Q-2 — API: sendBatch
  async sendBatch(bodies: unknown[]): Promise<{ id: string }[]> {
    if (!Array.isArray(bodies)) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Bodies must be an array (Q-2)",
      );
    }

    if (bodies.length === 0) {
      return [];
    }

    // spec: contracts/queues.contract.md#Q-2 — Max message size 128 KB per item
    for (let i = 0; i < bodies.length; i++) {
      const byteLength = this.getPayloadByteLength(bodies[i]);
      if (byteLength > MAX_PAYLOAD_BYTES) {
        throw new PayloadTooLargeError(
          `PAYLOAD_TOO_LARGE: Payload at index ${i} exceeds 128KB limit per Q-2`,
        );
      }
    }

    const url =
      `${this.baseUrl}/accounts/${this.accountId}/queues/${this.queueId}/messages/batch`;
    const payload = {
      messages: bodies.map((b) => ({ body: b })),
    };

    const res = await this.request(
      url,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.#apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      "sendBatch",
    );

    const data = await this.parseJsonResponse<{
      success: boolean;
      result?: Array<{ id?: string }> | { metadata?: unknown };
    }>(res, "sendBatch");

    if (Array.isArray(data.result)) {
      return data.result.map((item) => ({
        id: item.id ?? crypto.randomUUID(),
      }));
    }

    return bodies.map(() => ({ id: crypto.randomUUID() }));
  }

  // spec: contracts/queues.contract.md#Q-3 — Redelivery model: visibility timeout and attempts counter
  async receive(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null> {
    const visibilityTimeoutMs = opts?.visibilityTimeoutMs ??
      this.defaultVisibilityTimeoutMs;

    if (
      typeof visibilityTimeoutMs !== "number" ||
      Number.isNaN(visibilityTimeoutMs) ||
      !Number.isFinite(visibilityTimeoutMs) ||
      visibilityTimeoutMs <= 0
    ) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: visibilityTimeoutMs must be a positive number per Q-3",
      );
    }

    const url =
      `${this.baseUrl}/accounts/${this.accountId}/queues/${this.queueId}/messages/pull`;
    const payload = {
      visibility_timeout_ms: visibilityTimeoutMs,
      batch_size: 1,
    };

    const res = await this.request(
      url,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.#apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      "receive",
    );

    const data = await this.parseJsonResponse<{
      success: boolean;
      result?: {
        messages?: Array<{
          id: string;
          body: unknown;
          attempts?: number;
          lease_id?: string;
        }>;
      };
    }>(res, "receive");

    const messages = data.result?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return null;
    }

    const msg = messages[0];
    if (msg.lease_id) {
      if (this.#leaseMap.size >= 10_000) {
        const oldestKey = this.#leaseMap.keys().next().value;
        if (oldestKey) {
          this.#leaseMap.delete(oldestKey);
        }
      }
      this.#leaseMap.set(msg.id, msg.lease_id);
    }
    return {
      id: msg.id,
      body: msg.body,
      attempts: msg.attempts ?? 1,
    };
  }

  // spec: contracts/queues.contract.md#Q-3 — Redelivery model: ack removes message
  async ack(id: string): Promise<void> {
    if (!id || typeof id !== "string" || id.trim() === "") {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Message id is required and must be a non-empty string (Q-3)",
      );
    }

    const leaseId = this.#leaseMap.get(id);
    this.#leaseMap.delete(id);

    const ackItem: Record<string, string> = leaseId
      ? { lease_id: leaseId }
      : { id };

    const url =
      `${this.baseUrl}/accounts/${this.accountId}/queues/${this.queueId}/messages/ack`;
    const res = await this.request(
      url,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.#apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ acks: [ackItem] }),
      },
      "ack",
    );

    await this.parseJsonResponse<{ success: boolean }>(res, "ack");
  }
}
