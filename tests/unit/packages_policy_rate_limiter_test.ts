/**
 * Tests for Token Bucket Rate Limiter and Concurrency Tracker.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md PLAT-9 (Rate limiting: token bucket & tiers)
 * - docs/contracts/platform.contract.md PLAT-12 (Error model: 429 RATE_LIMITED, Retry-After header, error response shape)
 * - docs/contracts/functions.contract.md FN-5 (Resource limits: concurrency limit default 50, hard kills)
 * - tasks/milestone-0.3-security/T-0302-token-bucket-rate-limiter.md (AC1 - AC5)
 */

import { assertEquals, assertExists, assertNotEquals } from "@std/assert";
import {
  type ConcurrencyResult,
  formatRateLimitRejection,
  RATE_LIMIT_TIERS,
  type RateLimitResult,
  type RateLimitScope,
  type RateLimitTierConfig,
  TokenBucketLimiter,
} from "../../packages/policy/rate-limiter.ts";

// ============================================================================
// AC1 & Tier Definitions: PLAT-9 Token Bucket Rate Limits & Burst Boundaries
// ============================================================================

Deno.test("PLAT-9: RATE_LIMIT_TIERS matches spec definitions exactly and adheres to tier interface", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  // IP: 10 req/s, burst 20
  const ipConfig: RateLimitTierConfig = RATE_LIMIT_TIERS.ip;
  assertEquals(ipConfig.rate, 10);
  assertEquals(ipConfig.burst, 20);

  // Identity: 50 req/s, burst 100
  const identityConfig: RateLimitTierConfig = RATE_LIMIT_TIERS.identity;
  assertEquals(identityConfig.rate, 50);
  assertEquals(identityConfig.burst, 100);

  // Project: 200 req/s, burst 400
  const projectConfig: RateLimitTierConfig = RATE_LIMIT_TIERS.project;
  assertEquals(projectConfig.rate, 200);
  assertEquals(projectConfig.burst, 400);

  // Validate scopes type checking
  const scopes: RateLimitScope[] = ["ip", "identity", "project"];
  assertEquals(scopes.length, 3);
});

Deno.test("AC1 (Unit): Burst of 21 requests from same IP evaluated by IP scope allows 20 and rejects 21st", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  // AC1: Given a burst of 21 requests from the same IP within 1 second, when evaluated by the IP scope
  // (rate: 10, burst: 20), then the first 20 requests are allowed and the 21st request is rejected
  // with allowed: false and a non-zero retryAfterSeconds.
  const currentTime = 1_000_000;
  const limiter = new TokenBucketLimiter({ nowProvider: () => currentTime });
  const ipKey = "192.168.1.100";

  // Requests 1 through 20: all within burst limit (burst: 20)
  for (let i = 1; i <= 20; i++) {
    const result: RateLimitResult = limiter.consume(ipKey, "ip");
    assertEquals(
      result.allowed,
      true,
      `Request #${i} within burst should be allowed`,
    );
    assertEquals(
      result.remaining,
      20 - i,
      `Remaining tokens after request #${i} should be ${20 - i}`,
    );
    assertEquals(
      result.retryAfterSeconds,
      undefined,
      `Allowed request #${i} should not have retryAfterSeconds`,
    );
  }

  // 21st request at same instant (tokens depleted to 0)
  const rejectedResult: RateLimitResult = limiter.consume(ipKey, "ip");
  assertEquals(
    rejectedResult.allowed,
    false,
    "21st request exceeding burst must be rejected",
  );
  assertEquals(
    rejectedResult.remaining,
    0,
    "Remaining tokens should be 0",
  );
  assertExists(
    rejectedResult.retryAfterSeconds,
    "Rejected request must include retryAfterSeconds",
  );
  assertNotEquals(
    rejectedResult.retryAfterSeconds,
    0,
    "retryAfterSeconds must be non-zero",
  );
  assertEquals(
    rejectedResult.retryAfterSeconds! > 0,
    true,
    "retryAfterSeconds must be positive",
  );
});

