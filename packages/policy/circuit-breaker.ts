import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import { UnavailableError } from "../errors/mod.ts";

// spec: contracts/queues.contract.md#Q-6 — Composed reliability patterns as library code over kv.atomic()
export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_COOLDOWN_MS = 30_000;
export const DEFAULT_HALF_OPEN_SUCCESS_THRESHOLD = 2;

export type CircuitState = "Closed" | "Open" | "Half-Open";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  halfOpenSuccessThreshold?: number;
  nowProvider?: () => number;
}

export interface CircuitBreakerStateRecord {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastStateChangeEpochMs: number;
  version: number;
}

export interface CircuitBreaker {
  execute<T>(operation: () => Promise<T>): Promise<T>;
  getState(): Promise<CircuitBreakerStateRecord>;
  reset(): Promise<void>;
}

// spec: contracts/queues.contract.md#Q-6 — Circuit breaker implemented as library code without background daemons
class KVCircuitBreaker implements CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenSuccessThreshold: number;
  private readonly now: () => number;

  constructor(
    private readonly kv: KVProvider,
    private readonly circuitKey: string[],
    options?: CircuitBreakerOptions,
  ) {
    this.failureThreshold = options?.failureThreshold ??
      DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.halfOpenSuccessThreshold = options?.halfOpenSuccessThreshold ??
      DEFAULT_HALF_OPEN_SUCCESS_THRESHOLD;
    this.now = options?.nowProvider ?? Date.now;
  }

  // spec: contracts/kv.contract.md#KV-5 — State backed by strong consistency tier
  async getState(): Promise<CircuitBreakerStateRecord> {
    const raw = await this.kv.get(this.circuitKey);
    if (!raw || typeof raw !== "object") {
      // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#Assumptions
      return {
        state: "Closed",
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastStateChangeEpochMs: 0,
        version: 0,
      };
    }

    const record = raw as Partial<CircuitBreakerStateRecord>;
    return {
      state: record.state ?? "Closed",
      consecutiveFailures: record.consecutiveFailures ?? 0,
      consecutiveSuccesses: record.consecutiveSuccesses ?? 0,
      lastStateChangeEpochMs: record.lastStateChangeEpochMs ?? 0,
      version: typeof record.version === "number" ? record.version : 0,
    };
  }

  // spec: contracts/kv.contract.md#KV-3 — Optimistic concurrency (CAS) check, set, commit with conflict retry
  private async mutateState(
    mutator: (
      current: CircuitBreakerStateRecord,
    ) => Omit<CircuitBreakerStateRecord, "version"> | null,
  ): Promise<CircuitBreakerStateRecord> {
    while (true) {
      const current = await this.getState();
      const mutation = mutator(current);
      if (mutation === null) {
        return current;
      }

      const nextRecord: CircuitBreakerStateRecord = {
        ...mutation,
        version: current.version + 1,
      };

      const commitResult = await this.kv.atomic()
        .check(this.circuitKey, current.version)
        .set(this.circuitKey, nextRecord)
        .commit();

      if (commitResult.ok) {
        return {
          ...nextRecord,
          version: commitResult.version ?? nextRecord.version,
        };
      }
    }
  }

  private async recordSuccess(stateBeforeOp: CircuitState): Promise<void> {
    await this.mutateState((latest) => {
      const now = this.now();
      if (
        latest.state === "Half-Open" ||
        stateBeforeOp === "Open" ||
        stateBeforeOp === "Half-Open"
      ) {
        const currentSuccesses = latest.state === "Half-Open"
          ? latest.consecutiveSuccesses
          : 0;
        const nextSuccesses = currentSuccesses + 1;
        if (nextSuccesses >= this.halfOpenSuccessThreshold) {
          return {
            state: "Closed",
            consecutiveFailures: 0,
            consecutiveSuccesses: 0,
            lastStateChangeEpochMs: now,
          };
        }
        return {
          state: "Half-Open",
          consecutiveFailures: 0,
          consecutiveSuccesses: nextSuccesses,
          lastStateChangeEpochMs: latest.state === "Half-Open"
            ? latest.lastStateChangeEpochMs
            : now,
        };
      }

      if (latest.state === "Closed") {
        if (latest.consecutiveFailures > 0) {
          return {
            state: "Closed",
            consecutiveFailures: 0,
            consecutiveSuccesses: 0,
            lastStateChangeEpochMs: latest.lastStateChangeEpochMs,
          };
        }
        return null;
      }

      return null;
    });
  }

  private async recordFailure(stateBeforeOp: CircuitState): Promise<void> {
    await this.mutateState((latest) => {
      const now = this.now();
      if (
        latest.state === "Half-Open" ||
        stateBeforeOp === "Open" ||
        stateBeforeOp === "Half-Open"
      ) {
        return {
          state: "Open",
          consecutiveFailures: this.failureThreshold,
          consecutiveSuccesses: 0,
          lastStateChangeEpochMs: now,
        };
      }

      if (latest.state === "Open") {
        return null;
      }

      const nextFailures = latest.consecutiveFailures + 1;
      if (nextFailures >= this.failureThreshold) {
        return {
          state: "Open",
          consecutiveFailures: nextFailures,
          consecutiveSuccesses: 0,
          lastStateChangeEpochMs: now,
        };
      }

      return {
        state: "Closed",
        consecutiveFailures: nextFailures,
        consecutiveSuccesses: 0,
        lastStateChangeEpochMs: latest.lastStateChangeEpochMs,
      };
    });
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const current = await this.getState();
    const now = this.now();

    if (current.state === "Open") {
      const elapsed = now - current.lastStateChangeEpochMs;
      if (elapsed < this.cooldownMs) {
        // spec: contracts/platform.contract.md#PLAT-12 — Fast-fail with UNAVAILABLE error code
        throw new UnavailableError(
          "Circuit breaker is Open: downstream service unavailable",
        );
      }
    }

    const stateBeforeOp = current.state;
    try {
      const result = await operation();
      await this.recordSuccess(stateBeforeOp);
      return result;
    } catch (err) {
      await this.recordFailure(stateBeforeOp);
      throw err;
    }
  }

  async reset(): Promise<void> {
    await this.mutateState(() => ({
      state: "Closed",
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      lastStateChangeEpochMs: this.now(),
    }));
  }
}

export function createCircuitBreaker(
  kv: KVProvider,
  circuitKey: string[],
  options?: CircuitBreakerOptions,
): CircuitBreaker {
  return new KVCircuitBreaker(kv, circuitKey, options);
}
