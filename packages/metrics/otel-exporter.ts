/**
 * OpenTelemetry metrics exporter for RailFog data-plane metrics.
 *
 * Implements OpenTelemetry-compatible counter and histogram metric aggregation,
 * Prometheus exposition format serialization, OTLP/HTTP JSON serialization,
 * and periodic background export.
 *
 * Spec references:
 * - contracts/platform.contract.md#PLAT-13 (Observability: metrics, counters, histograms)
 * - contracts/platform.contract.md#PLAT-20 (Out of scope: no distributed tracing platforms, no proprietary protocols)
 * - docs/CONSTITUTION.md (The Boundary Rule: OOP/SOLID at package interface boundary)
 */

import type { UsageRecord } from "./usage-collector.ts";

// spec: contracts/platform.contract.md#PLAT-13 — default periodic export interval for OTLP push
export const DEFAULT_EXPORT_INTERVAL_MS = 15000;

// spec: contracts/platform.contract.md#PLAT-13 — standard web latency histogram boundaries in milliseconds
export const DEFAULT_LATENCY_BUCKETS: readonly number[] = [
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1000,
  2500,
  5000,
  10000,
];

// OpenTelemetry specification constants
const OTLP_AGGREGATION_TEMPORALITY_CUMULATIVE = 2;
const OTLP_SERVICE_NAME = "railfog";
const OTLP_SCOPE_NAME = "railfog.metrics";
const OTLP_SCOPE_VERSION = "1.0.0";
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/**
 * Statistical summary and bucket distribution for a histogram metric.
 *
 * spec: contracts/platform.contract.md#PLAT-13
 */
export interface HistogramStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: Record<number, number>;
}

/**
 * Snapshot of all aggregated counters and histograms at a point in time.
 *
 * spec: contracts/platform.contract.md#PLAT-13
 */
export interface MetricSnapshot {
  counters: Record<string, number>;
  histograms: Record<string, HistogramStats>;
  timestamp: number;
}

/**
 * Options for configuring OpenTelemetry metric export.
 *
 * spec: contracts/platform.contract.md#PLAT-13
 */
export interface OtelExporterOptions {
  endpointUrl?: string;
  exportIntervalMs?: number;
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
}

/**
 * Interface for aggregating usage records and exporting OpenTelemetry metrics.
 *
 * spec: contracts/platform.contract.md#PLAT-13
 * spec: contracts/platform.contract.md#PLAT-20 — strictly metrics; no tracing spans or proprietary protocols
 * spec: docs/CONSTITUTION.md — swappable OOP interface at package boundary
 */
export interface MetricsExporter {
  consumeBatch(batch: ReadonlyArray<UsageRecord>): void;
  getSnapshot(): MetricSnapshot;
  toPrometheusText(): string;
  toOtlpJson(): string;
  exportOnce(): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
}

interface CounterDefinition {
  singular: string;
  plural: string;
  help: string;
}

// spec: contracts/platform.contract.md#PLAT-13 — full counter enumeration
const COUNTER_DEFINITIONS: readonly CounterDefinition[] = [
  {
    singular: "function.invocation",
    plural: "function.invocations",
    help: "Total function invocations.",
  },
  {
    singular: "function.error",
    plural: "function.errors",
    help: "Total function execution errors.",
  },
  {
    singular: "kv.read",
    plural: "kv.reads",
    help: "Total KV read operations.",
  },
  {
    singular: "kv.write",
    plural: "kv.writes",
    help: "Total KV write operations.",
  },
  {
    singular: "object.read",
    plural: "object.reads",
    help: "Total object read operations.",
  },
  {
    singular: "object.write",
    plural: "object.writes",
    help: "Total object write operations.",
  },
  {
    singular: "queue.sent",
    plural: "queue.sent",
    help: "Total queue messages sent.",
  },
  {
    singular: "queue.processed",
    plural: "queue.processed",
    help: "Total queue messages processed.",
  },
  {
    singular: "queue.failed",
    plural: "queue.failed",
    help: "Total queue messages failed.",
  },
  {
    singular: "queue.retry",
    plural: "queue.retry",
    help: "Total queue messages retried.",
  },
];

interface HistogramDefinition {
  name: string;
  unit: string;
  help: string;
}

// spec: contracts/platform.contract.md#PLAT-13 — full histogram enumeration
const HISTOGRAM_DEFINITIONS: readonly HistogramDefinition[] = [
  {
    name: "function.duration",
    unit: "ms",
    help: "Function execution duration distribution in milliseconds.",
  },
  {
    name: "function.cpu",
    unit: "ms",
    help: "Function CPU execution time distribution in milliseconds.",
  },
  {
    name: "function.memory",
    unit: "By",
    help: "Function memory usage distribution in bytes.",
  },
];

const METRIC_TO_COUNTER_DEF: ReadonlyMap<string, CounterDefinition> = new Map(
  COUNTER_DEFINITIONS.flatMap((def) => [
    [def.singular, def],
    [def.plural, def],
  ]),
);

