/**
 * OpenTelemetry metrics exporter test suite.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-13 (Observability: metrics, counters, histograms)
 * - docs/contracts/platform.contract.md#PLAT-20 (Out of scope: no distributed tracing platforms/spans, no proprietary protocols)
 * - tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md (AC1 - AC5, Tests required)
 */

import {
  assert,
  assertEquals,
  assertGreaterOrEqual,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { delay } from "@std/async/delay";
import {
  createMetricsExporter,
  type HistogramStats,
  type MetricsExporter,
  type MetricSnapshot,
  type OtelExporterOptions,
} from "../../packages/metrics/otel-exporter.ts";
import type {
  UsageMetricType,
  UsageRecord,
} from "../../packages/metrics/usage-collector.ts";

// ============================================================================
// Test Helpers
// ============================================================================

function makeRecord(
  metric: UsageMetricType,
  value = 1,
  overrides?: Partial<UsageRecord>,
): UsageRecord {
  return {
    timestamp: Date.now(),
    project: "proj_test",
    functionName: "fn_test",
    revisionId: "rev_01J",
    metric,
    value,
    ...overrides,
  };
}

/**
 * Helper to retrieve counter values regardless of whether the implementation
 * keys by the UsageMetricType string (e.g. "function.invocation") or the
 * PLAT-13 pluralized string (e.g. "function.invocations").
 */
function getCounter(
  snapshot: MetricSnapshot,
  singular: string,
  plural: string,
): number {
  if (snapshot.counters[plural] !== undefined) {
    return snapshot.counters[plural];
  }
  if (snapshot.counters[singular] !== undefined) {
    return snapshot.counters[singular];
  }
  return 0;
}

/**
 * Case-insensitive header lookup helper for mock fetch RequestInit.
 */
function getHeader(
  headers: HeadersInit | undefined,
  headerName: string,
): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) {
    return headers.get(headerName);
  }
  if (Array.isArray(headers)) {
    const found = headers.find(
      ([k]) => k.toLowerCase() === headerName.toLowerCase(),
    );
    return found ? found[1] : null;
  }
  const record = headers as Record<string, string>;
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === headerName.toLowerCase()) {
      return v;
    }
  }
  return null;
}

// ============================================================================
// AC1 & Unit: Counter aggregation across batches
// ============================================================================

Deno.test("AC1 & Unit: Consuming batch with 10 function.invocation and 2 function.error records reflects counters in getSnapshot()", () => {
  // spec: contracts/platform.contract.md#PLAT-13
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#AC1
  const exporter: MetricsExporter = createMetricsExporter();

  const batch: UsageRecord[] = [
    ...Array.from({ length: 10 }, () => makeRecord("function.invocation", 1)),
    ...Array.from({ length: 2 }, () => makeRecord("function.error", 1)),
  ];

  exporter.consumeBatch(batch);

  const snapshot: MetricSnapshot = exporter.getSnapshot();
  const invocations = getCounter(
    snapshot,
    "function.invocation",
    "function.invocations",
  );
  const errors = getCounter(snapshot, "function.error", "function.errors");

  assertEquals(invocations, 10);
  assertEquals(errors, 2);
  assertGreaterOrEqual(snapshot.timestamp, 1);
});

