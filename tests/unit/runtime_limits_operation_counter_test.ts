/**
 * Tests for Per-Invocation Operation Counters and Call-Depth Guard.
 *
 * Spec references:
 * - docs/contracts/functions.contract.md FN-5 (Resource limits: KV 1,000 ops, Objects 100 ops,
 *   Queues 100 ops, Logs 64,000 bytes, call_depth_max 8)
 * - docs/contracts/functions.contract.md FN-6 (Warm-isolate reuse & invocation isolation)
 * - docs/contracts/functions.contract.md FN-7 (Call-depth guard: X-RailFog-Call-Depth propagation & recursion denial-of-wallet)
 * - docs/contracts/platform.contract.md PLAT-12 (Error model: RATE_LIMITED, CALL_DEPTH_EXCEEDED, VALIDATION_FAILED)
 * - tasks/milestone-0.3-security/T-0307-per-invocation-limits.md (AC1 - AC4, custom limits, adversarial)
 */

import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import {
  CallDepthExceededError,
  RateLimitedError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
} from "../../packages/policy/permission-resolver.ts";
import {
  createInvocationTracker,
  type InvocationOperationLimits,
  type InvocationTracker,
} from "../../runtime/limits/operation-counter.ts";

// ============================================================================
// Spec-anchored Constants (FN-5, FN-7)
// ============================================================================

// spec: contracts/functions.contract.md#FN-5 — kv ops per invocation: 1,000
const DEFAULT_MAX_KV_OPS = 1_000;

// spec: contracts/functions.contract.md#FN-5 — objects ops per invocation: 100
const DEFAULT_MAX_OBJECT_OPS = 100;

// spec: contracts/functions.contract.md#FN-5 — queue ops per invocation: 100
const DEFAULT_MAX_QUEUE_OPS = 100;

// spec: contracts/functions.contract.md#FN-5 — logs.bytes_per_invocation: 64,000
const DEFAULT_MAX_LOG_BYTES = 64_000;

// spec: contracts/functions.contract.md#FN-5 — call_depth_max: 8
// spec: contracts/functions.contract.md#FN-7 — call-depth guard: default 8
const DEFAULT_MAX_CALL_DEPTH = 8;

// spec: contracts/functions.contract.md#FN-5 — logs exceed limit: truncate + emit LOG_TRUNCATED marker
const LOG_TRUNCATED_MARKER = "[LOG_TRUNCATED]";

// ============================================================================
// Error Properties & Contract Verification (PLAT-12)
// ============================================================================

Deno.test("PLAT-12: Error taxonomy codes match spec definitions exactly", () => {
  // spec: contracts/platform.contract.md#PLAT-12
  const rateLimitErr = new RateLimitedError("test rate limit");
  assertEquals(rateLimitErr.code, "RATE_LIMITED");

  const callDepthErr = new CallDepthExceededError("test call depth");
  assertEquals(callDepthErr.code, "CALL_DEPTH_EXCEEDED");

  const validationErr = new ValidationFailedError("test validation");
  assertEquals(validationErr.code, "VALIDATION_FAILED");
});

// ============================================================================
// AC1: KV Operation Limits (FN-5)
// ============================================================================

Deno.test("AC1 (Unit): First 1,000 KV operations succeed, 1,001st throws RateLimitedError", () => {
  // spec: contracts/functions.contract.md#FN-5 — kv ops: max 1,000 per invocation.
  // AC1: Given an invocation executing KV operations, when the 1,001st KV operation is attempted,
  // then it throws RateLimitedError (429 RATE_LIMITED). The first 1,000 operations succeed without throwing.
  const tracker: InvocationTracker = createInvocationTracker();

  for (let i = 1; i <= DEFAULT_MAX_KV_OPS; i++) {
    tracker.recordKvOp();
  }

  // 1,001st operation must throw RateLimitedError
  const err = assertThrows(
    () => tracker.recordKvOp(),
    RateLimitedError,
  );
  assertEquals(err.code, "RATE_LIMITED");

  // Subsequent attempts within the same invocation must also throw
  assertThrows(
    () => tracker.recordKvOp(),
    RateLimitedError,
  );
});

// ============================================================================
// AC2: Object and Queue Operation Limits (FN-5)
// ============================================================================

