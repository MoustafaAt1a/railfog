// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: sdk/typescript
// spec: contracts/queues.contract.md#Q-4 — Idempotency helper (withIdempotency) with mandatory TTL
// spec: contracts/queues.contract.md#Q-5 — Exponential backoff with decorrelated jitter retry helper (withRetry)
// spec: contracts/queues.contract.md#Q-6 — Composed reliability patterns as library code over KV
// spec: contracts/kv.contract.md#KV-2 — KV binding API, required TTL for dedupe keys (Audit Finding #5)
// spec: contracts/platform.contract.md#PLAT-12 — Error model: typed error preservation on retry exhaustion

import type { KVAtomicOperation, KVBinding, ListOptions } from "./types.ts";
import { ConflictError, UnavailableError } from "../../packages/errors/mod.ts";

// spec: contracts/queues.contract.md#Q-3, Q-4 — Default retention window for idempotency dedupe keys (14 days = 1,209,600s)
// spec: contracts/kv.contract.md#KV-2 — Mandatory TTL prevents unbounded dedupe key growth (Audit Finding #5)
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 14 * 24 * 3600;

// spec: contracts/queues.contract.md#Q-5 — Default retry settings table
export const DEFAULT_RETRY_BASE_MS = 100;
export const DEFAULT_RETRY_CAP_MS = 20_000;
export const DEFAULT_RETRY_MAX_ATTEMPTS = 5;

// spec: contracts/queues.contract.md#Q-6 — Default circuit breaker thresholds
export const DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
export const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

/**
 * Options for withCircuitBreaker helper.
 * @spec contracts/queues.contract.md#Q-6
 */
export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

/**
 * Circuit breaker state stored in KV.
 * @spec contracts/queues.contract.md#Q-6
 */
export interface CircuitBreakerState {
  failures: number;
  openUntil: number;
}

/**
 * Options for withIdempotency helper.
 * @spec contracts/queues.contract.md#Q-4
 * @spec contracts/kv.contract.md#KV-2
 */
export interface IdempotencyOptions {
  ttlSeconds?: number;
}

/**
 * Options for withRetry helper.
 * @spec contracts/queues.contract.md#Q-5
 */
export interface RetryOptions {
  baseMs?: number;
  capMs?: number;
  maxAttempts?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomUniform(min: number, max: number): number {
  if (min >= max) return min;
  return Math.random() * (max - min) + min;
}

/**
 * Composed idempotency pattern over KV with mandatory TTL.
 * Checks whether the dedupe key exists in KV; if so, returns without executing action.
 * Otherwise, executes action, writes the dedupe marker with TTL, and returns the result.
 * If action throws, no dedupe key is written, allowing subsequent attempts.
 *
 * @spec contracts/queues.contract.md#Q-4 — Idempotency helper (withIdempotency) with mandatory TTL
 * @spec contracts/queues.contract.md#Q-6 — Composed reliability patterns as library code over KV
 * @spec contracts/kv.contract.md#KV-2 — KV binding API, required TTL for dedupe keys (Audit Finding #5)
 */
export async function withIdempotency<T>(
  kv: KVBinding,
  dedupeKey: string[],
  action: () => Promise<T> | T,
  options?: IdempotencyOptions,
): Promise<{ processed: boolean; result?: T }> {
  // Check if dedupe marker already exists in KV
  const existing = await kv.get(dedupeKey);
  if (existing !== null) {
    return { processed: false, result: undefined };
  }

  // Execute action; if it throws, rethrow without writing dedupe key
  const result = await action();

  // Write dedupe marker with mandatory TTL (defaults to 14 days)
  // spec: contracts/kv.contract.md#KV-2, queues.contract.md#Q-4 — Enforce positive finite TTL.
  // Undefined, null, 0, negative, or NaN all default to DEFAULT_IDEMPOTENCY_TTL_SECONDS (Audit Finding #5).
  const ttl = (typeof options?.ttlSeconds === "number" &&
      Number.isFinite(options.ttlSeconds) && options.ttlSeconds > 0)
    ? options.ttlSeconds
    : DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  await kv.set(dedupeKey, true, { ttl });

  return { processed: true, result };
}

/**
 * Exponential backoff with decorrelated jitter retry helper.
 * Implements:
 *   sleep_0 = base
 *   sleep_n = min(cap, random_uniform(base, sleep_(n-1) * 3))
 * On exhaustion of maxAttempts, rethrows the original error unchanged.
 *
 * @spec contracts/queues.contract.md#Q-5 — Exponential backoff with decorrelated jitter retry helper (withRetry)
 * @spec contracts/queues.contract.md#Q-6 — Composed reliability patterns as library code over KV
 * @spec contracts/platform.contract.md#PLAT-12 — Preservation of original typed error on exhaustion
 */
export async function withRetry<T>(
  action: () => Promise<T> | T,
  options?: RetryOptions,
): Promise<T> {
  const baseMs =
    (typeof options?.baseMs === "number" && Number.isFinite(options.baseMs) &&
        options.baseMs >= 0)
      ? options.baseMs
      : DEFAULT_RETRY_BASE_MS;
  const capMs =
    (typeof options?.capMs === "number" && Number.isFinite(options.capMs) &&
        options.capMs >= baseMs)
      ? options.capMs
      : Math.max(baseMs, DEFAULT_RETRY_CAP_MS);
  // spec: contracts/queues.contract.md#Q-5 — Strictly cap maxAttempts; prevent infinite loop or negative bounds (Audit Finding #4)
  const maxAttempts = (typeof options?.maxAttempts === "number" &&
      Number.isFinite(options.maxAttempts) && options.maxAttempts > 0)
    ? Math.floor(options.maxAttempts)
    : DEFAULT_RETRY_MAX_ATTEMPTS;

  let prevSleep = baseMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await action();
    } catch (err) {
      // Re-throw when max attempts are exhausted per Q-5 & PLAT-12
      if (attempt >= maxAttempts) {
        throw err;
      }

      // Decorrelated jitter backoff per Q-5
      const sleepMs = attempt === 1
        ? prevSleep
        : Math.min(capMs, randomUniform(baseMs, prevSleep * 3));
      prevSleep = sleepMs;

      await delay(sleepMs);
    }
  }

  throw new Error("Retry loop terminated unexpectedly");
}

