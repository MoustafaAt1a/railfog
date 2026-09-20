/**
 * Tests for Resource Kill Enforcer and Payload Limits.
 *
 * Spec references:
 * - docs/contracts/functions.contract.md#FN-5 (Resource limits: timeout_ms 30s/900s, cpu_ms 200,
 *   request_body_mb 10, response_body_mb 10, streamed responses capped at 512MB)
 * - docs/contracts/platform.contract.md#PLAT-12 (Error model: TIMEOUT, PAYLOAD_TOO_LARGE, VALIDATION_FAILED)
 * - tasks/milestone-0.3-security/T-0308-resource-kill-enforcer.md (AC1 - AC4, Interface, Integration)
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { delay } from "@std/async/delay";
import {
  PayloadTooLargeError,
  RailFogError,
  TimeoutError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import {
  createKillEnforcer,
  DEFAULT_CPU_MS,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  DEFAULT_MAX_RESPONSE_BODY_BYTES,
  DEFAULT_MAX_STREAMED_BYTES,
  DEFAULT_QUEUE_TIMEOUT_MS,
  type KillEnforcer,
  type ResourceKillOptions,
} from "../../runtime/limits/kill-enforcer.ts";

// ============================================================================
// Spec-anchored Constants (FN-5)
// ============================================================================

// spec: contracts/functions.contract.md#FN-5 — timeout_ms: 30,000 (HTTP)
const SPEC_DEFAULT_HTTP_TIMEOUT_MS = 30_000;

// spec: contracts/functions.contract.md#FN-5 — timeout_ms: 900,000 (queue & schedule)
const SPEC_DEFAULT_QUEUE_TIMEOUT_MS = 900_000;

// spec: contracts/functions.contract.md#FN-5 — cpu_ms: 200
const SPEC_DEFAULT_CPU_MS = 200;

// spec: contracts/functions.contract.md#FN-5 — request_body_mb: 10 (10,485,760 bytes)
const SPEC_DEFAULT_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

// spec: contracts/functions.contract.md#FN-5 — response_body_mb: 10 (10,485,760 bytes)
const SPEC_DEFAULT_MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024;

// spec: contracts/functions.contract.md#FN-5 — streamed responses capped at 512 MB (536,870,912 bytes)
const SPEC_DEFAULT_MAX_STREAMED_BYTES = 512 * 1024 * 1024;

// ============================================================================
// Stream Helpers for Tests
// ============================================================================

/**
 * Creates a ReadableStream emitting the provided Uint8Array chunks sequentially.
 */
function createStreamFromChunks(
  chunks: Uint8Array[],
  onCancel?: (reason: unknown) => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  });
}

/**
 * Consumes a ReadableStream<Uint8Array> to completion and returns the concatenated Uint8Array.
 */
async function consumeStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLength += value.byteLength;
    }
  }

  const concatenated = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    concatenated.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return concatenated;
}

// ============================================================================
// PLAT-12: Error Model & Spec Constants
// ============================================================================

Deno.test("PLAT-12 & FN-5: Exported default constants match spec limits exactly", () => {
  // spec: contracts/functions.contract.md#FN-5
  assertEquals(DEFAULT_HTTP_TIMEOUT_MS, SPEC_DEFAULT_HTTP_TIMEOUT_MS);
  assertEquals(DEFAULT_QUEUE_TIMEOUT_MS, SPEC_DEFAULT_QUEUE_TIMEOUT_MS);
  assertEquals(DEFAULT_CPU_MS, SPEC_DEFAULT_CPU_MS);
  assertEquals(
    DEFAULT_MAX_REQUEST_BODY_BYTES,
    SPEC_DEFAULT_MAX_REQUEST_BODY_BYTES,
  );
  assertEquals(
    DEFAULT_MAX_RESPONSE_BODY_BYTES,
    SPEC_DEFAULT_MAX_RESPONSE_BODY_BYTES,
  );
  assertEquals(DEFAULT_MAX_STREAMED_BYTES, SPEC_DEFAULT_MAX_STREAMED_BYTES);
});

