# T-0403 — Data-plane usage accounting batch collector

Status: Done
Milestone: 0.4 Reliability
Depends on: T-0102
Blocks: T-0409, T-0412

## Spec references

`PLAT-13`

## Scope

**In scope** (be exact — file/module/interface level, not a feature area):
- `packages/metrics/usage-collector.ts`: implement data-oriented usage accounting collector adhering to `docs/CONSTITUTION.md` Boundary Rule ("model as a flat, pre-sized buffer of plain records, appended to in the hot path, flushed in a batch on a timer or size threshold").
- Plain typed struct `UsageRecord` capturing resource operations defined in PLAT-13:
  - Counters: `function.invocation`, `function.error`, `kv.read`, `kv.write`, `object.read`, `object.write`, `queue.sent`, `queue.processed`, `queue.failed`, `queue.retry`.
  - Histograms / Gauges: `function.duration`, `function.cpu`, `function.memory`.
- In-memory ring buffer with pre-allocated capacity:
  - Default `maxBufferSize = 10000`.
  - Default `flushBatchSize = 500`.
  - Default `flushIntervalMs = 5000`.
- Automatic batch flushing triggered when buffer size reaches `flushBatchSize` or periodic background interval fires.
- Buffer overflow handling: bounds memory by dropping oldest entries or counting dropped events under load spikes to prevent runtime node Out-Of-Memory failures.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- OpenTelemetry protocol network serialization and HTTP export (T-0409).
- Pricing tables, credit deductions, or billing invoicing.
- Per-invocation limit kills or cgroup enforcement (T-0307, T-0308).

## Interface to implement

```typescript
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

export interface UsageRecord {
  timestamp: number;
  project: string;
  functionName: string;
  revisionId: string;
  metric: UsageMetricType;
  value: number;
}

export interface UsageCollectorOptions {
  maxBufferSize?: number; // default 10000
  flushBatchSize?: number; // default 500
  flushIntervalMs?: number; // default 5000
  onFlush?: (batch: ReadonlyArray<UsageRecord>) => Promise<void> | void;
}

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

export function createUsageCollector(
  options?: UsageCollectorOptions,
): UsageBatchCollector;
```

## Acceptance criteria (Given/When/Then)

1. Given a new `UsageBatchCollector`, when `record` is called with operation details, then the event is appended to the internal buffer and `getBufferSize()` increments by 1.
2. Given a collector with `flushBatchSize = 500`, when 500 events are recorded, then the `onFlush` callback is invoked with all 500 records and the buffer is drained.
3. Given a collector with events below `flushBatchSize`, when `flushIntervalMs` elapses, then the background timer automatically invokes `onFlush` with the pending batch.
4. Given a collector with `maxBufferSize = 10000`, when incoming events exceed 10000 before flushing, then excess events increment `getDroppedCount()` without unbounded memory allocation.
5. Given a running collector with an active flush timer, when `dispose` is called, then pending records are flushed and background timers are cleared cleanly.

## Tests required

- [x] Unit — record appends and buffer size tracking without object allocation per method
- [x] Unit — batch size threshold auto-flush trigger
- [x] Unit — periodic timer-based flush trigger
- [x] Unit — maxBufferSize bounding and drop counter under buffer saturation
- [x] Integration — concurrent record calls under high throughput flush batches cleanly

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

```
$ deno check packages/metrics/usage-collector.ts packages/metrics/usage-collector_test.ts
EXIT: 0

$ deno test packages/metrics/usage-collector_test.ts
running 16 tests from ./packages/metrics/usage-collector_test.ts
AC1 & Checklist (1): Initial collector has zero buffer size and zero dropped records ... ok (15ms)
AC1 & Checklist (1): Calling record appends event and increments buffer size ... ok (430µs)
AC1: All 13 PLAT-13 metric types can be recorded accurately ... ok (1ms)
AC1 & DOD: Flat primitive arguments in record avoid caller heap allocation ... ok (373µs)
AC2 & Checklist (2): Reaching flushBatchSize automatically triggers onFlush and drains buffer ... ok (1ms)
AC2: Default flushBatchSize of 500 triggers auto-flush at 500 items ... ok (1ms)
AC2: Async onFlush callback is supported without dropping pending items ... ok (42ms)
AC3 & Checklist (3): Pending items below batch size flush automatically when flushIntervalMs elapses ... ok (93ms)
AC3: Empty buffer does not trigger redundant onFlush invocations on timer fire ... ok (109ms)
AC3: Successive periodic timer flushes handle multiple batches over time ... ok (156ms)
AC4 & Checklist (4): Exceeding maxBufferSize increments droppedCount without unbounded buffer growth ... ok (384µs)
AC4: Default maxBufferSize of 10000 bounds memory under large volume ... ok (7ms)
AC5: Calling dispose flushes all pending records and clears timer cleanly ... ok (116ms)
AC5: Calling dispose on an empty collector completes without error ... ok (221µs)
AC5: Calling record after dispose is gracefully ignored or dropped without crash ... ok (136µs)
Checklist (5) (Integration): High-throughput concurrent record calls flush batches cleanly ... ok (80ms)

ok | 16 passed | 0 failed (651ms)
EXIT: 0

$ deno lint packages/metrics/usage-collector.ts packages/metrics/usage-collector_test.ts
Checked 2 files
EXIT: 0

$ deno fmt --check packages/metrics/usage-collector.ts packages/metrics/usage-collector_test.ts
Checked 2 files
EXIT: 0
```

## Assumptions made

- `record` takes flat primitive arguments (`project`, `functionName`, `revisionId`, `metric`, `value`) to avoid caller-side object allocations on the request hot path.
- In-memory buffer stores plain `UsageRecord` structs in a flat array drained on flush.
- Dropped records increment an internal counter accessible via `getDroppedCount()` for observability under capacity saturation and post-disposal calls.
- Background interval timer is unreferenced via `Deno.unrefTimer` so as not to prevent idle shutdown or trigger leak detector in tests, and cleared on `dispose()`.
- In-flight async `onFlush` callback promises are tracked during batch drain so `dispose()` awaits all pending flushes cleanly.
