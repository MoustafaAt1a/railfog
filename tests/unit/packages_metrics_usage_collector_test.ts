/**
 * Comprehensive test suite for Data-Plane Usage Accounting Batch Collector.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-13 (Observability: metrics & counters)
 * - docs/CONSTITUTION.md (The Boundary Rule: Data-Oriented Design in runtime hot path)
 * - tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md (AC1 - AC5, Tests required)
 */

import { assert, assertEquals, assertGreaterOrEqual } from "@std/assert";
import { delay } from "@std/async/delay";
import {
  createUsageCollector,
  type UsageBatchCollector,
  type UsageMetricType,
  type UsageRecord,
} from "../../packages/metrics/usage-collector.ts";

// ============================================================================
// AC1 & Checklist (1): Record appends and buffer size tracking
// ============================================================================

Deno.test("AC1 & Checklist (1): Initial collector has zero buffer size and zero dropped records", () => {
  // spec: contracts/platform.contract.md#PLAT-13
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#AC1
  const collector: UsageBatchCollector = createUsageCollector();

  assertEquals(collector.getBufferSize(), 0);
  assertEquals(collector.getDroppedCount(), 0);
});

Deno.test("AC1 & Checklist (1): Calling record appends event and increments buffer size", () => {
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#AC1
  const collector = createUsageCollector({ flushBatchSize: 1000 });

  collector.record(
    "proj_alpha",
    "fn_handler",
    "rev_01J",
    "function.invocation",
    1,
  );
  assertEquals(collector.getBufferSize(), 1);

  collector.record("proj_alpha", "fn_handler", "rev_01J", "function.cpu", 42);
  assertEquals(collector.getBufferSize(), 2);
});

Deno.test("AC1: All 13 PLAT-13 metric types can be recorded accurately", async () => {
  // spec: contracts/platform.contract.md#PLAT-13 — Full metrics enumeration
  const allMetrics: UsageMetricType[] = [
    "function.invocation",
    "function.error",
    "function.duration",
    "function.cpu",
    "function.memory",
    "kv.read",
    "kv.write",
    "object.read",
    "object.write",
    "queue.sent",
    "queue.processed",
    "queue.failed",
    "queue.retry",
  ];

  const collector = createUsageCollector({ flushBatchSize: 1000 });
  const beforeTime = Date.now();

  for (let i = 0; i < allMetrics.length; i++) {
    collector.record(
      "proj_test",
      "test_fn",
      "rev_test",
      allMetrics[i],
      i + 1,
    );
  }

  assertEquals(collector.getBufferSize(), allMetrics.length);

  const batch = await collector.flush();
  assertEquals(batch.length, allMetrics.length);
  assertEquals(collector.getBufferSize(), 0);

  for (let i = 0; i < allMetrics.length; i++) {
    const rec = batch[i];
    assertEquals(rec.project, "proj_test");
    assertEquals(rec.functionName, "test_fn");
    assertEquals(rec.revisionId, "rev_test");
    assertEquals(rec.metric, allMetrics[i]);
    assertEquals(rec.value, i + 1);
    assertGreaterOrEqual(rec.timestamp, beforeTime);
    assert(rec.timestamp <= Date.now());
  }

  await collector.dispose();
});

Deno.test("AC1 & DOD: Flat primitive arguments in record avoid caller heap allocation", async () => {
  // spec: docs/CONSTITUTION.md — Boundary Rule on DOD for usage accounting
  const collector = createUsageCollector({ flushBatchSize: 50 });

  // Append records with primitive values
  for (let i = 0; i < 10; i++) {
    collector.record("p1", "f1", "r1", "kv.read", i);
  }

  assertEquals(collector.getBufferSize(), 10);
  const records = await collector.flush();
  assertEquals(records.length, 10);

  await collector.dispose();
});

// ============================================================================
// AC2 & Checklist (2): Batch size threshold auto-flush trigger
// ============================================================================

