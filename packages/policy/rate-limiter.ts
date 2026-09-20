/**
 * Token bucket rate limiter and concurrency tracker for RailFog policy layer.
 *
 * Spec references:
 * - contracts/platform.contract.md#PLAT-9: Rate limiting: token bucket algorithm and tier limits.
 * - contracts/platform.contract.md#PLAT-12: Error model: 429 RATE_LIMITED, Retry-After header.
 * - contracts/functions.contract.md#FN-5: Resource limits: concurrency tracking per Function.
 */

import { RateLimitedError, toErrorResponseBody } from "../errors/mod.ts";

// spec: contracts/platform.contract.md#PLAT-9 — Millisecond conversion for rate calculations
const MILLISECONDS_PER_SECOND = 1000;

// spec: contracts/platform.contract.md#PLAT-12 — HTTP 429 Too Many Requests status code
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;

export type RateLimitScope = "ip" | "identity" | "project";

export interface RateLimitTierConfig {
  rate: number;
  burst: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

export interface ConcurrencyResult {
  allowed: boolean;
  active: number;
}

export interface TokenBucketLimiterOptions {
  nowProvider?: () => number;
}

export interface TokenBucketLimiter {
  consume(key: string, scope: RateLimitScope): RateLimitResult;
  acquireConcurrency(fnKey: string, maxConcurrency: number): ConcurrencyResult;
  releaseConcurrency(fnKey: string): void;
}

/**
 * Tier configurations defining token replenishment rates and burst capacities per scope.
 * spec: contracts/platform.contract.md#PLAT-9
 */
export const RATE_LIMIT_TIERS: Record<RateLimitScope, RateLimitTierConfig> = {
  ip: {
    rate: 10,
    burst: 20,
  },
  identity: {
    rate: 50,
    burst: 100,
  },
  project: {
    rate: 200,
    burst: 400,
  },
};

interface TokenBucketState {
  tokens: number;
  lastReplenishedAt: number;
}

/**
 * In-memory Token Bucket rate limiter and concurrency tracking implementation.
 * Enforces per-scope burst / replenishment limits and per-function concurrency limits.
 */
export class TokenBucketLimiter implements TokenBucketLimiter {
  private readonly nowProvider: () => number;
  private readonly buckets = new Map<string, TokenBucketState>();
  private readonly concurrencyCounts = new Map<string, number>();

  constructor(options?: TokenBucketLimiterOptions) {
    this.nowProvider = options?.nowProvider ?? Date.now;
  }

  /**
   * Consumes a single token for the given key and scope.
   * spec: contracts/platform.contract.md#PLAT-9
   * Formula: tokens(t) = min(burst, tokens(t-1) + rate * Δt)
   * Allow request iff tokens >= 1, then tokens -= 1
   * If rejected: Retry-After = ceil((1 - tokens) / rate)
   */
  consume(key: string, scope: RateLimitScope): RateLimitResult {
    const tier = RATE_LIMIT_TIERS[scope];
    const bucketKey = `${scope}:${key}`;
    const now = this.nowProvider();

    let tokens: number;
    const bucket = this.buckets.get(bucketKey);

    if (!bucket) {
      tokens = tier.burst;
    } else {
      const deltaSec = Math.max(
        0,
        (now - bucket.lastReplenishedAt) / MILLISECONDS_PER_SECOND,
      );
      tokens = Math.min(tier.burst, bucket.tokens + tier.rate * deltaSec);
    }

    if (tokens >= 1) {
      tokens -= 1;
      this.buckets.set(bucketKey, { tokens, lastReplenishedAt: now });
      return {
        allowed: true,
        remaining: Math.floor(tokens),
        retryAfterSeconds: undefined,
      };
    }

    this.buckets.set(bucketKey, { tokens, lastReplenishedAt: now });
    const retryAfterSeconds = Math.ceil((1 - tokens) / tier.rate);
    return {
      allowed: false,
      remaining: Math.max(0, Math.floor(tokens)),
      retryAfterSeconds,
    };
  }

  /**
   * Acquires a concurrent execution slot for a function key.
   * spec: contracts/functions.contract.md#FN-5
   */
  acquireConcurrency(fnKey: string, maxConcurrency: number): ConcurrencyResult {
    const currentActive = this.concurrencyCounts.get(fnKey) ?? 0;
    if (currentActive < maxConcurrency) {
      const newActive = currentActive + 1;
      this.concurrencyCounts.set(fnKey, newActive);
      return { allowed: true, active: newActive };
    }
    return { allowed: false, active: currentActive };
  }

  /**
   * Releases a concurrent execution slot for a function key with underflow protection.
   * spec: contracts/functions.contract.md#FN-5
   */
  releaseConcurrency(fnKey: string): void {
    const currentActive = this.concurrencyCounts.get(fnKey) ?? 0;
    if (currentActive > 1) {
      this.concurrencyCounts.set(fnKey, currentActive - 1);
    } else {
      this.concurrencyCounts.delete(fnKey);
    }
  }
}

/**
 * Formats an HTTP 429 response for rate-limited requests according to PLAT-12.
 * spec: contracts/platform.contract.md#PLAT-9
 * spec: contracts/platform.contract.md#PLAT-12
 */
export function formatRateLimitRejection(
  retryAfterSeconds: number,
  requestId?: string,
): Response {
  const error = new RateLimitedError("Rate limit exceeded", requestId);
  const body = toErrorResponseBody(error);
  return new Response(JSON.stringify(body), {
    status: HTTP_STATUS_TOO_MANY_REQUESTS,
    headers: {
      "content-type": "application/json",
      "Retry-After": String(retryAfterSeconds),
    },
  });
}