Deno.test("AC2 (Unit): First 100 Object operations succeed, 101st throws RateLimitedError", () => {
  // spec: contracts/functions.contract.md#FN-5 — objects ops: max 100 per invocation.
  // AC2: Given an invocation executing Object operations, when the 101st operation is attempted,
  // then it throws RateLimitedError (429 RATE_LIMITED). The first 100 succeed.
  const tracker: InvocationTracker = createInvocationTracker();

  for (let i = 1; i <= DEFAULT_MAX_OBJECT_OPS; i++) {
    tracker.recordObjectOp();
  }

  // 101st operation must throw RateLimitedError
  const err = assertThrows(
    () => tracker.recordObjectOp(),
    RateLimitedError,
  );
  assertEquals(err.code, "RATE_LIMITED");

  // Subsequent attempts continue to throw
  assertThrows(
    () => tracker.recordObjectOp(),
    RateLimitedError,
  );
});

Deno.test("AC2 (Unit): First 100 Queue operations succeed, 101st throws RateLimitedError", () => {
  // spec: contracts/functions.contract.md#FN-5 — queue ops: max 100 per invocation.
  // AC2: Given an invocation executing Queue operations, when the 101st operation is attempted,
  // then it throws RateLimitedError (429 RATE_LIMITED). The first 100 succeed.
  const tracker: InvocationTracker = createInvocationTracker();

  for (let i = 1; i <= DEFAULT_MAX_QUEUE_OPS; i++) {
    tracker.recordQueueOp();
  }

  // 101st operation must throw RateLimitedError
  const err = assertThrows(
    () => tracker.recordQueueOp(),
    RateLimitedError,
  );
  assertEquals(err.code, "RATE_LIMITED");

  // Subsequent attempts continue to throw
  assertThrows(
    () => tracker.recordQueueOp(),
    RateLimitedError,
  );
});

Deno.test("FN-5 (Unit): KV, Object, and Queue operation counters track independently within the same invocation", () => {
  // spec: contracts/functions.contract.md#FN-5
  const tracker: InvocationTracker = createInvocationTracker();

  // Exhaust KV operations (1,000)
  for (let i = 0; i < DEFAULT_MAX_KV_OPS; i++) {
    tracker.recordKvOp();
  }
  assertThrows(() => tracker.recordKvOp(), RateLimitedError);

  // Object and Queue operations must still succeed up to their independent limits
  for (let i = 0; i < DEFAULT_MAX_OBJECT_OPS; i++) {
    tracker.recordObjectOp();
  }
  assertThrows(() => tracker.recordObjectOp(), RateLimitedError);

  for (let i = 0; i < DEFAULT_MAX_QUEUE_OPS; i++) {
    tracker.recordQueueOp();
  }
  assertThrows(() => tracker.recordQueueOp(), RateLimitedError);
});

// ============================================================================
// AC3: Log Bytes Ceiling & Truncation Marker (FN-5)
// ============================================================================

Deno.test("AC3 (Unit): Exactly 64,000 bytes emitted without truncation", () => {
  // spec: contracts/functions.contract.md#FN-5 — logs.bytes_per_invocation: 64,000
  const tracker: InvocationTracker = createInvocationTracker();
  const chunk = "a".repeat(DEFAULT_MAX_LOG_BYTES);

  const result = tracker.appendLog(chunk);
  assertEquals(result.output, chunk);
  assertEquals(result.truncated, false);
});

Deno.test("AC3 (Unit): 64,001st byte triggers truncation with LOG_TRUNCATED marker", () => {
  // spec: contracts/functions.contract.md#FN-5
  const tracker: InvocationTracker = createInvocationTracker();

  // Emit exactly 64,000 bytes first
  const initial = tracker.appendLog("a".repeat(DEFAULT_MAX_LOG_BYTES));
  assertEquals(initial.truncated, false);

  // Attempting to append 1 more byte crosses the boundary
  const overflow = tracker.appendLog("b");
  assertEquals(overflow.truncated, true);
  assertEquals(overflow.output, LOG_TRUNCATED_MARKER);
});

Deno.test("AC3 (Unit): Single large chunk exceeding 64,000 bytes is truncated and suffixed with marker", () => {
  // spec: contracts/functions.contract.md#FN-5
  const tracker: InvocationTracker = createInvocationTracker();
  const chunkSize = 70_000;
  const chunk = "x".repeat(chunkSize);

  const result = tracker.appendLog(chunk);
  assertEquals(result.truncated, true);
  assertEquals(
    result.output,
    "x".repeat(DEFAULT_MAX_LOG_BYTES) + LOG_TRUNCATED_MARKER,
  );
});