Deno.test("AC2 & Checklist (2): Reaching flushBatchSize automatically triggers onFlush and drains buffer", () => {
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#AC2
  const flushedBatches: UsageRecord[][] = [];
  const flushBatchSize = 10;

  const collector = createUsageCollector({
    flushBatchSize,
    flushIntervalMs: 60_000, // Do not trigger via timer
    onFlush: (batch: ReadonlyArray<UsageRecord>) => {
      flushedBatches.push([...batch]);
    },
  });

  // Record 9 items — should not trigger flush yet
  for (let i = 0; i < 9; i++) {
    collector.record("p", "f", "r", "function.invocation", 1);
  }
  assertEquals(flushedBatches.length, 0);
  assertEquals(collector.getBufferSize(), 9);

  // 10th item reaches threshold — triggers onFlush
  collector.record("p", "f", "r", "function.invocation", 1);
  assertEquals(flushedBatches.length, 1);
  assertEquals(flushedBatches[0].length, 10);
  assertEquals(collector.getBufferSize(), 0);

  // Another 10 items triggers second batch
  for (let i = 0; i < 10; i++) {
    collector.record("p", "f", "r", "kv.write", i);
  }
  assertEquals(flushedBatches.length, 2);
  assertEquals(flushedBatches[1].length, 10);
  assertEquals(collector.getBufferSize(), 0);
});

Deno.test("AC2: Default flushBatchSize of 500 triggers auto-flush at 500 items", () => {
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#AC2
  let flushCount = 0;
  let lastBatchSize = 0;

  const collector = createUsageCollector({
    flushIntervalMs: 60_000,
    onFlush: (batch: ReadonlyArray<UsageRecord>) => {
      flushCount++;
      lastBatchSize = batch.length;
    },
  });

  for (let i = 0; i < 499; i++) {
    collector.record("p", "f", "r", "object.read", 1);
  }
  assertEquals(flushCount, 0);
  assertEquals(collector.getBufferSize(), 499);

  // 500th item trips flush
  collector.record("p", "f", "r", "object.read", 1);
  assertEquals(flushCount, 1);
  assertEquals(lastBatchSize, 500);
  assertEquals(collector.getBufferSize(), 0);
});

Deno.test("AC2: Async onFlush callback is supported without dropping pending items", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#Interface
  const batchesReceived: UsageRecord[][] = [];

  const collector = createUsageCollector({
    flushBatchSize: 5,
    flushIntervalMs: 60_000,
    onFlush: async (batch: ReadonlyArray<UsageRecord>) => {
      await delay(10);
      batchesReceived.push([...batch]);
    },
  });

  for (let i = 0; i < 5; i++) {
    collector.record("p", "f", "r", "queue.sent", 1);
  }

  // Wait briefly for async onFlush promise to settle
  await delay(25);
  assertEquals(batchesReceived.length, 1);
  assertEquals(batchesReceived[0].length, 5);

  await collector.dispose();
});

// ============================================================================
// AC3 & Checklist (3): Periodic timer-based flush trigger
// ============================================================================

Deno.test("AC3 & Checklist (3): Pending items below batch size flush automatically when flushIntervalMs elapses", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#AC3
  // Real elapsed time verification per docs/ANTIHALLUCINATION.md Rule 5
  const batches: UsageRecord[][] = [];
  const flushIntervalMs = 50;

  const collector = createUsageCollector({
    flushBatchSize: 100, // Large threshold so it doesn't flush on size
    flushIntervalMs,
    onFlush: (batch: ReadonlyArray<UsageRecord>) => {
      batches.push([...batch]);
    },
  });

  // Record 3 items
  collector.record("p", "f", "r", "function.duration", 120);
  collector.record("p", "f", "r", "function.cpu", 15);
  collector.record("p", "f", "r", "function.memory", 64);

  assertEquals(collector.getBufferSize(), 3);
  assertEquals(batches.length, 0);

  // Wait for timer to fire
  await delay(flushIntervalMs + 40);

  assertEquals(batches.length, 1);
  assertEquals(batches[0].length, 3);
  assertEquals(collector.getBufferSize(), 0);

  await collector.dispose();
});

