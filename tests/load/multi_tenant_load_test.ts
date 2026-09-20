/**
 * Multi-Tenant Load Benchmark & High-Concurrency Harness Test Suite (T-0609).
 *
 * Validates high-concurrency multi-tenant throughput, latency percentiles (p50, p95, p99),
 * token bucket burst shedding (PLAT-9), 99.95% data plane availability SLO (PLAT-10),
 * monotonic ULID request ID injection (PLAT-14), and zero cross-tenant data bleed (PLAT-7, FN-6).
 *
 * Spec references:
 * - contracts/platform.contract.md#PLAT-7: Multi-tenancy & physical prefix isolation.
 * - contracts/platform.contract.md#PLAT-9: Token bucket rate limiting (429 RATE_LIMITED, Retry-After).
 * - contracts/platform.contract.md#PLAT-10: 99.95% data plane availability SLO & error budget.
 * - contracts/platform.contract.md#PLAT-12: Canonical error model (RATE_LIMITED, UNAVAILABLE).
 * - contracts/platform.contract.md#PLAT-14: Monotonic 128-bit Crockford Base32 ULID request IDs.
 * - contracts/functions.contract.md#FN-5: Resource limits & bounded memory consumption.
 * - contracts/functions.contract.md#FN-6: Isolation & warm-reuse rule (zero cross-tenant state bleed).
 * - tasks/milestone-0.6-public-beta/T-0609-multi-tenant-load-harness.md: AC1 - AC4.
 */

import { assert, assertEquals } from "@std/assert";
import type {
  LoadBenchmarkResult,
  LoadScenarioOptions,
  TenantLoadSpec,
} from "../fixtures/load-generator.ts";
import { runLoadBenchmark } from "../fixtures/load-generator.ts";
import type {
  GatewayOptions,
  GatewayServer,
} from "../../apps/gateway/gateway-server.ts";
import { startGatewayServer } from "../../apps/gateway/gateway-server.ts";
import { MultiTenantRateLimiter } from "../../apps/gateway/rate-limiter.ts";
import { isValidUlid } from "../../packages/core/id/ulid.ts";

/**
 * Handle to an active mock data plane server recording requests.
 */
interface MockDataPlane {
  server: Deno.HttpServer;
  url: string;
  receivedRequestIds: string[];
  close: () => Promise<void>;
}

/**
 * Spawns an in-memory mock data plane server on an ephemeral OS-assigned port.
 * Records propagated request IDs and returns JSON echoing tenant and status.
 */
function createMockDataPlane(
  customHandler?: (req: Request) => Promise<Response> | Response,
): MockDataPlane {
  const receivedRequestIds: string[] = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req: Request) => {
      const reqId = req.headers.get("x-request-id") ??
        req.headers.get("request-id") ?? "";
      if (reqId) {
        receivedRequestIds.push(reqId);
      }

      if (customHandler) {
        return await customHandler(req);
      }

      const tenant = req.headers.get("x-project-id") ?? "unknown";
      return new Response(
        JSON.stringify({ tenant, status: "ok" }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": reqId,
            "request-id": reqId,
          },
        },
      );
    },
  );

  const port = (server.addr as Deno.NetAddr).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    receivedRequestIds,
    close: () => server.shutdown(),
  };
}

// ============================================================================
// AC1: Multi-tenant load benchmark within limits (PLAT-10)
// ============================================================================

