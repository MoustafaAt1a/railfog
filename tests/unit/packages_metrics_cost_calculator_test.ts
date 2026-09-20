/**
 * Multi-Tenant Cost Calculation Engine Test Suite.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-10 (SLOs & billing error bounds)
 * - docs/contracts/platform.contract.md#PLAT-13 (Observability: resource metrics & counters)
 * - docs/contracts/platform.contract.md#PLAT-18 (Resource hierarchy: Org -> Project isolation)
 * - tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md (AC1 - AC4)
 */

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  calculateProjectCost,
  DEFAULT_PRICING_RATES,
  type PricingRates,
  type ProjectCostItemized,
  type ProjectUsageSummary,
} from "../../packages/metrics/cost-calculator.ts";

/**
 * Helper to assert that a USD monetary value adheres to micro-cent ($0.000001 / 6 decimal places) precision.
 * spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC1
 */
function assertMicroCentPrecision(value: number, fieldName: string) {
  assert(
    Number.isFinite(value),
    `${fieldName} must be a finite number, got: ${value}`,
  );
  assert(!Number.isNaN(value), `${fieldName} must not be NaN`);
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  assertAlmostEquals(
    value,
    rounded,
    1e-9,
    `${fieldName} violates micro-cent precision ($0.000001 / 6 decimals): ${value}`,
  );
}

/**
 * Helper rounding to micro-cent precision for test expected values.
 */
function roundMicroCent(val: number): number {
  return Math.round(val * 1_000_000) / 1_000_000;
}

// ============================================================================
// AC1: Standard pricing calculation & itemization breakdown
// ============================================================================

Deno.test("AC1: DEFAULT_PRICING_RATES exposes all required non-negative rate coefficients", () => {
  // spec: contracts/platform.contract.md#PLAT-13
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC1
  const rates = DEFAULT_PRICING_RATES;
  assert(rates, "DEFAULT_PRICING_RATES must be exported and defined");

  assertEquals(typeof rates.cpuMillisecondCostUsd, "number");
  assertEquals(typeof rates.memoryMbSecondCostUsd, "number");
  assertEquals(typeof rates.kvReadOpCostUsd, "number");
  assertEquals(typeof rates.kvWriteOpCostUsd, "number");
  assertEquals(typeof rates.objectReadOpCostUsd, "number");
  assertEquals(typeof rates.objectWriteOpCostUsd, "number");
  assertEquals(typeof rates.queueSentOpCostUsd, "number");
  assertEquals(typeof rates.queueProcessedOpCostUsd, "number");
  assertEquals(typeof rates.kvStorageGbMonthCostUsd, "number");
  assertEquals(typeof rates.objectStorageGbMonthCostUsd, "number");

  assert(
    rates.cpuMillisecondCostUsd > 0,
    "cpuMillisecondCostUsd must be positive",
  );
  assert(
    rates.memoryMbSecondCostUsd > 0,
    "memoryMbSecondCostUsd must be positive",
  );
  assert(rates.kvReadOpCostUsd > 0, "kvReadOpCostUsd must be positive");
  assert(rates.kvWriteOpCostUsd > 0, "kvWriteOpCostUsd must be positive");
  assert(rates.objectReadOpCostUsd > 0, "objectReadOpCostUsd must be positive");
  assert(
    rates.objectWriteOpCostUsd > 0,
    "objectWriteOpCostUsd must be positive",
  );
  assert(rates.queueSentOpCostUsd > 0, "queueSentOpCostUsd must be positive");
  assert(
    rates.queueProcessedOpCostUsd > 0,
    "queueProcessedOpCostUsd must be positive",
  );
  assert(
    rates.kvStorageGbMonthCostUsd > 0,
    "kvStorageGbMonthCostUsd must be positive",
  );
  assert(
    rates.objectStorageGbMonthCostUsd > 0,
    "objectStorageGbMonthCostUsd must be positive",
  );
});

