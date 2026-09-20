/**
 * Data-plane usage accounting batch collector.
 *
 * Implements data-oriented usage accounting adhering to docs/CONSTITUTION.md
 * Boundary Rule: flat buffer of plain records appended in hot path
 * and flushed in batches on timer or size threshold.
 *
 * Spec references:
 * - contracts/platform.contract.md#PLAT-13 (Observability: metrics & counters)
 * - docs/CONSTITUTION.md (The Boundary Rule: Data-Oriented Design in hot path)
 */

// spec: contracts/platform.contract.md#PLAT-13 — default in-memory buffer bound to avoid OOM under load spikes
export const DEFAULT_MAX_BUFFER_SIZE = 10000;

// spec: contracts/platform.contract.md#PLAT-13 — default batch size threshold for automated batch draining
export const DEFAULT_FLUSH_BATCH_SIZE = 500;

// spec: contracts/platform.contract.md#PLAT-13 — default periodic flush interval for pending usage metrics
export const DEFAULT_FLUSH_INTERVAL_MS = 5000;

/**
 * Metric types capturing resource operations defined in PLAT-13.
 *
 * Counters: function.invocation, function.error, kv.read, kv.write, object.read,
 * object.write, queue.sent, queue.processed, queue.failed, queue.retry.
 * Histograms / Gauges: function.duration, function.cpu, function.memory.
 *
 * spec: contracts/platform.contract.md#PLAT-13
 */
export type UsageMetricType =
  | "function.invocation"
  | "function.error"
  | "function.duration"
  | "function.cpu"
  | "function.memory"
  | "kv.read"
  | "kv.write"
  | "object.read"
  | "object.write"
  | "queue.sent"
  | "queue.processed"
  | "queue.failed"
  | "queue.retry";

/**
 * Plain typed struct capturing resource operation metrics.
 *
 * spec: contracts/platform.contract.md#PLAT-13
 * spec: docs/CONSTITUTION.md — DOD plain struct avoiding per-call object allocations
 */
export interface UsageRecord {
  timestamp: number;
  project: string;
  functionName: string;
  revisionId: string;
  metric: UsageMetricType;
  value: number;
}

/**
 * Configuration options for the batch collector.
 *
 * spec: contracts/platform.contract.md#PLAT-13
 */
export interface UsageCollectorOptions {
  maxBufferSize?: number;
  flushBatchSize?: number;
  flushIntervalMs?: number;
  onFlush?: (batch: ReadonlyArray<UsageRecord>) => Promise<void> | void;
}

/**
 * Interface for the batch collector.
 *
 * spec: contracts/platform.contract.md#PLAT-13
 */
export interface UsageBatchCollector {
  record(
    project: string,
    functionName: string,
    revisionId: string,
    metric: UsageMetricType,
    value: number,
  ): void;
  flush(): Promise<ReadonlyArray<UsageRecord>>;
  getBufferSize(): number;
  getDroppedCount(): number;
  dispose(): Promise<void>;
}

/**
 * Data-oriented in-memory usage collector implementing UsageBatchCollector.
 */
class DefaultUsageBatchCollector implements UsageBatchCollector {
  private readonly maxBufferSize: number;
  private readonly flushBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly onFlush?: (
    batch: ReadonlyArray<UsageRecord>,
  ) => Promise<void> | void;

  private buffer: UsageRecord[] = [];
  private droppedCount = 0;
  private disposed = false;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private readonly inFlightFlushes = new Set<Promise<void>>();

  constructor(options?: UsageCollectorOptions) {
    this.maxBufferSize = options?.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.flushBatchSize = options?.flushBatchSize ?? DEFAULT_FLUSH_BATCH_SIZE;
    this.flushIntervalMs = options?.flushIntervalMs ??
      DEFAULT_FLUSH_INTERVAL_MS;
    this.onFlush = options?.onFlush;

    if (this.flushIntervalMs > 0) {
      // spec: contracts/platform.contract.md#PLAT-13 — periodic background flush for pending usage records
      this.timerId = setInterval(() => {
        if (this.buffer.length > 0) {
          this.triggerFlush();
        }
      }, this.flushIntervalMs);

      // Avoid keeping Deno event loop open in testing / idle environments
      if (
        typeof Deno !== "undefined" && typeof Deno.unrefTimer === "function"
      ) {
        Deno.unrefTimer(this.timerId);
      }
    }
  }

  /**
   * Appends an event to the buffer using primitive arguments.
   *
   * spec: docs/CONSTITUTION.md — Boundary Rule on DOD hot path to avoid caller heap allocations
   * spec: contracts/platform.contract.md#PLAT-13 — bounds memory under saturation by dropping excess records
   */
  record(
    project: string,
    functionName: string,
    revisionId: string,
    metric: UsageMetricType,
    value: number,
  ): void {
    if (this.disposed) {
      this.droppedCount++;
      return;
    }

    if (this.buffer.length >= this.maxBufferSize) {
      this.droppedCount++;
      return;
    }

    this.buffer.push({
      timestamp: Date.now(),
      project,
      functionName,
      revisionId,
      metric,
      value,
    });

    if (this.buffer.length >= this.flushBatchSize) {
      // spec: contracts/platform.contract.md#PLAT-13 — automated batch flush when threshold reached
      this.triggerFlush();
    }
  }

  /**
   * Flushes and drains pending records immediately.
   *
   * spec: contracts/platform.contract.md#PLAT-13 — drains pending records and awaits onFlush callback
   */
  async flush(): Promise<ReadonlyArray<UsageRecord>> {
    const batch = this.drain();
    if (batch.length > 0 && this.onFlush) {
      const result = this.onFlush(batch);
      if (result instanceof Promise) {
        this.inFlightFlushes.add(result);
        try {
          await result;
        } finally {
          this.inFlightFlushes.delete(result);
        }
      }
    }
    return batch;
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  getDroppedCount(): number {
    return this.droppedCount;
  }

  /**
   * Disposes the collector, flushes pending records, and clears background timers.
   *
   * spec: contracts/platform.contract.md#PLAT-13 — clean lifecycle teardown and remaining record flush
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }

    await this.flush();

    if (this.inFlightFlushes.size > 0) {
      await Promise.all(Array.from(this.inFlightFlushes));
    }
  }

  private drain(): UsageRecord[] {
    if (this.buffer.length === 0) {
      return [];
    }
    const batch = this.buffer;
    this.buffer = [];
    return batch;
  }

  private triggerFlush(): void {
    const batch = this.drain();
    if (batch.length > 0 && this.onFlush) {
      try {
        const result = this.onFlush(batch);
        if (result instanceof Promise) {
          this.inFlightFlushes.add(result);
          result
            .catch(() => {
              // Unhandled rejection prevention in background/synchronous trigger
            })
            .finally(() => {
              this.inFlightFlushes.delete(result);
            });
        }
      } catch {
        // Prevent synchronous onFlush exception from breaking callers
      }
    }
  }
}

/**
 * Creates a new UsageBatchCollector instance.
 *
 * spec: contracts/platform.contract.md#PLAT-13
 */
export function createUsageCollector(
  options?: UsageCollectorOptions,
): UsageBatchCollector {
  return new DefaultUsageBatchCollector(options);
}