Deno.test("PLAT-12: TimeoutError has code TIMEOUT and is RailFogError", () => {
  // spec: contracts/platform.contract.md#PLAT-12 — TIMEOUT
  const err = new TimeoutError("Execution exceeded deadline");
  assert(err instanceof RailFogError);
  assertInstanceOf(err, Error);
  assertEquals(err.code, "TIMEOUT");
  assertEquals(err.message, "Execution exceeded deadline");
});

Deno.test("PLAT-12: PayloadTooLargeError has code PAYLOAD_TOO_LARGE and is RailFogError", () => {
  // spec: contracts/platform.contract.md#PLAT-12 — PAYLOAD_TOO_LARGE
  const err = new PayloadTooLargeError("Payload exceeds 10MB limit");
  assert(err instanceof RailFogError);
  assertInstanceOf(err, Error);
  assertEquals(err.code, "PAYLOAD_TOO_LARGE");
  assertEquals(err.message, "Payload exceeds 10MB limit");
});

Deno.test("PLAT-12: ValidationFailedError has code VALIDATION_FAILED and is RailFogError", () => {
  // spec: contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED
  const err = new ValidationFailedError("Invalid content length");
  assert(err instanceof RailFogError);
  assertInstanceOf(err, Error);
  assertEquals(err.code, "VALIDATION_FAILED");
});

// ============================================================================
// AC1: Wall-clock Timeout Enforcement (FN-5, PLAT-12)
// ============================================================================

Deno.test("AC1: createAbortController() aborts execution when timeout expires, emitting TimeoutError (504 TIMEOUT)", async () => {
  // spec: contracts/functions.contract.md#FN-5 — timeout_ms: hard kill at deadline
  // spec: contracts/platform.contract.md#PLAT-12 — TIMEOUT
  const timeoutMs = 30; // short timeout for fast and reliable test
  const enforcer = createKillEnforcer({
    timeoutMs,
    cpuMs: 200,
  });

  const { signal, cleanup } = enforcer.createAbortController();
  try {
    assertEquals(signal.aborted, false);
    assertEquals(signal.reason, undefined);

    // Wait until timeout expires
    await delay(50);

    assertEquals(signal.aborted, true);
    assertInstanceOf(signal.reason, TimeoutError);
    assertEquals((signal.reason as TimeoutError).code, "TIMEOUT");
  } finally {
    cleanup();
  }
});

Deno.test("AC1: createAbortController() dispatches abort event on signal upon timeout expiry", async () => {
  // spec: contracts/functions.contract.md#FN-5
  const timeoutMs = 25;
  const enforcer = createKillEnforcer({
    timeoutMs,
    cpuMs: 200,
  });

  const { signal, cleanup } = enforcer.createAbortController();
  let abortFired = false;
  let receivedReason: unknown = null;

  signal.addEventListener("abort", () => {
    abortFired = true;
    receivedReason = signal.reason;
  });

  try {
    assertEquals(abortFired, false);
    await delay(45);

    assertEquals(abortFired, true);
    assertInstanceOf(receivedReason, TimeoutError);
    assertEquals((receivedReason as TimeoutError).code, "TIMEOUT");
  } finally {
    cleanup();
  }
});

Deno.test("AC1: calling cleanup() before expiry clears timer so signal is NOT aborted", async () => {
  // spec: contracts/functions.contract.md#FN-5
  const timeoutMs = 40;
  const enforcer = createKillEnforcer({
    timeoutMs,
    cpuMs: 200,
  });

  const { signal, cleanup } = enforcer.createAbortController();
  let abortFired = false;
  signal.addEventListener("abort", () => {
    abortFired = true;
  });

  // Call cleanup before timeout expiry
  await delay(10);
  cleanup();

  // Wait beyond original timeout duration
  await delay(50);

  assertEquals(signal.aborted, false);
  assertEquals(signal.reason, undefined);
  assertEquals(abortFired, false);
});

Deno.test("AC1: cleanup() is idempotent and safe to call multiple times", () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 50,
    cpuMs: 200,
  });

  const { cleanup } = enforcer.createAbortController();
  // Multiple invocations must not throw
  cleanup();
  cleanup();
  cleanup();
});

