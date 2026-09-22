/**
 * CLI Usage and Cost Reporting Subcommand (T-0607).
 *
 * Provides human-readable table formatting and structured JSON output of
 * itemized resource usage and financial cost breakdowns across compute, storage,
 * and primitive operations.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-10 (SLOs & billing error bounds: deterministic rounding, micro-cent precision, zero handling)
 * - docs/contracts/platform.contract.md#PLAT-12 (Error model: VALIDATION_FAILED, RESOURCE_NOT_FOUND error containment)
 * - docs/contracts/platform.contract.md#PLAT-13 (Observability: resource metrics counters for invocations, CPU, memory, KV, objects, queues)
 * - docs/contracts/platform.contract.md#PLAT-18 (Resource hierarchy: Organization -> Project isolation and metadata preservation)
 * - docs/contracts/platform.contract.md#PLAT-19 (Repository structure and CLI subcommand dispatch)
 * - tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md (AC1 - AC6)
 */

import { isAbsolute, join, resolve } from "@std/path";
import { parse } from "@std/toml";
import {
  calculateProjectCost,
  type PricingRates,
  type ProjectCostItemized,
  type ProjectUsageSummary,
} from "../packages/metrics/cost-calculator.ts";
import { renderStatusBar } from "./ui.ts";

/**
 * Options for the usage reporting CLI subcommand.
 *
 * spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#Interface to implement
 */
export interface UsageCliOptions {
  projectDir?: string;
  projectId?: string;
  project?: string;
  format?: "pretty" | "json";
  rates?: Partial<PricingRates>;
  usageSource?: ProjectUsageSummary | string;
}

/**
 * Formats a USD monetary value to two decimal places, safely handling non-finite or missing numbers.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-10 — deterministic micro-cent rounding and zero-cost display
 */
function formatUsd(amount: number | undefined): string {
  const val = typeof amount === "number" && Number.isFinite(amount)
    ? amount
    : 0;
  return `$${val.toFixed(2)}`;
}

/**
 * Formats an itemized project cost breakdown into human-readable text or JSON.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-10 — micro-cent precision and zero-cost reporting ($0.00 without NaN)
 * spec: docs/contracts/platform.contract.md#PLAT-12 — clean structured JSON output
 * spec: docs/contracts/platform.contract.md#PLAT-13 — itemized breakdown of compute, operations, and storage
 * spec: docs/contracts/platform.contract.md#PLAT-18 — organization and project metadata display
 * spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC1, AC2, AC3
 *
 * @param cost Itemized financial cost breakdown calculated for the project
 * @param format Output mode ("pretty" for formatted terminal table, "json" for raw JSON)
 * @returns Formatted report string
 */
export function formatUsageReport(
  cost: ProjectCostItemized,
  format: "pretty" | "json",
): string {
  // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC2 — clean JSON without prefixes
  // spec: docs/contracts/platform.contract.md#PLAT-12 — machine-readable JSON error and data representation
  if (format === "json") {
    return JSON.stringify(cost, null, 2);
  }

  // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC1 — pretty human-readable table
  // spec: docs/contracts/platform.contract.md#PLAT-18 — display project ID, org ID, and period
  const pStart =
    typeof cost.periodStart === "number" && Number.isFinite(cost.periodStart)
      ? cost.periodStart
      : 0;
  const pEnd =
    typeof cost.periodEnd === "number" && Number.isFinite(cost.periodEnd)
      ? cost.periodEnd
      : 0;
  const startDate = new Date(pStart).toISOString().slice(0, 10);
  const endDate = new Date(pEnd).toISOString().slice(0, 10);

  const lines: string[] = [
    "==================================================",
    "              RailFog Usage & Cost Report         ",
    "==================================================",
    `Project:  ${cost.projectId ?? "default-project"}`,
    `Org:      ${cost.orgId ?? "default-org"}`,
    `Period:   ${pStart} (${startDate}) to ${pEnd} (${endDate})`,
    "--------------------------------------------------",
    "Itemized Breakdown:",
    "",
    "  Compute:",
    `    CPU:                ${formatUsd(cost.itemized?.cpuCostUsd)}`,
    `    Memory:             ${formatUsd(cost.itemized?.memoryCostUsd)}`,
    `    Subtotal Compute:   ${formatUsd(cost.computeCostUsd)}`,
    "",
    "  Operations:",
    `    KV Operations:      ${formatUsd(cost.itemized?.kvOpsCostUsd)}`,
    `    Object Operations:  ${formatUsd(cost.itemized?.objectOpsCostUsd)}`,
    `    Queue Operations:   ${formatUsd(cost.itemized?.queueOpsCostUsd)}`,
    `    Subtotal Operations:${formatUsd(cost.operationsCostUsd)}`,
    "",
    "  Storage:",
    `    KV Storage:         ${formatUsd(cost.itemized?.kvStorageCostUsd)}`,
    `    Object Storage:     ${formatUsd(cost.itemized?.objectStorageCostUsd)}`,
    `    Subtotal Storage:   ${formatUsd(cost.storageCostUsd)}`,
    "",
    "--------------------------------------------------",
    `Total Cost:             ${formatUsd(cost.totalCostUsd)}`,
    "==================================================",
  ];

  return lines.join("\n");
}

