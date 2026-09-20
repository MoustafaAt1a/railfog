/**
 * Decorrelated jitter retry engine and idempotency policy for RailFog.
 *
 * Spec references:
 * - contracts/queues.contract.md#Q-5: Retries: exponential backoff with decorrelated jitter,
 *   idempotency eligibility rules, and banned patterns (unbounded retries, bare POST retries).
 */

// spec: contracts/queues.contract.md#Q-5 — Default retry settings table
export const DEFAULT_BASE_MS = 100;
export const DEFAULT_CAP_MS = 20_000;
export const DEFAULT_MAX_ATTEMPTS = 5;

// spec: contracts/queues.contract.md#Q-5 — Decorrelated jitter multiplier factor: 3
const JITTER_MULTIPLIER = 3;

// spec: contracts/queues.contract.md#Q-5 — Standard idempotency header name
const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export interface RetryPolicyOptions {
  baseMs?: number; // default 100 (Q-5)
  capMs?: number; // default 20000 (Q-5)
  maxAttempts?: number; // default 5 (Q-5)
  randomUniform?: (min: number, max: number) => number; // injected RNG for deterministic tests
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

export interface RetryState {
  attempt: number;
  lastSleepMs: number;
}

/**
 * Default pseudo-random uniform number generator on the interval [min, max].
 */
function defaultRandomUniform(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/**
 * Calculates the next sleep duration in milliseconds using decorrelated jitter:
 * - sleep_0 = base
 * - sleep_n = min(cap, random_uniform(base, sleep_(n-1) * 3))
 *
 * spec: contracts/queues.contract.md#Q-5 — Exponential backoff with decorrelated jitter calculation
 */
export function calculateNextSleep(
  state: RetryState,
  options?: RetryPolicyOptions,
): number {
  const baseMs = options?.baseMs ?? DEFAULT_BASE_MS;
  const capMs = options?.capMs ?? DEFAULT_CAP_MS;

  // spec: contracts/queues.contract.md#Q-5 — sleep_0 = base
  if (state.attempt === 0) {
    return baseMs;
  }

  // spec: contracts/queues.contract.md#Q-5 — sleep_n = min(cap, random_uniform(base, sleep_(n-1) * 3))
  const rng = options?.randomUniform ?? defaultRandomUniform;
  const upperRange = Math.max(baseMs, state.lastSleepMs * JITTER_MULTIPLIER);
  const jitteredSleep = rng(baseMs, upperRange);

  return Math.min(capMs, jitteredSleep);
}

/**
 * Checks for the presence of a non-empty, non-whitespace Idempotency-Key header.
 * Performs case-insensitive lookup across Headers instances and plain Record objects.
 */
function hasValidIdempotencyKey(
  headers?: Headers | Record<string, string>,
): boolean {
  if (!headers) {
    return false;
  }

  if (headers instanceof Headers) {
    const value = headers.get(IDEMPOTENCY_KEY_HEADER);
    return value !== null && value.trim().length > 0;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === IDEMPOTENCY_KEY_HEADER) {
      return typeof value === "string" && value.trim().length > 0;
    }
  }

  return false;
}

/**
 * Determines whether an HTTP request method and its headers permit automatic retries.
 * Safe methods (GET, HEAD) are always retry-eligible.
 * Non-safe methods (such as PUT or POST) require a non-empty Idempotency-Key header.
 * Bare POST requests without an Idempotency-Key are strictly rejected per Q-5.
 *
 * spec: contracts/queues.contract.md#Q-5 — Idempotent retry eligibility and banned bare POST retries
 */
export function isIdempotentRetryAllowed(
  method: string,
  headers?: Headers | Record<string, string>,
): boolean {
  const normalizedMethod = method.trim().toUpperCase();

  // spec: contracts/queues.contract.md#Q-5 — Safe methods GET and HEAD are retry-eligible
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD") {
    return true;
  }

  // spec: contracts/queues.contract.md#Q-5 — Non-safe methods require a valid Idempotency-Key header
  return hasValidIdempotencyKey(headers);
}

/**
 * Helper to pause execution for a given duration in milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes an asynchronous operation with retry logic adhering to exponential
 * backoff with decorrelated jitter and idempotency rules per Q-5.
 *
 * spec: contracts/queues.contract.md#Q-5 — drives retry loop up to maxAttempts, sleep calculation, error rethrow upon exhaustion
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options?: RetryPolicyOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let attempt = 0;
  let lastSleepMs = 0;

  while (true) {
    try {
      return await operation(attempt);
    } catch (error: unknown) {
      if (options?.shouldRetry && !options.shouldRetry(error, attempt)) {
        throw error;
      }

      if (attempt + 1 >= maxAttempts) {
        // spec: contracts/queues.contract.md#Q-5 — Infinite retries are never implemented; rethrow final error upon exhaustion
        throw error;
      }

      const sleepMs = calculateNextSleep({ attempt, lastSleepMs }, options);
      await delay(sleepMs);
      lastSleepMs = sleepMs;
      attempt++;
    }
  }
}