Deno.test("AC3 (Unit): Cumulative chunks crossing 64,000 bytes boundary are truncated at boundary and suffixed", () => {
  // spec: contracts/functions.contract.md#FN-5
  const tracker: InvocationTracker = createInvocationTracker();

  // Chunk 1: 40,000 bytes (within limit)
  const chunk1 = "m".repeat(40_000);
  const res1 = tracker.appendLog(chunk1);
  assertEquals(res1.output, chunk1);
  assertEquals(res1.truncated, false);

  // Chunk 2: 30,000 bytes (crosses boundary at 24,000 bytes into chunk 2)
  const chunk2 = "n".repeat(30_000);
  const res2 = tracker.appendLog(chunk2);
  assertEquals(res2.truncated, true);
  assertEquals(
    res2.output,
    "n".repeat(24_000) + LOG_TRUNCATED_MARKER,
  );
});

Deno.test("AC3 (Unit): Subsequent appendLog calls after truncation return empty string and truncated true", () => {
  // spec: contracts/functions.contract.md#FN-5
  const tracker: InvocationTracker = createInvocationTracker();

  // Cause truncation
  tracker.appendLog("z".repeat(DEFAULT_MAX_LOG_BYTES + 100));

  // Subsequent calls must return empty output and truncated: true
  const after1 = tracker.appendLog("more logs after limit");
  assertEquals(after1.output, "");
  assertEquals(after1.truncated, true);

  const after2 = tracker.appendLog("even more logs");
  assertEquals(after2.output, "");
  assertEquals(after2.truncated, true);
});

Deno.test("AC3 (Unit): UTF-8 multi-byte characters are accurately measured by byte length", () => {
  // spec: contracts/functions.contract.md#FN-5
  // UTF-8 multi-byte characters:
  // "€" is 3 bytes in UTF-8, but length is 1
  // "🚀" is 4 bytes in UTF-8, but length is 2 (surrogate pair)
  const tracker: InvocationTracker = createInvocationTracker({
    maxLogBytes: 20,
  });

  // "こんにちは" is 5 chars, each 3 bytes in UTF-8 = 15 bytes total
  const greeting = "こんにちは";
  const textEncoder = new TextEncoder();
  assertEquals(textEncoder.encode(greeting).byteLength, 15);

  const res1 = tracker.appendLog(greeting);
  assertEquals(res1.output, greeting);
  assertEquals(res1.truncated, false);

  // Adding "世界" (2 chars * 3 bytes = 6 bytes) would bring total to 21 bytes (> 20 byte limit).
  // Remaining capacity is 5 bytes. 1 char ("世") is 3 bytes, 2 chars ("世界") is 6 bytes.
  // Truncation must occur, preserving valid prefix up to byte limit and appending marker.
  const res2 = tracker.appendLog("世界");
  assertEquals(res2.truncated, true);
  assertEquals(res2.output.endsWith(LOG_TRUNCATED_MARKER), true);

  // Subsequent calls are suppressed
  const res3 = tracker.appendLog("テスト");
  assertEquals(res3.output, "");
  assertEquals(res3.truncated, true);
});

Deno.test("AC3 (Security): Multi-byte UTF-8 string exceeding byte ceiling cannot bypass log limit via character count", () => {
  // spec: contracts/functions.contract.md#FN-5
  // If an implementation erroneously measured string.length instead of UTF-8 byte length:
  // 17,000 emojis (each 4 bytes = 68,000 bytes > 64,000 bytes, but length is 34,000 < 64,000).
  const tracker: InvocationTracker = createInvocationTracker();
  const emojiChunk = "🦀".repeat(17_000);
  const byteLength = new TextEncoder().encode(emojiChunk).byteLength;
  assertEquals(byteLength, 68_000);
  assertEquals(emojiChunk.length, 34_000);

  const result = tracker.appendLog(emojiChunk);
  assertEquals(
    result.truncated,
    true,
    "Log with 68,000 UTF-8 bytes must be truncated despite string length being 34,000",
  );
  assertEquals(result.output.endsWith(LOG_TRUNCATED_MARKER), true);
});

// ============================================================================
// AC4: Call-Depth Guard (FN-7, PLAT-12)
// ============================================================================

Deno.test("AC4 (Unit): checkCallDepth handles initial hops (undefined or empty header)", () => {
  // spec: contracts/functions.contract.md#FN-7
  // AC4: Initial hop without incoming depth header begins at depth 1.
  const tracker: InvocationTracker = createInvocationTracker();

  assertEquals(tracker.checkCallDepth(undefined), 1);
  assertEquals(tracker.checkCallDepth(""), 1);
});