/**
 * Default implementation of MetricsExporter.
 *
 * spec: contracts/platform.contract.md#PLAT-13
 */
class DefaultMetricsExporter implements MetricsExporter {
  private readonly options: OtelExporterOptions;
  private readonly counters: Record<string, number> = {};
  private readonly histograms: Record<string, HistogramStats> = {};
  private timerId: ReturnType<typeof setInterval> | null = null;
  private inFlightExport: Promise<boolean> | null = null;

  constructor(options?: OtelExporterOptions) {
    this.options = options ?? {};

    // spec: contracts/platform.contract.md#PLAT-13 — initialize all counters with both singular and plural keys
    for (const def of COUNTER_DEFINITIONS) {
      this.counters[def.singular] = 0;
      this.counters[def.plural] = 0;
    }

    // spec: contracts/platform.contract.md#PLAT-13 — initialize all histograms with standard latency bucket bounds
    for (const def of HISTOGRAM_DEFINITIONS) {
      const buckets: Record<number, number> = {};
      for (const bound of DEFAULT_LATENCY_BUCKETS) {
        buckets[bound] = 0;
      }
      this.histograms[def.name] = {
        count: 0,
        sum: 0,
        min: 0,
        max: 0,
        buckets,
      };
    }
  }

  /**
   * Consumes a batch of DOD usage records and aggregates counter and histogram values.
   *
   * spec: contracts/platform.contract.md#PLAT-13
   * spec: docs/CONSTITUTION.md — DOD plain batch processing into aggregated state
   */
  consumeBatch(batch: ReadonlyArray<UsageRecord>): void {
    for (const record of batch) {
      const counterDef = METRIC_TO_COUNTER_DEF.get(record.metric);
      if (counterDef) {
        const val = record.value;
        if (typeof val === "number" && !isNaN(val)) {
          const updated = (this.counters[counterDef.singular] ?? 0) + val;
          this.counters[counterDef.singular] = updated;
          this.counters[counterDef.plural] = updated;
        }
        continue;
      }

      const hist = this.histograms[record.metric];
      if (hist) {
        const val = record.value;
        if (typeof val === "number" && !isNaN(val)) {
          if (hist.count === 0) {
            hist.min = val;
            hist.max = val;
          } else {
            hist.min = Math.min(hist.min, val);
            hist.max = Math.max(hist.max, val);
          }
          hist.count += 1;
          hist.sum += val;
          for (const bound of DEFAULT_LATENCY_BUCKETS) {
            if (val <= bound) {
              hist.buckets[bound] = (hist.buckets[bound] ?? 0) + 1;
            }
          }
        }
      }
    }
  }