Deno.test("AC1 & Unit: All 10 PLAT-13 counters are aggregated accurately across batches", () => {
  // spec: contracts/platform.contract.md#PLAT-13 — Full counter enumeration:
  // function.invocations, function.errors, kv.reads, kv.writes, object.reads,
  // object.writes, queue.sent, queue.processed, queue.failed, queue.retry
  const exporter = createMetricsExporter();

  const counterDefinitions: Array<{
    metric: UsageMetricType;
    singular: string;
    plural: string;
    count: number;
  }> = [
    {
      metric: "function.invocation",
      singular: "function.invocation",
      plural: "function.invocations",
      count: 12,
    },
    {
      metric: "function.error",
      singular: "function.error",
      plural: "function.errors",
      count: 3,
    },
    {
      metric: "kv.read",
      singular: "kv.read",
      plural: "kv.reads",
      count: 25,
    },
    {
      metric: "kv.write",
      singular: "kv.write",
      plural: "kv.writes",
      count: 7,
    },
    {
      metric: "object.read",
      singular: "object.read",
      plural: "object.reads",
      count: 14,
    },
    {
      metric: "object.write",
      singular: "object.write",
      plural: "object.writes",
      count: 4,
    },
    {
      metric: "queue.sent",
      singular: "queue.sent",
      plural: "queue.sent",
      count: 9,
    },
    {
      metric: "queue.processed",
      singular: "queue.processed",
      plural: "queue.processed",
      count: 8,
    },
    {
      metric: "queue.failed",
      singular: "queue.failed",
      plural: "queue.failed",
      count: 2,
    },
    {
      metric: "queue.retry",
      singular: "queue.retry",
      plural: "queue.retry",
      count: 5,
    },
  ];

  const batch: UsageRecord[] = [];
  for (const def of counterDefinitions) {
    for (let i = 0; i < def.count; i++) {
      batch.push(makeRecord(def.metric, 1));
    }
  }

  exporter.consumeBatch(batch);

  const snapshot = exporter.getSnapshot();
  for (const def of counterDefinitions) {
    const val = getCounter(snapshot, def.singular, def.plural);
    assertEquals(
      val,
      def.count,
      `Expected counter ${def.plural} to equal ${def.count}, got ${val}`,
    );
  }
});

Deno.test("AC1 & Unit: Multiple sequential batches accumulate counter values additively", () => {
  // spec: contracts/platform.contract.md#PLAT-13
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#AC1
  const exporter = createMetricsExporter();

  // Batch 1: 5 invocations, 3 kv reads
  const batch1: UsageRecord[] = [
    ...Array.from({ length: 5 }, () => makeRecord("function.invocation", 1)),
    ...Array.from({ length: 3 }, () => makeRecord("kv.read", 1)),
  ];
  exporter.consumeBatch(batch1);

  let snapshot = exporter.getSnapshot();
  assertEquals(
    getCounter(snapshot, "function.invocation", "function.invocations"),
    5,
  );
  assertEquals(getCounter(snapshot, "kv.read", "kv.reads"), 3);

  // Batch 2: 7 more invocations, 4 more kv reads, 2 queue.sent
  const batch2: UsageRecord[] = [
    ...Array.from({ length: 7 }, () => makeRecord("function.invocation", 1)),
    ...Array.from({ length: 4 }, () => makeRecord("kv.read", 1)),
    ...Array.from({ length: 2 }, () => makeRecord("queue.sent", 1)),
  ];
  exporter.consumeBatch(batch2);

  snapshot = exporter.getSnapshot();
  assertEquals(
    getCounter(snapshot, "function.invocation", "function.invocations"),
    12,
  );
  assertEquals(getCounter(snapshot, "kv.read", "kv.reads"), 7);
  assertEquals(getCounter(snapshot, "queue.sent", "queue.sent"), 2);
});

Deno.test("AC1 & Unit: Counter record with value > 1 adds value additively", () => {
  // spec: contracts/platform.contract.md#PLAT-13
  const exporter = createMetricsExporter();

  exporter.consumeBatch([
    makeRecord("function.invocation", 5),
    makeRecord("function.invocation", 10),
  ]);

  const snapshot = exporter.getSnapshot();
  assertEquals(
    getCounter(snapshot, "function.invocation", "function.invocations"),
    15,
  );
});

// ============================================================================
// AC2 & Unit: Histogram aggregation math across batches
// ============================================================================