/**
 * Composed circuit breaker pattern over KV with mandatory TTL.
 * Fails fast with UnavailableError when the circuit is open.
 * Tracks consecutive failures and trips to open when threshold is reached.
 * Automatically resets failure count upon successful execution.
 *
 * @spec contracts/queues.contract.md#Q-6 — Composed reliability patterns as library code over KV
 * @spec contracts/kv.contract.md#KV-2 — Mandatory TTL prevents unbounded key growth (Audit Finding #5)
 * @spec contracts/platform.contract.md#PLAT-12 — UnavailableError when circuit is open
 */
export async function withCircuitBreaker<T>(
  kv: KVBinding,
  circuitKey: string[],
  action: () => Promise<T> | T,
  options?: CircuitBreakerOptions,
): Promise<T> {
  const failureThreshold = (typeof options?.failureThreshold === "number" &&
      Number.isFinite(options.failureThreshold) && options.failureThreshold > 0)
    ? Math.floor(options.failureThreshold)
    : DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD;

  const cooldownMs = (typeof options?.cooldownMs === "number" &&
      Number.isFinite(options.cooldownMs) && options.cooldownMs > 0)
    ? Math.floor(options.cooldownMs)
    : DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS;

  const now = Date.now();

  const state = await kv.get<CircuitBreakerState>(circuitKey);
  if (state && typeof state.openUntil === "number" && state.openUntil > now) {
    throw new UnavailableError(
      `Circuit breaker '${circuitKey.join("/")}' is open until ${
        new Date(state.openUntil).toISOString()
      }`,
    );
  }

  try {
    const result = await action();
    if (state && (state.failures > 0 || state.openUntil > 0)) {
      await kv.delete(circuitKey);
    }
    return result;
  } catch (err) {
    const currentFailures = (state?.failures ?? 0) + 1;
    const openUntil = currentFailures >= failureThreshold
      ? now + cooldownMs
      : 0;
    // Store failure state with TTL matching cooldown window + safety buffer
    const ttlSeconds = Math.max(60, Math.ceil((cooldownMs * 2) / 1000));
    await kv.set(
      circuitKey,
      { failures: currentFailures, openUntil },
      { ttl: ttlSeconds },
    );
    throw err;
  }
}

/**
 * Options for the mutate helper.
 * @spec contracts/kv.contract.md#KV-3
 * @spec contracts/queues.contract.md#Q-5
 */
export interface MutateOptions {
  maxRetries?: number;
  baseMs?: number;
  capMs?: number;
  ttl?: number;
}

/**
 * Creates a scoped KVBinding that automatically prefixes all keys with the specified base prefix.
 * Transparently strips the prefix when listing entries.
 *
 * @spec contracts/kv.contract.md#KV-2 — Key-Value storage capability binding
 * @spec contracts/platform.contract.md#PLAT-6 — Capability-scoped storage
 */