Deno.test("AC1: cleanup() after signal has already aborted does not throw", async () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 20,
    cpuMs: 200,
  });

  const { signal, cleanup } = enforcer.createAbortController();
  await delay(35);
  assertEquals(signal.aborted, true);

  // Calling cleanup after abort must be safe and clean
  cleanup();
});

Deno.test("AC1: multiple abort controllers from same enforcer are independent", async () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 30,
    cpuMs: 200,
  });

  const ctrl1 = enforcer.createAbortController();
  const ctrl2 = enforcer.createAbortController();

  // Clean up ctrl1 early
  ctrl1.cleanup();

  // Wait for timeout
  await delay(50);

  // ctrl1 should NOT be aborted because it was cleaned up
  assertEquals(ctrl1.signal.aborted, false);
  // ctrl2 should be aborted because its timer expired
  assertEquals(ctrl2.signal.aborted, true);
  assertInstanceOf(ctrl2.signal.reason, TimeoutError);

  ctrl2.cleanup();
});

Deno.test("AC1: invalid timeoutMs (zero, negative, NaN) throws ValidationFailedError", () => {
  // spec: contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED
  assertThrows(
    () => createKillEnforcer({ timeoutMs: 0, cpuMs: 200 }),
    ValidationFailedError,
  );
  assertThrows(
    () => createKillEnforcer({ timeoutMs: -100, cpuMs: 200 }),
    ValidationFailedError,
  );
  assertThrows(
    () => createKillEnforcer({ timeoutMs: NaN, cpuMs: 200 }),
    ValidationFailedError,
  );
});

// ============================================================================
// AC2: Request Body Size Limit (FN-5, PLAT-12)
// ============================================================================

Deno.test("AC2: rejects immediately with PayloadTooLargeError when contentLength > maxRequestBodyBytes (default 10MB)", async () => {
  // spec: contracts/functions.contract.md#FN-5 — request_body_mb: 10
  // spec: contracts/platform.contract.md#PLAT-12 — 413 PAYLOAD_TOO_LARGE
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
  });

  const oversizedLength = 10 * 1024 * 1024 + 1; // 10.000001 MB
  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(oversizedLength);
    },
    PayloadTooLargeError,
  );

  // Also verify error code matches PLAT-12
  try {
    await enforcer.validateRequestBody(11 * 1024 * 1024);
  } catch (e) {
    assertInstanceOf(e, PayloadTooLargeError);
    assertEquals(e.code, "PAYLOAD_TOO_LARGE");
  }
});

Deno.test("AC2: rejects immediately with PayloadTooLargeError when contentLength > custom maxRequestBodyBytes", async () => {
  const customMaxBytes = 1_000;
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxRequestBodyBytes: customMaxBytes,
  });

  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(customMaxBytes + 1);
    },
    PayloadTooLargeError,
  );
});

Deno.test("AC2: rejects immediately with PayloadTooLargeError without reading bodyStream if contentLength exceeds limit", async () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxRequestBodyBytes: 500,
  });

  let streamWasRead = false;
  const dummyStream = new ReadableStream<Uint8Array>({
    pull() {
      streamWasRead = true;
      throw new Error("Stream pull should not have been called");
    },
  });

  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(501, dummyStream);
    },
    PayloadTooLargeError,
  );

  assertEquals(
    streamWasRead,
    false,
    "bodyStream should not be read when contentLength already exceeds limit",
  );
});

Deno.test("AC2: validates chunk-by-chunk and rejects with PayloadTooLargeError when contentLength is omitted and chunks exceed limit", async () => {
  // spec: contracts/functions.contract.md#FN-5 — reject with 413 PAYLOAD_TOO_LARGE
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxRequestBodyBytes: 500,
  });

  // Stream with 2 chunks totaling 600 bytes (300 + 300 > 500)
  const chunk1 = new Uint8Array(300).fill(1);
  const chunk2 = new Uint8Array(300).fill(2);
  const stream = createStreamFromChunks([chunk1, chunk2]);

  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(undefined, stream);
    },
    PayloadTooLargeError,
  );
});

