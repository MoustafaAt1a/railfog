/**
 * Multi-Tenant Load Generator & Synthetic Benchmark Harness.
 *
 * Simulates high-concurrency multi-tenant client traffic against the RailFog gateway,
 * measuring latency percentiles (p50, p95, p99), availability SLO compliance (PLAT-10),
 * token bucket rate limiting shedding (PLAT-9), and verifying zero cross-tenant state bleed (PLAT-7, FN-6).
 *
 * Spec references:
 * - contracts/platform.contract.md#PLAT-7: Multi-tenancy & tenant isolation.
 * - contracts/platform.contract.md#PLAT-9: Token bucket rate limiting (429 RATE_LIMITED, Retry-After).
 * - contracts/platform.contract.md#PLAT-10: 99.95% data plane availability SLO & error budget.
 * - contracts/platform.contract.md#PLAT-12: Canonical error model (VALIDATION_FAILED, RATE_LIMITED).
 * - contracts/functions.contract.md#FN-5: Bounded memory and resource consumption.
 * - contracts/functions.contract.md#FN-6: Isolation & warm-reuse rule (zero cross-tenant state bleed).
 * - tasks/milestone-0.6-public-beta/T-0609-multi-tenant-load-harness.md: AC1 - AC4.
 */

import { delay } from "@std/async/delay";

/**
 * Tenant workload specification for load generation.
 * spec: tasks/milestone-0.6-public-beta/T-0609-multi-tenant-load-harness.md
 */
export interface TenantLoadSpec {
  orgId: string;
  projectId: string;
  apiKey: string;
  targetPath: string;
}

/**
 * Options for configuring a multi-tenant benchmark scenario.
 * spec: tasks/milestone-0.6-public-beta/T-0609-multi-tenant-load-harness.md
 */
export interface LoadScenarioOptions {
  gatewayUrl: string;
  concurrency: number; // concurrent client workers
  durationMs: number;
  tenants: TenantLoadSpec[];
  targetRps: number;
}

export interface TenantMetrics {
  totalRequests: number;
  successfulRequests: number;
  rateLimitedRequests: number;
  errorRequests: number;
}

/**
 * Aggregated benchmark results and SLO metrics.
 * spec: tasks/milestone-0.6-public-beta/T-0609-multi-tenant-load-harness.md
 */
export interface LoadBenchmarkResult {
  totalRequests: number;
  successfulRequests: number;
  rateLimitedRequests: number;
  errorRequests: number;
  availabilityPercent: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  crossTenantCollisions: number;
  tenantBreakdown?: Record<string, TenantMetrics>;
}

/**
 * Deterministically derives a unique synthetic client IP from a tenant identifier (PLAT-7, PLAT-9).
 */
function deriveClientIp(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const b1 = hash & 0xff;
  const b2 = (hash >>> 8) & 0xff;
  return `198.51.${b1}.${b2}`;
}

/**
 * Executes a high-concurrency multi-tenant synthetic load benchmark against the gateway.
 *
 * Validates data plane availability under load (PLAT-10), token bucket rate limiting (PLAT-9),
 * and verifies absence of cross-tenant data bleed or route collision (PLAT-7, FN-6).
 *
 * spec: contracts/platform.contract.md#PLAT-10 — Availability SLO calculation
 * spec: contracts/platform.contract.md#PLAT-9 — Managed rate shedding counting toward SLO
 * spec: contracts/platform.contract.md#PLAT-7 — Zero cross-tenant data bleed
 * spec: contracts/functions.contract.md#FN-5 — Bounded memory consumption
 * spec: contracts/functions.contract.md#FN-6 — Zero cross-tenant state bleed under warm concurrency
 */