Deno.test(
  "PLAT-10 (AC1): Multi-tenant load benchmark within limits meets 99.95% SLO",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-10 — 99.95% data plane availability SLO
    // spec: contracts/platform.contract.md#PLAT-7 — Multi-tenant data isolation
    // spec: contracts/functions.contract.md#FN-6 — Zero cross-tenant state bleed under concurrency
    let mockDataPlane: MockDataPlane | undefined;
    let gateway: GatewayServer | undefined;

    try {
      mockDataPlane = createMockDataPlane();
      const options: GatewayOptions = {
        port: 0,
        controlPlaneUrl: mockDataPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      };
      gateway = await startGatewayServer(options);

      const tenantA: TenantLoadSpec = {
        orgId: "org-alpha",
        projectId: "proj-alpha",
        apiKey: "key-alpha",
        targetPath: "/api/hello",
      };

      const tenantB: TenantLoadSpec = {
        orgId: "org-beta",
        projectId: "proj-beta",
        apiKey: "key-beta",
        targetPath: "/api/hello",
      };

      const scenario: LoadScenarioOptions = {
        gatewayUrl: `http://127.0.0.1:${gateway.port}`,
        concurrency: 4,
        durationMs: 500,
        tenants: [tenantA, tenantB],
        targetRps: 50,
      };

      const result: LoadBenchmarkResult = await runLoadBenchmark(scenario);

      // Assertions per AC1 & PLAT-10 SLO requirements
      assert(
        result.totalRequests >= 10,
        `Expected totalRequests >= 10, got ${result.totalRequests}`,
      );
      assert(
        result.successfulRequests > 0,
        `Expected successfulRequests > 0, got ${result.successfulRequests}`,
      );
      assertEquals(
        result.errorRequests,
        0,
        `Expected errorRequests === 0, got ${result.errorRequests}`,
      );
      assert(
        result.availabilityPercent >= 99.95,
        `Expected availabilityPercent >= 99.95 (PLAT-10 SLO), got ${result.availabilityPercent}`,
      );
      assert(
        result.latencyP50Ms > 0,
        `Expected latencyP50Ms > 0, got ${result.latencyP50Ms}`,
      );
      assert(
        result.latencyP95Ms >= result.latencyP50Ms,
        `Expected latencyP95Ms >= latencyP50Ms (${result.latencyP95Ms} vs ${result.latencyP50Ms})`,
      );
      assert(
        result.latencyP99Ms >= result.latencyP95Ms,
        `Expected latencyP99Ms >= latencyP95Ms (${result.latencyP99Ms} vs ${result.latencyP95Ms})`,
      );
      assertEquals(
        result.crossTenantCollisions,
        0,
        `Expected crossTenantCollisions === 0 per PLAT-7 and FN-6, got ${result.crossTenantCollisions}`,
      );
    } finally {
      await gateway?.close();
      await mockDataPlane?.close();
    }
  },
);

// ============================================================================
// AC2: Token bucket shedding under burst load (PLAT-9)
// ============================================================================

Deno.test(
  "PLAT-9 (AC2): Token bucket shedding under burst load cleanly sheds excess requests with 429 without starving benign tenant",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-9 — Token bucket rate limiting: 429 RATE_LIMITED with Retry-After
    // spec: contracts/platform.contract.md#PLAT-10 — Clean rate shedding considered managed traffic under SLO
    // spec: contracts/platform.contract.md#PLAT-7 — Tenant noisy neighbor rate isolation
    let mockDataPlane: MockDataPlane | undefined;
    let gateway: GatewayServer | undefined;

    try {
      mockDataPlane = createMockDataPlane();

      // Tight project token bucket: burst 10, refill rate 5 req/s
      const rateLimiter = new MultiTenantRateLimiter({
        project: { rate: 5, burst: 10 },
      });

      const options: GatewayOptions = {
        port: 0,
        controlPlaneUrl: mockDataPlane.url,
        dataPlaneUrl: mockDataPlane.url,
        rateLimiter,
      };
      gateway = await startGatewayServer(options);

      const tenantBurst: TenantLoadSpec = {
        orgId: "org-burst",
        projectId: "proj-burst",
        apiKey: "key-burst",
        targetPath: "/api/burst",
      };

      const tenantBenign: TenantLoadSpec = {
        orgId: "org-benign",
        projectId: "proj-benign",
        apiKey: "key-benign",
        targetPath: "/api/benign",
      };

      // High targetRps (100 rps) designed to overwhelm burst capacity (10 tokens) within 500ms
      const burstScenario: LoadScenarioOptions = {
        gatewayUrl: `http://127.0.0.1:${gateway.port}`,
        concurrency: 4,
        durationMs: 500,
        tenants: [tenantBurst],
        targetRps: 100,
      };

      // Benign tenant running concurrently at 2 rps (well within 5 req/s rate and 10 burst capacity)
      const benignScenario: LoadScenarioOptions = {
        gatewayUrl: `http://127.0.0.1:${gateway.port}`,
        concurrency: 1,
        durationMs: 500,
        tenants: [tenantBenign],
        targetRps: 2,
      };

      // Execute both bursting tenant and benign tenant simultaneously against the same gateway
      const [burstResult, benignResult] = await Promise.all([
        runLoadBenchmark(burstScenario),
        runLoadBenchmark(benignScenario),
      ]);

      // Assertions per AC2: clean 429 shedding for bursting tenant
      assert(
        burstResult.rateLimitedRequests > 0,
        `Expected burstResult.rateLimitedRequests > 0 due to burst exhaustion, got ${burstResult.rateLimitedRequests}`,
      );
      assertEquals(
        burstResult.errorRequests,
        0,
        `Expected burstResult.errorRequests === 0 (clean shedding per PLAT-9, no internal errors), got ${burstResult.errorRequests}`,
      );
      assert(
        burstResult.availabilityPercent >= 99.95,
        `Expected burstResult.availabilityPercent >= 99.95 (clean 429 shedding is managed traffic), got ${burstResult.availabilityPercent}`,
      );
      assertEquals(
        burstResult.crossTenantCollisions,
        0,
        `Expected zero cross-tenant collisions in burstResult, got ${burstResult.crossTenantCollisions}`,
      );

      // Assertions per AC2 & PLAT-7/PLAT-9: benign tenant is NEVER starved or degraded by noisy neighbor
      assert(
        benignResult.successfulRequests > 0,
        `Expected benignResult.successfulRequests > 0, got ${benignResult.successfulRequests}`,
      );
      assertEquals(
        benignResult.rateLimitedRequests,
        0,
        `Expected benignResult.rateLimitedRequests === 0 (benign tenant must not be rate limited), got ${benignResult.rateLimitedRequests}`,
      );
      assertEquals(
        benignResult.errorRequests,
        0,
        `Expected benignResult.errorRequests === 0, got ${benignResult.errorRequests}`,
      );
      assertEquals(
        benignResult.availabilityPercent,
        100,
        `Expected benignResult.availabilityPercent === 100%, got ${benignResult.availabilityPercent}`,
      );
      assertEquals(
        benignResult.crossTenantCollisions,
        0,
        `Expected zero cross-tenant collisions in benignResult, got ${benignResult.crossTenantCollisions}`,
      );
    } finally {
      await gateway?.close();
      await mockDataPlane?.close();
    }
  },
);