Deno.test("AC2: validates chunk-by-chunk and cancels bodyStream as soon as limit is exceeded", async () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxRequestBodyBytes: 300,
  });

  let streamCancelled = false;
  const chunk1 = new Uint8Array(200);
  const chunk2 = new Uint8Array(200); // 200 + 200 = 400 > 300
  const chunk3 = new Uint8Array(200); // should never be read

  const stream = createStreamFromChunks(
    [chunk1, chunk2, chunk3],
    () => {
      streamCancelled = true;
    },
  );

  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(undefined, stream);
    },
    PayloadTooLargeError,
  );

  // The stream should be cancelled to stop upstream reading
  assertEquals(streamCancelled, true);
});

Deno.test("AC2: successfully returns full Uint8Array when contentLength is specified and within limit", async () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxRequestBodyBytes: 1024,
  });

  const payload = new Uint8Array([10, 20, 30, 40, 50]);
  const stream = createStreamFromChunks([payload]);

  const result = await enforcer.validateRequestBody(payload.length, stream);
  assertEquals(result, payload);
  assertEquals(result.byteLength, 5);
});

Deno.test("AC2: successfully returns full Uint8Array when contentLength is omitted and stream is within limit across multiple chunks", async () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxRequestBodyBytes: 1000,
  });

  const chunk1 = new Uint8Array([1, 2, 3]);
  const chunk2 = new Uint8Array([4, 5, 6]);
  const chunk3 = new Uint8Array([7, 8, 9, 10]);
  const stream = createStreamFromChunks([chunk1, chunk2, chunk3]);

  const result = await enforcer.validateRequestBody(undefined, stream);
  assertEquals(result, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  assertEquals(result.byteLength, 10);
});

Deno.test("AC2: exact boundary: body of exactly maxRequestBodyBytes succeeds", async () => {
  const limit = 100;
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxRequestBodyBytes: limit,
  });

  const body = new Uint8Array(limit).fill(42);
  const stream = createStreamFromChunks([body]);

  const result = await enforcer.validateRequestBody(limit, stream);
  assertEquals(result.byteLength, limit);
});

Deno.test("AC2: exact boundary: body of maxRequestBodyBytes + 1 fails", async () => {
  const limit = 100;
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxRequestBodyBytes: limit,
  });

  const body = new Uint8Array(limit + 1).fill(42);
  const stream = createStreamFromChunks([body]);

  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(limit + 1, stream);
    },
    PayloadTooLargeError,
  );
});

Deno.test("AC2: returns empty Uint8Array when request body is empty (contentLength 0, no stream)", async () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
  });

  const result = await enforcer.validateRequestBody(0, undefined);
  assertInstanceOf(result, Uint8Array);
  assertEquals(result.byteLength, 0);
});

Deno.test("AC2: returns empty Uint8Array when request body is empty (contentLength 0, empty stream)", async () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
  });

  const emptyStream = createStreamFromChunks([]);
  const result = await enforcer.validateRequestBody(0, emptyStream);
  assertInstanceOf(result, Uint8Array);
  assertEquals(result.byteLength, 0);
});

Deno.test("AC2: returns empty Uint8Array when both contentLength and bodyStream are omitted (undefined)", async () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
  });

  const result = await enforcer.validateRequestBody(undefined, undefined);
  assertInstanceOf(result, Uint8Array);
  assertEquals(result.byteLength, 0);
});

Deno.test("AC2: rejects with ValidationFailedError on negative or invalid contentLength", async () => {
  // spec: contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
  });

  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(-1);
    },
    ValidationFailedError,
  );

  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(-100);
    },
    ValidationFailedError,
  );

  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(NaN);
    },
    ValidationFailedError,
  );

  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(1.5); // non-integer byte count
    },
    ValidationFailedError,
  );
});

Deno.test("AC2: under-reported contentLength: declared within limit but stream delivers more than maxRequestBodyBytes", async () => {
  // Adversarial: client claims 50 bytes, but stream actually emits 200 bytes when limit is 100
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxRequestBodyBytes: 100,
  });

  const deceptiveStream = createStreamFromChunks([
    new Uint8Array(80),
    new Uint8Array(80), // total 160 > 100
  ]);

  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(50, deceptiveStream);
    },
    PayloadTooLargeError,
  );
});

// ============================================================================
// AC3: Streamed Response Size Limit (FN-5, PLAT-12)
// ============================================================================