/**
 * Required numeric metric keys in a valid ProjectUsageSummary schema.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-13 — resource counters for compute, ops, storage
 */
const REQUIRED_NUMERIC_FIELDS: Array<keyof ProjectUsageSummary> = [
  "periodStart",
  "periodEnd",
  "invocations",
  "cpuTimeMs",
  "memoryMbSeconds",
  "kvReads",
  "kvWrites",
  "objectReads",
  "objectWrites",
  "queueSent",
  "queueProcessed",
  "storageBytesKv",
  "storageBytesObjects",
];

/**
 * Validates whether an unknown object conforms to the ProjectUsageSummary schema.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED on schema error
 * spec: docs/contracts/platform.contract.md#PLAT-13 — resource metric counters
 */
function validateUsageSchema(obj: unknown): obj is ProjectUsageSummary {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return false;
  }
  const record = obj as Record<string, unknown>;
  for (const field of REQUIRED_NUMERIC_FIELDS) {
    if (typeof record[field] !== "number" || !Number.isFinite(record[field])) {
      return false;
    }
  }
  if (record.orgId !== undefined && typeof record.orgId !== "string") {
    return false;
  }
  if (record.projectId !== undefined && typeof record.projectId !== "string") {
    return false;
  }
  return true;
}

/**
 * Executes the usage and cost reporting command.
 *
 * Resolves project usage data from direct memory, custom files, or local `.railfog/usage.json`,
 * calculates itemized costs, and outputs reports in the specified format.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-10 — pricing calculation and zero-usage handling
 * spec: docs/contracts/platform.contract.md#PLAT-12 — error model containment (VALIDATION_FAILED, RESOURCE_NOT_FOUND)
 * spec: docs/contracts/platform.contract.md#PLAT-13 — observability resource metrics
 * spec: docs/contracts/platform.contract.md#PLAT-18 — project and organization hierarchy resolution
 * spec: docs/contracts/platform.contract.md#PLAT-19 — CLI subcommand dispatch
 * spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md
 *
 * @param options UsageCliOptions configuration flags
 * @returns Process exit code (0 for success, 1 for validation or resolution error)
 */