Deno.test("AC4 (Unit): checkCallDepth parses and increments call-depth header values up to maxCallDepth", () => {
  // spec: contracts/functions.contract.md#FN-7
  // Header "1" -> next hop is 2
  // Header "7" -> next hop is 8 (default limit is 8)
  const tracker: InvocationTracker = createInvocationTracker();

  assertEquals(tracker.checkCallDepth("1"), 2);
  assertEquals(tracker.checkCallDepth("7"), DEFAULT_MAX_CALL_DEPTH);
});

Deno.test("AC4 (Unit): checkCallDepth throws CallDepthExceededError when incoming depth is 8 or higher", () => {
  // spec: contracts/functions.contract.md#FN-7
  // spec: contracts/platform.contract.md#PLAT-12
  // AC4: Given a request with header X-RailFog-Call-Depth: 8, when forwarded to next hop (depth 9),
  // then it is rejected with CallDepthExceededError (429 CALL_DEPTH_EXCEEDED).
  const tracker: InvocationTracker = createInvocationTracker();

  // Incoming "8" -> next hop is 9 > 8 -> throws CallDepthExceededError
  const err8 = assertThrows(
    () => tracker.checkCallDepth(String(DEFAULT_MAX_CALL_DEPTH)),
    CallDepthExceededError,
  );
  assertEquals(err8.code, "CALL_DEPTH_EXCEEDED");

  // Incoming "9" -> next hop is 10 > 8 -> throws CallDepthExceededError
  const err9 = assertThrows(
    () => tracker.checkCallDepth("9"),
    CallDepthExceededError,
  );
  assertEquals(err9.code, "CALL_DEPTH_EXCEEDED");
});

// ============================================================================
// Custom Limits Injection
// ============================================================================

Deno.test("Custom Limits (Unit): Tracker respects custom thresholds injected via InvocationOperationLimits", () => {
  // spec: contracts/functions.contract.md#FN-5
  // spec: contracts/functions.contract.md#FN-7
  const customLimits: InvocationOperationLimits = {
    maxKvOps: 5,
    maxObjectOps: 3,
    maxQueueOps: 2,
    maxLogBytes: 20,
    maxCallDepth: 3,
  };
  const tracker: InvocationTracker = createInvocationTracker(customLimits);

  // Custom KV limit: 5 ops allowed, 6th rejected
  for (let i = 0; i < 5; i++) tracker.recordKvOp();
  assertThrows(() => tracker.recordKvOp(), RateLimitedError);

  // Custom Object limit: 3 ops allowed, 4th rejected
  for (let i = 0; i < 3; i++) tracker.recordObjectOp();
  assertThrows(() => tracker.recordObjectOp(), RateLimitedError);

  // Custom Queue limit: 2 ops allowed, 3rd rejected
  for (let i = 0; i < 2; i++) tracker.recordQueueOp();
  assertThrows(() => tracker.recordQueueOp(), RateLimitedError);

  // Custom Log limit: 20 bytes allowed, 21st byte triggers truncation
  const logRes1 = tracker.appendLog("12345678901234567890"); // 20 bytes
  assertEquals(logRes1.truncated, false);
  const logRes2 = tracker.appendLog("!");
  assertEquals(logRes2.truncated, true);
  assertEquals(logRes2.output, LOG_TRUNCATED_MARKER);

  // Custom Call Depth limit: max 3
  assertEquals(tracker.checkCallDepth(undefined), 1);
  assertEquals(tracker.checkCallDepth("1"), 2);
  assertEquals(tracker.checkCallDepth("2"), 3);
  assertThrows(() => tracker.checkCallDepth("3"), CallDepthExceededError);
});

// ============================================================================
// Invocation Isolation (FN-6)
// ============================================================================

Deno.test("FN-6 (Unit): Distinct tracker instances have isolated counters without module-level state bleed", () => {
  // spec: contracts/functions.contract.md#FN-6 — bindings are re-injected on every invocation,
  // module-level state must never bleed across invocations.
  const trackerA: InvocationTracker = createInvocationTracker();
  const trackerB: InvocationTracker = createInvocationTracker();

  // Exhaust KV ops on trackerA
  for (let i = 0; i < DEFAULT_MAX_KV_OPS; i++) {
    trackerA.recordKvOp();
  }
  assertThrows(() => trackerA.recordKvOp(), RateLimitedError);

  // trackerB must be completely unaffected and have full capacity
  for (let i = 0; i < DEFAULT_MAX_KV_OPS; i++) {
    trackerB.recordKvOp();
  }
  assertThrows(() => trackerB.recordKvOp(), RateLimitedError);

  // Exhaust log on trackerA
  trackerA.appendLog("a".repeat(DEFAULT_MAX_LOG_BYTES + 10));
  assertEquals(trackerA.appendLog("test").output, "");

  // trackerB log capacity is fresh
  const bLog = trackerB.appendLog("fresh log for invocation B");
  assertEquals(bLog.output, "fresh log for invocation B");
  assertEquals(bLog.truncated, false);
});