Deno.test("AC2 & Unit: Consuming function.duration records of 10, 20, 30 results in count: 3, sum: 60, min: 10, max: 30", () => {
  // spec: contracts/platform.contract.md#PLAT-13
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#AC2
  const exporter = createMetricsExporter();

  exporter.consumeBatch([
    makeRecord("function.duration", 10),
    makeRecord("function.duration", 20),
    makeRecord("function.duration", 30),
  ]);

  const snapshot = exporter.getSnapshot();
  const hist: HistogramStats | undefined =
    snapshot.histograms["function.duration"];
  assert(hist !== undefined, "Expected function.duration histogram to exist");

  assertEquals(hist.count, 3);
  assertEquals(hist.sum, 60);
  assertEquals(hist.min, 10);
  assertEquals(hist.max, 30);
});

Deno.test("AC2 & Unit: Standard bucket distribution tallies values cumulatively", () => {
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#Assumptions
  // Standard buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
  const exporter = createMetricsExporter();

  exporter.consumeBatch([
    makeRecord("function.duration", 10),
    makeRecord("function.duration", 20),
    makeRecord("function.duration", 30),
  ]);

  const snapshot = exporter.getSnapshot();
  const hist = snapshot.histograms["function.duration"];
  assert(hist !== undefined, "Expected function.duration histogram to exist");
  assert(hist.buckets !== undefined, "Expected buckets to be defined");

  // Value 10 is <= 10; values 20, 30 are > 10. Cumulative count for le 5 is 0, le 10 is 1.
  assertEquals(hist.buckets[5] ?? 0, 0);
  assertEquals(hist.buckets[10], 1);

  // Values 10 and 20 are <= 25. Cumulative count for le 25 is 2.
  assertEquals(hist.buckets[25], 2);

  // Values 10, 20, 30 are all <= 50. Cumulative count for le 50 is 3.
  assertEquals(hist.buckets[50], 3);

  // All higher buckets must include all 3 observations.
  assertEquals(hist.buckets[100], 3);
  assertEquals(hist.buckets[250], 3);
  assertEquals(hist.buckets[500], 3);
  assertEquals(hist.buckets[1000], 3);
  assertEquals(hist.buckets[2500], 3);
  assertEquals(hist.buckets[5000], 3);
  assertEquals(hist.buckets[10000], 3);
});

Deno.test("AC2 & Unit: Multiple sequential batches accumulate histogram math additively", () => {
  // spec: contracts/platform.contract.md#PLAT-13
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#AC2
  const exporter = createMetricsExporter();

  // Batch 1: durations 10, 20, 30
  exporter.consumeBatch([
    makeRecord("function.duration", 10),
    makeRecord("function.duration", 20),
    makeRecord("function.duration", 30),
  ]);

  // Batch 2: durations 2, 150
  exporter.consumeBatch([
    makeRecord("function.duration", 2),
    makeRecord("function.duration", 150),
  ]);

  const snapshot = exporter.getSnapshot();
  const hist = snapshot.histograms["function.duration"];
  assert(hist !== undefined);

  // Total count: 5, sum: 60 + 2 + 150 = 212, min: 2, max: 150
  assertEquals(hist.count, 5);
  assertEquals(hist.sum, 212);
  assertEquals(hist.min, 2);
  assertEquals(hist.max, 150);

  // Buckets:
  // <= 5: [2] -> 1
  // <= 10: [2, 10] -> 2
  // <= 25: [2, 10, 20] -> 3
  // <= 50: [2, 10, 20, 30] -> 4
  // <= 100: [2, 10, 20, 30] -> 4
  // <= 250: [2, 10, 20, 30, 150] -> 5
  // <= 10000: [2, 10, 20, 30, 150] -> 5
  assertEquals(hist.buckets[5], 1);
  assertEquals(hist.buckets[10], 2);
  assertEquals(hist.buckets[25], 3);
  assertEquals(hist.buckets[50], 4);
  assertEquals(hist.buckets[100], 4);
  assertEquals(hist.buckets[250], 5);
  assertEquals(hist.buckets[10000], 5);
});