Deno.test("AC3: Empty buffer does not trigger redundant onFlush invocations on timer fire", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#AC3
  let emptyFlushCount = 0;

  const collector = createUsageCollector({
    flushBatchSize: 10,
    flushIntervalMs: 40,
    onFlush: (batch: ReadonlyArray<UsageRecord>) => {
      if (batch.length === 0) {
        emptyFlushCount++;
      }
    },
  });

  // Do not record anything, let timer tick twice
  await delay(100);

  assertEquals(emptyFlushCount, 0, "Timer should not flush empty batches");

  await collector.dispose();
});

Deno.test("AC3: Successive periodic timer flushes handle multiple batches over time", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#AC3
  const batches: UsageRecord[][] = [];
  const interval = 40;

  const collector = createUsageCollector({
    flushBatchSize: 100,
    flushIntervalMs: interval,
    onFlush: (batch: ReadonlyArray<UsageRecord>) => {
      batches.push([...batch]);
    },
  });

  // Batch 1
  collector.record("p", "f", "r", "kv.read", 1);
  collector.record("p", "f", "r", "kv.read", 2);
  await delay(interval + 30);
  assertEquals(batches.length, 1);
  assertEquals(batches[0].length, 2);

  // Batch 2
  collector.record("p", "f", "r", "kv.write", 3);
  await delay(interval + 30);
  assertEquals(batches.length, 2);
  assertEquals(batches[1].length, 1);

  await collector.dispose();
});

// ============================================================================
// AC4 & Checklist (4): maxBufferSize bounding & drop counter under saturation
// ============================================================================

Deno.test("AC4 & Checklist (4): Exceeding maxBufferSize increments droppedCount without unbounded buffer growth", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#AC4
  // Buffer saturation under load spikes to prevent runtime OOM
  const maxBufferSize = 10;
  const collector = createUsageCollector({
    maxBufferSize,
    flushBatchSize: 100, // Do not auto flush on size
    flushIntervalMs: 60_000, // Do not auto flush on timer
  });

  // Fill up to maxBufferSize
  for (let i = 0; i < maxBufferSize; i++) {
    collector.record("p", "f", "r", "function.invocation", i);
  }
  assertEquals(collector.getBufferSize(), maxBufferSize);
  assertEquals(collector.getDroppedCount(), 0);

  // Record 5 more items beyond capacity
  for (let i = 0; i < 5; i++) {
    collector.record("p", "f", "r", "function.invocation", 100 + i);
  }

  // Buffer size must be strictly bounded by maxBufferSize
  assertEquals(
    collector.getBufferSize(),
    maxBufferSize,
    "Buffer size must not exceed maxBufferSize",
  );
  assertEquals(
    collector.getDroppedCount(),
    5,
    "Dropped count must record all overflow events",
  );

  // Flushing returns the maxBufferSize stored records
  const flushed = await collector.flush();
  assertEquals(flushed.length, maxBufferSize);
  assertEquals(collector.getBufferSize(), 0);
  assertEquals(
    collector.getDroppedCount(),
    5,
    "Dropped count persists after buffer flush",
  );

  await collector.dispose();
});

Deno.test("AC4: Default maxBufferSize of 10000 bounds memory under large volume", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#AC4
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#Interface
  const collector = createUsageCollector({
    flushBatchSize: 50_000,
    flushIntervalMs: 60_000,
  });

  // Push 10050 records (default maxBufferSize is 10000)
  for (let i = 0; i < 10050; i++) {
    collector.record("p", "f", "r", "queue.processed", 1);
  }

  assertEquals(collector.getBufferSize(), 10000);
  assertEquals(collector.getDroppedCount(), 50);

  await collector.dispose();
});

