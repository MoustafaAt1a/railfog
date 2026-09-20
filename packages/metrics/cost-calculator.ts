/**
 * Multi-Tenant Cost Calculation Engine.
 *
 * Deterministic cost calculation and usage metering engine computing itemized costs
 * across compute, storage, and primitive operations for organizations and projects.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-10 (SLOs & billing error bounds: deterministic rounding, micro-cent precision)
 * - docs/contracts/platform.contract.md#PLAT-13 (Observability: resource counters for function invocations, KV, objects, and queues)
 * - docs/contracts/platform.contract.md#PLAT-18 (Resource hierarchy: Organization -> Project isolation)
 * - tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md (AC1 - AC4)
 */

/**
 * Standard unit pricing rates for platform resource consumption.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-13
 * spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC1
 */
export interface PricingRates {
  cpuMillisecondCostUsd: number;
  memoryMbSecondCostUsd: number;
  kvReadOpCostUsd: number;
  kvWriteOpCostUsd: number;
  objectReadOpCostUsd: number;
  objectWriteOpCostUsd: number;
  queueSentOpCostUsd: number;
  queueProcessedOpCostUsd: number;
  kvStorageGbMonthCostUsd: number;
  objectStorageGbMonthCostUsd: number;
}

/**
 * Aggregated usage metric totals for a project over a specified time window.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-13
 * spec: docs/contracts/platform.contract.md#PLAT-18
 */
export interface ProjectUsageSummary {
  orgId: string;
  projectId: string;
  periodStart: number;
  periodEnd: number;
  invocations: number;
  cpuTimeMs: number;
  memoryMbSeconds: number;
  kvReads: number;
  kvWrites: number;
  objectReads: number;
  objectWrites: number;
  queueSent: number;
  queueProcessed: number;
  storageBytesKv: number;
  storageBytesObjects: number;
}

/**
 * Itemized and aggregated financial cost breakdown for a project.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-10
 * spec: docs/contracts/platform.contract.md#PLAT-18
 */
export interface ProjectCostItemized {
  orgId: string;
  projectId: string;
  periodStart: number;
  periodEnd: number;
  computeCostUsd: number;
  storageCostUsd: number;
  operationsCostUsd: number;
  totalCostUsd: number;
  itemized: {
    cpuCostUsd: number;
    memoryCostUsd: number;
    kvOpsCostUsd: number;
    objectOpsCostUsd: number;
    queueOpsCostUsd: number;
    kvStorageCostUsd: number;
    objectStorageCostUsd: number;
  };
}

// spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC1 — default pricing rates schedule
export const DEFAULT_PRICING_RATES: PricingRates = Object.freeze({
  cpuMillisecondCostUsd: 0.000010, // $10 per 1M ms CPU
  memoryMbSecondCostUsd: 0.000002, // $2 per 1M MB-s
  kvReadOpCostUsd: 0.000001, // $1 per 1M reads
  kvWriteOpCostUsd: 0.000005, // $5 per 1M writes
  objectReadOpCostUsd: 0.000001, // $1 per 1M reads
  objectWriteOpCostUsd: 0.000005, // $5 per 1M writes
  queueSentOpCostUsd: 0.000001, // $1 per 1M sent
  queueProcessedOpCostUsd: 0.000001, // $1 per 1M processed
  kvStorageGbMonthCostUsd: 0.20, // $0.20 per GB-month
  objectStorageGbMonthCostUsd: 0.02, // $0.02 per GB-month
});

// spec: docs/contracts/platform.contract.md#PLAT-10 — micro-cent precision scale factor ($0.000001, 6 decimal places)
const MICRO_CENT_FACTOR = 1_000_000;

// spec: docs/contracts/platform.contract.md#PLAT-10 — bytes per gigabyte divisor (1024^3)
const BYTES_PER_GIGABYTE = 1024 * 1024 * 1024;

// spec: docs/contracts/platform.contract.md#PLAT-10 — nominal billing month duration in milliseconds (30 days)
const MS_PER_BILLING_MONTH = 30 * 24 * 60 * 60 * 1000;

/**
 * Rounds a USD monetary value to micro-cent ($0.000001 / 6 decimal places) precision.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-10 — error bounds and deterministic rounding
 * spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC1
 */
function roundMicroCent(val: number): number {
  if (!Number.isFinite(val) || val <= 0) {
    return 0;
  }
  return Math.round(val * MICRO_CENT_FACTOR) / MICRO_CENT_FACTOR;
}

/**
 * Sanitizes a numeric usage metric, ensuring non-negative finite value.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-10 — boundary safety against negative usage
 */
function sanitizeUsageQuantity(quantity: number): number {
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
}

/**
 * Calculates itemized and total USD costs for a project usage summary.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-10 — deterministic pricing calculation
 * spec: docs/contracts/platform.contract.md#PLAT-13 — resource consumption dimensions
 * spec: docs/contracts/platform.contract.md#PLAT-18 — organization and project level isolation
 * spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC1-AC4
 *
 * @param usage Aggregated project usage summary
 * @param rates Optional partial pricing rates overriding defaults
 * @returns Itemized and aggregated cost breakdown
 */