Deno.test("AC1: calculateProjectCost with default rates computes itemized costs and aggregations accurately", () => {
  // spec: contracts/platform.contract.md#PLAT-13
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC1
  const periodStart = 1_700_000_000_000;
  const periodEnd = 1_702_592_000_000; // +30 days

  const usage: ProjectUsageSummary = {
    orgId: "org_alpha",
    projectId: "proj_billing",
    periodStart,
    periodEnd,
    invocations: 10_000,
    cpuTimeMs: 250_000,
    memoryMbSeconds: 1_000_000,
    kvReads: 50_000,
    kvWrites: 10_000,
    objectReads: 20_000,
    objectWrites: 5_000,
    queueSent: 15_000,
    queueProcessed: 15_000,
    storageBytesKv: 1024 * 1024 * 1024, // 1 GB
    storageBytesObjects: 5 * 1024 * 1024 * 1024, // 5 GB
  };

  const cost: ProjectCostItemized = calculateProjectCost(usage);

  // Metadata verification
  assertEquals(cost.orgId, "org_alpha");
  assertEquals(cost.projectId, "proj_billing");
  assertEquals(cost.periodStart, periodStart);
  assertEquals(cost.periodEnd, periodEnd);

  // Compute breakdown
  const expectedCpuCost = roundMicroCent(
    usage.cpuTimeMs * DEFAULT_PRICING_RATES.cpuMillisecondCostUsd,
  );
  const expectedMemoryCost = roundMicroCent(
    usage.memoryMbSeconds * DEFAULT_PRICING_RATES.memoryMbSecondCostUsd,
  );
  assertEquals(cost.itemized.cpuCostUsd, expectedCpuCost);
  assertEquals(cost.itemized.memoryCostUsd, expectedMemoryCost);

  const expectedComputeCost = roundMicroCent(
    cost.itemized.cpuCostUsd + cost.itemized.memoryCostUsd,
  );
  assertEquals(cost.computeCostUsd, expectedComputeCost);

  // Operations breakdown
  const expectedKvOpsCost = roundMicroCent(
    usage.kvReads * DEFAULT_PRICING_RATES.kvReadOpCostUsd +
      usage.kvWrites * DEFAULT_PRICING_RATES.kvWriteOpCostUsd,
  );
  const expectedObjectOpsCost = roundMicroCent(
    usage.objectReads * DEFAULT_PRICING_RATES.objectReadOpCostUsd +
      usage.objectWrites * DEFAULT_PRICING_RATES.objectWriteOpCostUsd,
  );
  const expectedQueueOpsCost = roundMicroCent(
    usage.queueSent * DEFAULT_PRICING_RATES.queueSentOpCostUsd +
      usage.queueProcessed * DEFAULT_PRICING_RATES.queueProcessedOpCostUsd,
  );

  assertEquals(cost.itemized.kvOpsCostUsd, expectedKvOpsCost);
  assertEquals(cost.itemized.objectOpsCostUsd, expectedObjectOpsCost);
  assertEquals(cost.itemized.queueOpsCostUsd, expectedQueueOpsCost);

  const expectedOpsCost = roundMicroCent(
    cost.itemized.kvOpsCostUsd + cost.itemized.objectOpsCostUsd +
      cost.itemized.queueOpsCostUsd,
  );
  assertEquals(cost.operationsCostUsd, expectedOpsCost);

  // Storage breakdown
  assert(
    cost.itemized.kvStorageCostUsd > 0,
    "kvStorageCostUsd must be positive for non-zero bytes",
  );
  assert(
    cost.itemized.objectStorageCostUsd > 0,
    "objectStorageCostUsd must be positive for non-zero bytes",
  );
  const expectedStorageCost = roundMicroCent(
    cost.itemized.kvStorageCostUsd + cost.itemized.objectStorageCostUsd,
  );
  assertEquals(cost.storageCostUsd, expectedStorageCost);

  // Total cost aggregation
  const expectedTotalCost = roundMicroCent(
    cost.computeCostUsd + cost.operationsCostUsd + cost.storageCostUsd,
  );
  assertEquals(cost.totalCostUsd, expectedTotalCost);

  // Micro-cent precision check across all fields
  assertMicroCentPrecision(cost.computeCostUsd, "computeCostUsd");
  assertMicroCentPrecision(cost.storageCostUsd, "storageCostUsd");
  assertMicroCentPrecision(cost.operationsCostUsd, "operationsCostUsd");
  assertMicroCentPrecision(cost.totalCostUsd, "totalCostUsd");
  assertMicroCentPrecision(cost.itemized.cpuCostUsd, "itemized.cpuCostUsd");
  assertMicroCentPrecision(
    cost.itemized.memoryCostUsd,
    "itemized.memoryCostUsd",
  );
  assertMicroCentPrecision(cost.itemized.kvOpsCostUsd, "itemized.kvOpsCostUsd");
  assertMicroCentPrecision(
    cost.itemized.objectOpsCostUsd,
    "itemized.objectOpsCostUsd",
  );
  assertMicroCentPrecision(
    cost.itemized.queueOpsCostUsd,
    "itemized.queueOpsCostUsd",
  );
  assertMicroCentPrecision(
    cost.itemized.kvStorageCostUsd,
    "itemized.kvStorageCostUsd",
  );
  assertMicroCentPrecision(
    cost.itemized.objectStorageCostUsd,
    "itemized.objectStorageCostUsd",
  );
});

