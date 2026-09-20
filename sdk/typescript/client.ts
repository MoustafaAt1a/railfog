// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: sdk/typescript
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection: bindings physically scoped
// spec: contracts/platform.contract.md#PLAT-12 — Error model: exhaustive machine-readable error codes mapped to typed errors
// spec: contracts/kv.contract.md#KV-2 — KV binding API and error normalization
// spec: contracts/kv.contract.md#KV-3 — Optimistic concurrency CAS conflict error normalization
// spec: contracts/objects.contract.md#OBJ-2 — Object binding API shape and client wrapper error normalization
// spec: contracts/objects.contract.md#OBJ-3 — Direct client-to-storage transfer (presigned direct transfers)
// spec: contracts/queues.contract.md#Q-2 — Queue binding API shape and client wrapper error normalization

import {
  CallDepthExceededError,
  ConflictError,
  InternalError,
  PayloadTooLargeError,
  PermissionDeniedError,
  RailFogError,
  RateLimitedError,
  ResourceNotFoundError,
  TimeoutError,
  UnavailableError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

import type {
  EnvBinding,
  KVAtomicOperation,
  KVBinding,
  ListOptions,
  ObjectBinding,
  PresignOptions,
  QueueBinding,
  RailFogContext,
} from "./types.ts";

/**
 * Normalizes an unknown error, JSON response body, or platform error object into
 * one of the 10 exhaustive RailFogError subclasses defined in PLAT-12.
 *
 * @spec contracts/platform.contract.md#PLAT-12 — Error model: exhaustive code table
 */
export function normalizeError(
  err: unknown,
  fallbackRequestId?: string,
): RailFogError {
  // If already an instance of RailFogError, pass through unchanged
  if (err instanceof RailFogError) {
    return err;
  }

  let code: string | undefined;
  let message: string | undefined;
  let explicitRequestId: string | undefined;

  if (typeof err === "object" && err !== null) {
    const errObj = err as Record<string, unknown>;
    const nested = typeof errObj.error === "object" && errObj.error !== null
      ? (errObj.error as Record<string, unknown>)
      : undefined;

    const target = nested ?? errObj;

    if (typeof target.code === "string") {
      code = target.code;
    }
    if (typeof target.message === "string") {
      message = target.message;
    }
    if (typeof target.request_id === "string") {
      explicitRequestId = target.request_id;
    } else if (typeof target.requestId === "string") {
      explicitRequestId = target.requestId;
    }
  }

  const finalMessage = message ??
    (err instanceof Error
      ? err.message
      : (typeof err === "string" ? err : String(err ?? "Internal error")));

  const finalRequestId = explicitRequestId ?? fallbackRequestId;

  // spec: contracts/platform.contract.md#PLAT-12 — Map code to the 10 exhaustive error subclasses
  switch (code) {
    case "RESOURCE_NOT_FOUND":
      return new ResourceNotFoundError(finalMessage, finalRequestId);
    case "PERMISSION_DENIED":
      return new PermissionDeniedError(finalMessage, finalRequestId);
    case "VALIDATION_FAILED":
      return new ValidationFailedError(finalMessage, finalRequestId);
    case "RATE_LIMITED":
      return new RateLimitedError(finalMessage, finalRequestId);
    case "CALL_DEPTH_EXCEEDED":
      return new CallDepthExceededError(finalMessage, finalRequestId);
    case "TIMEOUT":
      return new TimeoutError(finalMessage, finalRequestId);
    case "PAYLOAD_TOO_LARGE":
      return new PayloadTooLargeError(finalMessage, finalRequestId);
    case "CONFLICT":
      return new ConflictError(finalMessage, finalRequestId);
    case "UNAVAILABLE":
      return new UnavailableError(finalMessage, finalRequestId);
    case "INTERNAL":
      return new InternalError(finalMessage, finalRequestId);
    default:
      // Unknown code, standard JS error, or unclassified fault maps to InternalError
      return new InternalError(finalMessage, finalRequestId);
  }
}

/**
 * Wraps a KVBinding to normalize all errors to typed RailFogError subclasses.
 *
 * @spec contracts/kv.contract.md#KV-2 — KV binding API
 * @spec contracts/kv.contract.md#KV-3 — Optimistic concurrency CAS conflict error normalization
 * @spec contracts/platform.contract.md#PLAT-6 — Capability injection: bindings physically scoped
 * @spec contracts/platform.contract.md#PLAT-12 — Error model normalization
 */
export function wrapKVBinding(kv: KVBinding): KVBinding {
  return {
    async get<T = unknown>(key: string[]): Promise<T | null> {
      try {
        return await kv.get<T>(key);
      } catch (err) {
        throw normalizeError(err);
      }
    },

    async set(
      key: string[],
      value: unknown,
      options?: { ttl?: number },
    ): Promise<void> {
      try {
        await kv.set(key, value, options);
      } catch (err) {
        throw normalizeError(err);
      }
    },

    async delete(key: string[]): Promise<void> {
      try {
        await kv.delete(key);
      } catch (err) {
        throw normalizeError(err);
      }
    },

    async list<T = unknown>(
      prefix: string[],
      options?: ListOptions,
    ): Promise<{
      entries: Array<{ key: string[]; value: T; version: number }>;
      cursor?: string;
    }> {
      try {
        return await kv.list<T>(prefix, options);
      } catch (err) {
        throw normalizeError(err);
      }
    },

    atomic(): KVAtomicOperation {
      const op = kv.atomic();
      const wrappedOp: KVAtomicOperation = {
        check(key: string[], expectedVersion: number): KVAtomicOperation {
          op.check(key, expectedVersion);
          return wrappedOp;
        },
        set(
          key: string[],
          value: unknown,
          options?: { ttl?: number },
        ): KVAtomicOperation {
          op.set(key, value, options);
          return wrappedOp;
        },
        delete(key: string[]): KVAtomicOperation {
          op.delete(key);
          return wrappedOp;
        },
        async commit(): Promise<{ ok: boolean; version?: number }> {
          try {
            return await op.commit();
          } catch (err) {
            throw normalizeError(err);
          }
        },
      };
      return wrappedOp;
    },
  };
}

/**
 * Wraps an ObjectBinding to normalize all errors to typed RailFogError subclasses.
 *
 * @spec contracts/objects.contract.md#OBJ-2 — Object binding API shape and client wrapper error normalization
 * @spec contracts/objects.contract.md#OBJ-3 — Presigned direct storage transfer client wrapper
 * @spec contracts/platform.contract.md#PLAT-6 — Capability injection: bindings physically scoped
 * @spec contracts/platform.contract.md#PLAT-12 — Error model normalization
 */
export function wrapObjectBinding(objects: ObjectBinding): ObjectBinding {
  return {
    async put(
      key: string,
      data: Uint8Array | ReadableStream<Uint8Array>,
    ): Promise<void> {
      try {
        await objects.put(key, data);
      } catch (err) {
        throw normalizeError(err);
      }
    },

    async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
      try {
        return await objects.get(key);
      } catch (err) {
        throw normalizeError(err);
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await objects.delete(key);
      } catch (err) {
        throw normalizeError(err);
      }
    },

    async head(
      key: string,
    ): Promise<
      { sizeBytes: number; sha256: string; integrity: string } | null
    > {
      try {
        return await objects.head(key);
      } catch (err) {
        throw normalizeError(err);
      }
    },

    async list(
      prefix: string,
      options?: ListOptions,
    ): Promise<{
      keys: Array<{ key: string; sizeBytes: number; sha256: string }>;
      cursor?: string;
    }> {
      try {
        return await objects.list(prefix, options);
      } catch (err) {
        throw normalizeError(err);
      }
    },

    async createMultipartUpload(
      key: string,
    ): Promise<{ uploadId: string }> {
      try {
        return await objects.createMultipartUpload(key);
      } catch (err) {
        throw normalizeError(err);
      }
    },

    async presign(
      key: string,
      options: PresignOptions,
    ): Promise<{ url: string; headers: Record<string, string> }> {
      try {
        return await objects.presign(key, options);
      } catch (err) {
        throw normalizeError(err);
      }
    },
  };
}