Deno.test("AC2 & Unit: function.cpu and function.memory histograms aggregate math correctly", () => {
  // spec: contracts/platform.contract.md#PLAT-13 — histograms: function.duration, function.cpu, function.memory
  const exporter = createMetricsExporter();

  exporter.consumeBatch([
    makeRecord("function.cpu", 15),
    makeRecord("function.cpu", 25),
    makeRecord("function.cpu", 60),
    makeRecord("function.memory", 32),
    makeRecord("function.memory", 64),
    makeRecord("function.memory", 128),
  ]);

  const snapshot = exporter.getSnapshot();

  const cpuHist = snapshot.histograms["function.cpu"];
  assert(cpuHist !== undefined, "Expected function.cpu histogram to exist");
  assertEquals(cpuHist.count, 3);
  assertEquals(cpuHist.sum, 100);
  assertEquals(cpuHist.min, 15);
  assertEquals(cpuHist.max, 60);

  const memHist = snapshot.histograms["function.memory"];
  assert(memHist !== undefined, "Expected function.memory histogram to exist");
  assertEquals(memHist.count, 3);
  assertEquals(memHist.sum, 224);
  assertEquals(memHist.min, 32);
  assertEquals(memHist.max, 128);
});

Deno.test("AC2 & Unit: Empty histogram has zero count, sum, min, and max", () => {
  // spec: contracts/platform.contract.md#PLAT-13
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#AC2
  const exporter = createMetricsExporter();
  const snapshot = exporter.getSnapshot();

  const durationHist = snapshot.histograms["function.duration"];
  if (durationHist !== undefined) {
    assertEquals(durationHist.count, 0);
    assertEquals(durationHist.sum, 0);
    assertEquals(durationHist.min, 0);
    assertEquals(durationHist.max, 0);
  }
});

// ============================================================================
// AC3 & Unit: toPrometheusText() format validation
// ============================================================================

Deno.test("AC3 & Unit: toPrometheusText() emits valid Prometheus exposition format for counters and histograms", () => {
  // spec: contracts/platform.contract.md#PLAT-13
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#AC3
  const exporter = createMetricsExporter();

  exporter.consumeBatch([
    ...Array.from({ length: 10 }, () => makeRecord("function.invocation", 1)),
    ...Array.from({ length: 2 }, () => makeRecord("function.error", 1)),
    makeRecord("function.duration", 10),
    makeRecord("function.duration", 20),
    makeRecord("function.duration", 30),
  ]);

  const text = exporter.toPrometheusText();
  assert(typeof text === "string");
  assert(text.length > 0, "Prometheus text output must not be empty");

  // Must end with a newline per Prometheus text exposition spec
  assert(
    text.endsWith("\n"),
    "Prometheus exposition format must end with newline",
  );

  // Counter TYPE declaration
  assertMatch(
    text,
    /#\s*TYPE\s+(?:railfog_)?function_invocations(?:_total)?\s+counter/i,
    "Missing counter TYPE declaration for function_invocations",
  );

  // Counter metric line with value 10
  assertMatch(
    text,
    /(?:railfog_)?function_invocations(?:_total)?(?:\s*\{[^}]*\})?\s+10(?:\.0+)?/i,
    "Missing or invalid counter value line for function_invocations",
  );

  // Error counter metric line with value 2
  assertMatch(
    text,
    /(?:railfog_)?function_errors(?:_total)?(?:\s*\{[^}]*\})?\s+2(?:\.0+)?/i,
    "Missing or invalid counter value line for function_errors",
  );

  // Histogram TYPE declaration
  assertMatch(
    text,
    /#\s*TYPE\s+(?:railfog_)?function_duration(?:[a-zA-Z0-9_]*)\s+histogram/i,
    "Missing histogram TYPE declaration for function_duration",
  );

  // Histogram bucket lines: le="10", le="50", le="+Inf"
  assertMatch(
    text,
    /(?:railfog_)?function_duration(?:[a-zA-Z0-9_]*)_bucket\{[^}]*le="10"[^}]*\}\s+1(?:\.0+)?/i,
    "Missing or invalid bucket line for le=10",
  );
  assertMatch(
    text,
    /(?:railfog_)?function_duration(?:[a-zA-Z0-9_]*)_bucket\{[^}]*le="50"[^}]*\}\s+3(?:\.0+)?/i,
    "Missing or invalid bucket line for le=50",
  );
  assertMatch(
    text,
    /(?:railfog_)?function_duration(?:[a-zA-Z0-9_]*)_bucket\{[^}]*le="\+Inf"[^}]*\}\s+3(?:\.0+)?/i,
    "Missing or invalid bucket line for le=+Inf",
  );

  // Histogram _sum line with sum 60
  assertMatch(
    text,
    /(?:railfog_)?function_duration(?:[a-zA-Z0-9_]*)_sum(?:\s*\{[^}]*\})?\s+60(?:\.0+)?/i,
    "Missing or invalid histogram _sum line",
  );

  // Histogram _count line with count 3
  assertMatch(
    text,
    /(?:railfog_)?function_duration(?:[a-zA-Z0-9_]*)_count(?:\s*\{[^}]*\})?\s+3(?:\.0+)?/i,
    "Missing or invalid histogram _count line",
  );

  // Check HELP lines
  assertStringIncludes(text, "# HELP ");
  assertMatch(
    text,
    /#\s*HELP\s+/i,
    "Prometheus text should contain HELP comments",
  );
});