Deno.test("AC3: wrapResponseStream() allows streams within maxStreamedBytes to be read to completion", async () => {
  // spec: contracts/functions.contract.md#FN-5 — streamed responses capped at 512 MB
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxStreamedBytes: 1000,
  });

  const chunk1 = new Uint8Array([1, 2, 3, 4, 5]);
  const chunk2 = new Uint8Array([6, 7, 8, 9, 10]);
  const originalStream = createStreamFromChunks([chunk1, chunk2]);

  const wrappedStream = enforcer.wrapResponseStream(originalStream);
  const result = await consumeStream(wrappedStream);

  assertEquals(result, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  assertEquals(result.byteLength, 10);
});

Deno.test("AC3: wrapResponseStream() aborts stream with PayloadTooLargeError when total emitted bytes exceed limit", async () => {
  // spec: contracts/functions.contract.md#FN-5 — reject with 413 PAYLOAD_TOO_LARGE
  // spec: contracts/platform.contract.md#PLAT-12 — PAYLOAD_TOO_LARGE
  const limit = 500;
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxStreamedBytes: limit,
  });

  const chunk1 = new Uint8Array(300).fill(1);
  const chunk2 = new Uint8Array(300).fill(2); // 300 + 300 = 600 > 500
  const originalStream = createStreamFromChunks([chunk1, chunk2]);

  const wrappedStream = enforcer.wrapResponseStream(originalStream);

  await assertRejects(
    async () => {
      await consumeStream(wrappedStream);
    },
    PayloadTooLargeError,
  );
});

Deno.test("AC3: wrapResponseStream() allows stream with exactly maxStreamedBytes to complete successfully", async () => {
  const limit = 400;
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxStreamedBytes: limit,
  });

  const chunk1 = new Uint8Array(200);
  const chunk2 = new Uint8Array(200); // exactly 400
  const originalStream = createStreamFromChunks([chunk1, chunk2]);

  const wrappedStream = enforcer.wrapResponseStream(originalStream);
  const result = await consumeStream(wrappedStream);
  assertEquals(result.byteLength, limit);
});

Deno.test("AC3: wrapResponseStream() aborts stream when maxStreamedBytes + 1 is reached", async () => {
  const limit = 400;
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxStreamedBytes: limit,
  });

  const chunk1 = new Uint8Array(200);
  const chunk2 = new Uint8Array(201); // 401 > 400
  const originalStream = createStreamFromChunks([chunk1, chunk2]);

  const wrappedStream = enforcer.wrapResponseStream(originalStream);

  await assertRejects(
    async () => {
      await consumeStream(wrappedStream);
    },
    PayloadTooLargeError,
  );
});

Deno.test("AC3: wrapResponseStream() handles empty stream without emitting chunks or errors", async () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
  });

  const emptyStream = createStreamFromChunks([]);
  const wrappedStream = enforcer.wrapResponseStream(emptyStream);
  const result = await consumeStream(wrappedStream);

  assertEquals(result.byteLength, 0);
});

Deno.test("AC3: wrapResponseStream() cancels underlying stream when ceiling is exceeded", async () => {
  const limit = 200;
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxStreamedBytes: limit,
  });

  let underlyingCancelled = false;
  const chunk1 = new Uint8Array(150);
  const chunk2 = new Uint8Array(150); // total 300 > 200
  const chunk3 = new Uint8Array(150);

  const originalStream = createStreamFromChunks(
    [chunk1, chunk2, chunk3],
    () => {
      underlyingCancelled = true;
    },
  );

  const wrappedStream = enforcer.wrapResponseStream(originalStream);

  await assertRejects(
    async () => {
      await consumeStream(wrappedStream);
    },
    PayloadTooLargeError,
  );

  assertEquals(
    underlyingCancelled,
    true,
    "underlying stream must be cancelled when limit exceeded",
  );
});

// ============================================================================
// AC4: CPU Time Limit Enforcement (FN-5, PLAT-12)
// ============================================================================

