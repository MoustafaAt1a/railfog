/**
 * Resilient provider adapters and canonical error normalizer.
 *
 * Spec references:
 * - PLAT-10: Runtime data plane SLO (99.95%) and circuit breaker protection
 * - PLAT-12: Canonical error model (exhaustive code table)
 * - PLAT-15: Auto-redaction of secrets in errors and logs
 * - PLAT-16: Provider abstraction wrappers (KVProvider, ObjectProvider, QueueProvider)
 * - Q-5: Retries: exponential backoff with decorrelated jitter on idempotent operations;
 *        banned automatic retries on non-idempotent operations
 * - docs/CONSTITUTION.md: Boundary Rule (OOP/SOLID at module and Provider boundary)
 */

import {
  ConflictError,
  InternalError,
  RailFogError,
  RateLimitedError,
  ResourceNotFoundError,
  TimeoutError,
  UnavailableError,
} from "../../packages/errors/mod.ts";

import type {
  KVAtomicBuilder,
  KVProvider,
} from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";

import type { CircuitBreaker } from "../../packages/policy/circuit-breaker.ts";
import {
  type RetryPolicyOptions,
  withRetry,
} from "../../packages/policy/retry.ts";

export interface ResilientProviderOptions {
  retryPolicy?: RetryPolicyOptions;
  circuitBreaker?: CircuitBreaker;
  sensitivePatterns?: RegExp[];
}

/**
 * Redacts secret credentials, tokens, connection strings, and custom patterns
 * from error messages and stack traces before surfacing to caller.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-15
 */
function redactSecrets(text: string, sensitivePatterns?: RegExp[]): string {
  if (!text) return text;
  let result = text;

  // Redact passwords in standard database/cache/queue/HTTP connection URLs
  result = result.replace(
    /((?:postgres|postgresql|mysql|mariadb|redis|rediss|mongodb|mongodb\+srv|amqp|amqps|https?):\/\/[^:\s/@]*:)([^@\s]+)(@)/gi,
    "$1[REDACTED]$3",
  );

  // Redact AWS4-HMAC-SHA256 authorization headers, credentials, and signatures
  result = result.replace(
    /AWS4-HMAC-SHA256[^\r\n]*/gi,
    "[REDACTED]",
  );
  result = result.replace(/Credential=[^,\s\r\n]+/gi, "Credential=[REDACTED]");
  result = result.replace(
    /Signature=[a-f0-9A-Fa-f]+/gi,
    "Signature=[REDACTED]",
  );
  result = result.replace(
    /((?:SecretAccessKey|aws_secret_access_key|x-amz-security-token)\s*=\s*)[^,\s\r\n]+/gi,
    "$1[REDACTED]",
  );
  result = result.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]");

  // Redact Bearer authorization tokens
  result = result.replace(
    /Bearer\s+["']?[A-Za-z0-9\-._~+/]+=*["']?/gi,
    "Bearer [REDACTED]",
  );

  // Redact RailFog secret tokens
  result = result.replace(/railfog_sec_[A-Za-z0-9_]+/gi, "[REDACTED]");

  // Redact caller-provided sensitive patterns
  if (sensitivePatterns) {
    for (const pattern of sensitivePatterns) {
      const regex = pattern.global
        ? pattern
        : new RegExp(pattern.source, pattern.flags + "g");
      result = result.replace(regex, "[REDACTED]");
    }
  }

  return result;
}

/**
 * Recursively sanitizes cause chain, message, stack, and custom properties to prevent
 * secret leakage through error cause inspection, console.log, or diagnostic traces.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-15
 */