// ============================================================================
// Adversarial & Security Tests (FN-5, FN-7, PLAT-12)
// ============================================================================

Deno.test("FN-7 / PLAT-12 (Security): Malformed X-RailFog-Call-Depth header values are rejected", () => {
  // spec: contracts/functions.contract.md#FN-7
  // spec: contracts/platform.contract.md#PLAT-12
  // Adversaries attempting to bypass call-depth checks with negative numbers, non-integers,
  // hex values, or NaN must be rejected with ValidationFailedError or CallDepthExceededError.
  const tracker: InvocationTracker = createInvocationTracker();

  const malformedInputs = [
    "-1",
    "-100",
    "abc",
    "invalid",
    "1.5",
    "3.14",
    "NaN",
    "0x10",
    "Infinity",
    "-Infinity",
    "1e5",
    " 1 ",
    "1; drop table",
  ];

  for (const input of malformedInputs) {
    const err = assertThrows(
      () => tracker.checkCallDepth(input),
      Error,
      undefined,
      `Malformed call depth "${input}" must be rejected`,
    );

    const isExpectedError = err instanceof ValidationFailedError ||
      err instanceof CallDepthExceededError;
    assertEquals(
      isExpectedError,
      true,
      `Expected ValidationFailedError or CallDepthExceededError for input "${input}", but got ${err}`,
    );
  }
});

Deno.test("FN-7 (Security): Extremely large call-depth values throw CallDepthExceededError", () => {
  // spec: contracts/functions.contract.md#FN-7
  const tracker: InvocationTracker = createInvocationTracker();

  const oversizedInputs = ["999", "999999999", "2147483647"];
  for (const input of oversizedInputs) {
    const err = assertThrows(
      () => tracker.checkCallDepth(input),
      CallDepthExceededError,
    );
    assertEquals(err.code, "CALL_DEPTH_EXCEEDED");
  }
});

Deno.test("FN-5 (Security): Operation flood rejection prevents unbounded storage operations", () => {
  // spec: contracts/functions.contract.md#FN-5
  // Denial-of-wallet / flood prevention: an attacker attempting to perform 5,000 KV ops
  // is strictly capped at 1,000. All 4,000 subsequent ops are rejected.
  const tracker: InvocationTracker = createInvocationTracker();

  let successfulOps = 0;
  let rejectedOps = 0;

  for (let i = 0; i < 5_000; i++) {
    try {
      tracker.recordKvOp();
      successfulOps++;
    } catch (err) {
      assertInstanceOf(err, RateLimitedError);
      rejectedOps++;
    }
  }

  assertEquals(successfulOps, DEFAULT_MAX_KV_OPS);
  assertEquals(rejectedOps, 4_000);
});

Deno.test("FN-5 (Security): Concurrently dispatched operations cannot race or exceed quotas", async () => {
  // spec: contracts/functions.contract.md#FN-5
  // Verify that concurrent/parallel async operations within an invocation cannot race the counters
  const tracker: InvocationTracker = createInvocationTracker();

  // 1. Race KV operations (5,000 concurrent promises)
  const kvPromises = Array.from({ length: 5_000 }, async () => {
    await Promise.resolve();
    tracker.recordKvOp();
  });
  const kvResults = await Promise.allSettled(kvPromises);
  const kvFulfilled = kvResults.filter((r) => r.status === "fulfilled").length;
  const kvRejected = kvResults.filter((r) => r.status === "rejected").length;

  assertEquals(kvFulfilled, DEFAULT_MAX_KV_OPS);
  assertEquals(kvRejected, 4_000);

  // 2. Race Object operations (500 concurrent promises)
  const objPromises = Array.from({ length: 500 }, async () => {
    await Promise.resolve();
    tracker.recordObjectOp();
  });
  const objResults = await Promise.allSettled(objPromises);
  const objFulfilled =
    objResults.filter((r) => r.status === "fulfilled").length;
  const objRejected = objResults.filter((r) => r.status === "rejected").length;

  assertEquals(objFulfilled, DEFAULT_MAX_OBJECT_OPS);
  assertEquals(objRejected, 400);

  // 3. Race Queue operations (500 concurrent promises)
  const queuePromises = Array.from({ length: 500 }, async () => {
    await Promise.resolve();
    tracker.recordQueueOp();
  });
  const queueResults = await Promise.allSettled(queuePromises);
  const queueFulfilled =
    queueResults.filter((r) => r.status === "fulfilled").length;
  const queueRejected =
    queueResults.filter((r) => r.status === "rejected").length;

  assertEquals(queueFulfilled, DEFAULT_MAX_QUEUE_OPS);
  assertEquals(queueRejected, 400);

  // 4. Fail-closed: verify subsequent synchronous calls immediately fail
  assertThrows(() => tracker.recordKvOp(), RateLimitedError);
  assertThrows(() => tracker.recordObjectOp(), RateLimitedError);
  assertThrows(() => tracker.recordQueueOp(), RateLimitedError);
});