// ============================================================================
// AC3 & Security: Zero cross-tenant data bleed / collision (PLAT-7, FN-6)
// ============================================================================

Deno.test(
  "PLAT-7, FN-6 (AC3): Zero cross-tenant data bleed under multi-tenant concurrent stress",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-7 — Physical key & tenant isolation
    // spec: contracts/functions.contract.md#FN-6 — Zero cross-tenant state bleeding under warm-isolate concurrency
    let mockDataPlane: MockDataPlane | undefined;
    let gateway: GatewayServer | undefined;

    try {
      mockDataPlane = createMockDataPlane((req: Request) => {
        const tenant = req.headers.get("x-project-id") ?? "unknown";
        const path = new URL(req.url).pathname;
        return new Response(
          JSON.stringify({ tenant, path, status: "ok" }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-request-id": req.headers.get("x-request-id") ?? "",
            },
          },
        );
      });

      const options: GatewayOptions = {
        port: 0,
        controlPlaneUrl: mockDataPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      };
      gateway = await startGatewayServer(options);

      const tenant1: TenantLoadSpec = {
        orgId: "org-1",
        projectId: "proj-1",
        apiKey: "key-1",
        targetPath: "/api/tenant-1",
      };
      const tenant2: TenantLoadSpec = {
        orgId: "org-2",
        projectId: "proj-2",
        apiKey: "key-2",
        targetPath: "/api/tenant-2",
      };
      const tenant3: TenantLoadSpec = {
        orgId: "org-3",
        projectId: "proj-3",
        apiKey: "key-3",
        targetPath: "/api/tenant-3",
      };

      const scenario: LoadScenarioOptions = {
        gatewayUrl: `http://127.0.0.1:${gateway.port}`,
        concurrency: 6,
        durationMs: 500,
        tenants: [tenant1, tenant2, tenant3],
        targetRps: 60,
      };

      const result: LoadBenchmarkResult = await runLoadBenchmark(scenario);

      assert(
        result.totalRequests >= 10,
        `Expected totalRequests >= 10 across 3 tenants, got ${result.totalRequests}`,
      );
      assert(
        result.successfulRequests > 0,
        `Expected successfulRequests > 0, got ${result.successfulRequests}`,
      );
      assertEquals(
        result.crossTenantCollisions,
        0,
        `Expected crossTenantCollisions strictly 0 (PLAT-7, FN-6), got ${result.crossTenantCollisions}`,
      );
      assertEquals(
        result.errorRequests,
        0,
        `Expected errorRequests === 0, got ${result.errorRequests}`,
      );
      assert(
        result.availabilityPercent >= 99.95,
        `Expected availabilityPercent >= 99.95, got ${result.availabilityPercent}`,
      );
    } finally {
      await gateway?.close();
      await mockDataPlane?.close();
    }
  },
);

// ============================================================================
// Metric Accuracy & Structure Properties (PLAT-10, PLAT-14)
// ============================================================================