function sanitizeCause(
  cause: unknown,
  sensitivePatterns?: RegExp[],
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (cause === null || cause === undefined) return cause;
  if (typeof cause === "string") {
    return redactSecrets(cause, sensitivePatterns);
  }
  if (typeof cause !== "object") return cause;
  if (seen.has(cause)) return "[CIRCULAR]";
  if (depth > 10) return "[MAX_DEPTH_EXCEEDED]";

  seen.add(cause);

  if (cause instanceof Error) {
    const causeObj = cause as unknown as Record<string, unknown>;
    const redactedMsg = redactSecrets(cause.message, sensitivePatterns);
    let sanitizedError: Error;
    try {
      sanitizedError = new (cause.constructor as new (
        msg: string,
        extra?: unknown,
      ) => Error)(
        redactedMsg,
        causeObj.requestId,
      );
    } catch {
      sanitizedError = new Error(redactedMsg);
    }
    sanitizedError.name = cause.name;
    sanitizedError.message = redactedMsg;
    if (cause.stack) {
      sanitizedError.stack = redactSecrets(cause.stack, sensitivePatterns);
    }

    const sanitizedObj = sanitizedError as unknown as Record<string, unknown>;

    // Sanitize any extra properties attached to the Error
    for (const [key, val] of Object.entries(cause)) {
      if (key === "cause" || key === "message" || key === "stack") continue;
      if (typeof val === "string") {
        sanitizedObj[key] = redactSecrets(val, sensitivePatterns);
      } else if (typeof val === "object" && val !== null) {
        sanitizedObj[key] = sanitizeCause(
          val,
          sensitivePatterns,
          seen,
          depth + 1,
        );
      } else {
        sanitizedObj[key] = val;
      }
    }

    if ("cause" in causeObj) {
      sanitizedError.cause = sanitizeCause(
        causeObj.cause,
        sensitivePatterns,
        seen,
        depth + 1,
      );
    }
    return sanitizedError;
  }

  // Sanitize plain object
  const sanitizedObj: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(cause)) {
    if (typeof val === "string") {
      sanitizedObj[key] = redactSecrets(val, sensitivePatterns);
    } else if (typeof val === "object" && val !== null) {
      sanitizedObj[key] = sanitizeCause(
        val,
        sensitivePatterns,
        seen,
        depth + 1,
      );
    } else {
      sanitizedObj[key] = val;
    }
  }
  return sanitizedObj;
}

/**
 * Extracts numeric HTTP status code from error object or error cause chain.
 */
function extractStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const obj = error as Record<string, unknown>;
  if (typeof obj.status === "number") return obj.status;
  if (typeof obj.statusCode === "number") return obj.statusCode;
  if (typeof obj.httpStatus === "number") return obj.httpStatus;
  if (
    obj.$metadata &&
    typeof obj.$metadata === "object" &&
    typeof (obj.$metadata as Record<string, unknown>).httpStatusCode ===
      "number"
  ) {
    return (obj.$metadata as Record<string, unknown>).httpStatusCode as number;
  }
  if (obj.cause) {
    return extractStatusCode(obj.cause);
  }
  return undefined;
}

/**
 * Collects message strings across an error and its nested cause chain.
 */
function extractAllMessages(error: unknown): string {
  let combined = "";
  let current: unknown = error;
  let depth = 0;
  const maxCauseDepth = 10;
  while (current && depth < maxCauseDepth) {
    if (typeof current === "string") {
      combined += " " + current;
      break;
    }
    if (typeof current === "object") {
      const obj = current as Record<string, unknown>;
      if (typeof obj.message === "string") {
        combined += " " + obj.message;
      }
      if (typeof obj.name === "string") {
        combined += " " + obj.name;
      }
      current = obj.cause;
      depth++;
    } else {
      break;
    }
  }
  return combined;
}

/**
 * Intercepts arbitrary provider network exceptions, HTTP status codes, and connection drops,
 * normalizing them to canonical RailFogError instances with auto-redacted credentials.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-12
 * spec: docs/contracts/platform.contract.md#PLAT-15
 */