export async function runLoadBenchmark(
  options: LoadScenarioOptions,
): Promise<LoadBenchmarkResult> {
  // spec: contracts/platform.contract.md#PLAT-12 — Input validation
  if (options.concurrency < 1) {
    throw new Error("VALIDATION_FAILED: concurrency must be >= 1");
  }
  if (options.durationMs <= 0) {
    throw new Error("VALIDATION_FAILED: durationMs must be > 0");
  }
  if (!options.tenants || options.tenants.length === 0) {
    throw new Error("VALIDATION_FAILED: at least one tenant must be specified");
  }

  const endTime = performance.now() + options.durationMs;
  // spec: tasks/milestone-0.6-public-beta/T-0609-multi-tenant-load-harness.md — Pacing per worker
  const pacingDelayMs = options.targetRps > 0
    ? Math.max(1, (1000 * options.concurrency) / options.targetRps)
    : 1;

  let successfulRequests = 0;
  let rateLimitedRequests = 0;
  let errorRequests = 0;
  let crossTenantCollisions = 0;
  const latencies: number[] = [];
  const tenantBreakdown: Record<string, TenantMetrics> = {};

  const runWorker = async (workerIndex: number): Promise<void> => {
    let reqCount = 0;
    while (performance.now() < endTime) {
      // spec: contracts/platform.contract.md#PLAT-7 — Round-robin tenant dispatch across concurrency pool
      const tenant =
        options.tenants[(workerIndex + reqCount) % options.tenants.length];
      reqCount++;

      let tMetrics = tenantBreakdown[tenant.projectId];
      if (!tMetrics) {
        tMetrics = {
          totalRequests: 0,
          successfulRequests: 0,
          rateLimitedRequests: 0,
          errorRequests: 0,
        };
        tenantBreakdown[tenant.projectId] = tMetrics;
      }
      tMetrics.totalRequests++;

      const basePath = options.gatewayUrl.replace(/\/+$/, "");
      const subPath = tenant.targetPath.startsWith("/")
        ? tenant.targetPath
        : `/${tenant.targetPath}`;
      const url = `${basePath}${subPath}`;

      // spec: contracts/platform.contract.md#PLAT-9 — Deterministic client IP per tenant for IP scope isolation
      const clientIp = deriveClientIp(tenant.projectId || tenant.orgId);

      const headers: Record<string, string> = {
        "authorization": `Bearer ${tenant.apiKey}`,
        "x-project-id": tenant.projectId,
        "x-org-id": tenant.orgId,
        "x-forwarded-for": clientIp,
        "accept": "application/json",
      };

      try {
        const startReq = performance.now();
        const response = await fetch(url, { headers });
        const latency = performance.now() - startReq;
        latencies.push(latency);

        if (response.status >= 200 && response.status < 300) {
          successfulRequests++;
          tMetrics.successfulRequests++;
          try {
            // spec: contracts/functions.contract.md#FN-5 — Response stream consumed to bound heap
            const body = await response.json();
            // spec: contracts/platform.contract.md#PLAT-7 — Tenant isolation check
            // spec: contracts/functions.contract.md#FN-6 — Zero cross-tenant data bleed
            if (
              body !== null &&
              typeof body === "object" &&
              "tenant" in body &&
              typeof (body as { tenant: unknown }).tenant === "string"
            ) {
              if ((body as { tenant: string }).tenant !== tenant.projectId) {
                crossTenantCollisions++;
              }
            }
          } catch {
            // Body was not valid JSON or was empty; not a cross-tenant collision
          }
        } else if (response.status === 429) {
          // spec: contracts/platform.contract.md#PLAT-9 — Token bucket shedding (429 RATE_LIMITED)
          rateLimitedRequests++;
          tMetrics.rateLimitedRequests++;
          try {
            // spec: contracts/functions.contract.md#FN-5 — Consume body text to free connection
            await response.text();
          } catch {
            // Ignored on drain failure
          }
        } else {
          // spec: contracts/platform.contract.md#PLAT-12 — HTTP error status codes
          errorRequests++;
          tMetrics.errorRequests++;
          try {
            // spec: contracts/functions.contract.md#FN-5 — Consume body text to free connection
            await response.text();
          } catch {
            // Ignored on drain failure
          }
        }
      } catch {
        // spec: contracts/platform.contract.md#PLAT-12 — Network failure / connection drop
        errorRequests++;
        tMetrics.errorRequests++;
      }

      if (performance.now() < endTime) {
        await delay(pacingDelayMs);
      }
    }
  };

  // Launch parallel worker loops matching options.concurrency
  const workers: Promise<void>[] = [];
  for (let i = 0; i < options.concurrency; i++) {
    workers.push(runWorker(i));
  }
  await Promise.all(workers);

  // spec: contracts/platform.contract.md#PLAT-10 — Total requests aggregation
  const totalRequests = successfulRequests + rateLimitedRequests +
    errorRequests;

  // spec: contracts/platform.contract.md#PLAT-10 — Availability SLO calculation
  // Clean rate-limited shedding (429) per PLAT-9 counts as managed traffic towards SLO
  const availabilityPercent = totalRequests > 0
    ? ((successfulRequests + rateLimitedRequests) / totalRequests) * 100
    : 100;

  // spec: contracts/platform.contract.md#PLAT-10 — Latency percentiles (p50, p95, p99)
  let latencyP50Ms = 0;
  let latencyP95Ms = 0;
  let latencyP99Ms = 0;

  if (latencies.length > 0) {
    latencies.sort((a, b) => a - b);
    latencyP50Ms = latencies[Math.floor(latencies.length * 0.50)] ?? 0;
    const rawP95 = latencies[
      Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))
    ] ?? latencyP50Ms;
    latencyP95Ms = Math.max(latencyP50Ms, rawP95);
    const rawP99 = latencies[
      Math.min(latencies.length - 1, Math.floor(latencies.length * 0.99))
    ] ?? latencyP95Ms;
    latencyP99Ms = Math.max(latencyP95Ms, rawP99);
  }

  return {
    totalRequests,
    successfulRequests,
    rateLimitedRequests,
    errorRequests,
    availabilityPercent,
    latencyP50Ms,
    latencyP95Ms,
    latencyP99Ms,
    crossTenantCollisions,
    tenantBreakdown,
  };
}