Deno.test("AC1: Deterministic cost calculation against explicit custom pricing schedule", () => {
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC1
  const explicitRates: PricingRates = {
    cpuMillisecondCostUsd: 0.000010, // $10 / 1M ms
    memoryMbSecondCostUsd: 0.000002, // $2 / 1M MB-s
    kvReadOpCostUsd: 0.000001, // $1 / 1M reads
    kvWriteOpCostUsd: 0.000005, // $5 / 1M writes
    objectReadOpCostUsd: 0.000001, // $1 / 1M reads
    objectWriteOpCostUsd: 0.000005, // $5 / 1M writes
    queueSentOpCostUsd: 0.000001, // $1 / 1M sent
    queueProcessedOpCostUsd: 0.000001, // $1 / 1M processed
    kvStorageGbMonthCostUsd: 0.20,
    objectStorageGbMonthCostUsd: 0.02,
  };

  const usage: ProjectUsageSummary = {
    orgId: "org_deterministic",
    projectId: "proj_deterministic",
    periodStart: 1_700_000_000_000,
    periodEnd: 1_702_592_000_000,
    invocations: 5_000,
    cpuTimeMs: 100_000, // 100_000 * 0.000010 = 1.000000
    memoryMbSeconds: 200_000, // 200_000 * 0.000002 = 0.400000
    kvReads: 50_000, // 50_000 * 0.000001 = 0.050000
    kvWrites: 10_000, // 10_000 * 0.000005 = 0.050000
    objectReads: 20_000, // 20_000 * 0.000001 = 0.020000
    objectWrites: 6_000, // 6_000 * 0.000005 = 0.030000
    queueSent: 10_000, // 10_000 * 0.000001 = 0.010000
    queueProcessed: 10_000, // 10_000 * 0.000001 = 0.010000
    storageBytesKv: 0,
    storageBytesObjects: 0,
  };

  const cost = calculateProjectCost(usage, explicitRates);

  assertEquals(cost.itemized.cpuCostUsd, 1.000000);
  assertEquals(cost.itemized.memoryCostUsd, 0.400000);
  assertEquals(cost.computeCostUsd, 1.400000);

  assertEquals(cost.itemized.kvOpsCostUsd, 0.100000);
  assertEquals(cost.itemized.objectOpsCostUsd, 0.050000);
  assertEquals(cost.itemized.queueOpsCostUsd, 0.020000);
  assertEquals(cost.operationsCostUsd, 0.170000);

  assertEquals(cost.itemized.kvStorageCostUsd, 0.000000);
  assertEquals(cost.itemized.objectStorageCostUsd, 0.000000);
  assertEquals(cost.storageCostUsd, 0.000000);

  assertEquals(cost.totalCostUsd, 1.570000);
});

