/**
 * Comprehensive test suite for Decorrelated Jitter Retry Engine.
 *
 * Spec references:
 * - docs/contracts/queues.contract.md#Q-5 (Exponential backoff with decorrelated jitter, idempotency requirements, banned patterns)
 * - docs/contracts/queues.contract.md#Q-4 (Idempotency composition and deduplication)
 * - docs/contracts/kv.contract.md#KV-3 (Optimistic concurrency CAS & retry semantics)
 * - tasks/milestone-0.4-reliability/T-0401-decorrelated-jitter-retry-engine.md (AC1 - AC6, Tests required)
 * - docs/ANTIHALLUCINATION.md Rule 5 (Real elapsed time verification)
 */

import {
  assert,
  assertEquals,
  assertGreaterOrEqual,
  assertLessOrEqual,
  assertRejects,
} from "@std/assert";
import {
  calculateNextSleep,
  isIdempotentRetryAllowed,
  type RetryPolicyOptions,
  type RetryState,
  withRetry,
} from "../../packages/policy/retry.ts";

// ============================================================================
// Group 1: calculateNextSleep — Decorrelated Jitter Formula & Bounds (Q-5, AC1-AC3)
// ============================================================================

Deno.test("AC1 (Q-5): Given attempt 0, calculateNextSleep returns base (100ms default)", () => {
  // spec: contracts/queues.contract.md#Q-5 — sleep_0 = base (default 100 ms)
  const state: RetryState = { attempt: 0, lastSleepMs: 0 };
  const sleepMs = calculateNextSleep(state);
  assertEquals(sleepMs, 100, "Attempt 0 must return default baseMs of 100 ms");

  // Custom baseMs
  const customOptions: RetryPolicyOptions = { baseMs: 250 };
  const customSleepMs = calculateNextSleep(state, customOptions);
  assertEquals(
    customSleepMs,
    250,
    "Attempt 0 must return custom baseMs of 250 ms",
  );

  // Attempt 0 with non-zero lastSleepMs should still return baseMs
  const stateWithLastSleep: RetryState = { attempt: 0, lastSleepMs: 500 };
  assertEquals(
    calculateNextSleep(stateWithLastSleep, { baseMs: 150 }),
    150,
    "Attempt 0 always returns baseMs regardless of lastSleepMs",
  );
});

Deno.test("AC2 (Q-5): Given attempt n > 0 with lastSleepMs = 300 and randomUniform 0.5, returns 500 ms", () => {
  // spec: contracts/queues.contract.md#Q-5 — sleep_n = min(cap, random_uniform(base, sleep_(n-1) * 3))
  // min(20000, 100 + 0.5 * (900 - 100)) = 500 ms
  const state: RetryState = { attempt: 1, lastSleepMs: 300 };

  let recordedMin = -1;
  let recordedMax = -1;
  const deterministicRng = (min: number, max: number): number => {
    recordedMin = min;
    recordedMax = max;
    return min + 0.5 * (max - min);
  };

  const sleepMs = calculateNextSleep(state, {
    randomUniform: deterministicRng,
  });

  assertEquals(
    recordedMin,
    100,
    "randomUniform must be called with min = base (100)",
  );
  assertEquals(
    recordedMax,
    900,
    "randomUniform must be called with max = lastSleepMs * 3 (900)",
  );
  assertEquals(
    sleepMs,
    500,
    "Calculated sleep must equal 500 ms for uniform factor 0.5",
  );
});