export function normalizeProviderError(
  error: unknown,
  sensitivePatterns?: RegExp[],
): Error {
  const status = extractStatusCode(error);
  const combined = extractAllMessages(error);

  let rawMessage = "Internal error";
  if (typeof error === "string") {
    rawMessage = error;
  } else if (error instanceof Error) {
    rawMessage = error.message || error.name || "Error";
  } else if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") {
      rawMessage = obj.message;
    } else {
      rawMessage = String(error);
    }
  } else if (error === null) {
    rawMessage = "Internal error: null";
  } else if (error === undefined) {
    rawMessage = "Internal error: undefined";
  } else {
    rawMessage = String(error);
  }

  const redactedMessage = redactSecrets(rawMessage, sensitivePatterns);

  // spec: docs/contracts/platform.contract.md#PLAT-12 — Canonical error classification mapping
  const isUnavailable = status === 503 ||
    status === 502 ||
    status === 504 ||
    /(?:ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|SlowDown|Service Unavailable)/i
      .test(combined);

  const isNotFound = status === 404 ||
    /(?:NoSuchKey|Not Found|Key not found)/i.test(combined);

  const isTimeout = status === 408 ||
    /(?:ETIMEDOUT|Request Timeout|Socket timeout|deadline exceeded)/i.test(
      combined,
    );

  const isRateLimited = status === 429 ||
    /(?:Too Many Requests|ThrottlingException|Rate limit)/i.test(combined);

  const isConflict = status === 409 ||
    /(?:CAS mismatch|version conflict)/i.test(combined);

  let TargetClass: new (message: string, requestId?: string) => RailFogError;

  if (isUnavailable) {
    TargetClass = UnavailableError;
  } else if (isNotFound) {
    TargetClass = ResourceNotFoundError;
  } else if (isTimeout) {
    TargetClass = TimeoutError;
  } else if (isRateLimited) {
    TargetClass = RateLimitedError;
  } else if (isConflict) {
    TargetClass = ConflictError;
  } else if (error instanceof RailFogError) {
    TargetClass = error.constructor as new (
      message: string,
      requestId?: string,
    ) => RailFogError;
  } else {
    TargetClass = InternalError;
  }

  const requestId = error instanceof RailFogError ? error.requestId : undefined;
  const normalized = new TargetClass(redactedMessage, requestId);

  // spec: docs/contracts/platform.contract.md#PLAT-12 — Preserve causality via cause
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Auto-redact secrets in cause chain
  if (error !== undefined && error !== null) {
    const hasExplicitCause = typeof error === "object" &&
      "cause" in (error as Record<string, unknown>) &&
      (error as Record<string, unknown>).cause !== undefined;
    const rawCause = hasExplicitCause
      ? (error as Record<string, unknown>).cause
      : error;
    if (rawCause !== undefined && rawCause !== null) {
      normalized.cause = sanitizeCause(rawCause, sensitivePatterns);
    }
  }

  // spec: docs/contracts/platform.contract.md#PLAT-15 — Stack trace secret redaction
  if (error instanceof Error && error.stack) {
    const redactedOrigStack = redactSecrets(error.stack, sensitivePatterns);
    const newlineIdx = redactedOrigStack.indexOf("\n");
    if (newlineIdx !== -1) {
      normalized.stack = `${normalized.name}: ${redactedMessage}${
        redactedOrigStack.slice(newlineIdx)
      }`;
    } else {
      normalized.stack = `${normalized.name}: ${redactedMessage}`;
    }
  }

  return normalized;
}

/**
 * Executes a safe, idempotent operation with decorrelated jitter retry loop (Q-5)
 * and circuit breaker fast-fail protection (PLAT-10).
 *
 * spec: docs/contracts/queues.contract.md#Q-5
 * spec: docs/contracts/platform.contract.md#PLAT-10
 */
async function executeIdempotent<T>(
  operation: () => Promise<T>,
  options?: ResilientProviderOptions,
): Promise<T> {
  const runner = async () => {
    const retryOpts: RetryPolicyOptions = {
      ...options?.retryPolicy,
      shouldRetry: (err: unknown, attempt: number) => {
        const normalized = normalizeProviderError(
          err,
          options?.sensitivePatterns,
        );
        const isTransient = normalized instanceof UnavailableError ||
          normalized instanceof TimeoutError;
        if (!isTransient) {
          return false;
        }
        if (options?.retryPolicy?.shouldRetry) {
          return options.retryPolicy.shouldRetry(err, attempt);
        }
        return true;
      },
    };

    return await withRetry(async () => {
      return await operation();
    }, retryOpts);
  };

  try {
    if (options?.circuitBreaker) {
      return await options.circuitBreaker.execute(runner);
    }
    return await runner();
  } catch (err) {
    throw normalizeProviderError(err, options?.sensitivePatterns);
  }
}

/**
 * Executes a non-idempotent operation protected by circuit breaker (PLAT-10).
 * Automatic retries are strictly banned per Q-5.
 *
 * spec: docs/contracts/queues.contract.md#Q-5
 * spec: docs/contracts/platform.contract.md#PLAT-10
 */
async function executeNonIdempotent<T>(
  operation: () => Promise<T>,
  options?: ResilientProviderOptions,
): Promise<T> {
  try {
    if (options?.circuitBreaker) {
      return await options.circuitBreaker.execute(operation);
    }
    return await operation();
  } catch (err) {
    throw normalizeProviderError(err, options?.sensitivePatterns);
  }
}

/**
 * Resilient KV provider decorator.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-16
 * spec: docs/CONSTITUTION.md Boundary Rule (OOP/SOLID decorator)
 */
class ResilientKVProvider implements KVProvider {
  constructor(
    private readonly inner: KVProvider,
    private readonly options?: ResilientProviderOptions,
  ) {}