Deno.test("FN-7 / PLAT-12 (Security): Comprehensive call-depth header evasion attacks are rejected or contained", () => {
  // spec: contracts/functions.contract.md#FN-7
  // spec: contracts/platform.contract.md#PLAT-12
  const tracker: InvocationTracker = createInvocationTracker();

  // Negative numbers must fail validation
  for (const val of ["-1", "-999", "-0"]) {
    assertThrows(() => tracker.checkCallDepth(val), ValidationFailedError);
  }

  // Floating point numbers must fail validation
  for (const val of ["1.5", "7.9", "0.0", "8.0"]) {
    assertThrows(() => tracker.checkCallDepth(val), ValidationFailedError);
  }

  // Whitespace and escape characters must fail validation
  for (const val of [" 8 ", "\t8\n", " 8", "8 ", "\r\n8", "8\0"]) {
    assertThrows(() => tracker.checkCallDepth(val), ValidationFailedError);
  }

  // Non-decimal encodings and scientific notation must fail validation
  for (const val of ["0x8", "0b1000", "1e1", "8e0", "+8"]) {
    assertThrows(() => tracker.checkCallDepth(val), ValidationFailedError);
  }

  // Header smuggling and delimiters must fail validation
  for (const val of ["8, 1", "8; depth=8", "8\r\nInjected: true", "8\n8"]) {
    assertThrows(() => tracker.checkCallDepth(val), ValidationFailedError);
  }

  // Giant integers and overflow values must exceed call depth
  for (
    const val of ["99999999999999999999999999999999999999", "9".repeat(400)]
  ) {
    assertThrows(() => tracker.checkCallDepth(val), CallDepthExceededError);
  }

  // Octal-like notation: "010" is parsed as decimal 10, nextHop 11 > 8 -> throws CallDepthExceededError
  assertThrows(() => tracker.checkCallDepth("010"), CallDepthExceededError);

  // Leading zeros: "01" parses as decimal 1 -> next hop 2; "008" parses as decimal 8 -> next hop 9 > 8 -> throws
  assertEquals(tracker.checkCallDepth("01"), 2);
  assertThrows(() => tracker.checkCallDepth("008"), CallDepthExceededError);
  assertEquals(tracker.checkCallDepth("0"), 1);
});

Deno.test("FN-5 (Security): Multi-byte UTF-8 character boundary truncation produces strictly valid Unicode", () => {
  // spec: contracts/functions.contract.md#FN-5
  const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
  const sampleStrings = [
    "hello world",
    "こんにちは世界",
    "🦀🔥🚀✨🎉",
    "a🦀b🔥c🚀d",
    "€€€€€€",
    "𠮷野家",
    "a".repeat(100),
    "\uD83D\uDE00".repeat(10),
  ];

  for (const str of sampleStrings) {
    for (let max = 0; max <= 30; max++) {
      const tracker = createInvocationTracker({ maxLogBytes: max });
      const res = tracker.appendLog(str);
      const logPart = res.truncated
        ? res.output.slice(0, res.output.length - LOG_TRUNCATED_MARKER.length)
        : res.output;

      const bytes = new TextEncoder().encode(logPart);
      // Byte length must never exceed max
      assertEquals(
        bytes.byteLength <= max,
        true,
        `Truncated output byteLength (${bytes.byteLength}) must not exceed maxLogBytes (${max})`,
      );

      // Must be valid UTF-8 without throwing decoding errors
      fatalDecoder.decode(bytes);

      // Must not end in an orphaned high surrogate
      if (logPart.length > 0) {
        const lastCode = logPart.charCodeAt(logPart.length - 1);
        const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
        assertEquals(
          isHighSurrogate,
          false,
          `Output must not end in dangling high surrogate: ${logPart}`,
        );
      }
    }
  }
});