Deno.test("AC3 (Q-5): Given lastSleepMs * 3 exceeding capMs, calculateNextSleep never exceeds capMs", () => {
  // spec: contracts/queues.contract.md#Q-5 — default cap = 20 s (20,000 ms)
  const state: RetryState = { attempt: 4, lastSleepMs: 10_000 };
  // 10,000 * 3 = 30,000 ms, which exceeds default cap 20,000 ms

  // Force RNG to return upper bound
  const maxRng = (_min: number, max: number): number => max;

  const sleepMs = calculateNextSleep(state, { randomUniform: maxRng });
  assertEquals(
    sleepMs,
    20_000,
    "Sleep duration must be capped at default capMs (20,000 ms)",
  );

  // Custom capMs = 5000 ms
  const customCapState: RetryState = { attempt: 2, lastSleepMs: 2_500 }; // 2,500 * 3 = 7,500 > 5,000
  const customCapSleep = calculateNextSleep(customCapState, {
    capMs: 5_000,
    randomUniform: maxRng,
  });
  assertEquals(
    customCapSleep,
    5_000,
    "Sleep duration must be capped at custom capMs (5,000 ms)",
  );
});

Deno.test("Tests Required 1: calculateNextSleep math verification across attempts 0 through 5 with deterministic RNG", () => {
  // spec: contracts/queues.contract.md#Q-5 — Decorrelated jitter progression across attempts 0-5
  const baseMs = 100;
  const capMs = 20_000;

  // Test lower bound: RNG returns min
  const minRng = (min: number, _max: number): number => min;
  // Test upper bound: RNG returns max
  const maxRng = (_min: number, max: number): number => max;
  // Test midpoint: RNG returns midpoint
  const midRng = (min: number, max: number): number => min + 0.5 * (max - min);

  let lastSleep = 0;
  for (let attempt = 0; attempt <= 5; attempt++) {
    const state: RetryState = { attempt, lastSleepMs: lastSleep };

    if (attempt === 0) {
      const sleep0 = calculateNextSleep(state, { baseMs, capMs });
      assertEquals(sleep0, 100, `Attempt 0 must equal baseMs (100)`);
      lastSleep = sleep0;
    } else {
      const minSleep = calculateNextSleep(state, {
        baseMs,
        capMs,
        randomUniform: minRng,
      });
      const maxSleep = calculateNextSleep(state, {
        baseMs,
        capMs,
        randomUniform: maxRng,
      });
      const midSleep = calculateNextSleep(state, {
        baseMs,
        capMs,
        randomUniform: midRng,
      });

      const expectedMax = Math.min(capMs, lastSleep * 3);
      const expectedMid = Math.min(
        capMs,
        baseMs + 0.5 * (lastSleep * 3 - baseMs),
      );

      assertEquals(
        minSleep,
        baseMs,
        `Attempt ${attempt} min bound must be baseMs`,
      );
      assertEquals(
        maxSleep,
        expectedMax,
        `Attempt ${attempt} max bound must be min(cap, lastSleep * 3)`,
      );
      assertEquals(
        midSleep,
        expectedMid,
        `Attempt ${attempt} mid value must match formula`,
      );

      assertGreaterOrEqual(midSleep, baseMs);
      assertLessOrEqual(midSleep, capMs);

      lastSleep = midSleep;
    }
  }
});

Deno.test("Tests Required 1: calculateNextSleep stochastic bounds with default Math.random generator", () => {
  // spec: contracts/queues.contract.md#Q-5 — Default randomUniform in [base, min(cap, lastSleep * 3)]
  const baseMs = 100;
  const capMs = 20_000;

  let lastSleep = 100;
  for (let attempt = 1; attempt <= 10; attempt++) {
    const state: RetryState = { attempt, lastSleepMs: lastSleep };

    // Run 50 samples for each attempt to verify bounds and variance
    const samples: number[] = [];
    for (let sample = 0; sample < 50; sample++) {
      const sleep = calculateNextSleep(state, { baseMs, capMs });
      assertGreaterOrEqual(sleep, baseMs, `Sample ${sample} must be >= baseMs`);
      assertLessOrEqual(sleep, capMs, `Sample ${sample} must be <= capMs`);
      assertLessOrEqual(
        sleep,
        Math.max(baseMs, lastSleep * 3),
        `Sample ${sample} must be <= lastSleep * 3`,
      );
      samples.push(sleep);
    }

    // Verify non-zero variance (not returning static/mocked number)
    const allSame = samples.every((v) => v === samples[0]);
    assertEquals(
      allSame,
      false,
      `Attempt ${attempt} samples should exhibit stochastic variance`,
    );

    lastSleep = samples[0];
  }
});