export async function runUsage(options: UsageCliOptions = {}): Promise<number> {
  try {
    if (
      options.format !== undefined &&
      options.format !== "pretty" &&
      options.format !== "json"
    ) {
      console.error(
        `Error [VALIDATION_FAILED]: Invalid format '${options.format}', must be 'pretty' or 'json'`,
      );
      return 1;
    }

    // spec: docs/contracts/platform.contract.md#PLAT-18 — project directory resolution
    const projectDir = resolve(options.projectDir ?? Deno.cwd());

    // spec: docs/contracts/platform.contract.md#PLAT-18 — read railfog.toml if present for project metadata
    let tomlName: string | undefined;
    let tomlOrg: string | undefined;
    const tomlPath = join(projectDir, "railfog.toml");
    try {
      const tomlContent = await Deno.readTextFile(tomlPath);
      const parsedToml = parse(tomlContent) as Record<string, unknown>;
      if (
        typeof parsedToml.name === "string" && parsedToml.name.trim().length > 0
      ) {
        tomlName = parsedToml.name.trim();
      }
      if (
        typeof parsedToml.org === "string" && parsedToml.org.trim().length > 0
      ) {
        tomlOrg = parsedToml.org.trim();
      }
    } catch {
      // railfog.toml is optional for usage reporting
    }

    const resolvedProjectId = options.projectId ?? options.project;
    const fallbackProject = resolvedProjectId ?? tomlName ?? "default-project";
    const fallbackOrg = tomlOrg ?? "default-org";

    let usage: ProjectUsageSummary;

    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC4, AC5 — usage source resolution
    if (options.usageSource !== undefined) {
      if (
        typeof options.usageSource === "object" && options.usageSource !== null
      ) {
        if (!validateUsageSchema(options.usageSource)) {
          console.error("Error [VALIDATION_FAILED]: Invalid usage schema");
          return 1;
        }
        usage = {
          ...options.usageSource,
          orgId: options.usageSource.orgId || fallbackOrg,
          projectId: resolvedProjectId || options.usageSource.projectId ||
            fallbackProject,
        };
      } else if (typeof options.usageSource === "string") {
        const trimmedSource = options.usageSource.trim();
        if (trimmedSource.startsWith("{")) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmedSource);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `Error [VALIDATION_FAILED]: Failed to parse JSON usage source: ${msg}`,
            );
            return 1;
          }
          if (!validateUsageSchema(parsed)) {
            console.error("Error [VALIDATION_FAILED]: Invalid usage schema");
            return 1;
          }
          usage = {
            ...parsed,
            orgId: parsed.orgId || fallbackOrg,
            projectId: resolvedProjectId || parsed.projectId || fallbackProject,
          };
        } else {
          // File path resolution
          const filePath = isAbsolute(options.usageSource)
            ? options.usageSource
            : resolve(projectDir, options.usageSource);

          try {
            const stat = await Deno.stat(filePath);
            if (!stat.isFile) {
              console.error(
                `Error [RESOURCE_NOT_FOUND]: Usage file not found: ${filePath}`,
              );
              return 1;
            }
          } catch (err) {
            if (err instanceof Deno.errors.NotFound) {
              console.error(
                `Error [RESOURCE_NOT_FOUND]: Usage file not found: ${filePath}`,
              );
              return 1;
            }
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `Error [VALIDATION_FAILED]: Failed to access usage file: ${msg}`,
            );
            return 1;
          }

          let fileText: string;
          try {
            fileText = await Deno.readTextFile(filePath);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `Error [VALIDATION_FAILED]: Failed to read usage file: ${msg}`,
            );
            return 1;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(fileText);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `Error [VALIDATION_FAILED]: Failed to parse usage file JSON: ${msg}`,
            );
            return 1;
          }

          if (!validateUsageSchema(parsed)) {
            console.error("Error [VALIDATION_FAILED]: Invalid usage schema");
            return 1;
          }

          usage = {
            ...parsed,
            orgId: parsed.orgId || fallbackOrg,
            projectId: resolvedProjectId || parsed.projectId || fallbackProject,
          };
        }
      } else {
        console.error("Error [VALIDATION_FAILED]: Invalid usageSource type");
        return 1;
      }
    } else {
      // Default: Check .railfog/usage.json in projectDir (PLAT-18)
      const defaultUsagePath = join(projectDir, ".railfog", "usage.json");
      let fileExists = false;
      try {
        const stat = await Deno.stat(defaultUsagePath);
        fileExists = stat.isFile;
      } catch {
        fileExists = false;
      }

      if (fileExists) {
        let fileText: string;
        try {
          fileText = await Deno.readTextFile(defaultUsagePath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `Error [VALIDATION_FAILED]: Failed to read .railfog/usage.json: ${msg}`,
          );
          return 1;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(fileText);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `Error [VALIDATION_FAILED]: Failed to parse .railfog/usage.json: ${msg}`,
          );
          return 1;
        }

        if (!validateUsageSchema(parsed)) {
          console.error("Error [VALIDATION_FAILED]: Invalid usage schema");
          return 1;
        }

        usage = {
          ...parsed,
          orgId: parsed.orgId || fallbackOrg,
          projectId: resolvedProjectId || parsed.projectId || fallbackProject,
        };
      } else {
        // spec: docs/contracts/platform.contract.md#PLAT-10 — Graceful zero-usage default
        const now = Date.now();
        usage = {
          orgId: fallbackOrg,
          projectId: fallbackProject,
          periodStart: now - 30 * 24 * 60 * 60 * 1000,
          periodEnd: now,
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
      }
    }

    // spec: docs/contracts/platform.contract.md#PLAT-10 — Calculate deterministic itemized cost
    const cost = calculateProjectCost(usage, options.rates);

    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC1, AC2 — Output report
    console.log(formatUsageReport(cost, options.format ?? "pretty"));
    if (options.format !== "json") {
      console.log();
      console.log(
        renderStatusBar([
          { label: "Project", value: cost.projectId ?? "default-project" },
          { label: "Compute", value: formatUsd(cost.computeCostUsd) },
          { label: "Operations", value: formatUsd(cost.operationsCostUsd) },
          { label: "Storage", value: formatUsd(cost.storageCostUsd) },
          { label: "Total Cost", value: formatUsd(cost.totalCostUsd) },
        ]),
      );
    }
    return 0;
  } catch (err) {
    // spec: docs/contracts/platform.contract.md#PLAT-12 — Error containment
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error [VALIDATION_FAILED]: ${message}`);
    return 1;
  }
}

export async function usageCommand(
  options?: UsageCliOptions,
): Promise<number> {
  return await runUsage(options);
}

export function printUsageHelp(): void {
  console.log(`RailFog CLI - Usage and cost reporting

Usage:
  rail usage [options]
  rail cost [options]

Options:
  -C, --dir <path>         Target project directory (alias: --project-dir, --cwd, default: current directory)
  -p, --project <name>     Project ID or name override (alias: -n, --name)
  --format <pretty|json>   Output format: pretty (default) or json (alias: --json)
  --json                   Output machine-readable JSON (alias for --format=json)
  --source <path|json>     Custom usage source JSON string or file path
  --rates <json>           Custom pricing rates JSON override
  -h, --help               Show help for usage command`);
}