  get(key: string[]): Promise<unknown | null> {
    return executeIdempotent(() => this.inner.get(key), this.options);
  }

  set(key: string[], value: unknown, opts?: { ttl?: number }): Promise<void> {
    return executeNonIdempotent(
      () => this.inner.set(key, value, opts),
      this.options,
    );
  }

  delete(key: string[]): Promise<void> {
    return executeNonIdempotent(() => this.inner.delete(key), this.options);
  }

  list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }> {
    return executeIdempotent(() => this.inner.list(prefix, opts), this.options);
  }

  atomic(): KVAtomicBuilder {
    return new ResilientKVAtomicBuilder(this.inner.atomic(), this.options);
  }
}

class ResilientKVAtomicBuilder implements KVAtomicBuilder {
  constructor(
    private readonly inner: KVAtomicBuilder,
    private readonly options?: ResilientProviderOptions,
  ) {}

  check(key: string[], expectedVersion: number): this {
    this.inner.check(key, expectedVersion);
    return this;
  }

  set(key: string[], value: unknown): this {
    this.inner.set(key, value);
    return this;
  }

  delete(key: string[]): this {
    this.inner.delete(key);
    return this;
  }

  commit(): Promise<{ ok: boolean; version?: number }> {
    return executeNonIdempotent(() => this.inner.commit(), this.options);
  }
}

/**
 * Resilient Object provider decorator.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-16
 */
class ResilientObjectProvider implements ObjectProvider {
  constructor(
    private readonly inner: ObjectProvider,
    private readonly options?: ResilientProviderOptions,
  ) {}

  put(
    key: string,
    data: ArrayBuffer | ReadableStream,
  ): Promise<{ etag: string }> {
    return executeNonIdempotent(
      () => this.inner.put(key, data),
      this.options,
    );
  }

  get(key: string): Promise<ReadableStream | null> {
    return executeIdempotent(() => this.inner.get(key), this.options);
  }

  delete(key: string): Promise<void> {
    return executeNonIdempotent(() => this.inner.delete(key), this.options);
  }

  head(key: string): Promise<{ size: number; etag: string } | null> {
    return executeIdempotent(() => this.inner.head(key), this.options);
  }

  list(
    prefix: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: string[]; cursor?: string }> {
    return executeIdempotent(() => this.inner.list(prefix, opts), this.options);
  }

  presign(
    key: string,
    opts: { method: "GET" | "PUT"; expiresIn?: number; maxExpiresIn?: number },
  ): Promise<{ url: string; expiresAt: number }> {
    return executeNonIdempotent(
      () => this.inner.presign(key, opts),
      this.options,
    );
  }

  createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    return executeNonIdempotent(
      () => this.inner.createMultipartUpload(key),
      this.options,
    );
  }
}

/**
 * Resilient Queue provider decorator.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-16
 */
class ResilientQueueProvider implements QueueProvider {
  constructor(
    private readonly inner: QueueProvider,
    private readonly options?: ResilientProviderOptions,
  ) {}

  send(body: unknown, opts?: { delay?: number }): Promise<{ id: string }> {
    return executeNonIdempotent(
      () => this.inner.send(body, opts),
      this.options,
    );
  }

  sendBatch(bodies: unknown[]): Promise<{ id: string }[]> {
    return executeNonIdempotent(
      () => this.inner.sendBatch(bodies),
      this.options,
    );
  }

  receive(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null> {
    return executeIdempotent(() => this.inner.receive(opts), this.options);
  }

  ack(id: string): Promise<void> {
    return executeNonIdempotent(() => this.inner.ack(id), this.options);
  }
}

/**
 * Wraps a KVProvider with retry and circuit breaker resilience.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-16
 */
export function wrapResilientKv(
  provider: KVProvider,
  options?: ResilientProviderOptions,
): KVProvider {
  return new ResilientKVProvider(provider, options);
}

/**
 * Wraps an ObjectProvider with retry and circuit breaker resilience.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-16
 */
export function wrapResilientObjects(
  provider: ObjectProvider,
  options?: ResilientProviderOptions,
): ObjectProvider {
  return new ResilientObjectProvider(provider, options);
}

/**
 * Wraps a QueueProvider with retry and circuit breaker resilience.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-16
 */
export function wrapResilientQueues(
  provider: QueueProvider,
  options?: ResilientProviderOptions,
): QueueProvider {
  return new ResilientQueueProvider(provider, options);
}