Deno.test("calculateNextSleep: Handles edge cases where lastSleepMs is smaller than baseMs", () => {
  // Edge case: if lastSleepMs = 10, lastSleepMs * 3 = 30 < baseMs (100)
  // The sleep range upper bound should not drop below baseMs
  const state: RetryState = { attempt: 1, lastSleepMs: 10 };
  const sleep = calculateNextSleep(state, { baseMs: 100 });
  assertGreaterOrEqual(
    sleep,
    100,
    "Sleep duration should never be less than baseMs",
  );
});

// ============================================================================
// Group 2: isIdempotentRetryAllowed — Q-5 Idempotency Rule & Banned Patterns
// ============================================================================

Deno.test("AC4 (Q-5): Given HTTP POST without Idempotency-Key, isIdempotentRetryAllowed returns false", () => {
  // spec: contracts/queues.contract.md#Q-5 — A bare POST without an idempotency key is retried by the caller's choice only, never silently by RailFog.
  // Audit Finding #4 / Q-5 banned pattern
  assertEquals(
    isIdempotentRetryAllowed("POST"),
    false,
    "Bare POST without headers must be rejected",
  );
  assertEquals(
    isIdempotentRetryAllowed("POST", {}),
    false,
    "POST with empty headers object must be rejected",
  );
  assertEquals(
    isIdempotentRetryAllowed("POST", { "Content-Type": "application/json" }),
    false,
    "POST without Idempotency-Key must be rejected",
  );
  assertEquals(
    isIdempotentRetryAllowed(
      "POST",
      new Headers({ "Content-Type": "application/json" }),
    ),
    false,
    "POST with Headers instance without Idempotency-Key must be rejected",
  );
  assertEquals(
    isIdempotentRetryAllowed("post"),
    false,
    "Lowercase 'post' without key must be rejected",
  );
});

Deno.test("AC5 (Q-5): Given HTTP GET, HEAD, or PUT with Idempotency-Key, isIdempotentRetryAllowed returns true", () => {
  // spec: contracts/queues.contract.md#Q-5 — Safe methods GET and HEAD are retry-eligible; PUT with Idempotency-Key is retry-eligible.
  assertEquals(
    isIdempotentRetryAllowed("GET"),
    true,
    "GET without headers is retry-eligible",
  );
  assertEquals(
    isIdempotentRetryAllowed("get"),
    true,
    "Lowercase 'get' is retry-eligible",
  );
  assertEquals(
    isIdempotentRetryAllowed("GET", {}),
    true,
    "GET with empty headers is retry-eligible",
  );
  assertEquals(
    isIdempotentRetryAllowed("HEAD"),
    true,
    "HEAD without headers is retry-eligible",
  );
  assertEquals(
    isIdempotentRetryAllowed("head"),
    true,
    "Lowercase 'head' is retry-eligible",
  );

  // PUT with Idempotency-Key
  assertEquals(
    isIdempotentRetryAllowed("PUT", { "Idempotency-Key": "req-uuid-1" }),
    true,
    "PUT with Idempotency-Key is retry-eligible",
  );
  assertEquals(
    isIdempotentRetryAllowed("put", { "Idempotency-Key": "req-uuid-1" }),
    true,
    "Lowercase 'put' with Idempotency-Key is retry-eligible",
  );
  assertEquals(
    isIdempotentRetryAllowed(
      "PUT",
      new Headers({ "Idempotency-Key": "req-uuid-1" }),
    ),
    true,
    "PUT with Headers instance having Idempotency-Key is retry-eligible",
  );
});