Deno.test("AC1: Micro-cent precision rounds sub-micro-cent fractional costs to 6 decimals", () => {
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC1
  // 3 * 0.0000007 = 0.0000021 -> rounds to 0.000002
  const rates: PricingRates = {
    ...DEFAULT_PRICING_RATES,
    cpuMillisecondCostUsd: 0.0000007,
  };

  const usage: ProjectUsageSummary = {
    orgId: "org_precision",
    projectId: "proj_precision",
    periodStart: 1_700_000_000_000,
    periodEnd: 1_702_592_000_000,
    invocations: 1,
    cpuTimeMs: 3,
    memoryMbSeconds: 0,
    kvReads: 0,
    kvWrites: 0,
    objectReads: 0,
    objectWrites: 0,
    queueSent: 0,
    queueProcessed: 0,
    storageBytesKv: 0,
    storageBytesObjects: 0,
  };

  const cost = calculateProjectCost(usage, rates);
  assertEquals(cost.itemized.cpuCostUsd, 0.000002);
  assertEquals(cost.computeCostUsd, 0.000002);
  assertEquals(cost.totalCostUsd, 0.000002);
  assertMicroCentPrecision(cost.itemized.cpuCostUsd, "cpuCostUsd");
});

// ============================================================================
// AC2: Custom rates override
// ============================================================================

Deno.test("AC2: Partial PricingRates override applies custom rate while preserving default rates", () => {
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC2
  const usage: ProjectUsageSummary = {
    orgId: "org_override",
    projectId: "proj_override",
    periodStart: 1_700_000_000_000,
    periodEnd: 1_702_592_000_000,
    invocations: 100,
    cpuTimeMs: 50_000,
    memoryMbSeconds: 20_000,
    kvReads: 1_000,
    kvWrites: 500,
    objectReads: 0,
    objectWrites: 0,
    queueSent: 0,
    queueProcessed: 0,
    storageBytesKv: 0,
    storageBytesObjects: 0,
  };

  // Custom CPU millisecond rate override (10x default or specific custom amount)
  const customCpuRate = 0.000055;
  const cost = calculateProjectCost(usage, {
    cpuMillisecondCostUsd: customCpuRate,
  });

  // Custom CPU rate applied
  const expectedCustomCpuCost = roundMicroCent(usage.cpuTimeMs * customCpuRate);
  assertEquals(cost.itemized.cpuCostUsd, expectedCustomCpuCost);

  // Remaining components use DEFAULT_PRICING_RATES
  const expectedDefaultMemoryCost = roundMicroCent(
    usage.memoryMbSeconds * DEFAULT_PRICING_RATES.memoryMbSecondCostUsd,
  );
  assertEquals(cost.itemized.memoryCostUsd, expectedDefaultMemoryCost);

  const expectedDefaultKvCost = roundMicroCent(
    usage.kvReads * DEFAULT_PRICING_RATES.kvReadOpCostUsd +
      usage.kvWrites * DEFAULT_PRICING_RATES.kvWriteOpCostUsd,
  );
  assertEquals(cost.itemized.kvOpsCostUsd, expectedDefaultKvCost);
});

Deno.test("AC2: Overriding specific operation rates (kvWriteOpCostUsd) keeps read ops at default rate", () => {
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC2
  const usage: ProjectUsageSummary = {
    orgId: "org_override_op",
    projectId: "proj_override_op",
    periodStart: 1_700_000_000_000,
    periodEnd: 1_702_592_000_000,
    invocations: 10,
    cpuTimeMs: 0,
    memoryMbSeconds: 0,
    kvReads: 10_000,
    kvWrites: 5_000,
    objectReads: 0,
    objectWrites: 0,
    queueSent: 0,
    queueProcessed: 0,
    storageBytesKv: 0,
    storageBytesObjects: 0,
  };

  const customKvWriteRate = 0.000099;
  const cost = calculateProjectCost(usage, {
    kvWriteOpCostUsd: customKvWriteRate,
  });

  const expectedKvOpsCost = roundMicroCent(
    usage.kvReads * DEFAULT_PRICING_RATES.kvReadOpCostUsd +
      usage.kvWrites * customKvWriteRate,
  );
  assertEquals(cost.itemized.kvOpsCostUsd, expectedKvOpsCost);
});

