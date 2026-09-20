# T-0601 — Multi-Tenant Cost Calculation Engine

Status: Done
Milestone: 0.6 Public Beta
Depends on: T-0403, T-0501
Blocks: T-0607, T-0611

## Spec references

`PLAT-10`, `PLAT-13`, `PLAT-18`

## Scope

**In scope**:
- `packages/metrics/cost-calculator.ts`: Deterministic cost calculation and usage metering engine computing itemized costs across compute, storage, and primitive operations for organizations and projects.
- `packages/metrics/cost-calculator_test.ts`: Unit tests validating rate application, precision, itemization, and zero/negative boundary conditions.

**Out of scope**:
- Payment gateway integrations (Stripe, PayPal) or live credit card charging (banned per `PLAT-20`).
- Graphical accounting dashboards or invoice PDF rendering (banned per `PLAT-20`).
- Direct currency exchange rate conversions.

## Interface to implement

```typescript
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

export const DEFAULT_PRICING_RATES: PricingRates;

export function calculateProjectCost(
  usage: ProjectUsageSummary,
  rates?: Partial<PricingRates>,
): ProjectCostItemized;
```

## Acceptance criteria (Given/When/Then)

1. Given a `ProjectUsageSummary` containing invocation counts, CPU time in ms, memory-MB-seconds, storage operations, and byte volumes, when `calculateProjectCost` is called with default rates, then it returns itemized compute, storage, operations, and total USD cost matching the spec rate formulas with rounded micro-cent precision ($0.000001).
2. Given custom `PricingRates` overrides provided to `calculateProjectCost`, when evaluated, then it applies the specified custom coefficients without altering other default rates.
3. Given an empty or zero usage summary, when calculated, then it returns 0.00 for all itemized cost fields without NaN, undefined, or division-by-zero errors.
4. Given multiple consecutive usage batches aggregated for an organization across projects, when calculated, then each project's cost isolates cleanly per `PLAT-18`.

## Tests required

- [x] Unit — `packages/metrics/cost-calculator_test.ts`: Test default rate math, custom rate override, zero usage, and high-volume billing calculations.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-10`, `PLAT-13`, `PLAT-18`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

### Verification Outputs

```
$ deno check packages/metrics/cost-calculator.ts packages/metrics/cost-calculator_test.ts
(clean exit code 0, zero errors)
```

```
$ deno test -A packages/metrics/cost-calculator_test.ts
running 15 tests from ./packages/metrics/cost-calculator_test.ts
AC1: DEFAULT_PRICING_RATES exposes all required non-negative rate coefficients ... ok (4ms)
AC1: calculateProjectCost with default rates computes itemized costs and aggregations accurately ... ok (3ms)
AC1: Deterministic cost calculation against explicit custom pricing schedule ... ok (1ms)
AC1: Micro-cent precision rounds sub-micro-cent fractional costs to 6 decimals ... ok (1ms)
AC2: Partial PricingRates override applies custom rate while preserving default rates ... ok (2ms)
AC2: Overriding specific operation rates (kvWriteOpCostUsd) keeps read ops at default rate ... ok (442µs)
AC2: DEFAULT_PRICING_RATES object is not mutated by calculateProjectCost calls ... ok (640µs)
AC3: All-zero ProjectUsageSummary returns 0.00 across all fields without NaN or undefined ... ok (847µs)
AC3: Free-tier / zero rate override calculates zero cost for covered resources ... ok (366µs)
AC3: Non-positive or inverted period duration handles gracefully without negative cost ... ok (504µs)
AC4: Distinct projects within an organization calculate independently per PLAT-18 ... ok (607µs)
AC4: Multi-tenant organization isolation with identical project names ... ok (351µs)
AC4: Repeated calculations are pure and free of internal state retention ... ok (802µs)
Scale: Enterprise high-volume billing calculation without overflow or floating drift ... ok (993µs)
Scale: Linear cost proportionality across operation counts ... ok (1ms)

ok | 15 passed | 0 failed (64ms)
```

```
$ deno lint packages/metrics/cost-calculator.ts packages/metrics/cost-calculator_test.ts
Checked 2 files
(clean exit code 0, zero warnings)
```

## Assumptions made

None.