Deno.test("Tests Required 2: isIdempotentRetryAllowed PUT verification with and without Idempotency-Key", () => {
  // spec: contracts/queues.contract.md#Q-5 — PUT requires Idempotency-Key to be retry-eligible
  assertEquals(
    isIdempotentRetryAllowed("PUT"),
    false,
    "Bare PUT without headers must return false",
  );
  assertEquals(
    isIdempotentRetryAllowed("PUT", {}),
    false,
    "PUT with empty headers object must return false",
  );
  assertEquals(
    isIdempotentRetryAllowed("PUT", { "Authorization": "Bearer tok" }),
    false,
    "PUT without Idempotency-Key must return false",
  );
  assertEquals(
    isIdempotentRetryAllowed("PUT", new Headers()),
    false,
    "PUT with empty Headers instance must return false",
  );
  assertEquals(
    isIdempotentRetryAllowed("PUT", { "Idempotency-Key": "valid-key" }),
    true,
    "PUT with Idempotency-Key must return true",
  );
});

Deno.test("Tests Required 2: isIdempotentRetryAllowed POST with Idempotency-Key is allowed", () => {
  // spec: contracts/queues.contract.md#Q-5 — POST with Idempotency-Key is safe for retry
  assertEquals(
    isIdempotentRetryAllowed("POST", { "Idempotency-Key": "post-idemp-123" }),
    true,
    "POST with Idempotency-Key in Record must return true",
  );
  assertEquals(
    isIdempotentRetryAllowed(
      "POST",
      new Headers({ "Idempotency-Key": "post-idemp-123" }),
    ),
    true,
    "POST with Idempotency-Key in Headers must return true",
  );
});

Deno.test("isIdempotentRetryAllowed: Case-insensitive header lookup for Headers and plain Record", () => {
  // Header lookup must be case-insensitive per HTTP specifications (idempotency-key vs Idempotency-Key)
  const variants = [
    "idempotency-key",
    "Idempotency-Key",
    "IDEMPOTENCY-KEY",
    "Idempotency-key",
    "iDeMpOtEnCy-KeY",
  ];

  for (const headerName of variants) {
    // Test with plain Record
    const recordHeaders: Record<string, string> = {
      [headerName]: "unique-key-42",
    };
    assertEquals(
      isIdempotentRetryAllowed("POST", recordHeaders),
      true,
      `Record with header '${headerName}' must be recognized`,
    );
    assertEquals(
      isIdempotentRetryAllowed("PUT", recordHeaders),
      true,
      `Record with header '${headerName}' must be recognized for PUT`,
    );

    // Test with Headers instance
    const webHeaders = new Headers();
    webHeaders.set(headerName, "unique-key-42");
    assertEquals(
      isIdempotentRetryAllowed("POST", webHeaders),
      true,
      `Headers with '${headerName}' must be recognized`,
    );
    assertEquals(
      isIdempotentRetryAllowed("PUT", webHeaders),
      true,
      `Headers with '${headerName}' must be recognized for PUT`,
    );
  }
});

Deno.test("isIdempotentRetryAllowed: Empty or whitespace-only Idempotency-Key is rejected", () => {
  // An empty idempotency key provides no deduplication guarantee
  assertEquals(
    isIdempotentRetryAllowed("POST", { "Idempotency-Key": "" }),
    false,
    "Empty Idempotency-Key must return false",
  );
  assertEquals(
    isIdempotentRetryAllowed("POST", { "Idempotency-Key": "   " }),
    false,
    "Whitespace-only Idempotency-Key must return false",
  );
  assertEquals(
    isIdempotentRetryAllowed("PUT", { "Idempotency-Key": "" }),
    false,
    "PUT with empty Idempotency-Key must return false",
  );
});

Deno.test("isIdempotentRetryAllowed: Non-idempotent methods (PATCH, DELETE) without key return false", () => {
  // PATCH and DELETE without idempotency key cannot be automatically retried
  assertEquals(isIdempotentRetryAllowed("PATCH"), false);
  assertEquals(isIdempotentRetryAllowed("DELETE"), false);
  assertEquals(isIdempotentRetryAllowed("CONNECT"), false);
});

// ============================================================================
// Group 3: withRetry — Execution Loop, Attempt Counting, and Surfacing (AC6)
// ============================================================================