export function calculateProjectCost(
  usage: ProjectUsageSummary,
  rates?: Partial<PricingRates>,
): ProjectCostItemized {
  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC2 — merge rates without mutating DEFAULT_PRICING_RATES
  const mergedRates: PricingRates = {
    cpuMillisecondCostUsd: rates?.cpuMillisecondCostUsd ??
      DEFAULT_PRICING_RATES.cpuMillisecondCostUsd,
    memoryMbSecondCostUsd: rates?.memoryMbSecondCostUsd ??
      DEFAULT_PRICING_RATES.memoryMbSecondCostUsd,
    kvReadOpCostUsd: rates?.kvReadOpCostUsd ??
      DEFAULT_PRICING_RATES.kvReadOpCostUsd,
    kvWriteOpCostUsd: rates?.kvWriteOpCostUsd ??
      DEFAULT_PRICING_RATES.kvWriteOpCostUsd,
    objectReadOpCostUsd: rates?.objectReadOpCostUsd ??
      DEFAULT_PRICING_RATES.objectReadOpCostUsd,
    objectWriteOpCostUsd: rates?.objectWriteOpCostUsd ??
      DEFAULT_PRICING_RATES.objectWriteOpCostUsd,
    queueSentOpCostUsd: rates?.queueSentOpCostUsd ??
      DEFAULT_PRICING_RATES.queueSentOpCostUsd,
    queueProcessedOpCostUsd: rates?.queueProcessedOpCostUsd ??
      DEFAULT_PRICING_RATES.queueProcessedOpCostUsd,
    kvStorageGbMonthCostUsd: rates?.kvStorageGbMonthCostUsd ??
      DEFAULT_PRICING_RATES.kvStorageGbMonthCostUsd,
    objectStorageGbMonthCostUsd: rates?.objectStorageGbMonthCostUsd ??
      DEFAULT_PRICING_RATES.objectStorageGbMonthCostUsd,
  };

  // spec: docs/contracts/platform.contract.md#PLAT-13 — compute cost calculation
  const cpuMs = sanitizeUsageQuantity(usage.cpuTimeMs);
  const memoryMbSec = sanitizeUsageQuantity(usage.memoryMbSeconds);
  const cpuCostUsd = roundMicroCent(cpuMs * mergedRates.cpuMillisecondCostUsd);
  const memoryCostUsd = roundMicroCent(
    memoryMbSec * mergedRates.memoryMbSecondCostUsd,
  );
  const computeCostUsd = roundMicroCent(cpuCostUsd + memoryCostUsd);

  // spec: docs/contracts/platform.contract.md#PLAT-13 — operations cost calculation
  const kvReads = sanitizeUsageQuantity(usage.kvReads);
  const kvWrites = sanitizeUsageQuantity(usage.kvWrites);
  const kvOpsCostUsd = roundMicroCent(
    kvReads * mergedRates.kvReadOpCostUsd +
      kvWrites * mergedRates.kvWriteOpCostUsd,
  );

  const objectReads = sanitizeUsageQuantity(usage.objectReads);
  const objectWrites = sanitizeUsageQuantity(usage.objectWrites);
  const objectOpsCostUsd = roundMicroCent(
    objectReads * mergedRates.objectReadOpCostUsd +
      objectWrites * mergedRates.objectWriteOpCostUsd,
  );

  const queueSent = sanitizeUsageQuantity(usage.queueSent);
  const queueProcessed = sanitizeUsageQuantity(usage.queueProcessed);
  const queueOpsCostUsd = roundMicroCent(
    queueSent * mergedRates.queueSentOpCostUsd +
      queueProcessed * mergedRates.queueProcessedOpCostUsd,
  );

  const operationsCostUsd = roundMicroCent(
    kvOpsCostUsd + objectOpsCostUsd + queueOpsCostUsd,
  );

  // spec: docs/contracts/platform.contract.md#PLAT-10 — duration fraction calculation with inverted period boundary guard
  const periodDurationMs = usage.periodEnd - usage.periodStart;
  const monthFraction = periodDurationMs > 0
    ? periodDurationMs / MS_PER_BILLING_MONTH
    : 0;

  // spec: docs/contracts/platform.contract.md#PLAT-13 — storage cost calculation
  const storageBytesKv = sanitizeUsageQuantity(usage.storageBytesKv);
  const storageBytesObjects = sanitizeUsageQuantity(usage.storageBytesObjects);

  const kvStorageCostUsd = roundMicroCent(
    (storageBytesKv / BYTES_PER_GIGABYTE) * monthFraction *
      mergedRates.kvStorageGbMonthCostUsd,
  );
  const objectStorageCostUsd = roundMicroCent(
    (storageBytesObjects / BYTES_PER_GIGABYTE) * monthFraction *
      mergedRates.objectStorageGbMonthCostUsd,
  );
  const storageCostUsd = roundMicroCent(
    kvStorageCostUsd + objectStorageCostUsd,
  );

  // spec: tasks/milestone-0.6-public-beta/T-0601-multi-tenant-cost-calculator.md#AC1 — total aggregated cost
  const totalCostUsd = roundMicroCent(
    computeCostUsd + operationsCostUsd + storageCostUsd,
  );

  // spec: docs/contracts/platform.contract.md#PLAT-18 — project isolation and metadata preservation
  return {
    orgId: usage.orgId,
    projectId: usage.projectId,
    periodStart: usage.periodStart,
    periodEnd: usage.periodEnd,
    computeCostUsd,
    storageCostUsd,
    operationsCostUsd,
    totalCostUsd,
    itemized: {
      cpuCostUsd,
      memoryCostUsd,
      kvOpsCostUsd,
      objectOpsCostUsd,
      queueOpsCostUsd,
      kvStorageCostUsd,
      objectStorageCostUsd,
    },
  };
}
