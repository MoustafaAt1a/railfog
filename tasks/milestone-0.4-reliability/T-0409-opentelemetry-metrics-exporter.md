# T-0409 — OpenTelemetry metrics exporter

Status: Done
Milestone: 0.4 Reliability
Depends on: T-0403
Blocks: T-0412

## Spec references

`PLAT-13` `PLAT-20`

## Scope

**In scope** (be exact — file/module/interface level, not a feature area):
- `packages/metrics/otel-exporter.ts`: export aggregated data-plane usage metrics conforming to OpenTelemetry specifications per PLAT-13:
  - Aggregates counters from `UsageRecord` batches (T-0403): `function.invocations`, `function.errors`, `kv.reads`, `kv.writes`, `object.reads`, `object.writes`, `queue.sent`, `queue.processed`, `queue.failed`, `queue.retry`.
  - Aggregates histograms: `function.duration`, `function.cpu`, `function.memory` (tracking `count`, `sum`, `min`, `max`, and standard bucket distribution).
  - Serialization:
    - `toPrometheusText()`: emits standard Prometheus text exposition format for scraping via `/metrics`.
    - `toOtlpJson()`: emits standard OpenTelemetry Protocol (OTLP/HTTP) JSON metric payload.
  - Background HTTP exporter: periodically posts OTLP payload to an OpenTelemetry collector endpoint using native `fetch`.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Distributed tracing platforms, spans, or trace contexts (strictly banned in 1.0.0 per PLAT-20).
- Proprietary metric protocols (banned per PLAT-13).
- Heavy external third-party SDK dependencies (implemented using standard Web APIs per Engineering Rule 3 & 7).

## Interface to implement

```typescript
import type { UsageRecord } from "./usage-collector.ts";

export interface HistogramStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: Record<number, number>;
}

export interface MetricSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, HistogramStats>;
  timestamp: number;
}

export interface OtelExporterOptions {
  endpointUrl?: string;
  exportIntervalMs?: number; // default 15000
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
}

export interface MetricsExporter {
  consumeBatch(batch: ReadonlyArray<UsageRecord>): void;
  getSnapshot(): MetricSnapshot;
  toPrometheusText(): string;
  toOtlpJson(): string;
  exportOnce(): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
}

export function createMetricsExporter(
  options?: OtelExporterOptions,
): MetricsExporter;
```

## Acceptance criteria (Given/When/Then)

1. Given a batch containing 10 `function.invocation` and 2 `function.error` records, when consumed by `MetricsExporter`, then `getSnapshot()` reflects counter values 10 and 2 respectively.
2. Given a batch containing `function.duration` records of 10ms, 20ms, and 30ms, when consumed, then the histogram records `count: 3`, `sum: 60`, `min: 10`, `max: 30`.
3. Given accumulated metrics, when `toPrometheusText()` is called, then it outputs valid Prometheus metric families including `# TYPE function_invocations counter` and histogram format.
4. Given accumulated metrics, when `toOtlpJson()` is called, then it produces valid OTLP ResourceMetrics JSON conforming to OpenTelemetry specification.
5. Given an exporter configured with `endpointUrl`, when `exportOnce()` runs, then it POSTs the OTLP payload with Content-Type `application/json` to the target endpoint.

## Tests required

- [x] Unit — counter and histogram aggregation math across multiple record batches
- [x] Unit — toPrometheusText format validation against Prometheus parser rules
- [x] Unit — toOtlpJson schema compliance with OTLP ResourceMetrics specifications
- [x] Integration — periodic background export pushes payloads to mock OTLP receiver

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

### Verified Tool Outputs

#### `deno check`
```
Check packages/metrics/otel-exporter.ts
Check packages/metrics/otel-exporter_test.ts
```

#### `deno test`
```
running 20 tests from ./packages/metrics/otel-exporter_test.ts
AC1 & Unit: Consuming batch with 10 function.invocation and 2 function.error records reflects counters in getSnapshot() ... ok (1ms)
AC1 & Unit: All 10 PLAT-13 counters are aggregated accurately across batches ... ok (667µs)
AC1 & Unit: Multiple sequential batches accumulate counter values additively ... ok (1ms)
AC1 & Unit: Counter record with value > 1 adds value additively ... ok (357µs)
AC2 & Unit: Consuming function.duration records of 10, 20, 30 results in count: 3, sum: 60, min: 10, max: 30 ... ok (468µs)
AC2 & Unit: Standard bucket distribution tallies values cumulatively ... ok (492µs)
AC2 & Unit: Multiple sequential batches accumulate histogram math additively ... ok (338µs)
AC2 & Unit: function.cpu and function.memory histograms aggregate math correctly ... ok (812µs)
AC2 & Unit: Empty histogram has zero count, sum, min, and max ... ok (372µs)
AC3 & Unit: toPrometheusText() emits valid Prometheus exposition format for counters and histograms ... ok (1ms)
AC4 & Unit: toOtlpJson() emits valid OTLP JSON schema with ResourceMetrics, ScopeMetrics, and DataPoints ... ok (1ms)
AC5 & Integration: exportOnce() POSTs OTLP payload to endpointUrl with application/json and custom headers ... ok (10ms)
AC5 & Integration: exportOnce() returns false on HTTP error status (4xx/5xx) without throwing unhandled rejection ... ok (924µs)
AC5 & Integration: exportOnce() returns false on network error without throwing unhandled rejection ... ok (589µs)
AC5 & Integration: Background periodic export loop starts, fires periodically, and stops cleanly ... ok (191ms)
AC5 & Integration: Background loop start() is idempotent and stop() on idle exporter is safe ... ok (93ms)
Edge Case: Calling exportOnce() without endpointUrl returns false safely ... ok (266µs)
Edge Case: Consuming empty batches does not throw or corrupt state ... ok (167µs)
Edge Case: Initial exporter snapshot has valid timestamp and defined structures ... ok (187µs)
Edge Case: Serialization on empty exporter returns valid non-throwing output ... ok (918µs)

ok | 20 passed | 0 failed (323ms)
```

#### `deno lint`
```
Checked 2 files
```

## Assumptions made

- [Implementation choice] Metric names are normalized in Prometheus exposition (e.g. `function.invocations` -> `railfog_function_invocations_total`).
- [Implementation choice] Histogram duration buckets default to standard web latency boundaries: `[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]` ms.
- [Implementation choice] Both plural (`function.invocations`) and singular (`function.invocation`) keys are populated in `getSnapshot().counters` with identical accumulated counts for compatibility.
- [Implementation choice] Empty histograms return count: 0, sum: 0, min: 0, max: 0.
- [Implementation choice] OTLP metrics specify cumulative aggregation temporality (2) and monotonic sum for counters.
- [Implementation choice] Periodic background export defaults to 15000 ms interval per `DEFAULT_EXPORT_INTERVAL_MS`.