Deno.test("PLAT-9 (Unit): Identity scope burst boundary (rate: 50, burst: 100)", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  const currentTime = 2_000_000;
  const limiter = new TokenBucketLimiter({ nowProvider: () => currentTime });
  const apiKey = "api_key_ident_001";

  // Consume 100 requests (burst: 100)
  for (let i = 1; i <= 100; i++) {
    const res = limiter.consume(apiKey, "identity");
    assertEquals(res.allowed, true, `Identity request #${i} should be allowed`);
  }

  // 101st request should be rejected
  const rejected = limiter.consume(apiKey, "identity");
  assertEquals(
    rejected.allowed,
    false,
    "101st identity request must be rejected",
  );
  assertExists(rejected.retryAfterSeconds);
  assertEquals(rejected.retryAfterSeconds! > 0, true);
});

Deno.test("PLAT-9 (Unit): Project scope burst boundary (rate: 200, burst: 400)", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  const currentTime = 3_000_000;
  const limiter = new TokenBucketLimiter({ nowProvider: () => currentTime });
  const projKey = "proj_01J8Z00000";

  // Consume 400 requests (burst: 400)
  for (let i = 1; i <= 400; i++) {
    const res = limiter.consume(projKey, "project");
    assertEquals(res.allowed, true, `Project request #${i} should be allowed`);
  }

  // 401st request should be rejected
  const rejected = limiter.consume(projKey, "project");
  assertEquals(
    rejected.allowed,
    false,
    "401st project request must be rejected",
  );
  assertExists(rejected.retryAfterSeconds);
  assertEquals(rejected.retryAfterSeconds! > 0, true);
});

// ============================================================================
// AC2: retryAfterSeconds strictly equals Math.ceil((1 - tokens) / rate)
// ============================================================================

Deno.test("AC2 (Unit): retryAfterSeconds strictly equals Math.ceil((1 - tokens) / rate)", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  // AC2: Given a rejected request with remaining tokens < 1, when retryAfterSeconds is calculated,
  // then it strictly equals Math.ceil((1 - tokens) / rate).
  let currentTime = 1_000_000;
  const limiter = new TokenBucketLimiter({ nowProvider: () => currentTime });
  const ipKey = "192.168.2.1";

  // Deplete burst of 20 tokens
  for (let i = 0; i < 20; i++) {
    limiter.consume(ipKey, "ip");
  }

  // Case 1: tokens = 0, rate = 10 -> ceil((1 - 0) / 10) = ceil(0.1) = 1
  const res0 = limiter.consume(ipKey, "ip");
  assertEquals(res0.allowed, false);
  const expected0 = Math.ceil((1 - 0) / 10);
  assertEquals(res0.retryAfterSeconds, expected0);
  assertEquals(res0.retryAfterSeconds, 1);

  // Case 2: Advance time by 40ms -> tokens = 0 + 10 * 0.04 = 0.4 tokens
  // ceil((1 - 0.4) / 10) = ceil(0.6 / 10) = ceil(0.06) = 1
  currentTime += 40;
  const res1 = limiter.consume(ipKey, "ip");
  assertEquals(res1.allowed, false);
  const expected1 = Math.ceil((1 - 0.4) / 10);
  assertEquals(res1.retryAfterSeconds, expected1);
  assertEquals(res1.retryAfterSeconds, 1);

  // Case 3: Advance time by another 30ms -> total elapsed 70ms -> tokens = 0.7 tokens
  // ceil((1 - 0.7) / 10) = ceil(0.3 / 10) = ceil(0.03) = 1
  currentTime += 30;
  const res2 = limiter.consume(ipKey, "ip");
  assertEquals(res2.allowed, false);
  const expected2 = Math.ceil((1 - 0.7) / 10);
  assertEquals(res2.retryAfterSeconds, expected2);
  assertEquals(res2.retryAfterSeconds, 1);
});