Deno.test("withRetry: Returns value immediately on first successful attempt", async () => {
  let callCount = 0;
  const result = await withRetry(async (attempt: number) => {
    await Promise.resolve();
    callCount++;
    assertEquals(typeof attempt, "number");
    return "success-data";
  });

  assertEquals(result, "success-data");
  assertEquals(
    callCount,
    1,
    "Operation must only be called once when it succeeds immediately",
  );
});

Deno.test("withRetry: Resolves after transient failures within maxAttempts", async () => {
  let callCount = 0;
  const recordedAttempts: number[] = [];

  const result = await withRetry(
    async (attempt: number) => {
      await Promise.resolve();
      callCount++;
      recordedAttempts.push(attempt);
      if (callCount < 3) {
        throw new Error(`Transient failure ${callCount}`);
      }
      return `recovered-on-${callCount}`;
    },
    { baseMs: 1, capMs: 10 },
  );

  assertEquals(result, "recovered-on-3");
  assertEquals(
    callCount,
    3,
    "Operation should have been attempted exactly 3 times",
  );
  assertEquals(recordedAttempts.length, 3);
});

Deno.test("AC6 (Q-5): Given operation failing 5 consecutive times, attempts exactly 5 times and throws final error", async () => {
  // spec: contracts/queues.contract.md#Q-5 — max attempts 5, then DLQ / surfaced failure. Infinite retries banned.
  let callCount = 0;
  const attemptsRecorded: number[] = [];
  const expectedError = new Error("Persistent service outage");

  await assertRejects(
    async () => {
      await withRetry(
        async (attempt: number) => {
          await Promise.resolve();
          callCount++;
          attemptsRecorded.push(attempt);
          throw expectedError;
        },
        { baseMs: 1, capMs: 5 }, // minimal delay for test execution speed
      );
    },
    Error,
    "Persistent service outage",
  );

  assertEquals(
    callCount,
    5,
    "Operation must attempt exactly 5 times (default maxAttempts) before exhausting",
  );
  assertEquals(
    attemptsRecorded.length,
    5,
    "Exactly 5 attempts must be recorded",
  );
});

Deno.test("Tests Required 3: withRetry custom maxAttempts boundary enforcement", async () => {
  // maxAttempts = 1 should fail immediately without any retries
  let singleCallCount = 0;
  await assertRejects(
    async () => {
      await withRetry(
        async () => {
          await Promise.resolve();
          singleCallCount++;
          throw new Error("Immediate failure");
        },
        { maxAttempts: 1, baseMs: 1 },
      );
    },
    Error,
    "Immediate failure",
  );
  assertEquals(
    singleCallCount,
    1,
    "With maxAttempts = 1, operation must execute exactly once",
  );

  // maxAttempts = 3 should fail after exactly 3 calls
  let tripleCallCount = 0;
  await assertRejects(
    async () => {
      await withRetry(
        async () => {
          await Promise.resolve();
          tripleCallCount++;
          throw new Error("Triple failure");
        },
        { maxAttempts: 3, baseMs: 1 },
      );
    },
    Error,
    "Triple failure",
  );
  assertEquals(
    tripleCallCount,
    3,
    "With maxAttempts = 3, operation must execute exactly 3 times",
  );
});

Deno.test("Tests Required 3: withRetry cancellation on shouldRetry returning false", async () => {
  // When shouldRetry returns false, the retry loop aborts immediately without exhausting maxAttempts
  let callCount = 0;
  const shouldRetryCalls: Array<{ err: unknown; attempt: number }> = [];

  class NonRetryableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "NonRetryableError";
    }
  }

  await assertRejects(
    async () => {
      await withRetry(
        async (_attempt: number) => {
          await Promise.resolve();
          callCount++;
          if (callCount === 2) {
            throw new NonRetryableError("Fatal client error 400 Bad Request");
          }
          throw new Error("Temporary network timeout");
        },
        {
          maxAttempts: 5,
          baseMs: 1,
          shouldRetry: (error: unknown, attempt: number) => {
            shouldRetryCalls.push({ err: error, attempt });
            return !(error instanceof NonRetryableError);
          },
        },
      );
    },
    NonRetryableError,
    "Fatal client error 400 Bad Request",
  );

  assertEquals(
    callCount,
    2,
    "Execution must abort immediately after shouldRetry returns false",
  );
  assertEquals(
    shouldRetryCalls.length,
    2,
    "shouldRetry must have been invoked for each failure",
  );
  assert(shouldRetryCalls[1].err instanceof NonRetryableError);
});