Deno.test("AC4: checkCpuLimit() does not throw when cpuTimeMs < cpuMs (default 200ms)", () => {
  // spec: contracts/functions.contract.md#FN-5 — cpu_ms: 200
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
  });

  // Consumed CPU time below 200ms must not throw
  enforcer.checkCpuLimit(0);
  enforcer.checkCpuLimit(50);
  enforcer.checkCpuLimit(150);
  enforcer.checkCpuLimit(199);
  enforcer.checkCpuLimit(199.9);
});

Deno.test("AC4: checkCpuLimit() throws TimeoutError when cpuTimeMs >= cpuMs (exact 200ms or greater)", () => {
  // spec: contracts/functions.contract.md#FN-5 — Kill at CPU time consumed >= limit, independent of wall clock
  // spec: contracts/platform.contract.md#PLAT-12 — TIMEOUT
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
  });

  // Exact boundary: 200 >= 200 -> throws TimeoutError
  assertThrows(
    () => enforcer.checkCpuLimit(200),
    TimeoutError,
  );

  // Above boundary: 201 >= 200 -> throws TimeoutError
  assertThrows(
    () => enforcer.checkCpuLimit(201),
    TimeoutError,
  );

  // Significantly above boundary: 500 >= 200 -> throws TimeoutError
  assertThrows(
    () => enforcer.checkCpuLimit(500),
    TimeoutError,
  );

  // Verify error code is TIMEOUT per PLAT-12
  try {
    enforcer.checkCpuLimit(250);
    assert(false, "Should have thrown TimeoutError");
  } catch (err) {
    assertInstanceOf(err, TimeoutError);
    assertEquals(err.code, "TIMEOUT");
  }
});

Deno.test("AC4: checkCpuLimit() respects custom cpuMs limit", () => {
  const customCpuLimit = 50;
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: customCpuLimit,
  });

  enforcer.checkCpuLimit(49);

  assertThrows(
    () => enforcer.checkCpuLimit(50),
    TimeoutError,
  );
  assertThrows(
    () => enforcer.checkCpuLimit(51),
    TimeoutError,
  );
});

Deno.test("AC4: checkCpuLimit() throws ValidationFailedError on negative or invalid cpuTimeMs", () => {
  // spec: contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
  });

  assertThrows(
    () => enforcer.checkCpuLimit(-1),
    ValidationFailedError,
  );
  assertThrows(
    () => enforcer.checkCpuLimit(-50),
    ValidationFailedError,
  );
  assertThrows(
    () => enforcer.checkCpuLimit(NaN),
    ValidationFailedError,
  );
});

// ============================================================================
// Integration Tests: End-to-End HTTP Requests & Streaming Responses
// ============================================================================

Deno.test("Integration: HTTP Request with Content-Length exceeding limit is rejected immediately", async () => {
  // spec: contracts/functions.contract.md#FN-5
  // spec: contracts/platform.contract.md#PLAT-12
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxRequestBodyBytes: 1024,
  });

  const req = new Request("http://localhost/api/upload", {
    method: "POST",
    headers: {
      "content-length": "2048",
    },
  });

  const contentLengthHeader = req.headers.get("content-length");
  const contentLength = contentLengthHeader
    ? parseInt(contentLengthHeader, 10)
    : undefined;

  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(contentLength, req.body ?? undefined);
    },
    PayloadTooLargeError,
  );
});

Deno.test("Integration: HTTP Request with chunked transfer exceeding limit is rejected during stream reading", async () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxRequestBodyBytes: 500,
  });

  const chunk1 = new Uint8Array(300).fill(65);
  const chunk2 = new Uint8Array(300).fill(66);
  const stream = createStreamFromChunks([chunk1, chunk2]);

  // Request without content-length header
  const req = new Request("http://localhost/api/stream", {
    method: "POST",
    body: stream,
    // @ts-ignore: duplex is required in standard fetch for streaming request bodies
    duplex: "half",
  });

  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(undefined, req.body ?? undefined);
    },
    PayloadTooLargeError,
  );
});

Deno.test("Integration: Valid HTTP Request within limit returns complete Uint8Array body", async () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
  });

  const payload = new TextEncoder().encode('{"action":"test"}');
  const req = new Request("http://localhost/api/data", {
    method: "POST",
    headers: {
      "content-length": payload.byteLength.toString(),
    },
    body: payload,
  });

  const contentLength = parseInt(req.headers.get("content-length")!, 10);
  const result = await enforcer.validateRequestBody(
    contentLength,
    req.body ?? undefined,
  );

  assertEquals(result, payload);
  assertEquals(new TextDecoder().decode(result), '{"action":"test"}');
});