// ============================================================================
// AC3: Token Replenishment Math & Boundaries
// ============================================================================

Deno.test("AC3 (Unit): Token replenishment formula tokens(t) = min(burst, tokens(t-1) + rate * Δt)", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  // AC3: Given depleted tokens for a key, when elapsed time Δt passes,
  // then tokens replenish according to min(burst, tokens(t-1) + rate * Δt).
  let currentTime = 1_000_000;
  const limiter = new TokenBucketLimiter({ nowProvider: () => currentTime });
  const ipKey = "192.168.3.1";

  // Deplete all 20 tokens at t = 1,000,000
  for (let i = 0; i < 20; i++) {
    limiter.consume(ipKey, "ip");
  }
  // Confirm depleted
  assertEquals(limiter.consume(ipKey, "ip").allowed, false);

  // Advance time by 500ms (0.5 seconds). At rate 10 req/s:
  // tokens = min(20, 0 + 10 * 0.5) = 5 tokens replenished
  currentTime += 500;

  // We should be able to consume exactly 5 requests
  for (let i = 1; i <= 5; i++) {
    const res = limiter.consume(ipKey, "ip");
    assertEquals(
      res.allowed,
      true,
      `Replenished request #${i} of 5 should be allowed`,
    );
  }

  // 6th request should be rejected (tokens depleted again)
  const rejected = limiter.consume(ipKey, "ip");
  assertEquals(
    rejected.allowed,
    false,
    "6th request should exceed replenished tokens",
  );
});

Deno.test("AC3 (Unit): Fractional token accumulation requires >= 1 full token to allow request", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  let currentTime = 1_000_000;
  const limiter = new TokenBucketLimiter({ nowProvider: () => currentTime });
  const ipKey = "192.168.4.1";

  // Deplete burst of 20
  for (let i = 0; i < 20; i++) {
    limiter.consume(ipKey, "ip");
  }

  // Advance 80ms: tokens = 10 * 0.08 = 0.8 tokens (fractional, < 1)
  currentTime += 80;
  const res80ms = limiter.consume(ipKey, "ip");
  assertEquals(
    res80ms.allowed,
    false,
    "0.8 tokens is < 1 token: request must not be allowed",
  );

  // Advance another 20ms (total 100ms = 0.1s from 0): tokens = 0.8 + 10 * 0.02 = 1.0 token
  currentTime += 20;
  const res100ms = limiter.consume(ipKey, "ip");
  assertEquals(
    res100ms.allowed,
    true,
    "1.0 token is >= 1 token: request must be allowed",
  );
  assertEquals(res100ms.remaining, 0);

  // Immediately next request: tokens = 0 (< 1), should be rejected
  const resImmediatelyAfter = limiter.consume(ipKey, "ip");
  assertEquals(resImmediatelyAfter.allowed, false);
});

Deno.test("AC3 (Unit): Burst boundary limit caps replenishment at burst capacity", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  // tokens(t) = min(burst, ...)
  let currentTime = 1_000_000;
  const limiter = new TokenBucketLimiter({ nowProvider: () => currentTime });
  const ipKey = "192.168.5.1";

  // Deplete burst
  for (let i = 0; i < 20; i++) {
    limiter.consume(ipKey, "ip");
  }
  assertEquals(limiter.consume(ipKey, "ip").allowed, false);

  // Advance time by 60 seconds (60,000ms). At rate 10 req/s, 10 * 60 = 600 tokens would be generated,
  // but burst cap for IP is 20.
  currentTime += 60_000;

  // We should be able to consume exactly 20 requests (burst cap), not 600.
  for (let i = 1; i <= 20; i++) {
    const res = limiter.consume(ipKey, "ip");
    assertEquals(
      res.allowed,
      true,
      `Request #${i} up to burst capacity (20) must be allowed`,
    );
  }

  // 21st request must be rejected
  const res21 = limiter.consume(ipKey, "ip");
  assertEquals(
    res21.allowed,
    false,
    "Request beyond burst capacity (21st) must be rejected even after long idle time",
  );
});