export function scopedKV(kv: KVBinding, ...basePrefix: string[]): KVBinding {
  const prefix = basePrefix.flat();
  const qualifyKey = (key: string[]): string[] => [...prefix, ...key];
  const stripKey = (fullKey: string[]): string[] => {
    if (
      prefix.length <= fullKey.length &&
      prefix.every((seg, i) => fullKey[i] === seg)
    ) {
      return fullKey.slice(prefix.length);
    }
    return fullKey;
  };

  return {
    get<T = unknown>(key: string[]): Promise<T | null> {
      return kv.get<T>(qualifyKey(key));
    },
    set(
      key: string[],
      value: unknown,
      options?: { ttl?: number },
    ): Promise<void> {
      return kv.set(qualifyKey(key), value, options);
    },
    delete(key: string[]): Promise<void> {
      return kv.delete(qualifyKey(key));
    },
    async list<T = unknown>(
      subPrefix: string[],
      options?: ListOptions,
    ): Promise<{
      entries: Array<{ key: string[]; value: T; version: number }>;
      cursor?: string;
    }> {
      const res = await kv.list<T>(qualifyKey(subPrefix), options);
      return {
        entries: res.entries.map((entry) => ({
          ...entry,
          key: stripKey(entry.key),
        })),
        cursor: res.cursor,
      };
    },
    atomic(): KVAtomicOperation {
      const op = kv.atomic();
      const scopedOp: KVAtomicOperation = {
        check(key: string[], expectedVersion: number): KVAtomicOperation {
          op.check(qualifyKey(key), expectedVersion);
          return scopedOp;
        },
        set(
          key: string[],
          value: unknown,
          options?: { ttl?: number },
        ): KVAtomicOperation {
          op.set(qualifyKey(key), value, options);
          return scopedOp;
        },
        delete(key: string[]): KVAtomicOperation {
          op.delete(qualifyKey(key));
          return scopedOp;
        },
        commit(): Promise<{ ok: boolean; version?: number }> {
          return op.commit();
        },
      };
      return scopedOp;
    },
  };
}

/**
 * Atomically mutates a KV key's value using optimistic concurrency (CAS).
 * Handles conflicts by executing an exponential backoff retry loop with decorrelated jitter.
 *
 * @spec contracts/kv.contract.md#KV-3 — Optimistic concurrency CAS formula
 * @spec contracts/queues.contract.md#Q-5 — Decorrelated jitter retry loop
 * @spec contracts/platform.contract.md#PLAT-12 — ConflictError upon retry exhaustion
 */
export async function mutate<T>(
  kv: KVBinding,
  key: string[],
  updater: (current: T | null) => Promise<T> | T,
  options?: MutateOptions,
): Promise<T> {
  const maxRetries = (typeof options?.maxRetries === "number" &&
      Number.isFinite(options.maxRetries) && options.maxRetries >= 0)
    ? Math.floor(options.maxRetries)
    : 5;
  const baseMs = (typeof options?.baseMs === "number" &&
      Number.isFinite(options.baseMs) && options.baseMs > 0)
    ? Math.floor(options.baseMs)
    : DEFAULT_RETRY_BASE_MS;
  const capMs = (typeof options?.capMs === "number" &&
      Number.isFinite(options.capMs) && options.capMs > 0)
    ? Math.floor(options.capMs)
    : DEFAULT_RETRY_CAP_MS;

  let attempt = 0;
  let prevSleep = baseMs;

  while (attempt <= maxRetries) {
    let currentVal: T | null = null;
    let currentVersion = 0;

    const listRes = await kv.list<T>(key, { limit: 1 });
    const exact = listRes.entries.find((e) =>
      e.key.length === key.length && e.key.every((seg, i) => seg === key[i])
    );

    if (exact) {
      currentVal = exact.value;
      currentVersion = exact.version ?? 1;
    } else {
      currentVal = await kv.get<T>(key);
      currentVersion = currentVal === null ? 0 : 1;
    }

    const newVal = await updater(currentVal);

    const atomicOp = kv.atomic().check(key, currentVersion);
    if (options?.ttl !== undefined) {
      atomicOp.set(key, newVal, { ttl: options.ttl });
    } else {
      atomicOp.set(key, newVal);
    }

    const commitRes = await atomicOp.commit();
    if (commitRes.ok) {
      return newVal;
    }

    attempt++;
    if (attempt > maxRetries) {
      throw new ConflictError(
        `Optimistic concurrency mutation conflict for key '${
          key.join("/")
        }': retries exhausted (${maxRetries})`,
      );
    }

    // Decorrelated jitter backoff per Q-5
    const sleep = Math.min(
      capMs,
      Math.max(
        baseMs,
        Math.floor(baseMs + Math.random() * (prevSleep * 3 - baseMs)),
      ),
    );
    prevSleep = sleep;
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }

  throw new ConflictError(`Mutation failed for key '${key.join("/")}'`);
}