// ============================================================================
// AC4 & Unit: toOtlpJson() schema compliance
// ============================================================================

Deno.test("AC4 & Unit: toOtlpJson() emits valid OTLP JSON schema with ResourceMetrics, ScopeMetrics, and DataPoints", () => {
  // spec: contracts/platform.contract.md#PLAT-13
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#AC4
  const exporter = createMetricsExporter();

  exporter.consumeBatch([
    ...Array.from({ length: 10 }, () => makeRecord("function.invocation", 1)),
    makeRecord("function.duration", 10),
    makeRecord("function.duration", 20),
    makeRecord("function.duration", 30),
  ]);

  const rawJson = exporter.toOtlpJson();
  assert(typeof rawJson === "string");

  // Schema parsing
  const payload = JSON.parse(rawJson);
  assert(
    Array.isArray(payload.resourceMetrics),
    "Payload must contain resourceMetrics array",
  );
  assert(
    payload.resourceMetrics.length >= 1,
    "resourceMetrics array must have at least 1 element",
  );

  const rm = payload.resourceMetrics[0];
  assert(
    rm.resource !== undefined,
    "ResourceMetrics must contain resource object",
  );
  assert(
    Array.isArray(rm.resource.attributes),
    "Resource must contain attributes array",
  );
  assert(
    Array.isArray(rm.scopeMetrics),
    "ResourceMetrics must contain scopeMetrics array",
  );
  assert(
    rm.scopeMetrics.length >= 1,
    "scopeMetrics must have at least 1 element",
  );

  const sm = rm.scopeMetrics[0];
  assert(Array.isArray(sm.metrics), "ScopeMetrics must contain metrics array");

  // Validate Counter metric
  interface OtelDataPoint {
    asInt?: number | string;
    asDouble?: number;
    value?: number;
    timeUnixNano?: string | number;
    startTimeUnixNano?: string | number;
    timestamp?: number;
    count?: number | string;
    sum?: number | string;
    min?: number | string;
    max?: number | string;
    bucketCounts?: number[];
    explicitBounds?: number[];
  }

  interface OtelMetric {
    name: string;
    sum?: { dataPoints: OtelDataPoint[] };
    histogram?: { dataPoints: OtelDataPoint[] };
    dataPoints?: OtelDataPoint[];
  }

  const counterMetric = sm.metrics.find((m: OtelMetric) =>
    m.name.includes("function.invocation") ||
    m.name.includes("function_invocation") ||
    m.name.includes("function.invocations") ||
    m.name.includes("function_invocations")
  );
  assert(
    counterMetric !== undefined,
    "Counter metric for function invocations not found in OTLP payload",
  );

  const counterDp: OtelDataPoint | undefined =
    counterMetric.sum?.dataPoints?.[0] ?? counterMetric.dataPoints?.[0];
  assert(
    counterDp !== undefined,
    "Counter metric must contain at least one dataPoint",
  );
  const counterVal = counterDp.asInt ?? counterDp.asDouble ?? counterDp.value;
  assertEquals(Number(counterVal), 10);
  assert(
    counterDp.timeUnixNano !== undefined ||
      counterDp.timestamp !== undefined ||
      counterDp.startTimeUnixNano !== undefined,
    "Counter dataPoint must have a timestamp field",
  );

  // Validate Histogram metric
  const histMetric = sm.metrics.find((m: OtelMetric) =>
    m.name.includes("function.duration") ||
    m.name.includes("function_duration")
  );
  assert(
    histMetric !== undefined,
    "Histogram metric for function duration not found in OTLP payload",
  );

  const histDp: OtelDataPoint | undefined =
    histMetric.histogram?.dataPoints?.[0] ?? histMetric.dataPoints?.[0];
  assert(
    histDp !== undefined,
    "Histogram metric must contain at least one dataPoint",
  );
  assertEquals(Number(histDp.count), 3);
  assertEquals(Number(histDp.sum), 60);
  assertEquals(Number(histDp.min), 10);
  assertEquals(Number(histDp.max), 30);
  assert(
    Array.isArray(histDp.bucketCounts),
    "Histogram dataPoint must contain bucketCounts array",
  );
  assert(
    Array.isArray(histDp.explicitBounds),
    "Histogram dataPoint must contain explicitBounds array",
  );
});

