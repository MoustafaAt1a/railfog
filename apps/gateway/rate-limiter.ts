/**
 * Multi-Tenant Token Bucket Rate Limiter.
 *
 * Spec references:
 * - contracts/platform.contract.md#PLAT-9: Rate limiting: token bucket algorithm, tier limits, retry-after formula.
 * - contracts/platform.contract.md#PLAT-12: Error model: 429 RATE_LIMITED with Retry-After.
 * - contracts/platform.contract.md#PLAT-18: Resource hierarchy and tenant/scope isolation.
 * - tasks/milestone-0.6-public-beta/T-0602-ingress-rate-limiter.md: AC1 - AC5.
 */

export type RateLimitScope = "ip" | "identity" | "project";

export interface RateLimitBucketConfig {
  rate: number; // tokens per second
  burst: number; // maximum burst capacity
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetMs: number;
  retryAfterSeconds?: number;
}

/**
 * Conversion factor between seconds and milliseconds.
 */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Token cost consumed per single request check.
 * spec: contracts/platform.contract.md#PLAT-9
 */
const TOKEN_COST_PER_REQUEST = 1;

/**
 * Default maximum idle duration in milliseconds before an inactive bucket is pruned.
 * tasks/milestone-0.6-public-beta/T-0602-ingress-rate-limiter.md
 */
const DEFAULT_MAX_IDLE_MS = 60_000;

/**
 * Default rate limit tier configurations.
 * spec: contracts/platform.contract.md#PLAT-9 — Anonymous/IP: 10 req/s, burst 20.
 * spec: contracts/platform.contract.md#PLAT-9 — Identity (API token): 50 req/s, burst 100.
 * spec: contracts/platform.contract.md#PLAT-9 — Project: 200 req/s, burst 400.
 */
export const DEFAULT_RATE_LIMITS: Record<
  RateLimitScope,
  RateLimitBucketConfig
> = Object.freeze({
  ip: Object.freeze({ rate: 10, burst: 20 }),
  identity: Object.freeze({ rate: 50, burst: 100 }),
  project: Object.freeze({ rate: 200, burst: 400 }),
});

/**
 * Internal state maintained per active token bucket.
 */
interface RateLimitBucketState {
  tokens: number;
  lastRefillTime: number;
  lastAccessTime: number;
}

/**
 * High-performance in-memory multi-tenant token bucket rate limiter.
 *
 * Enforces per-scope and per-tenant rate limits with burst allowance and
 * precise Retry-After calculation according to PLAT-9, PLAT-12, and PLAT-18.
 */
export class MultiTenantRateLimiter {
  private readonly configs: Record<RateLimitScope, RateLimitBucketConfig>;
  private readonly buckets: Map<string, RateLimitBucketState> = new Map();

  constructor(
    customConfigs?: Partial<Record<RateLimitScope, RateLimitBucketConfig>>,
  ) {
    // spec: contracts/platform.contract.md#PLAT-9 — Default tier limits preserved unless overridden
    this.configs = {
      ip: customConfigs?.ip ?? DEFAULT_RATE_LIMITS.ip,
      identity: customConfigs?.identity ?? DEFAULT_RATE_LIMITS.identity,
      project: customConfigs?.project ?? DEFAULT_RATE_LIMITS.project,
    };
  }

  /**
   * Evaluate request allowance under token bucket rate limiting.
   *
   * @param scope Target rate limiting scope ("ip" | "identity" | "project")
   * @param key Distinct identifier for the scope (e.g. IP address, API token ID, project ID)
   * @param now Current timestamp in milliseconds (defaults to Date.now())
   * @returns RateLimitDecision indicating whether request is allowed and remaining capacity
   */
  check(
    scope: RateLimitScope,
    key: string,
    now: number = Date.now(),
  ): RateLimitDecision {
    const config = this.configs[scope] ?? DEFAULT_RATE_LIMITS[scope];

    // spec: contracts/platform.contract.md#PLAT-18 — Map key format ${scope}:${key} ensures complete tenant/scope isolation
    const bucketKey = `${scope}:${key}`;
    let bucket = this.buckets.get(bucketKey);

    if (!bucket) {
      // spec: contracts/platform.contract.md#PLAT-9 — Fresh bucket initialized with full burst capacity
      bucket = {
        tokens: config.burst,
        lastRefillTime: now,
        lastAccessTime: now,
      };
      this.buckets.set(bucketKey, bucket);
    } else {
      // spec: contracts/platform.contract.md#PLAT-9 — Refill formula: tokens(t) = min(burst, tokens(t-1) + rate * delta_t_seconds)
      const deltaSeconds = Math.max(
        0,
        (now - bucket.lastRefillTime) / MILLISECONDS_PER_SECOND,
      );
      bucket.tokens = Math.min(
        config.burst,
        bucket.tokens + config.rate * deltaSeconds,
      );
      bucket.lastRefillTime = now;
      bucket.lastAccessTime = now;
    }

    // spec: contracts/platform.contract.md#PLAT-9 — Allow request iff tokens >= 1, then tokens -= 1
    if (bucket.tokens >= TOKEN_COST_PER_REQUEST) {
      bucket.tokens -= TOKEN_COST_PER_REQUEST;
      const resetMs = Math.ceil(
        Math.max(0, (config.burst - bucket.tokens) / config.rate) *
          MILLISECONDS_PER_SECOND,
      );
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        limit: config.burst,
        resetMs,
      };
    }

    // spec: contracts/platform.contract.md#PLAT-9, contracts/platform.contract.md#PLAT-12 — Rejection: retryAfterSeconds = ceil((1 - tokens) / rate)
    const retryAfterSeconds = Math.ceil(
      (TOKEN_COST_PER_REQUEST - bucket.tokens) / config.rate,
    );
    const resetMs = Math.ceil(
      Math.max(0, (config.burst - bucket.tokens) / config.rate) *
        MILLISECONDS_PER_SECOND,
    );

    return {
      allowed: false,
      remaining: 0,
      limit: config.burst,
      resetMs,
      retryAfterSeconds,
    };
  }

  /**
   * Reset rate limit state for a specific scope and key.
   *
   * spec: contracts/platform.contract.md#PLAT-9
   * tasks/milestone-0.6-public-beta/T-0602-ingress-rate-limiter.md
   */
  reset(scope: RateLimitScope, key: string): void {
    // spec: contracts/platform.contract.md#PLAT-18 — Scoped deletion preserves other scopes and keys
    const bucketKey = `${scope}:${key}`;
    this.buckets.delete(bucketKey);
  }

  /**
   * Prune idle buckets that have been inactive longer than maxIdleMs.
   *
   * spec: contracts/platform.contract.md#PLAT-9
   * tasks/milestone-0.6-public-beta/T-0602-ingress-rate-limiter.md
   *
   * @param maxIdleMs Maximum inactive time in milliseconds before reclaiming a bucket
   * @param now Current timestamp in milliseconds (defaults to Date.now())
   * @returns Number of pruned bucket entries
   */
  prune(
    maxIdleMs: number = DEFAULT_MAX_IDLE_MS,
    now: number = Date.now(),
  ): number {
    let prunedCount = 0;
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastAccessTime > maxIdleMs) {
        this.buckets.delete(key);
        prunedCount++;
      }
    }
    return prunedCount;
  }
}
