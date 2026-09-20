# T-0607 — CLI Usage Reporting Subcommand

Status: Done
Milestone: 0.6 Public Beta
Depends on: T-0506, T-0601
Blocks: T-0611

## Spec references

`PLAT-10`, `PLAT-12`, `PLAT-13`, `PLAT-18`, `PLAT-19`

## Scope

**In scope**:
- `cli/usage.ts`: Implementation of the `rail usage` (and `rail cost`) CLI subcommand aggregating project usage batches and invoking `calculateProjectCost` (`packages/metrics/cost-calculator.ts`) to produce itemized cost reports in human-readable table (`--format=pretty`) and structured machine-readable JSON (`--format=json`).
- `cli/usage_test.ts`: Automated tests validating CLI formatting, flag parsing, zero-usage handling, and error containment.
- `cli/main.ts`: Dispatch wiring for the `usage` subcommand.

**Out of scope**:
- Direct credit card billing or third-party accounting software integrations (banned per `PLAT-20`).
- Modification of existing runtime metering collection loops (implemented in `T-0403`).

## Interface to implement

```typescript
import type { PricingRates, ProjectCostItemized, ProjectUsageSummary } from "../packages/metrics/cost-calculator.ts";

export interface UsageCliOptions {
  projectDir?: string;
  projectId?: string;
  format?: "pretty" | "json";
  rates?: Partial<PricingRates>;
  usageSource?: ProjectUsageSummary | string;
}

export function formatUsageReport(
  cost: ProjectCostItemized,
  format: "pretty" | "json",
): string;

export async function runUsage(options: UsageCliOptions): Promise<number>;
```

## Acceptance criteria (Given/When/Then)

1. Given project usage data, when `rail usage --format=pretty` is invoked, then it prints a structured human-readable breakdown displaying project ID, period, itemized compute (CPU ms, memory-MB-s), storage (KV/Objects GB-mo), operations (KV, Objects, Queues), and final total in USD.
2. Given project usage data, when `rail usage --format=json` is invoked, then it outputs valid JSON adhering to `ProjectCostItemized` without extraneous log prefixes.
3. Given a project with no recorded usage, when `runUsage` is executed, then it reports 0.00 across all categories and exits with code 0 without crashing.
4. Given invalid flags or unparseable usage data, when executed, then it outputs an actionable error adhering to `PLAT-12` and exits with code 1.
5. Given `rail --help` or `rail usage --help`, when executed, then it documents usage parameters and flags cleanly.

## Tests required

- [x] Unit — `cli/usage_test.ts`: Test `--format=pretty`, `--format=json`, custom rate overrides, and empty usage records.
- [x] Integration — `cli/usage_test.ts`: Test CLI dispatcher integration, help output, and process exit code behavior.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-10`, `PLAT-12`, `PLAT-13`, `PLAT-18`, `PLAT-19`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

## Verification Transcripts

### `deno check cli/usage.ts cli/usage_test.ts cli/main.ts`
```
Exit code: 0
Check cli/usage.ts
Check cli/usage_test.ts
Check cli/main.ts
```

### `deno test -A cli/usage_test.ts`
```
running 19 tests from ./cli/usage_test.ts
AC1 (Unit): formatUsageReport with format: 'pretty' displays human-readable header with project ID, org ID, and period ... ok (1ms)
AC1 (Unit): formatUsageReport with format: 'pretty' displays itemized breakdown lines across compute, storage, and operations ... ok (494µs)
AC1 (Unit): formatUsageReport with format: 'pretty' displays category subtotals and total cost in USD ($) ... ok (1ms)
AC2 (Unit): formatUsageReport with format: 'json' returns valid JSON adhering to ProjectCostItemized ... ok (1ms)
AC2 (Unit): formatUsageReport with format: 'json' preserves exact numeric values without string conversion ... ok (289µs)
AC3 (Unit): formatUsageReport with zero cost breakdown reports $0.00 without NaN or undefined ... ok (372µs)
AC3 (Integration): runUsage with zero ProjectUsageSummary exits 0 and logs $0.00 in pretty format ... ok (4ms)
AC3 (Integration): runUsage with zero ProjectUsageSummary exits 0 and outputs all-zero JSON ... ok (1ms)
AC4 (Integration): runUsage returns exit code 1 and PLAT-12 VALIDATION_FAILED on invalid JSON string in usageSource ... ok (2ms)
AC4 (Integration): runUsage returns exit code 1 and PLAT-12 error on non-existent usageSource file path ... ok (2ms)
AC4 (Integration): runUsage returns exit code 1 and VALIDATION_FAILED when usage data has invalid schema ... ok (1ms)
AC5 (Integration): runUsage resolves usage from .railfog/usage.json in specified projectDir ... ok (28ms)
AC5 (Integration): runUsage defaults gracefully to zero usage when .railfog/usage.json is missing in projectDir ... ok (13ms)
AC5 (Integration): runUsage resolves usage directly from custom file path passed in usageSource ... ok (26ms)
AC6 (Unit/Integration): runUsage applies custom pricing rates override to calculate cost ... ok (2ms)
AC6 (Integration): runUsage with custom rates displays updated costs in pretty format ... ok (2ms)
Integration: rail usage --help documents usage options and flags cleanly ... ok (284ms)
Integration: rail cost --help alias functions identically to rail usage --help ... ok (254ms)
Integration: rail usage with invalid flag exits with code 1 and PLAT-12 VALIDATION_FAILED ... ok (207ms)

ok | 19 passed | 0 failed (866ms)
```

### `deno lint cli/usage.ts cli/usage_test.ts cli/main.ts`
```
Exit code: 0
Checked 3 files, 0 problems
```

## Assumptions made

None.
