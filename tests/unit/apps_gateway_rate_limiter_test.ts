/**
 * Unit tests for MultiTenantRateLimiter.
 *
 * Spec references:
 * - contracts/platform.contract.md#PLAT-9: Rate limiting: token bucket algorithm, tier limits, retry-after formula.
 * - contracts/platform.contract.md#PLAT-12: Error model: 429 RATE_LIMITED.
 * - contracts/platform.contract.md#PLAT-18: Resource hierarchy and tenant isolation.
 * - tasks/milestone-0.6-public-beta/T-0602-ingress-rate-limiter.md: AC1 - AC5.
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  DEFAULT_RATE_LIMITS,
  MultiTenantRateLimiter,
  type RateLimitBucketConfig,
  type RateLimitDecision,
  type RateLimitScope,
} from "../../apps/gateway/rate-limiter.ts";

// ============================================================================
// 1. Default Rates & Constants (PLAT-9)
// ============================================================================

Deno.test("PLAT-9: DEFAULT_RATE_LIMITS matches exact spec configuration for all scopes", () => {
  // spec: contracts/platform.contract.md#PLAT-9 — Anonymous/IP: 10 req/s, burst 20
  const ipConfig: RateLimitBucketConfig = DEFAULT_RATE_LIMITS.ip;
  assertEquals(ipConfig.rate, 10);
  assertEquals(ipConfig.burst, 20);

  // spec: contracts/platform.contract.md#PLAT-9 — Identity (API token): 50 req/s, burst 100
  const identityConfig: RateLimitBucketConfig = DEFAULT_RATE_LIMITS.identity;
  assertEquals(identityConfig.rate, 50);
  assertEquals(identityConfig.burst, 100);

  // spec: contracts/platform.contract.md#PLAT-9 — Project: 200 req/s, burst 400
  const projectConfig: RateLimitBucketConfig = DEFAULT_RATE_LIMITS.project;
  assertEquals(projectConfig.rate, 200);
  assertEquals(projectConfig.burst, 400);

  // Verify all 3 scopes exist
  const scopes: RateLimitScope[] = ["ip", "identity", "project"];
  assertEquals(scopes.length, 3);
  for (const scope of scopes) {
    assertExists(DEFAULT_RATE_LIMITS[scope]);
  }
});

// ============================================================================
// 2. AC1: Normal Consumption & Burst Capacity (PLAT-9)
// ============================================================================

Deno.test("AC1 / PLAT-9 (Unit): Initial request on fresh bucket consumes 1 token and returns remaining = burst - 1", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  const limiter = new MultiTenantRateLimiter();
  const t0 = 1_000_000;

  // IP scope: burst 20 -> first request leaves 19 remaining
  const ipDecision: RateLimitDecision = limiter.check("ip", "192.168.1.1", t0);
  assertEquals(ipDecision.allowed, true);
  assertEquals(ipDecision.limit, 20);
  assertEquals(ipDecision.remaining, 19);
  assertEquals(ipDecision.retryAfterSeconds, undefined);
  assertEquals(ipDecision.resetMs >= 0, true);

  // Identity scope: burst 100 -> first request leaves 99 remaining
  const idDecision: RateLimitDecision = limiter.check(
    "identity",
    "token_abc123",
    t0,
  );
  assertEquals(idDecision.allowed, true);
  assertEquals(idDecision.limit, 100);
  assertEquals(idDecision.remaining, 99);
  assertEquals(idDecision.retryAfterSeconds, undefined);
  assertEquals(idDecision.resetMs >= 0, true);

  // Project scope: burst 400 -> first request leaves 399 remaining
  const projDecision: RateLimitDecision = limiter.check(
    "project",
    "proj_xyz789",
    t0,
  );
  assertEquals(projDecision.allowed, true);
  assertEquals(projDecision.limit, 400);
  assertEquals(projDecision.remaining, 399);
  assertEquals(projDecision.retryAfterSeconds, undefined);
  assertEquals(projDecision.resetMs >= 0, true);
});

Deno.test("AC1 / PLAT-9 (Unit): Consecutive checks consume exactly 1 token per check up to burst limit", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  const limiter = new MultiTenantRateLimiter();
  const t0 = 1_000_000;
  const ipKey = "192.168.1.2";

  // Consume all 20 tokens within the same millisecond (instantaneous burst)
  for (let i = 1; i <= 20; i++) {
    const decision = limiter.check("ip", ipKey, t0);
    assertEquals(decision.allowed, true, `Check #${i} should be allowed`);
    assertEquals(
      decision.remaining,
      20 - i,
      `Remaining after check #${i} should be ${20 - i}`,
    );
    assertEquals(decision.limit, 20);
    assertEquals(decision.retryAfterSeconds, undefined);
  }

  // Identity scope: consume all 100 tokens
  const idKey = "token_burst_test";
  for (let i = 1; i <= 100; i++) {
    const decision = limiter.check("identity", idKey, t0);
    assertEquals(
      decision.allowed,
      true,
      `Identity check #${i} should be allowed`,
    );
    assertEquals(decision.remaining, 100 - i);
    assertEquals(decision.limit, 100);
  }

  // Project scope: consume all 400 tokens
  const projKey = "proj_burst_test";
  for (let i = 1; i <= 400; i++) {
    const decision = limiter.check("project", projKey, t0);
    assertEquals(
      decision.allowed,
      true,
      `Project check #${i} should be allowed`,
    );
    assertEquals(decision.remaining, 400 - i);
    assertEquals(decision.limit, 400);
  }
});

// ============================================================================
// 3. AC2: Bucket Depletion & Retry-After Formula (PLAT-9, PLAT-12)
// ============================================================================

Deno.test("AC2 / PLAT-9 (Unit): Depleted bucket rejects (burst + 1)-th request with allowed: false", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  // spec: contracts/platform.contract.md#PLAT-12
  const limiter = new MultiTenantRateLimiter();
  const t0 = 1_000_000;

  // IP scope (burst: 20): deplete 20 tokens
  const ipKey = "192.168.2.1";
  for (let i = 0; i < 20; i++) {
    limiter.check("ip", ipKey, t0);
  }
  // 21st request
  const ipRejected = limiter.check("ip", ipKey, t0);
  assertEquals(ipRejected.allowed, false);
  assertEquals(ipRejected.remaining, 0);
  assertEquals(ipRejected.limit, 20);
  assertExists(ipRejected.retryAfterSeconds);
  assertEquals(ipRejected.retryAfterSeconds, 1);
  assertEquals(ipRejected.resetMs > 0, true);

  // Identity scope (burst: 100): deplete 100 tokens
  const idKey = "token_depleted";
  for (let i = 0; i < 100; i++) {
    limiter.check("identity", idKey, t0);
  }
  // 101st request
  const idRejected = limiter.check("identity", idKey, t0);
  assertEquals(idRejected.allowed, false);
  assertEquals(idRejected.remaining, 0);
  assertEquals(idRejected.limit, 100);
  assertExists(idRejected.retryAfterSeconds);
  assertEquals(idRejected.retryAfterSeconds, 1);

  // Project scope (burst: 400): deplete 400 tokens
  const projKey = "proj_depleted";
  for (let i = 0; i < 400; i++) {
    limiter.check("project", projKey, t0);
  }
  // 401st request
  const projRejected = limiter.check("project", projKey, t0);
  assertEquals(projRejected.allowed, false);
  assertEquals(projRejected.remaining, 0);
  assertEquals(projRejected.limit, 400);
  assertExists(projRejected.retryAfterSeconds);
  assertEquals(projRejected.retryAfterSeconds, 1);
});

Deno.test("AC2 / PLAT-9 (Unit): Retry-After strictly equals Math.ceil((1 - tokens) / rate) across scopes and fractional tokens", () => {
  // spec: contracts/platform.contract.md#PLAT-9 — Retry-After = ceil((1 - tokens) / rate)
  const limiter = new MultiTenantRateLimiter();
  const ipKey = "192.168.2.2";
  let currentTime = 1_000_000;

  // Deplete burst of 20
  for (let i = 0; i < 20; i++) {
    limiter.check("ip", ipKey, currentTime);
  }

  // Case 1: tokens = 0, rate = 10 -> ceil((1 - 0) / 10) = ceil(0.1) = 1
  const rej0 = limiter.check("ip", ipKey, currentTime);
  assertEquals(rej0.allowed, false);
  assertEquals(rej0.retryAfterSeconds, Math.ceil((1 - 0) / 10));
  assertEquals(rej0.retryAfterSeconds, 1);

  // Case 2: Advance time by 40ms -> tokens replenished = 10 * 0.04 = 0.4 tokens
  // ceil((1 - 0.4) / 10) = ceil(0.6 / 10) = ceil(0.06) = 1
  currentTime += 40;
  const rej1 = limiter.check("ip", ipKey, currentTime);
  assertEquals(rej1.allowed, false);
  assertEquals(rej1.retryAfterSeconds, Math.ceil((1 - 0.4) / 10));
  assertEquals(rej1.retryAfterSeconds, 1);

  // Case 3: Advance time by another 30ms (total 70ms from zero) -> tokens = 0.7 tokens
  // ceil((1 - 0.7) / 10) = ceil(0.3 / 10) = ceil(0.03) = 1
  currentTime += 30;
  const rej2 = limiter.check("ip", ipKey, currentTime);
  assertEquals(rej2.allowed, false);
  assertEquals(rej2.retryAfterSeconds, Math.ceil((1 - 0.7) / 10));
  assertEquals(rej2.retryAfterSeconds, 1);

  // Case 4: Verify with custom rate < 1 to verify non-1 ceil calculations
  // rate: 0.2 tokens/s (1 token every 5s), burst: 1
  const slowLimiter = new MultiTenantRateLimiter({
    ip: { rate: 0.2, burst: 1 },
  });
  // 1st request consumes the token
  slowLimiter.check("ip", "slow_client", 1_000_000);
  // 2nd request rejected at tokens = 0: ceil((1 - 0) / 0.2) = ceil(5) = 5
  const slowRej = slowLimiter.check("ip", "slow_client", 1_000_000);
  assertEquals(slowRej.allowed, false);
  assertEquals(slowRej.retryAfterSeconds, 5);

  // Case 5: Custom rate 0.5 tokens/s, tokens = 0.2 (elapsed 400ms)
  // ceil((1 - 0.2) / 0.5) = ceil(0.8 / 0.5) = ceil(1.6) = 2
  const halfLimiter = new MultiTenantRateLimiter({
    ip: { rate: 0.5, burst: 2 },
  });
  halfLimiter.check("ip", "half_client", 1_000_000);
  halfLimiter.check("ip", "half_client", 1_000_000); // depleted to 0
  // Advance 400ms: tokens = 0 + 0.5 * 0.4 = 0.2
  const halfRej = halfLimiter.check("ip", "half_client", 1_000_400);
  assertEquals(halfRej.allowed, false);
  assertEquals(halfRej.retryAfterSeconds, Math.ceil((1 - 0.2) / 0.5));
  assertEquals(halfRej.retryAfterSeconds, 2);
});

// ============================================================================
// 4. AC3: Token Replenishment Over Elapsed Time (PLAT-9)
// ============================================================================

Deno.test("AC3 / PLAT-9 (Unit): Tokens replenish according to min(burst, tokens(t-1) + rate * delta_t)", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  const limiter = new MultiTenantRateLimiter();
  const ipKey = "192.168.3.1";
  let currentTime = 1_000_000;

  // Deplete all 20 tokens at t0
  for (let i = 0; i < 20; i++) {
    limiter.check("ip", ipKey, currentTime);
  }
  assertEquals(limiter.check("ip", ipKey, currentTime).allowed, false);

  // Advance time by 500ms (0.5 seconds). At rate 10 req/s:
  // tokens = min(20, 0 + 10 * 0.5) = 5 tokens replenished
  currentTime += 500;

  // Should be able to consume exactly 5 requests
  for (let i = 1; i <= 5; i++) {
    const res = limiter.check("ip", ipKey, currentTime);
    assertEquals(
      res.allowed,
      true,
      `Replenished request #${i} of 5 should be allowed`,
    );
    assertEquals(res.remaining, 5 - i);
  }

  // 6th request at same timestamp is rejected (depleted)
  const rej = limiter.check("ip", ipKey, currentTime);
  assertEquals(rej.allowed, false);
});

Deno.test("AC3 / PLAT-9 (Unit): Fractional token accumulation requires >= 1 full token to allow request", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  const limiter = new MultiTenantRateLimiter();
  const ipKey = "192.168.3.2";
  let currentTime = 1_000_000;

  // Deplete burst of 20
  for (let i = 0; i < 20; i++) {
    limiter.check("ip", ipKey, currentTime);
  }

  // Advance 80ms: tokens = 10 * 0.08 = 0.8 tokens (< 1)
  currentTime += 80;
  const res80ms = limiter.check("ip", ipKey, currentTime);
  assertEquals(
    res80ms.allowed,
    false,
    "0.8 tokens < 1: request must be rejected",
  );

  // Advance another 20ms (total 100ms = 0.1s from empty): tokens = 0.8 + 10 * 0.02 = 1.0 token
  currentTime += 20;
  const res100ms = limiter.check("ip", ipKey, currentTime);
  assertEquals(
    res100ms.allowed,
    true,
    "1.0 token >= 1: request must be allowed",
  );
  assertEquals(res100ms.remaining, 0);

  // Immediately following check at same timestamp has 0 tokens: rejected
  const resAfter = limiter.check("ip", ipKey, currentTime);
  assertEquals(resAfter.allowed, false);
});

Deno.test("AC3 / PLAT-9 (Unit): Refilled tokens are capped at burst capacity and never exceed it", () => {
  // spec: contracts/platform.contract.md#PLAT-9 — tokens(t) = min(burst, tokens(t-1) + rate * delta_t)
  const limiter = new MultiTenantRateLimiter();
  const ipKey = "192.168.3.3";
  let currentTime = 1_000_000;

  // Deplete burst
  for (let i = 0; i < 20; i++) {
    limiter.check("ip", ipKey, currentTime);
  }
  assertEquals(limiter.check("ip", ipKey, currentTime).allowed, false);

  // Advance time by 60 seconds (60,000ms).
  // At rate 10 req/s, 10 * 60 = 600 tokens would accumulate, but capped at burst = 20.
  currentTime += 60_000;

  // Exactly 20 requests allowed (burst capacity)
  for (let i = 1; i <= 20; i++) {
    const res = limiter.check("ip", ipKey, currentTime);
    assertEquals(
      res.allowed,
      true,
      `Request #${i} within burst cap must be allowed`,
    );
    assertEquals(res.remaining, 20 - i);
  }

  // 21st request must be rejected
  const res21 = limiter.check("ip", ipKey, currentTime);
  assertEquals(
    res21.allowed,
    false,
    "Request beyond burst capacity must be rejected",
  );
});

Deno.test("AC3 / PLAT-9 (Unit): check() defaults to system clock when now parameter is omitted", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  const limiter = new MultiTenantRateLimiter();
  const res = limiter.check("ip", "default_clock_client");
  assertEquals(res.allowed, true);
  assertEquals(res.remaining, 19);
  assertEquals(res.limit, 20);
});

// ============================================================================
// 5. AC4: Multi-Tenant and Scope Isolation (PLAT-18)
// ============================================================================

Deno.test("AC4 / PLAT-18 (Unit): Distinct keys within the same scope have isolated buckets", () => {
  // spec: contracts/platform.contract.md#PLAT-18
  const limiter = new MultiTenantRateLimiter();
  const t0 = 1_000_000;

  const clientA = "10.0.0.1";
  const clientB = "10.0.0.2";

  // Deplete clientA completely
  for (let i = 0; i < 20; i++) {
    limiter.check("ip", clientA, t0);
  }
  assertEquals(limiter.check("ip", clientA, t0).allowed, false);

  // clientB must have its full burst capacity intact
  const decisionB = limiter.check("ip", clientB, t0);
  assertEquals(decisionB.allowed, true);
  assertEquals(decisionB.remaining, 19);

  // Project isolation
  const projA = "proj_alpha";
  const projB = "proj_beta";
  for (let i = 0; i < 400; i++) {
    limiter.check("project", projA, t0);
  }
  assertEquals(limiter.check("project", projA, t0).allowed, false);

  const decisionProjB = limiter.check("project", projB, t0);
  assertEquals(decisionProjB.allowed, true);
  assertEquals(decisionProjB.remaining, 399);

  // Identity isolation
  const identA = "token_one";
  const identB = "token_two";
  for (let i = 0; i < 100; i++) {
    limiter.check("identity", identA, t0);
  }
  assertEquals(limiter.check("identity", identA, t0).allowed, false);

  const decisionIdentB = limiter.check("identity", identB, t0);
  assertEquals(decisionIdentB.allowed, true);
  assertEquals(decisionIdentB.remaining, 99);
});

Deno.test("AC4 / PLAT-18 (Unit): Same key under different scopes is completely isolated", () => {
  // spec: contracts/platform.contract.md#PLAT-18
  const limiter = new MultiTenantRateLimiter();
  const t0 = 1_000_000;
  const sharedKey = "shared_entity_42";

  // Deplete sharedKey under "ip" scope (burst: 20)
  for (let i = 0; i < 20; i++) {
    limiter.check("ip", sharedKey, t0);
  }
  assertEquals(limiter.check("ip", sharedKey, t0).allowed, false);

  // sharedKey under "identity" scope must not be affected
  const idDecision = limiter.check("identity", sharedKey, t0);
  assertEquals(idDecision.allowed, true);
  assertEquals(idDecision.remaining, 99);
  assertEquals(idDecision.limit, 100);

  // sharedKey under "project" scope must not be affected
  const projDecision = limiter.check("project", sharedKey, t0);
  assertEquals(projDecision.allowed, true);
  assertEquals(projDecision.remaining, 399);
  assertEquals(projDecision.limit, 400);
});

// ============================================================================
// 6. AC5: Inactive Bucket Pruning / GC (PLAT-9)
// ============================================================================

Deno.test("AC5 / PLAT-9 (Unit): prune(maxIdleMs, now) removes buckets inactive longer than maxIdleMs", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  const limiter = new MultiTenantRateLimiter();

  // Create two buckets at t = 1,000
  limiter.check("ip", "stale_client", 1_000);
  limiter.check("ip", "active_client", 1_000);

  // Touch active_client at t = 4,000
  limiter.check("ip", "active_client", 4_000);

  // At t = 5,000:
  // stale_client idle time = 5,000 - 1,000 = 4,000ms
  // active_client idle time = 5,000 - 4,000 = 1,000ms
  // Prune with maxIdleMs = 2,500
  const prunedCount = limiter.prune(2_500, 5_000);
  assertEquals(prunedCount, 1, "Exactly 1 stale bucket should be pruned");

  // Subsequent prune with same timestamp should prune 0 buckets
  const secondPrune = limiter.prune(2_500, 5_000);
  assertEquals(secondPrune, 0);

  // stale_client should start fresh with full capacity (remaining = 19 after consumption)
  const freshDecision = limiter.check("ip", "stale_client", 5_000);
  assertEquals(freshDecision.allowed, true);
  assertEquals(freshDecision.remaining, 19);

  // active_client was preserved
  const activeDecision = limiter.check("ip", "active_client", 5_000);
  assertEquals(activeDecision.allowed, true);
});

Deno.test("AC5 / PLAT-9 (Unit): prune() without arguments executes safely and returns non-negative count", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  const limiter = new MultiTenantRateLimiter();
  limiter.check("ip", "test_client");
  const pruned = limiter.prune();
  assertEquals(typeof pruned, "number");
  assertEquals(pruned >= 0, true);
});

// ============================================================================
// 7. Custom Configurations & Bucket Reset (PLAT-9)
// ============================================================================

Deno.test("PLAT-9 (Unit): MultiTenantRateLimiter accepts custom bucket configs and preserves defaults for omitted scopes", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  const limiter = new MultiTenantRateLimiter({
    ip: { rate: 2, burst: 5 },
  });
  const t0 = 1_000_000;

  // Custom IP scope: burst is 5
  for (let i = 1; i <= 5; i++) {
    const res = limiter.check("ip", "custom_ip_client", t0);
    assertEquals(res.allowed, true, `Custom request #${i} should be allowed`);
    assertEquals(res.limit, 5);
    assertEquals(res.remaining, 5 - i);
  }
  // 6th request rejected
  const rej = limiter.check("ip", "custom_ip_client", t0);
  assertEquals(rej.allowed, false);
  assertEquals(rej.limit, 5);

  // Omitted identity scope retains default (rate: 50, burst: 100)
  const idRes = limiter.check("identity", "default_identity_client", t0);
  assertEquals(idRes.allowed, true);
  assertEquals(idRes.limit, 100);
  assertEquals(idRes.remaining, 99);

  // Omitted project scope retains default (rate: 200, burst: 400)
  const projRes = limiter.check("project", "default_project_client", t0);
  assertEquals(projRes.allowed, true);
  assertEquals(projRes.limit, 400);
  assertEquals(projRes.remaining, 399);
});

Deno.test("PLAT-9 (Unit): reset(scope, key) resets bucket state immediately", () => {
  // spec: contracts/platform.contract.md#PLAT-9
  const limiter = new MultiTenantRateLimiter();
  const t0 = 1_000_000;
  const ipKeyA = "192.168.10.1";
  const ipKeyB = "192.168.10.2";

  // Deplete both clientA and clientB
  for (let i = 0; i < 20; i++) {
    limiter.check("ip", ipKeyA, t0);
    limiter.check("ip", ipKeyB, t0);
  }
  assertEquals(limiter.check("ip", ipKeyA, t0).allowed, false);
  assertEquals(limiter.check("ip", ipKeyB, t0).allowed, false);

  // Reset clientA only
  limiter.reset("ip", ipKeyA);

  // clientA should now be allowed with full capacity
  const resA = limiter.check("ip", ipKeyA, t0);
  assertEquals(resA.allowed, true);
  assertEquals(resA.remaining, 19);

  // clientB should still be depleted
  const resB = limiter.check("ip", ipKeyB, t0);
  assertEquals(resB.allowed, false);

  // Reset non-existent key does not throw
  limiter.reset("ip", "non_existent_key");

  // Resetting scope key does not affect other scopes with same key
  limiter.check("identity", "cross_scope_reset", t0);
  limiter.reset("ip", "cross_scope_reset");
  // Identity bucket state remains valid
  const idCheck = limiter.check("identity", "cross_scope_reset", t0);
  assertEquals(idCheck.allowed, true);
  assertEquals(idCheck.remaining, 98); // Was 99 after first check, now 98
});