Deno.test(
  "PLAT-10, PLAT-14: Percentile metric accuracy and ULID request ID propagation across benchmark",
  async () => {
    // spec: contracts/platform.contract.md#PLAT-10 — Latency percentiles calculation integrity
    // spec: contracts/platform.contract.md#PLAT-14 — 128-bit Crockford Base32 monotonic ULID request IDs
    let mockDataPlane: MockDataPlane | undefined;
    let gateway: GatewayServer | undefined;

    try {
      mockDataPlane = createMockDataPlane();
      const options: GatewayOptions = {
        port: 0,
        controlPlaneUrl: mockDataPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      };
      gateway = await startGatewayServer(options);

      const tenant: TenantLoadSpec = {
        orgId: "org-metric",
        projectId: "proj-metric",
        apiKey: "key-metric",
        targetPath: "/api/metric",
      };

      const scenario: LoadScenarioOptions = {
        gatewayUrl: `http://127.0.0.1:${gateway.port}`,
        concurrency: 2,
        durationMs: 400,
        tenants: [tenant],
        targetRps: 30,
      };

      const result: LoadBenchmarkResult = await runLoadBenchmark(scenario);

      // Structure and arithmetic invariant assertions
      assertEquals(
        result.totalRequests,
        result.successfulRequests + result.rateLimitedRequests +
          result.errorRequests,
        "Total requests must equal sum of success + rate limited + error requests",
      );
      assert(
        result.availabilityPercent >= 0 && result.availabilityPercent <= 100,
        `availabilityPercent must be bounded [0, 100], got ${result.availabilityPercent}`,
      );
      assert(
        result.latencyP50Ms >= 0,
        `latencyP50Ms must be non-negative, got ${result.latencyP50Ms}`,
      );
      assert(
        result.latencyP95Ms >= result.latencyP50Ms,
        `latencyP95Ms (${result.latencyP95Ms}) must be >= latencyP50Ms (${result.latencyP50Ms})`,
      );
      assert(
        result.latencyP99Ms >= result.latencyP95Ms,
        `latencyP99Ms (${result.latencyP99Ms}) must be >= latencyP95Ms (${result.latencyP95Ms})`,
      );
      assert(
        result.crossTenantCollisions >= 0,
        "crossTenantCollisions must be non-negative",
      );

      // Verify request IDs propagated upstream to mock data plane are valid ULIDs (PLAT-14)
      assert(
        mockDataPlane.receivedRequestIds.length > 0,
        "Data plane must receive request IDs",
      );
      const uniqueIds = new Set<string>();
      for (const id of mockDataPlane.receivedRequestIds) {
        assert(
          isValidUlid(id),
          `Propagated request ID '${id}' must be a valid 26-char Crockford Base32 ULID (PLAT-14)`,
        );
        uniqueIds.add(id);
      }
      assertEquals(
        uniqueIds.size,
        mockDataPlane.receivedRequestIds.length,
        "Every request through the gateway must have a unique request ID (PLAT-14)",
      );
    } finally {
      await gateway?.close();
      await mockDataPlane?.close();
    }
  },
);

// ============================================================================
// AC4: Bounded memory usage under sustained load (FN-5)
// ============================================================================

Deno.test(
  "FN-5 (AC4): Bounded memory consumption during sustained multi-tenant execution",
  async () => {
    // spec: contracts/functions.contract.md#FN-5 — Resource limits & bounded memory growth
    let mockDataPlane: MockDataPlane | undefined;
    let gateway: GatewayServer | undefined;

    try {
      mockDataPlane = createMockDataPlane();
      const options: GatewayOptions = {
        port: 0,
        controlPlaneUrl: mockDataPlane.url,
        dataPlaneUrl: mockDataPlane.url,
      };
      gateway = await startGatewayServer(options);

      const tenants: TenantLoadSpec[] = [
        {
          orgId: "org-mem-1",
          projectId: "proj-mem-1",
          apiKey: "key-mem-1",
          targetPath: "/api/mem-1",
        },
        {
          orgId: "org-mem-2",
          projectId: "proj-mem-2",
          apiKey: "key-mem-2",
          targetPath: "/api/mem-2",
        },
      ];

      const initialMemory = Deno.memoryUsage();

      const result: LoadBenchmarkResult = await runLoadBenchmark({
        gatewayUrl: `http://127.0.0.1:${gateway.port}`,
        concurrency: 4,
        durationMs: 600,
        tenants,
        targetRps: 60,
      });

      const finalMemory = Deno.memoryUsage();
      const heapGrowthMb = (finalMemory.heapUsed - initialMemory.heapUsed) /
        (1024 * 1024);

      // Memory growth during benchmark must be bounded (less than 128 MB max isolate ceiling per FN-5)
      assert(
        heapGrowthMb < 128,
        `Heap growth during load benchmark must remain bounded (<128MB per FN-5), observed: ${
          heapGrowthMb.toFixed(2)
        }MB`,
      );
      assert(result.totalRequests > 0, "Benchmark must process requests");
      assertEquals(result.errorRequests, 0, "Zero unhandled errors");
    } finally {
      await gateway?.close();
      await mockDataPlane?.close();
    }
  },
);