Deno.test("PLAT-9 (Unit): Replenishment math across Identity and Project tiers", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  let currentTime = 1_000_000;
  const limiter = new TokenBucketLimiter({ nowProvider: () => currentTime });

  // Identity tier: rate 50, burst 100
  const idKey = "ident_replenish_test";
  for (let i = 0; i < 100; i++) limiter.consume(idKey, "identity");
  assertEquals(limiter.consume(idKey, "identity").allowed, false);

  // Advance 1s (1000ms) -> 50 tokens replenished
  currentTime += 1000;
  for (let i = 1; i <= 50; i++) {
    assertEquals(
      limiter.consume(idKey, "identity").allowed,
      true,
      `Identity request #${i} of 50 should be allowed after 1s replenishment`,
    );
  }
  assertEquals(limiter.consume(idKey, "identity").allowed, false);

  // Project tier: rate 200, burst 400
  const projKey = "proj_replenish_test";
  for (let i = 0; i < 400; i++) limiter.consume(projKey, "project");
  assertEquals(limiter.consume(projKey, "project").allowed, false);

  // Advance 500ms (0.5s) -> 200 * 0.5 = 100 tokens replenished
  currentTime += 500;
  for (let i = 1; i <= 100; i++) {
    assertEquals(
      limiter.consume(projKey, "project").allowed,
      true,
      `Project request #${i} of 100 should be allowed after 0.5s replenishment`,
    );
  }
  assertEquals(limiter.consume(projKey, "project").allowed, false);
});

Deno.test("PLAT-9 (Unit): Key and scope isolation", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  const currentTime = 1_000_000;
  const limiter = new TokenBucketLimiter({ nowProvider: () => currentTime });

  const ip1 = "10.0.0.1";
  const ip2 = "10.0.0.2";

  // Deplete ip1
  for (let i = 0; i < 20; i++) limiter.consume(ip1, "ip");
  assertEquals(limiter.consume(ip1, "ip").allowed, false);

  // ip2 must still have full burst available
  assertEquals(limiter.consume(ip2, "ip").allowed, true);
  assertEquals(limiter.consume(ip2, "ip").remaining, 18);

  // Same key under different scopes is isolated
  const sharedKey = "scoped_key_1";
  for (let i = 0; i < 20; i++) limiter.consume(sharedKey, "ip");
  assertEquals(limiter.consume(sharedKey, "ip").allowed, false);

  // sharedKey under identity scope has its own bucket
  assertEquals(limiter.consume(sharedKey, "identity").allowed, true);
});

// ============================================================================
// AC4 & AC5: Concurrency Tracking (FN-5)
// ============================================================================

Deno.test("AC4 (Unit): Concurrency limit 50 allows 50 active calls and rejects 51st", () => {
  // spec: contracts/functions.contract.md#FN-5
  // AC4: Given a Function with concurrency limit 50, when 50 concurrent calls are active
  // and a 51st arrives, then acquireConcurrency returns allowed: false.
  const limiter = new TokenBucketLimiter();
  const fnKey = "fn_billing_charge";
  const maxConcurrency = 50;

  // Acquire 50 slots
  for (let i = 1; i <= maxConcurrency; i++) {
    const res: ConcurrencyResult = limiter.acquireConcurrency(
      fnKey,
      maxConcurrency,
    );
    assertEquals(
      res.allowed,
      true,
      `Concurrency acquire #${i} should be allowed`,
    );
    assertEquals(
      res.active,
      i,
      `Active count after acquire #${i} should be ${i}`,
    );
  }

  // 51st request must be rejected
  const rejected: ConcurrencyResult = limiter.acquireConcurrency(
    fnKey,
    maxConcurrency,
  );
  assertEquals(
    rejected.allowed,
    false,
    "51st concurrent acquire when maxConcurrency is 50 must be rejected",
  );
  assertEquals(
    rejected.active,
    50,
    "Active count should remain 50 when rejected",
  );
});