Deno.test("Integration: Streaming HTTP Response exceeding limit aborts consumer read with PayloadTooLargeError", async () => {
  // spec: contracts/functions.contract.md#FN-5 — streamed responses capped at 512 MB
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxStreamedBytes: 800,
  });

  const chunk1 = new Uint8Array(500).fill(1);
  const chunk2 = new Uint8Array(500).fill(2); // total 1000 > 800
  const originalStream = createStreamFromChunks([chunk1, chunk2]);

  const wrappedStream = enforcer.wrapResponseStream(originalStream);
  const response = new Response(wrappedStream);

  await assertRejects(
    async () => {
      await response.arrayBuffer();
    },
    PayloadTooLargeError,
  );
});

Deno.test("Integration: Streaming HTTP Response within limit is read to completion by consumer", async () => {
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
    maxStreamedBytes: 5000,
  });

  const encoder = new TextEncoder();
  const chunk1 = encoder.encode("Hello, ");
  const chunk2 = encoder.encode("world!");
  const originalStream = createStreamFromChunks([chunk1, chunk2]);

  const wrappedStream = enforcer.wrapResponseStream(originalStream);
  const response = new Response(wrappedStream);

  const text = await response.text();
  assertEquals(text, "Hello, world!");
});

// ============================================================================
// ResourceKillOptions Default Fallbacks
// ============================================================================

Deno.test("ResourceKillOptions: default byte limits apply when optional fields are omitted", async () => {
  // When optional limit fields are omitted, defaults from FN-5 must be used
  const enforcer = createKillEnforcer({
    timeoutMs: 30_000,
    cpuMs: 200,
  });

  // Request body: default 10MB limit
  // 10MB + 1 should fail
  await assertRejects(
    async () => {
      await enforcer.validateRequestBody(
        SPEC_DEFAULT_MAX_REQUEST_BODY_BYTES + 1,
      );
    },
    PayloadTooLargeError,
  );

  // 100 bytes should succeed
  const small = new Uint8Array(100);
  const smallStream = createStreamFromChunks([small]);
  const res = await enforcer.validateRequestBody(100, smallStream);
  assertEquals(res.byteLength, 100);
});

Deno.test("ResourceKillOptions: invalid cpuMs (negative or zero) throws ValidationFailedError", () => {
  assertThrows(
    () => createKillEnforcer({ timeoutMs: 30_000, cpuMs: 0 }),
    ValidationFailedError,
  );
  assertThrows(
    () => createKillEnforcer({ timeoutMs: 30_000, cpuMs: -10 }),
    ValidationFailedError,
  );
});

Deno.test("ResourceKillOptions: invalid byte limits (negative or zero) throws ValidationFailedError", () => {
  assertThrows(
    () =>
      createKillEnforcer({
        timeoutMs: 30_000,
        cpuMs: 200,
        maxRequestBodyBytes: -1,
      }),
    ValidationFailedError,
  );
  assertThrows(
    () =>
      createKillEnforcer({
        timeoutMs: 30_000,
        cpuMs: 200,
        maxStreamedBytes: 0,
      }),
    ValidationFailedError,
  );
});

Deno.test("ResourceKillOptions & KillEnforcer: type contract matches required interface shape", () => {
  const options: ResourceKillOptions = {
    timeoutMs: 30_000,
    cpuMs: 200,
    maxRequestBodyBytes: 10 * 1024 * 1024,
    maxResponseBodyBytes: 10 * 1024 * 1024,
    maxStreamedBytes: 512 * 1024 * 1024,
  };
  const enforcer: KillEnforcer = createKillEnforcer(options);
  assert(enforcer !== undefined);
  assertEquals(typeof enforcer.createAbortController, "function");
  assertEquals(typeof enforcer.validateRequestBody, "function");
  assertEquals(typeof enforcer.wrapResponseStream, "function");
  assertEquals(typeof enforcer.checkCpuLimit, "function");
});