Deno.test("FN-5 (Security): Giant single chunk (10MB) is safely truncated without unbounded memory consumption", () => {
  // spec: contracts/functions.contract.md#FN-5
  const tracker = createInvocationTracker();
  const giantChunk = "x".repeat(10_000_000); // 10MB chunk

  const res1 = tracker.appendLog(giantChunk);
  assertEquals(res1.truncated, true);
  assertEquals(
    res1.output.length,
    DEFAULT_MAX_LOG_BYTES + LOG_TRUNCATED_MARKER.length,
  );
  assertEquals(res1.output.endsWith(LOG_TRUNCATED_MARKER), true);

  // Subsequent logs are immediately suppressed with zero allocation
  const res2 = tracker.appendLog("subsequent message");
  assertEquals(res2.truncated, true);
  assertEquals(res2.output, "");
});

Deno.test("FN-6 (Security): Warm-isolate reuse across sequential invocations resets all quotas", () => {
  // spec: contracts/functions.contract.md#FN-6
  // Simulate 10 sequential invocations executing in the same isolate context
  for (let invocation = 1; invocation <= 10; invocation++) {
    const tracker = createInvocationTracker();

    // In each invocation, exhaust all quotas
    for (let i = 0; i < DEFAULT_MAX_KV_OPS; i++) tracker.recordKvOp();
    assertThrows(() => tracker.recordKvOp(), RateLimitedError);

    for (let i = 0; i < DEFAULT_MAX_OBJECT_OPS; i++) tracker.recordObjectOp();
    assertThrows(() => tracker.recordObjectOp(), RateLimitedError);

    for (let i = 0; i < DEFAULT_MAX_QUEUE_OPS; i++) tracker.recordQueueOp();
    assertThrows(() => tracker.recordQueueOp(), RateLimitedError);

    const logRes = tracker.appendLog("x".repeat(DEFAULT_MAX_LOG_BYTES + 10));
    assertEquals(logRes.truncated, true);

    // Call depth limit check operates consistently
    assertEquals(tracker.checkCallDepth("7"), DEFAULT_MAX_CALL_DEPTH);
    assertThrows(() => tracker.checkCallDepth("8"), CallDepthExceededError);
  }
});

// ============================================================================
// Integration: Context Bindings Wrapping (FN-4, FN-5)
// ============================================================================

Deno.test("FN-4 / FN-5 (Integration): Wrapping KVBinding with InvocationTracker enforces 1,000 op limit", async () => {
  // spec: contracts/functions.contract.md#FN-4
  // spec: contracts/functions.contract.md#FN-5
  // Tests required: Integration — wrapping context bindings with invocation trackers under sequential operations
  const tracker: InvocationTracker = createInvocationTracker();

  let underlyingStoreOps = 0;
  const mockKV: KVBinding = {
    get: (_key: string[]) => {
      underlyingStoreOps++;
      return Promise.resolve("val");
    },
    set: (_key: string[], _value: unknown) => {
      underlyingStoreOps++;
      return Promise.resolve();
    },
    delete: (_key: string[]) => {
      underlyingStoreOps++;
      return Promise.resolve();
    },
    list: (_prefix: string[]) => {
      underlyingStoreOps++;
      return Promise.resolve({ keys: [] });
    },
    atomic: () => {
      underlyingStoreOps++;
      return {} as unknown as ReturnType<KVBinding["atomic"]>;
    },
  };

  // Create wrapped binding that records operations against the tracker
  const wrappedKV: KVBinding = {
    get: (key) => {
      tracker.recordKvOp();
      return mockKV.get(key);
    },
    set: (key, val, opts) => {
      tracker.recordKvOp();
      return mockKV.set(key, val, opts);
    },
    delete: (key) => {
      tracker.recordKvOp();
      return mockKV.delete(key);
    },
    list: (prefix, opts) => {
      tracker.recordKvOp();
      return mockKV.list(prefix, opts);
    },
    atomic: () => {
      tracker.recordKvOp();
      return mockKV.atomic();
    },
  };

  // Perform 1,000 operations across various methods
  for (let i = 1; i <= DEFAULT_MAX_KV_OPS; i++) {
    await wrappedKV.get(["items", `${i}`]);
  }
  assertEquals(underlyingStoreOps, DEFAULT_MAX_KV_OPS);

  // 1,001st operation throws RateLimitedError and does NOT reach the underlying store
  assertThrows(
    () => wrappedKV.get(["items", "overflow"]),
    RateLimitedError,
  );
  assertEquals(
    underlyingStoreOps,
    DEFAULT_MAX_KV_OPS,
    "Underlying store must not be called when operation limit is exceeded",
  );
});