Deno.test("AC2: DEFAULT_PRICING_RATES object is not mutated by calculateProjectCost calls", () => {
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC2
  const originalCpuRate = DEFAULT_PRICING_RATES.cpuMillisecondCostUsd;
  const originalKvWriteRate = DEFAULT_PRICING_RATES.kvWriteOpCostUsd;

  const usage: ProjectUsageSummary = {
    orgId: "org_immutability",
    projectId: "proj_immutability",
    periodStart: 0,
    periodEnd: 1000,
    invocations: 1,
    cpuTimeMs: 10,
    memoryMbSeconds: 10,
    kvReads: 1,
    kvWrites: 1,
    objectReads: 0,
    objectWrites: 0,
    queueSent: 0,
    queueProcessed: 0,
    storageBytesKv: 0,
    storageBytesObjects: 0,
  };

  calculateProjectCost(usage, {
    cpuMillisecondCostUsd: 0.999999,
    kvWriteOpCostUsd: 0.888888,
  });

  assertEquals(DEFAULT_PRICING_RATES.cpuMillisecondCostUsd, originalCpuRate);
  assertEquals(DEFAULT_PRICING_RATES.kvWriteOpCostUsd, originalKvWriteRate);
});

// ============================================================================
// AC3: Zero and boundary usage
// ============================================================================

Deno.test("AC3: All-zero ProjectUsageSummary returns 0.00 across all fields without NaN or undefined", () => {
  // spec: contracts/platform.contract.md#PLAT-10
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC3
  const zeroUsage: ProjectUsageSummary = {
    orgId: "org_zero",
    projectId: "proj_zero",
    periodStart: 1_700_000_000_000,
    periodEnd: 1_700_000_000_000, // zero elapsed time
    invocations: 0,
    cpuTimeMs: 0,
    memoryMbSeconds: 0,
    kvReads: 0,
    kvWrites: 0,
    objectReads: 0,
    objectWrites: 0,
    queueSent: 0,
    queueProcessed: 0,
    storageBytesKv: 0,
    storageBytesObjects: 0,
  };

  const cost = calculateProjectCost(zeroUsage);

  assertEquals(cost.orgId, "org_zero");
  assertEquals(cost.projectId, "proj_zero");
  assertEquals(cost.periodStart, 1_700_000_000_000);
  assertEquals(cost.periodEnd, 1_700_000_000_000);

  assertEquals(cost.computeCostUsd, 0);
  assertEquals(cost.storageCostUsd, 0);
  assertEquals(cost.operationsCostUsd, 0);
  assertEquals(cost.totalCostUsd, 0);

  assertEquals(cost.itemized.cpuCostUsd, 0);
  assertEquals(cost.itemized.memoryCostUsd, 0);
  assertEquals(cost.itemized.kvOpsCostUsd, 0);
  assertEquals(cost.itemized.objectOpsCostUsd, 0);
  assertEquals(cost.itemized.queueOpsCostUsd, 0);
  assertEquals(cost.itemized.kvStorageCostUsd, 0);
  assertEquals(cost.itemized.objectStorageCostUsd, 0);

  // Check no field is NaN or undefined
  for (const [key, val] of Object.entries(cost.itemized)) {
    assert(!Number.isNaN(val), `itemized.${key} should not be NaN`);
    assertEquals(typeof val, "number", `itemized.${key} should be number`);
  }
});