  /**
   * Returns a detached snapshot of current counter and histogram statistics.
   *
   * spec: contracts/platform.contract.md#PLAT-13
   */
  getSnapshot(): MetricSnapshot {
    const counters: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.counters)) {
      counters[k] = v;
    }
    const histograms: Record<string, HistogramStats> = {};
    for (const [k, v] of Object.entries(this.histograms)) {
      histograms[k] = {
        count: v.count,
        sum: v.sum,
        min: v.min,
        max: v.max,
        buckets: { ...v.buckets },
      };
    }
    return {
      counters,
      histograms,
      timestamp: Date.now(),
    };
  }

  /**
   * Serializes accumulated metrics into Prometheus text exposition format.
   *
   * spec: contracts/platform.contract.md#PLAT-13 — Prometheus exposition for scraping via /metrics
   */
  toPrometheusText(): string {
    const lines: string[] = [];

    // Counters: normalized with railfog_ prefix and _total suffix per Prometheus conventions
    for (const def of COUNTER_DEFINITIONS) {
      const metricName = `railfog_${def.plural.replace(/\./g, "_")}_total`;
      lines.push(`# HELP ${metricName} ${def.help}`);
      lines.push(`# TYPE ${metricName} counter`);
      const val = this.counters[def.plural] ?? 0;
      lines.push(`${metricName} ${val}`);
    }

    // Histograms: emits standard _bucket, _sum, and _count metric lines
    for (const def of HISTOGRAM_DEFINITIONS) {
      const metricName = `railfog_${def.name.replace(/\./g, "_")}`;
      lines.push(`# HELP ${metricName} ${def.help}`);
      lines.push(`# TYPE ${metricName} histogram`);
      const hist = this.histograms[def.name];
      if (hist) {
        for (const bound of DEFAULT_LATENCY_BUCKETS) {
          const bucketVal = hist.buckets[bound] ?? 0;
          lines.push(`${metricName}_bucket{le="${bound}"} ${bucketVal}`);
        }
        lines.push(`${metricName}_bucket{le="+Inf"} ${hist.count}`);
        lines.push(`${metricName}_sum ${hist.sum}`);
        lines.push(`${metricName}_count ${hist.count}`);
      }
    }

    return lines.join("\n") + "\n";
  }

  /**
   * Serializes accumulated metrics into standard OpenTelemetry Protocol (OTLP/HTTP) JSON payload.
   *
   * spec: contracts/platform.contract.md#PLAT-13 — OpenTelemetry-compatible metric payload
   * spec: contracts/platform.contract.md#PLAT-20 — metric data only, no distributed tracing spans
   */
  toOtlpJson(): string {
    const timeUnixNano = String(
      BigInt(Date.now()) * NANOSECONDS_PER_MILLISECOND,
    );

    const metrics: unknown[] = [];

    for (const def of COUNTER_DEFINITIONS) {
      const val = this.counters[def.plural] ?? 0;
      metrics.push({
        name: def.plural,
        description: def.help,
        unit: "1",
        sum: {
          aggregationTemporality: OTLP_AGGREGATION_TEMPORALITY_CUMULATIVE,
          isMonotonic: true,
          dataPoints: [
            {
              asInt: val,
              timeUnixNano,
            },
          ],
        },
      });
    }

    for (const def of HISTOGRAM_DEFINITIONS) {
      const hist = this.histograms[def.name];
      const count = hist?.count ?? 0;
      const sum = hist?.sum ?? 0;
      const min = hist?.min ?? 0;
      const max = hist?.max ?? 0;

      // OTLP explicit bounds specification uses non-cumulative counts across bounds + 1 buckets
      const bucketCounts: number[] = [];
      if (hist) {
        let previousCumulative = 0;
        for (const bound of DEFAULT_LATENCY_BUCKETS) {
          const cumulative = hist.buckets[bound] ?? 0;
          bucketCounts.push(cumulative - previousCumulative);
          previousCumulative = cumulative;
        }
        bucketCounts.push(count - previousCumulative);
      } else {
        for (let i = 0; i <= DEFAULT_LATENCY_BUCKETS.length; i++) {
          bucketCounts.push(0);
        }
      }

      metrics.push({
        name: def.name,
        description: def.help,
        unit: def.unit,
        histogram: {
          aggregationTemporality: OTLP_AGGREGATION_TEMPORALITY_CUMULATIVE,
          dataPoints: [
            {
              count,
              sum,
              min,
              max,
              bucketCounts,
              explicitBounds: Array.from(DEFAULT_LATENCY_BUCKETS),
              timeUnixNano,
            },
          ],
        },
      });
    }

    const payload = {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: {
                  stringValue: OTLP_SERVICE_NAME,
                },
              },
            ],
          },
          scopeMetrics: [
            {
              scope: {
                name: OTLP_SCOPE_NAME,
                version: OTLP_SCOPE_VERSION,
              },
              metrics,
            },
          ],
        },
      ],
    };

    return JSON.stringify(payload);
  }

  /**
   * Pushes the current OTLP JSON payload once to the configured endpointUrl.
   *
   * spec: contracts/platform.contract.md#PLAT-13 — HTTP export of OTLP JSON payload
   */
  async exportOnce(): Promise<boolean> {
    if (!this.options.endpointUrl) {
      return false;
    }

    const payload = this.toOtlpJson();
    const fetchFn = this.options.fetchFn ?? fetch;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.options.headers ?? {}),
    };

    let hasContentType = false;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-type") {
        hasContentType = true;
        break;
      }
    }
    if (!hasContentType) {
      headers["Content-Type"] = "application/json";
    }

    try {
      const res = await fetchFn(this.options.endpointUrl, {
        method: "POST",
        headers,
        body: payload,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Starts periodic background export of metrics to endpointUrl.
   *
   * spec: contracts/platform.contract.md#PLAT-13 — periodic push to OpenTelemetry collector
   */
  start(): void {
    if (this.timerId !== null) {
      return;
    }
    const interval = this.options.exportIntervalMs ??
      DEFAULT_EXPORT_INTERVAL_MS;
    this.timerId = setInterval(() => {
      this.inFlightExport = this.exportOnce();
    }, interval);

    if (typeof Deno !== "undefined" && typeof Deno.unrefTimer === "function") {
      Deno.unrefTimer(this.timerId);
    }
  }

  /**
   * Stops periodic background export and awaits any in-flight export.
   *
   * spec: contracts/platform.contract.md#PLAT-13 — clean teardown of background timer
   */
  async stop(): Promise<void> {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.inFlightExport !== null) {
      try {
        await this.inFlightExport;
      } catch {
        // Safe rejection swallowing during teardown
      }
      this.inFlightExport = null;
    }
  }
}

/**
 * Creates a new MetricsExporter instance.
 *
 * spec: contracts/platform.contract.md#PLAT-13
 */
export function createMetricsExporter(
  options?: OtelExporterOptions,
): MetricsExporter {
  return new DefaultMetricsExporter(options);
}