Deno.test("FN-4 / FN-5 (Integration): Wrapping ObjectBinding with InvocationTracker enforces 100 op limit", async () => {
  // spec: contracts/functions.contract.md#FN-4
  // spec: contracts/functions.contract.md#FN-5
  const tracker: InvocationTracker = createInvocationTracker();

  let underlyingObjectOps = 0;
  const mockObjects: ObjectBinding = {
    put: (_key, _data) => {
      underlyingObjectOps++;
      return Promise.resolve({ etag: "etag1" });
    },
    get: (_key) => {
      underlyingObjectOps++;
      return Promise.resolve(null);
    },
    delete: (_key) => {
      underlyingObjectOps++;
      return Promise.resolve();
    },
    head: (_key) => {
      underlyingObjectOps++;
      return Promise.resolve({ size: 100, etag: "etag1" });
    },
    list: (_prefix, _opts) => {
      underlyingObjectOps++;
      return Promise.resolve({ keys: [] });
    },
    presign: (_key, _opts) => {
      underlyingObjectOps++;
      return Promise.resolve({ url: "https://example.com", expiresAt: 12345 });
    },
    createMultipartUpload: (_key) => {
      underlyingObjectOps++;
      return Promise.resolve({ uploadId: "up1" });
    },
  };

  const wrappedObjects: ObjectBinding = {
    put: (key, data) => {
      tracker.recordObjectOp();
      return mockObjects.put(key, data);
    },
    get: (key) => {
      tracker.recordObjectOp();
      return mockObjects.get(key);
    },
    delete: (key) => {
      tracker.recordObjectOp();
      return mockObjects.delete(key);
    },
    head: (key) => {
      tracker.recordObjectOp();
      return mockObjects.head(key);
    },
    list: (prefix, opts) => {
      tracker.recordObjectOp();
      return mockObjects.list(prefix, opts);
    },
    presign: (key, opts) => {
      tracker.recordObjectOp();
      return mockObjects.presign(key, opts);
    },
    createMultipartUpload: (key) => {
      tracker.recordObjectOp();
      return mockObjects.createMultipartUpload(key);
    },
  };

  // Perform 100 operations
  for (let i = 1; i <= DEFAULT_MAX_OBJECT_OPS; i++) {
    await wrappedObjects.head(`obj_${i}`);
  }
  assertEquals(underlyingObjectOps, DEFAULT_MAX_OBJECT_OPS);

  // 101st operation throws RateLimitedError and does not touch underlying store
  assertThrows(
    () => wrappedObjects.head("overflow"),
    RateLimitedError,
  );
  assertEquals(underlyingObjectOps, DEFAULT_MAX_OBJECT_OPS);
});

Deno.test("FN-4 / FN-5 (Integration): Wrapping QueueBinding with InvocationTracker enforces 100 op limit", async () => {
  // spec: contracts/functions.contract.md#FN-4
  // spec: contracts/functions.contract.md#FN-5
  const tracker: InvocationTracker = createInvocationTracker();

  let underlyingQueueOps = 0;
  const mockQueues: QueueBinding = {
    send: (_body, _opts) => {
      underlyingQueueOps++;
      return Promise.resolve({ id: "msg_1" });
    },
    sendBatch: (_bodies) => {
      underlyingQueueOps++;
      return Promise.resolve([{ id: "msg_1" }]);
    },
    receive: (_opts) => {
      underlyingQueueOps++;
      return Promise.resolve(null);
    },
    ack: (_id) => {
      underlyingQueueOps++;
      return Promise.resolve();
    },
  };

  const wrappedQueues: QueueBinding = {
    send: (body, opts) => {
      tracker.recordQueueOp();
      return mockQueues.send(body, opts);
    },
    sendBatch: (bodies) => {
      tracker.recordQueueOp();
      return mockQueues.sendBatch(bodies);
    },
    receive: (opts) => {
      tracker.recordQueueOp();
      return mockQueues.receive(opts);
    },
    ack: (id) => {
      tracker.recordQueueOp();
      return mockQueues.ack(id);
    },
  };

  // Perform 100 operations
  for (let i = 1; i <= DEFAULT_MAX_QUEUE_OPS; i++) {
    await wrappedQueues.send({ task: i });
  }
  assertEquals(underlyingQueueOps, DEFAULT_MAX_QUEUE_OPS);

  // 101st operation throws RateLimitedError and does not reach underlying queue
  assertThrows(
    () => wrappedQueues.send({ task: "overflow" }),
    RateLimitedError,
  );
  assertEquals(underlyingQueueOps, DEFAULT_MAX_QUEUE_OPS);
});