Deno.test("AC3: Free-tier / zero rate override calculates zero cost for covered resources", () => {
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC3
  const usage: ProjectUsageSummary = {
    orgId: "org_freetier",
    projectId: "proj_freetier",
    periodStart: 1_700_000_000_000,
    periodEnd: 1_702_592_000_000,
    invocations: 10_000,
    cpuTimeMs: 1_000_000,
    memoryMbSeconds: 5_000_000,
    kvReads: 50_000,
    kvWrites: 10_000,
    objectReads: 0,
    objectWrites: 0,
    queueSent: 0,
    queueProcessed: 0,
    storageBytesKv: 0,
    storageBytesObjects: 0,
  };

  // Zero out compute rates
  const cost = calculateProjectCost(usage, {
    cpuMillisecondCostUsd: 0,
    memoryMbSecondCostUsd: 0,
  });

  assertEquals(cost.itemized.cpuCostUsd, 0);
  assertEquals(cost.itemized.memoryCostUsd, 0);
  assertEquals(cost.computeCostUsd, 0);
  assert(
    cost.operationsCostUsd > 0,
    "Non-zero operations should still be billed",
  );
  assertEquals(cost.totalCostUsd, cost.operationsCostUsd);
});

Deno.test("AC3: Non-positive or inverted period duration handles gracefully without negative cost", () => {
  // spec: contracts/platform.contract.md#PLAT-10
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC3
  const usageInverted: ProjectUsageSummary = {
    orgId: "org_boundary",
    projectId: "proj_boundary",
    periodStart: 1_702_592_000_000,
    periodEnd: 1_700_000_000_000, // end < start
    invocations: 10,
    cpuTimeMs: 100,
    memoryMbSeconds: 100,
    kvReads: 10,
    kvWrites: 10,
    objectReads: 10,
    objectWrites: 10,
    queueSent: 10,
    queueProcessed: 10,
    storageBytesKv: 1024,
    storageBytesObjects: 1024,
  };

  const cost = calculateProjectCost(usageInverted);

  assert(cost.computeCostUsd >= 0, "computeCostUsd must not be negative");
  assert(cost.operationsCostUsd >= 0, "operationsCostUsd must not be negative");
  assert(cost.storageCostUsd >= 0, "storageCostUsd must not be negative");
  assert(cost.totalCostUsd >= 0, "totalCostUsd must not be negative");
  assert(!Number.isNaN(cost.totalCostUsd), "totalCostUsd must not be NaN");
});

// ============================================================================
// AC4: Multi-tenant and project isolation (PLAT-18)
// ============================================================================

Deno.test("AC4: Distinct projects within an organization calculate independently per PLAT-18", () => {
  // spec: contracts/platform.contract.md#PLAT-18 (Organization -> Project resource hierarchy)
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC4
  const periodStart = 1_700_000_000_000;
  const periodEnd = 1_702_592_000_000;

  const projectAUsage: ProjectUsageSummary = {
    orgId: "org_enterprise",
    projectId: "project_compute_heavy",
    periodStart,
    periodEnd,
    invocations: 50_000,
    cpuTimeMs: 1_000_000,
    memoryMbSeconds: 4_000_000,
    kvReads: 100,
    kvWrites: 10,
    objectReads: 0,
    objectWrites: 0,
    queueSent: 0,
    queueProcessed: 0,
    storageBytesKv: 0,
    storageBytesObjects: 0,
  };

  const projectBUsage: ProjectUsageSummary = {
    orgId: "org_enterprise",
    projectId: "project_storage_heavy",
    periodStart,
    periodEnd,
    invocations: 100,
    cpuTimeMs: 1_000,
    memoryMbSeconds: 2_000,
    kvReads: 500_000,
    kvWrites: 200_000,
    objectReads: 100_000,
    objectWrites: 50_000,
    queueSent: 0,
    queueProcessed: 0,
    storageBytesKv: 10 * 1024 * 1024 * 1024,
    storageBytesObjects: 100 * 1024 * 1024 * 1024,
  };

  const costA = calculateProjectCost(projectAUsage);
  const costB = calculateProjectCost(projectBUsage);

  // Metadata isolation
  assertEquals(costA.orgId, "org_enterprise");
  assertEquals(costA.projectId, "project_compute_heavy");
  assertEquals(costB.orgId, "org_enterprise");
  assertEquals(costB.projectId, "project_storage_heavy");

  // Profile isolation
  assert(
    costA.computeCostUsd > costB.computeCostUsd,
    "projectA compute cost must exceed projectB compute cost",
  );
  assert(
    costB.operationsCostUsd > costA.operationsCostUsd,
    "projectB operations cost must exceed projectA operations cost",
  );
  assert(
    costB.storageCostUsd > costA.storageCostUsd,
    "projectB storage cost must exceed projectA storage cost",
  );
});