Deno.test("AC5 (Unit): releaseConcurrency decrements active count and permits subsequent acquires", () => {
  // spec: contracts/functions.contract.md#FN-5
  // AC5: Given an active concurrent execution that completes, when releaseConcurrency is called,
  // then the active concurrency count decrements and subsequent requests are permitted.
  const limiter = new TokenBucketLimiter();
  const fnKey = "fn_webhook_processor";
  const maxConcurrency = 50;

  // Fill concurrency to limit
  for (let i = 1; i <= maxConcurrency; i++) {
    limiter.acquireConcurrency(fnKey, maxConcurrency);
  }
  assertEquals(
    limiter.acquireConcurrency(fnKey, maxConcurrency).allowed,
    false,
  );

  // Release 1 slot
  limiter.releaseConcurrency(fnKey);

  // Subsequent acquire should now succeed
  const permitted = limiter.acquireConcurrency(fnKey, maxConcurrency);
  assertEquals(
    permitted.allowed,
    true,
    "Acquire following releaseConcurrency must be permitted",
  );
  assertEquals(
    permitted.active,
    50,
    "Active count should be 50 after re-acquiring freed slot",
  );

  // Releasing multiple slots decrements active count accordingly
  limiter.releaseConcurrency(fnKey);
  limiter.releaseConcurrency(fnKey);
  limiter.releaseConcurrency(fnKey);

  const res1 = limiter.acquireConcurrency(fnKey, maxConcurrency);
  assertEquals(res1.allowed, true);
  assertEquals(res1.active, 48);
});

Deno.test("FN-5 (Unit): Concurrency tracking underflow protection and function isolation", () => {
  // spec: contracts/functions.contract.md#FN-5
  const limiter = new TokenBucketLimiter();
  const fnA = "fn_alpha";
  const fnB = "fn_beta";

  // Releasing when count is 0 does not underflow below 0
  limiter.releaseConcurrency(fnA);
  const acq = limiter.acquireConcurrency(fnA, 10);
  assertEquals(acq.allowed, true);
  assertEquals(acq.active, 1);

  // Concurrency tracking between fnA and fnB is completely isolated
  for (let i = 0; i < 9; i++) limiter.acquireConcurrency(fnA, 10);
  assertEquals(limiter.acquireConcurrency(fnA, 10).allowed, false);

  // fnB is unaffected by fnA reaching concurrency limit
  const bAcq = limiter.acquireConcurrency(fnB, 10);
  assertEquals(bAcq.allowed, true);
  assertEquals(bAcq.active, 1);
});

Deno.test("FN-5 (Integration): Concurrency acquire/release tracking under concurrent execution workflows", async () => {
  // spec: contracts/functions.contract.md#FN-5
  // Tests required: Integration — verify concurrency acquire and release tracking under concurrent execution workflows
  const limiter = new TokenBucketLimiter();
  const fnKey = "fn_worker_integration";
  const maxConcurrency = 10;
  const totalTasks = 50;

  let currentPeakConcurrency = 0;
  let successCount = 0;
  let rejectedCount = 0;

  const runTask = async (_taskId: number): Promise<void> => {
    const acquireResult = limiter.acquireConcurrency(fnKey, maxConcurrency);
    if (!acquireResult.allowed) {
      rejectedCount++;
      return;
    }

    // Allowed: verify invariants
    if (acquireResult.active > currentPeakConcurrency) {
      currentPeakConcurrency = acquireResult.active;
    }

    try {
      // Simulate asynchronous execution work
      await new Promise((resolve) => setTimeout(resolve, 5));
      successCount++;
    } finally {
      limiter.releaseConcurrency(fnKey);
    }
  };

  // Launch tasks in parallel
  const tasks = Array.from({ length: totalTasks }, (_, i) => runTask(i));
  await Promise.all(tasks);

  // Verify peak concurrency never exceeded the limit
  assertEquals(
    currentPeakConcurrency <= maxConcurrency,
    true,
    `Peak concurrency (${currentPeakConcurrency}) must not exceed maxConcurrency (${maxConcurrency})`,
  );
  // Verify all tasks were either successfully executed or rejected
  assertEquals(successCount + rejectedCount, totalTasks);
  // After all tasks finish and release, active count should be 0 (next acquire gives active: 1)
  const finalAcquire = limiter.acquireConcurrency(fnKey, maxConcurrency);
  assertEquals(finalAcquire.allowed, true);
  assertEquals(finalAcquire.active, 1);
  limiter.releaseConcurrency(fnKey);
});