// ============================================================================
// AC5 & Integration: Periodic background export and exportOnce()
// ============================================================================

Deno.test("AC5 & Integration: exportOnce() POSTs OTLP payload to endpointUrl with application/json and custom headers", async () => {
  // spec: contracts/platform.contract.md#PLAT-13
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#AC5
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;

  const mockFetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedUrl = input.toString();
    capturedInit = init;
    return Promise.resolve(
      new Response(JSON.stringify({ status: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  const options: OtelExporterOptions = {
    endpointUrl: "https://otlp.collector.example.com/v1/metrics",
    headers: {
      Authorization: "Bearer otlp_secret_tok_123",
      "X-RailFog-Source": "data-plane",
    },
    fetchFn: mockFetch as typeof fetch,
  };
  const exporter = createMetricsExporter(options);

  exporter.consumeBatch([makeRecord("function.invocation", 1)]);

  const success = await exporter.exportOnce();
  assertEquals(success, true);

  assertEquals(
    capturedUrl,
    "https://otlp.collector.example.com/v1/metrics",
  );
  assertEquals(capturedInit?.method, "POST");

  // Headers check
  const contentType = getHeader(capturedInit?.headers, "Content-Type");
  assert(
    contentType !== null && contentType.includes("application/json"),
    `Expected Content-Type application/json, got ${contentType}`,
  );
  const authHeader = getHeader(capturedInit?.headers, "Authorization");
  assertEquals(authHeader, "Bearer otlp_secret_tok_123");
  const sourceHeader = getHeader(capturedInit?.headers, "X-RailFog-Source");
  assertEquals(sourceHeader, "data-plane");

  // Body check
  assert(
    typeof capturedInit?.body === "string",
    "Request body must be a string",
  );
  const parsedBody = JSON.parse(capturedInit.body as string);
  assert(Array.isArray(parsedBody.resourceMetrics));
});

Deno.test("AC5 & Integration: exportOnce() returns false on HTTP error status (4xx/5xx) without throwing unhandled rejection", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#AC5
  const mockFetch = (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(
      new Response("Internal Server Error", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
  };

  const exporter = createMetricsExporter({
    endpointUrl: "https://otlp.collector.example.com/v1/metrics",
    fetchFn: mockFetch as typeof fetch,
  });

  exporter.consumeBatch([makeRecord("function.invocation", 1)]);

  const success = await exporter.exportOnce();
  assertEquals(success, false);
});

Deno.test("AC5 & Integration: exportOnce() returns false on network error without throwing unhandled rejection", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#AC5
  const mockFetch = (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.reject(
      new Error("Network connection refused: 127.0.0.1:4318"),
    );
  };

  const exporter = createMetricsExporter({
    endpointUrl: "https://otlp.collector.example.com/v1/metrics",
    fetchFn: mockFetch as typeof fetch,
  });

  exporter.consumeBatch([makeRecord("function.invocation", 1)]);

  const success = await exporter.exportOnce();
  assertEquals(success, false);
});

Deno.test("AC5 & Integration: Background periodic export loop starts, fires periodically, and stops cleanly", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#AC5
  let callCount = 0;

  const mockFetch = (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    callCount++;
    return Promise.resolve(
      new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    );
  };

  const exporter = createMetricsExporter({
    endpointUrl: "https://otlp.collector.example.com/v1/metrics",
    exportIntervalMs: 30,
    fetchFn: mockFetch as typeof fetch,
  });

  exporter.consumeBatch([makeRecord("function.invocation", 1)]);

  // Start periodic loop
  exporter.start();

  // Wait long enough for at least 2 ticks (30ms interval * 3 = ~90ms)
  await delay(95);
  assertGreaterOrEqual(
    callCount,
    2,
    `Expected at least 2 exports during background loop, got ${callCount}`,
  );

  // Stop background loop
  await exporter.stop();
  const callsAtStop = callCount;

  // Wait additional time to verify no more calls happen after stop
  await delay(70);
  assertEquals(
    callCount,
    callsAtStop,
    "Export calls must not continue after stop() is called",
  );
});

Deno.test("AC5 & Integration: Background loop start() is idempotent and stop() on idle exporter is safe", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#AC5
  let callCount = 0;
  const mockFetch = (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    callCount++;
    return Promise.resolve(new Response("ok", { status: 200 }));
  };

  const exporter = createMetricsExporter({
    endpointUrl: "https://otlp.collector.example.com/v1/metrics",
    exportIntervalMs: 40,
    fetchFn: mockFetch as typeof fetch,
  });

  // Stopping before start should resolve without error
  await exporter.stop();

  // Calling start twice shouldn't duplicate timers
  exporter.start();
  exporter.start();

  await delay(90);
  assertGreaterOrEqual(callCount, 1);

  await exporter.stop();
  // Multiple stops should resolve cleanly
  await exporter.stop();
});

// ============================================================================
// Negative & Edge Cases
// ============================================================================

Deno.test("Edge Case: Calling exportOnce() without endpointUrl returns false safely", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#AC5
  const exporter = createMetricsExporter();
  exporter.consumeBatch([makeRecord("function.invocation", 1)]);

  const result = await exporter.exportOnce();
  assertEquals(result, false);
});

Deno.test("Edge Case: Consuming empty batches does not throw or corrupt state", () => {
  // spec: tasks/milestone-0.4-reliability/T-0409-opentelemetry-metrics-exporter.md#Tests-required
  const exporter = createMetricsExporter();

  exporter.consumeBatch([]);
  const snapshot = exporter.getSnapshot();

  assertGreaterOrEqual(snapshot.timestamp, 1);
  assertEquals(typeof snapshot.counters, "object");
  assertEquals(typeof snapshot.histograms, "object");
});

Deno.test("Edge Case: Initial exporter snapshot has valid timestamp and defined structures", () => {
  const exporter = createMetricsExporter();
  const snapshot = exporter.getSnapshot();

  assertGreaterOrEqual(snapshot.timestamp, 1);
  assertEquals(typeof snapshot.counters, "object");
  assertEquals(typeof snapshot.histograms, "object");
});

Deno.test("Edge Case: Serialization on empty exporter returns valid non-throwing output", () => {
  const exporter = createMetricsExporter();

  const prometheusText = exporter.toPrometheusText();
  assertEquals(typeof prometheusText, "string");

  const otlpJson = exporter.toOtlpJson();
  assertEquals(typeof otlpJson, "string");
  const parsed = JSON.parse(otlpJson);
  assert(Array.isArray(parsed.resourceMetrics));
});