Deno.test("AC4: Multi-tenant organization isolation with identical project names", () => {
  // spec: contracts/platform.contract.md#PLAT-18
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC4
  const usageOrg1: ProjectUsageSummary = {
    orgId: "tenant_alpha",
    projectId: "frontend_app",
    periodStart: 1_000,
    periodEnd: 2_000,
    invocations: 100,
    cpuTimeMs: 1_000,
    memoryMbSeconds: 1_000,
    kvReads: 50,
    kvWrites: 20,
    objectReads: 0,
    objectWrites: 0,
    queueSent: 0,
    queueProcessed: 0,
    storageBytesKv: 0,
    storageBytesObjects: 0,
  };

  const usageOrg2: ProjectUsageSummary = {
    orgId: "tenant_beta",
    projectId: "frontend_app",
    periodStart: 5_000,
    periodEnd: 6_000,
    invocations: 200,
    cpuTimeMs: 2_000,
    memoryMbSeconds: 2_000,
    kvReads: 100,
    kvWrites: 40,
    objectReads: 0,
    objectWrites: 0,
    queueSent: 0,
    queueProcessed: 0,
    storageBytesKv: 0,
    storageBytesObjects: 0,
  };

  const costOrg1 = calculateProjectCost(usageOrg1);
  const costOrg2 = calculateProjectCost(usageOrg2);

  assertEquals(costOrg1.orgId, "tenant_alpha");
  assertEquals(costOrg1.projectId, "frontend_app");
  assertEquals(costOrg1.periodStart, 1_000);
  assertEquals(costOrg1.periodEnd, 2_000);

  assertEquals(costOrg2.orgId, "tenant_beta");
  assertEquals(costOrg2.projectId, "frontend_app");
  assertEquals(costOrg2.periodStart, 5_000);
  assertEquals(costOrg2.periodEnd, 6_000);

  assertEquals(
    roundMicroCent(costOrg1.computeCostUsd * 2),
    costOrg2.computeCostUsd,
    "Tenant beta with 2x usage should have 2x compute cost of tenant alpha",
  );
});

Deno.test("AC4: Repeated calculations are pure and free of internal state retention", () => {
  // spec: contracts/platform.contract.md#PLAT-18
  const usage: ProjectUsageSummary = {
    orgId: "org_pure",
    projectId: "proj_pure",
    periodStart: 10_000,
    periodEnd: 20_000,
    invocations: 500,
    cpuTimeMs: 25_000,
    memoryMbSeconds: 50_000,
    kvReads: 1_000,
    kvWrites: 500,
    objectReads: 200,
    objectWrites: 50,
    queueSent: 100,
    queueProcessed: 100,
    storageBytesKv: 1024 * 1024,
    storageBytesObjects: 10 * 1024 * 1024,
  };

  const run1 = calculateProjectCost(usage);
  const run2 = calculateProjectCost(usage);

  assertEquals(
    run1,
    run2,
    "Pure cost calculator must produce identical output across successive runs",
  );
});

// ============================================================================
// High-volume and scale tests
// ============================================================================

