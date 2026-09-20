/**
 * Resource kill enforcer and payload limits.
 *
 * Implements FN-5 resource limit kill switches and PLAT-12 error taxonomy.
 *
 * Spec references:
 * - docs/contracts/functions.contract.md#FN-5 (Resource limits: timeout_ms, cpu_ms, request_body_mb, response_body_mb, streamed cap)
 * - docs/contracts/platform.contract.md#PLAT-12 (Error model: TIMEOUT, PAYLOAD_TOO_LARGE, VALIDATION_FAILED)
 */

import {
  PayloadTooLargeError,
  TimeoutError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

// spec: contracts/functions.contract.md#FN-5 — timeout_ms: 30,000 (HTTP)
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

// spec: contracts/functions.contract.md#FN-5 — timeout_ms: 900,000 (queue & schedule triggers)
export const DEFAULT_QUEUE_TIMEOUT_MS = 900_000;

// spec: contracts/functions.contract.md#FN-5 — cpu_ms: 200
export const DEFAULT_CPU_MS = 200;

// spec: contracts/functions.contract.md#FN-5 — request_body_mb: 10
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

// spec: contracts/functions.contract.md#FN-5 — response_body_mb: 10
export const DEFAULT_MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;

// spec: contracts/functions.contract.md#FN-5 — streamed responses capped at 512 MB
export const DEFAULT_MAX_STREAMED_BYTES = 512 * 1024 * 1024;

export interface ResourceKillOptions {
  timeoutMs: number;
  cpuMs: number;
  maxRequestBodyBytes?: number;
  maxResponseBodyBytes?: number;
  maxStreamedBytes?: number;
}

export interface KillEnforcer {
  createAbortController(): { signal: AbortSignal; cleanup(): void };
  validateRequestBody(
    contentLength?: number,
    bodyStream?: ReadableStream<Uint8Array>,
  ): Promise<Uint8Array>;
  wrapResponseStream(
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<Uint8Array>;
  checkCpuLimit(cpuTimeMs: number): void;
}

export class KillEnforcer implements KillEnforcer {
  readonly timeoutMs: number;
  readonly cpuMs: number;
  readonly maxRequestBodyBytes: number;
  readonly maxResponseBodyBytes: number;
  readonly maxStreamedBytes: number;

  constructor(options: ResourceKillOptions) {
    // spec: contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED on invalid options
    if (
      typeof options.timeoutMs !== "number" ||
      Number.isNaN(options.timeoutMs) ||
      options.timeoutMs <= 0
    ) {
      throw new ValidationFailedError(
        "Invalid timeoutMs: must be a positive number",
      );
    }

    if (
      typeof options.cpuMs !== "number" ||
      Number.isNaN(options.cpuMs) ||
      options.cpuMs <= 0
    ) {
      throw new ValidationFailedError(
        "Invalid cpuMs: must be a positive number",
      );
    }

    if (
      options.maxRequestBodyBytes !== undefined &&
      (typeof options.maxRequestBodyBytes !== "number" ||
        Number.isNaN(options.maxRequestBodyBytes) ||
        options.maxRequestBodyBytes <= 0)
    ) {
      throw new ValidationFailedError(
        "Invalid maxRequestBodyBytes: must be a positive number",
      );
    }

    if (
      options.maxResponseBodyBytes !== undefined &&
      (typeof options.maxResponseBodyBytes !== "number" ||
        Number.isNaN(options.maxResponseBodyBytes) ||
        options.maxResponseBodyBytes <= 0)
    ) {
      throw new ValidationFailedError(
        "Invalid maxResponseBodyBytes: must be a positive number",
      );
    }

    if (
      options.maxStreamedBytes !== undefined &&
      (typeof options.maxStreamedBytes !== "number" ||
        Number.isNaN(options.maxStreamedBytes) ||
        options.maxStreamedBytes <= 0)
    ) {
      throw new ValidationFailedError(
        "Invalid maxStreamedBytes: must be a positive number",
      );
    }

    this.timeoutMs = options.timeoutMs;
    this.cpuMs = options.cpuMs;
    // spec: contracts/functions.contract.md#FN-5 — default limits if omitted
    this.maxRequestBodyBytes = options.maxRequestBodyBytes ??
      DEFAULT_MAX_REQUEST_BODY_BYTES;
    this.maxResponseBodyBytes = options.maxResponseBodyBytes ??
      DEFAULT_MAX_RESPONSE_BODY_BYTES;
    this.maxStreamedBytes = options.maxStreamedBytes ??
      DEFAULT_MAX_STREAMED_BYTES;
  }

  // spec: contracts/functions.contract.md#FN-5 — wall-clock deadline kill
  // spec: contracts/platform.contract.md#PLAT-12 — TIMEOUT
  createAbortController(): { signal: AbortSignal; cleanup(): void } {
    const controller = new AbortController();
    let timerId: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timerId = undefined;
      controller.abort(new TimeoutError("Invocation deadline exceeded"));
    }, this.timeoutMs);

    const cleanup = () => {
      if (timerId !== undefined) {
        clearTimeout(timerId);
        timerId = undefined;
      }
    };

    return { signal: controller.signal, cleanup };
  }

  // spec: contracts/functions.contract.md#FN-5 — request_body_mb: 10 reject with 413 PAYLOAD_TOO_LARGE
  // spec: contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED, PAYLOAD_TOO_LARGE
  async validateRequestBody(
    contentLength?: number,
    bodyStream?: ReadableStream<Uint8Array>,
  ): Promise<Uint8Array> {
    if (contentLength !== undefined) {
      if (
        typeof contentLength !== "number" ||
        Number.isNaN(contentLength) ||
        !Number.isInteger(contentLength) ||
        contentLength < 0
      ) {
        throw new ValidationFailedError(
          `Invalid Content-Length: ${contentLength} must be a non-negative integer`,
        );
      }

      if (contentLength > this.maxRequestBodyBytes) {
        if (bodyStream && !bodyStream.locked) {
          bodyStream.cancel().catch(() => {});
        }
        throw new PayloadTooLargeError(
          `Request body Content-Length ${contentLength} exceeds maximum allowed size of ${this.maxRequestBodyBytes} bytes`,
        );
      }
    }

    if (bodyStream === undefined) {
      return new Uint8Array(0);
    }

    const reader = bodyStream.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > this.maxRequestBodyBytes) {
            await reader.cancel();
            throw new PayloadTooLargeError(
              `Request body exceeds maximum allowed size of ${this.maxRequestBodyBytes} bytes`,
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  // spec: contracts/functions.contract.md#FN-5 — streamed responses capped at 512 MB
  // spec: contracts/platform.contract.md#PLAT-12 — PAYLOAD_TOO_LARGE
  wrapResponseStream(
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<Uint8Array> {
    const reader = stream.getReader();
    let emittedBytes = 0;
    const maxStreamedBytes = this.maxStreamedBytes;

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          emittedBytes += value.byteLength;
          if (emittedBytes > maxStreamedBytes) {
            const err = new PayloadTooLargeError(
              `Streamed response exceeded maximum allowed size of ${maxStreamedBytes} bytes`,
            );
            await reader.cancel(err);
            controller.error(err);
            return;
          }
          controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
  }

  // spec: contracts/functions.contract.md#FN-5 — cpu_ms: kill at CPU time consumed >= limit, independent of wall clock
  // spec: contracts/platform.contract.md#PLAT-12 — TIMEOUT
  checkCpuLimit(cpuTimeMs: number): void {
    if (
      typeof cpuTimeMs !== "number" ||
      Number.isNaN(cpuTimeMs) ||
      cpuTimeMs < 0
    ) {
      throw new ValidationFailedError(
        `Invalid cpuTimeMs: ${cpuTimeMs} must be a non-negative number`,
      );
    }

    if (cpuTimeMs >= this.cpuMs) {
      throw new TimeoutError(
        `CPU time limit exceeded: consumed ${cpuTimeMs}ms >= limit of ${this.cpuMs}ms`,
      );
    }
  }
}

export function createKillEnforcer(options: ResourceKillOptions): KillEnforcer {
  return new KillEnforcer(options);
}