// ============================================================================
// AC5 & Lifecycle: dispose() flushes remaining records and cancels timers
// ============================================================================

Deno.test("AC5: Calling dispose flushes all pending records and clears timer cleanly", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#AC5
  const flushedBatches: UsageRecord[][] = [];

  const collector = createUsageCollector({
    flushBatchSize: 100,
    flushIntervalMs: 1000,
    onFlush: (batch: ReadonlyArray<UsageRecord>) => {
      flushedBatches.push([...batch]);
    },
  });

  collector.record("p", "f", "r", "function.error", 1);
  collector.record("p", "f", "r", "function.error", 2);

  assertEquals(collector.getBufferSize(), 2);
  assertEquals(flushedBatches.length, 0);

  // Dispose immediately
  await collector.dispose();

  // Pending records must be flushed on dispose
  assertEquals(collector.getBufferSize(), 0);
  assertEquals(flushedBatches.length, 1);
  assertEquals(flushedBatches[0].length, 2);

  // Waiting after disposal should not trigger any timer flush
  await delay(100);
  assertEquals(flushedBatches.length, 1);
});

Deno.test("AC5: Calling dispose on an empty collector completes without error", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#AC5
  const collector = createUsageCollector({
    flushBatchSize: 50,
    flushIntervalMs: 50,
  });

  await collector.dispose();
  assertEquals(collector.getBufferSize(), 0);
});

Deno.test("AC5: Calling record after dispose is gracefully ignored or dropped without crash", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#AC5
  const collector = createUsageCollector({
    flushBatchSize: 10,
    flushIntervalMs: 50,
  });

  await collector.dispose();

  // Record after dispose should not throw
  collector.record("p", "f", "r", "kv.read", 1);

  // Either buffer stays 0 or dropped count increments
  assert(collector.getBufferSize() === 0 || collector.getDroppedCount() > 0);
});

// ============================================================================
// Checklist (5): Integration — High-throughput concurrent record calls
// ============================================================================

Deno.test("Checklist (5) (Integration): High-throughput concurrent record calls flush batches cleanly", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0403-usage-accounting-batch-collector.md#Checklist
  const allReceivedRecords: UsageRecord[] = [];
  const flushBatchSize = 100;
  const totalEvents = 1000;
  const workerCount = 10;
  const eventsPerWorker = totalEvents / workerCount;

  const collector = createUsageCollector({
    maxBufferSize: 5000,
    flushBatchSize,
    flushIntervalMs: 50,
    onFlush: (batch: ReadonlyArray<UsageRecord>) => {
      allReceivedRecords.push(...batch);
    },
  });

  // Spawn 10 parallel asynchronous workers recording events concurrently
  const workers = Array.from({ length: workerCount }, (_, workerId) => {
    return (async () => {
      for (let i = 0; i < eventsPerWorker; i++) {
        collector.record(
          `proj_${workerId}`,
          `fn_${workerId}`,
          "rev_01J",
          "function.invocation",
          i,
        );
        if (i % 20 === 0) {
          await delay(1); // Introduce realistic task interleaved concurrency
        }
      }
    })();
  });

  await Promise.all(workers);

  // Dispose collector to flush any remaining pending events
  await collector.dispose();

  // Total collected events + dropped must equal totalEvents
  const totalProcessed = allReceivedRecords.length +
    collector.getDroppedCount();
  assertEquals(
    totalProcessed,
    totalEvents,
    `Expected all ${totalEvents} events to be processed, received ${allReceivedRecords.length} and dropped ${collector.getDroppedCount()}`,
  );

  // Verify record structure integrity across all collected events
  for (const rec of allReceivedRecords) {
    assert(rec.project.startsWith("proj_"));
    assert(rec.functionName.startsWith("fn_"));
    assertEquals(rec.revisionId, "rev_01J");
    assertEquals(rec.metric, "function.invocation");
    assert(typeof rec.value === "number");
    assert(rec.timestamp > 0);
  }
});