// ============================================================================
// Rejection Formatting: PLAT-12 & PLAT-9 (429, Retry-After, RATE_LIMITED)
// ============================================================================

Deno.test("PLAT-12 / PLAT-9 (Unit): formatRateLimitRejection returns HTTP 429 Response with Retry-After header and RATE_LIMITED error code", async () => {
  // spec: contracts/platform.contract.md#PLAT-9
  // spec: contracts/platform.contract.md#PLAT-12
  const retryAfterSeconds = 5;
  const response = formatRateLimitRejection(retryAfterSeconds);

  // Must be an instance of Web standard Response
  assertEquals(response instanceof Response, true);

  // Status must be 429
  assertEquals(response.status, 429);

  // Retry-After header must match retryAfterSeconds as string
  assertEquals(response.headers.get("Retry-After"), "5");

  // Content-Type must be application/json
  const contentType = response.headers.get("content-type");
  assertExists(contentType);
  assertEquals(contentType.includes("application/json"), true);

  // Body must conform to PLAT-12 error shape: {"error": {"code": "RATE_LIMITED", "message": "..."}}
  const body = await response.json();
  assertExists(body.error);
  assertEquals(body.error.code, "RATE_LIMITED");
  assertExists(body.error.message);
  assertEquals(typeof body.error.message, "string");
  assertEquals(body.error.request_id, undefined);
});

Deno.test("PLAT-12 / PLAT-9 (Unit): formatRateLimitRejection includes request_id when provided", async () => {
  // spec: contracts/platform.contract.md#PLAT-12
  // spec: contracts/platform.contract.md#PLAT-14
  const retryAfterSeconds = 12;
  const requestId = "req_01J8Z000000000000000000000";
  const response = formatRateLimitRejection(retryAfterSeconds, requestId);

  assertEquals(response.status, 429);
  assertEquals(response.headers.get("Retry-After"), "12");

  const body = await response.json();
  assertExists(body.error);
  assertEquals(body.error.code, "RATE_LIMITED");
  assertEquals(body.error.request_id, requestId);
});

// ============================================================================
// Default Clock Provider: Date.now()
// ============================================================================

Deno.test("TokenBucketLimiter defaults to Date.now() when nowProvider is omitted", () => {
  const limiter = new TokenBucketLimiter();
  const res = limiter.consume("127.0.0.1", "ip");
  assertEquals(res.allowed, true);
  assertEquals(res.remaining, 19);
});

Deno.test("PLAT-9 (Unit): TokenBucketLimiter prune removes idle buckets while preserving capacity on fresh access", () => {
  let currentTime = 1_000_000;
  const limiter = new TokenBucketLimiter({ nowProvider: () => currentTime });

  limiter.consume("active_ip", "ip");
  limiter.consume("idle_ip", "ip");

  // Advance time beyond idle threshold (60s = 60,000ms)
  currentTime += 70_000;

  // Active key is accessed again, resetting its timestamp
  limiter.consume("active_ip", "ip");

  const pruned = limiter.prune(60_000, currentTime);
  assertEquals(pruned, 1, "Should prune exactly the 1 idle bucket");

  // Re-accessing the pruned key immediately gets full burst capacity
  const postPrune = limiter.consume("idle_ip", "ip");
  assertEquals(postPrune.allowed, true);
  assertEquals(postPrune.remaining, 19);
});