Deno.test("withRetry: Preserves error identity, custom properties, and async rejections", async () => {
  class CustomDomainError extends Error {
    readonly code = "KV_CAS_CONFLICT";
    readonly status = 409;
  }

  const customError = new CustomDomainError(
    "Optimistic concurrency check failed",
  );

  const thrownError = await assertRejects(
    async () => {
      await withRetry(
        async () => {
          await Promise.resolve();
          throw customError;
        },
        { maxAttempts: 2, baseMs: 1 },
      );
    },
    CustomDomainError,
  );

  assertEquals(
    thrownError,
    customError,
    "Surfaced error must match original thrown instance identity",
  );
  assertEquals(
    (thrownError as CustomDomainError).code,
    "KV_CAS_CONFLICT",
    "Custom error properties must be preserved",
  );
});

// ============================================================================
// Group 4: Integration — Delay Integration & Fake Timer Timing (Checklist Item 4)
// ============================================================================

Deno.test("Tests Required 4: withRetry async delay timing with fake/mock timers", async () => {
  // Intercept global setTimeout to verify exact delay scheduling without wall-clock blocking
  const scheduledDelays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;

  try {
    // Mock setTimeout: record sleep durations and invoke callback on next microtask
    globalThis.setTimeout = ((
      callback: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      scheduledDelays.push(ms ?? 0);
      return originalSetTimeout(callback, 0, ...args);
    }) as typeof globalThis.setTimeout;

    let calls = 0;
    const deterministicRng = (_min: number, _max: number) => 500;

    await assertRejects(
      async () => {
        await withRetry(
          async () => {
            await Promise.resolve();
            calls++;
            throw new Error(`Attempt ${calls} failed`);
          },
          {
            maxAttempts: 4,
            baseMs: 100,
            capMs: 20_000,
            randomUniform: deterministicRng,
          },
        );
      },
      Error,
      "Attempt 4 failed",
    );

    assertEquals(calls, 4, "Should have performed 4 total attempts");
    // Between 4 attempts, there should be exactly 3 delay calls
    assertEquals(
      scheduledDelays.length,
      3,
      "Should have scheduled 3 backoff sleeps between 4 attempts",
    );

    // Attempt 0 sleep (after 1st failure): sleep_0 = base = 100 ms
    assertEquals(
      scheduledDelays[0],
      100,
      "First sleep must equal baseMs (100 ms)",
    );
    // Subsequent sleeps: decorrelated jitter with RNG returning 500
    assertEquals(
      scheduledDelays[1],
      500,
      "Second sleep must match deterministic jitter calculation (500 ms)",
    );
    assertEquals(
      scheduledDelays[2],
      500,
      "Third sleep must match deterministic jitter calculation (500 ms)",
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

Deno.test("Integration (ANTIHALLUCINATION Rule 5): withRetry real elapsed time verification", async () => {
  // docs/ANTIHALLUCINATION.md Rule 5: real elapsed time verification without mocks
  const baseMs = 20;
  const start = performance.now();

  let calls = 0;
  await withRetry(
    async () => {
      await Promise.resolve();
      calls++;
      if (calls === 1) {
        throw new Error("Transient glitch to trigger 1 backoff delay");
      }
      return "ok";
    },
    { baseMs, capMs: 1000 },
  );

  const elapsed = performance.now() - start;
  assertEquals(calls, 2, "Operation must succeed on second attempt");
  assertGreaterOrEqual(
    elapsed,
    baseMs - 5, // 5ms tolerance for timer resolution
    `Real elapsed time (${elapsed}ms) must be at least baseMs (${baseMs}ms)`,
  );
});