/**
 * Wraps a QueueBinding to normalize all errors to typed RailFogError subclasses.
 *
 * @spec contracts/queues.contract.md#Q-2 — Queue binding API shape and client wrapper error normalization
 * @spec contracts/platform.contract.md#PLAT-6 — Capability injection: bindings physically scoped
 * @spec contracts/platform.contract.md#PLAT-12 — Error model normalization
 */
export function wrapQueueBinding(queues: QueueBinding): QueueBinding {
  return {
    async send<T = unknown>(
      message: T,
      options?: { delay?: number },
    ): Promise<{ id: string }> {
      try {
        return await queues.send<T>(message, options);
      } catch (err) {
        throw normalizeError(err);
      }
    },

    async sendBatch<T = unknown>(
      messages: T[],
    ): Promise<Array<{ id: string }>> {
      try {
        return await queues.sendBatch<T>(messages);
      } catch (err) {
        throw normalizeError(err);
      }
    },
  };
}

/**
 * Wraps an EnvBinding to normalize all errors and guarantee require() throws typed ValidationFailedError.
 *
 * @spec contracts/platform.contract.md#PLAT-15 — Secret access via capability-scoped EnvBinding
 * @spec contracts/platform.contract.md#PLAT-12 — Error model normalization
 */
export function wrapEnvBinding(env: EnvBinding): EnvBinding {
  return {
    get(key: string): string | undefined {
      try {
        return env.get(key);
      } catch (err) {
        throw normalizeError(err);
      }
    },
    require(key: string): string {
      try {
        if (typeof env.require === "function") {
          return env.require(key);
        }
        const val = env.get(key);
        if (val === undefined) {
          throw new ValidationFailedError(
            `Missing required environment secret: ${key}`,
          );
        }
        return val;
      } catch (err) {
        throw normalizeError(err);
      }
    },
  };
}

/**
 * Wraps an entire RailFogContext, wrapping all capability bindings with error normalization.
 *
 * @spec contracts/functions.contract.md#FN-4 — RailFogContext structure
 * @spec contracts/platform.contract.md#PLAT-6 — Capability injection: bindings physically scoped
 * @spec contracts/platform.contract.md#PLAT-12 — Error model normalization
 */
export function wrapContext(ctx: RailFogContext): RailFogContext {
  return {
    ...ctx,
    kv: wrapKVBinding(ctx.kv),
    objects: wrapObjectBinding(ctx.objects),
    queues: wrapQueueBinding(ctx.queues),
    env: wrapEnvBinding(ctx.env),
  };
}