Deno.test("Scale: Enterprise high-volume billing calculation without overflow or floating drift", () => {
  // spec: contracts/platform.contract.md#PLAT-10 (Error bounds and accounting stability under load)
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC1
  const periodStart = 1_700_000_000_000;
  const periodEnd = 1_702_592_000_000; // 30 days

  const enterpriseUsage: ProjectUsageSummary = {
    orgId: "org_megacorp",
    projectId: "proj_datacenter",
    periodStart,
    periodEnd,
    invocations: 50_000_000, // 50M requests
    cpuTimeMs: 250_000_000, // 250M ms CPU
    memoryMbSeconds: 32_000_000_000, // 32 Billion MB-s
    kvReads: 500_000_000, // 500M KV reads
    kvWrites: 100_000_000, // 100M KV writes
    objectReads: 200_000_000, // 200M Object reads
    objectWrites: 50_000_000, // 50M Object writes
    queueSent: 150_000_000, // 150M Queue sent
    queueProcessed: 150_000_000, // 150M Queue processed
    storageBytesKv: 500 * 1024 * 1024 * 1024, // 500 GB
    storageBytesObjects: 50 * 1024 * 1024 * 1024 * 1024, // 50 TB
  };

  const cost = calculateProjectCost(enterpriseUsage);

  // Assert all fields are finite positive numbers
  assert(Number.isFinite(cost.totalCostUsd), "totalCostUsd must be finite");
  assert(!Number.isNaN(cost.totalCostUsd), "totalCostUsd must not be NaN");
  assert(
    cost.totalCostUsd > 0,
    "totalCostUsd must be positive for enterprise volume",
  );

  // Sum integrity
  const expectedCompute = roundMicroCent(
    cost.itemized.cpuCostUsd + cost.itemized.memoryCostUsd,
  );
  assertEquals(cost.computeCostUsd, expectedCompute);

  const expectedOperations = roundMicroCent(
    cost.itemized.kvOpsCostUsd + cost.itemized.objectOpsCostUsd +
      cost.itemized.queueOpsCostUsd,
  );
  assertEquals(cost.operationsCostUsd, expectedOperations);

  const expectedStorage = roundMicroCent(
    cost.itemized.kvStorageCostUsd + cost.itemized.objectStorageCostUsd,
  );
  assertEquals(cost.storageCostUsd, expectedStorage);

  const expectedTotal = roundMicroCent(
    cost.computeCostUsd + cost.operationsCostUsd + cost.storageCostUsd,
  );
  assertEquals(cost.totalCostUsd, expectedTotal);

  // Micro-cent precision strictly preserved at enterprise scale
  assertMicroCentPrecision(cost.totalCostUsd, "scale: totalCostUsd");
  assertMicroCentPrecision(cost.computeCostUsd, "scale: computeCostUsd");
  assertMicroCentPrecision(cost.operationsCostUsd, "scale: operationsCostUsd");
  assertMicroCentPrecision(cost.storageCostUsd, "scale: storageCostUsd");
});

Deno.test("Scale: Linear cost proportionality across operation counts", () => {
  // spec: contracts/platform.contract.md#PLAT-10
  const rates: PricingRates = {
    ...DEFAULT_PRICING_RATES,
    kvReadOpCostUsd: 0.000002, // $2 per 1M reads
  };

  const usage1M: ProjectUsageSummary = {
    orgId: "org_linear",
    projectId: "proj_linear",
    periodStart: 0,
    periodEnd: 1000,
    invocations: 0,
    cpuTimeMs: 0,
    memoryMbSeconds: 0,
    kvReads: 1_000_000,
    kvWrites: 0,
    objectReads: 0,
    objectWrites: 0,
    queueSent: 0,
    queueProcessed: 0,
    storageBytesKv: 0,
    storageBytesObjects: 0,
  };

  const usage2M: ProjectUsageSummary = {
    ...usage1M,
    kvReads: 2_000_000,
  };

  const cost1M = calculateProjectCost(usage1M, rates);
  const cost2M = calculateProjectCost(usage2M, rates);

  assertEquals(cost1M.itemized.kvOpsCostUsd, 2.000000);
  assertEquals(cost2M.itemized.kvOpsCostUsd, 4.000000);
  assertEquals(
    roundMicroCent(cost1M.itemized.kvOpsCostUsd * 2),
    cost2M.itemized.kvOpsCostUsd,
  );
});
