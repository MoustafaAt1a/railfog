/**
 * Per-invocation operation counters and call-depth guard.
 *
 * Enforces resource ceilings per invocation to prevent resource exhaustion,
 * storage operation floods, and recursive function execution denial-of-wallet.
 *
 * Spec references:
 * - docs/contracts/functions.contract.md#FN-5 (Resource limits: KV 1,000 ops, Objects 100 ops,
 *   Queues 100 ops, Logs 64,000 bytes, call_depth_max 8)
 * - docs/contracts/functions.contract.md#FN-7 (Call-depth guard: X-RailFog-Call-Depth propagation)
 * - docs/contracts/platform.contract.md#PLAT-12 (Error model: RATE_LIMITED, CALL_DEPTH_EXCEEDED, VALIDATION_FAILED)
 */

import {
  CallDepthExceededError,
  RateLimitedError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

// ============================================================================
// Spec-anchored Constants (FN-5, FN-7)
// ============================================================================

// spec: contracts/functions.contract.md#FN-5 — kv ops per invocation: 1,000
export const DEFAULT_MAX_KV_OPS = 1_000;

// spec: contracts/functions.contract.md#FN-5 — objects ops per invocation: 100
export const DEFAULT_MAX_OBJECT_OPS = 100;

// spec: contracts/functions.contract.md#FN-5 — queue ops per invocation: 100
export const DEFAULT_MAX_QUEUE_OPS = 100;

// spec: contracts/functions.contract.md#FN-5 — logs.bytes_per_invocation: 64,000
export const DEFAULT_MAX_LOG_BYTES = 64_000;

// spec: contracts/functions.contract.md#FN-5 — call_depth_max: 8
// spec: contracts/functions.contract.md#FN-7 — call-depth guard: default 8
export const DEFAULT_MAX_CALL_DEPTH = 8;

// spec: contracts/functions.contract.md#FN-7 — internal hop header
export const CALL_DEPTH_HEADER = "X-RailFog-Call-Depth";

// spec: contracts/functions.contract.md#FN-5 — truncate + emit LOG_TRUNCATED marker
export const LOG_TRUNCATED_MARKER = "[LOG_TRUNCATED]";
export const LOG_TRUNCATED = "[LOG_TRUNCATED]";

const TEXT_ENCODER = new TextEncoder();
const CALL_DEPTH_REGEX = /^\d+$/;

/**
 * Configuration overrides for per-invocation operation limits.
 */
export interface InvocationOperationLimits {
  maxKvOps?: number; // default 1,000 (FN-5)
  maxObjectOps?: number; // default 100 (FN-5)
  maxQueueOps?: number; // default 100 (FN-5)
  maxLogBytes?: number; // default 64,000 (FN-5)
  maxCallDepth?: number; // default 8 (FN-5, FN-7)
}

/**
 * Tracks and enforces per-invocation resource operations and call depth.
 */
export interface InvocationTracker {
  recordKvOp(): void;
  recordObjectOp(): void;
  recordQueueOp(): void;
  appendLog(chunk: string): { output: string; truncated: boolean };
  checkCallDepth(currentDepthHeader?: string): number;
}

/**
 * Truncates a string to the maximum prefix whose UTF-8 representation
 * does not exceed maxBytes. Avoids splitting surrogate pairs.
 */
function truncateToUtf8Bytes(str: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  const candidate = str.slice(0, maxBytes);
  const encodedCandidate = TEXT_ENCODER.encode(candidate);
  if (encodedCandidate.byteLength <= maxBytes) {
    return candidate;
  }

  let low = 0;
  let high = candidate.length;
  let best = 0;

  while (low <= high) {
    const mid = (low + high) >> 1;
    let sliceEnd = mid;

    if (sliceEnd > 0 && sliceEnd < candidate.length) {
      const code = candidate.charCodeAt(sliceEnd - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        sliceEnd = sliceEnd - 1;
      }
    }

    const sub = candidate.slice(0, sliceEnd);
    const byteLength = TEXT_ENCODER.encode(sub).byteLength;

    if (byteLength <= maxBytes) {
      if (sliceEnd > best) {
        best = sliceEnd;
      }
      low = mid + 1;
    } else {
      high = sliceEnd - 1;
    }
  }

  return candidate.slice(0, best);
}

/**
 * Invocation tracker implementation enforcing FN-5 and FN-7 limits.
 */
export class InvocationTracker implements InvocationTracker {
  private readonly maxKvOps: number;
  private readonly maxObjectOps: number;
  private readonly maxQueueOps: number;
  private readonly maxLogBytes: number;
  private readonly maxCallDepth: number;

  private kvOps = 0;
  private objectOps = 0;
  private queueOps = 0;
  private currentLogBytes = 0;
  private logTruncated = false;

  constructor(limits?: InvocationOperationLimits) {
    // spec: contracts/functions.contract.md#FN-5 — resource limit defaults
    this.maxKvOps = limits?.maxKvOps ?? DEFAULT_MAX_KV_OPS;
    this.maxObjectOps = limits?.maxObjectOps ?? DEFAULT_MAX_OBJECT_OPS;
    this.maxQueueOps = limits?.maxQueueOps ?? DEFAULT_MAX_QUEUE_OPS;
    this.maxLogBytes = limits?.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    // spec: contracts/functions.contract.md#FN-7 — call_depth_max default
    this.maxCallDepth = limits?.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH;
  }

  /**
   * Records a KV operation.
   * Throws RateLimitedError when operation count exceeds maxKvOps.
   *
   * spec: contracts/functions.contract.md#FN-5 — kv ops: max 1,000 per invocation (429 RATE_LIMITED)
   */
  recordKvOp(): void {
    if (this.kvOps >= this.maxKvOps) {
      throw new RateLimitedError(
        `KV operation limit exceeded: maximum ${this.maxKvOps} operations per invocation allowed`,
      );
    }
    this.kvOps++;
  }

  /**
   * Records an Object operation.
   * Throws RateLimitedError when operation count exceeds maxObjectOps.
   *
   * spec: contracts/functions.contract.md#FN-5 — objects ops: max 100 per invocation (429 RATE_LIMITED)
   */
  recordObjectOp(): void {
    if (this.objectOps >= this.maxObjectOps) {
      throw new RateLimitedError(
        `Object operation limit exceeded: maximum ${this.maxObjectOps} operations per invocation allowed`,
      );
    }
    this.objectOps++;
  }

  /**
   * Records a Queue operation.
   * Throws RateLimitedError when operation count exceeds maxQueueOps.
   *
   * spec: contracts/functions.contract.md#FN-5 — queue ops: max 100 per invocation (429 RATE_LIMITED)
   */
  recordQueueOp(): void {
    if (this.queueOps >= this.maxQueueOps) {
      throw new RateLimitedError(
        `Queue operation limit exceeded: maximum ${this.maxQueueOps} operations per invocation allowed`,
      );
    }
    this.queueOps++;
  }

  /**
   * Appends log chunk while tracking cumulative UTF-8 byte length.
   * Truncates output and appends LOG_TRUNCATED marker if byte limit is exceeded.
   *
   * spec: contracts/functions.contract.md#FN-5 — logs.bytes_per_invocation: 64,000 (truncate + LOG_TRUNCATED)
   */
  appendLog(chunk: string): { output: string; truncated: boolean } {
    if (this.logTruncated) {
      return { output: "", truncated: true };
    }

    const chunkBytes = TEXT_ENCODER.encode(chunk).byteLength;
    if (this.currentLogBytes + chunkBytes <= this.maxLogBytes) {
      this.currentLogBytes += chunkBytes;
      return { output: chunk, truncated: false };
    }

    // Crosses boundary: calculate remaining byte budget
    const remainingCapacity = this.maxLogBytes - this.currentLogBytes;
    this.logTruncated = true;
    this.currentLogBytes = this.maxLogBytes;

    const validSlice = truncateToUtf8Bytes(chunk, remainingCapacity);
    return {
      output: validSlice + LOG_TRUNCATED_MARKER,
      truncated: true,
    };
  }

  /**
   * Parses, validates, and increments the internal call-depth header.
   * Throws CallDepthExceededError when next hop exceeds maxCallDepth.
   *
   * spec: contracts/functions.contract.md#FN-7 — call-depth guard: increment on hop, reject > call_depth_max
   * spec: contracts/platform.contract.md#PLAT-12 — error model (VALIDATION_FAILED, CALL_DEPTH_EXCEEDED)
   */
  checkCallDepth(currentDepthHeader?: string): number {
    if (currentDepthHeader === undefined || currentDepthHeader === "") {
      return 1;
    }

    if (!CALL_DEPTH_REGEX.test(currentDepthHeader)) {
      throw new ValidationFailedError(
        `Invalid ${CALL_DEPTH_HEADER} header value: "${currentDepthHeader}". Must be a non-negative integer.`,
      );
    }

    const depth = Number.parseInt(currentDepthHeader, 10);
    const nextHop = depth + 1;

    if (nextHop > this.maxCallDepth) {
      throw new CallDepthExceededError(
        `Call depth limit exceeded: next hop ${nextHop} exceeds maximum allowed depth of ${this.maxCallDepth}`,
      );
    }

    return nextHop;
  }
}

/**
 * Factory function to create an InvocationTracker instance.
 */
export function createInvocationTracker(
  limits?: InvocationOperationLimits,
): InvocationTracker {
  return new InvocationTracker(limits);
}
