/**
 * Test suite for CLI rail usage / cost subcommand (T-0607).
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-10 (SLOs & billing error bounds: micro-cent precision, zero handling)
 * - docs/contracts/platform.contract.md#PLAT-12 (Error model: VALIDATION_FAILED, RESOURCE_NOT_FOUND error containment)
 * - docs/contracts/platform.contract.md#PLAT-13 (Observability: resource metrics for compute, storage, ops)
 * - docs/contracts/platform.contract.md#PLAT-18 (Resource hierarchy: Org -> Project isolation and metadata)
 * - docs/contracts/platform.contract.md#PLAT-19 (Repository structure and CLI subcommand dispatch)
 * - tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md (AC1 - AC6)
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  calculateProjectCost,
  DEFAULT_PRICING_RATES,
  type PricingRates,
  type ProjectCostItemized,
  type ProjectUsageSummary,
} from "../../packages/metrics/cost-calculator.ts";
import {
  formatUsageReport,
  runUsage,
  type UsageCliOptions,
} from "../../cli/usage.ts";

const cliMainPath = fromFileUrl(new URL("../../cli/main.ts", import.meta.url));

// =============================================================================
// Test Helpers & Fixtures
// =============================================================================

interface CapturedOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Strips ANSI escape codes from terminal text.
 */
function stripAnsi(text: string): string {
  return text.replace(
    // deno-lint-ignore no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );
}

/**
 * Intercepts console logging while executing runUsage in-process.
 */
async function captureRunUsage(
  options: UsageCliOptions,
): Promise<CapturedOutput> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    stdoutChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };
  console.info = (...args: unknown[]) => {
    stdoutChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };
  console.warn = (...args: unknown[]) => {
    stderrChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };
  console.error = (...args: unknown[]) => {
    stderrChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };

  try {
    const exitCode = await runUsage(options);
    return {
      exitCode,
      stdout: stdoutChunks.join("\n"),
      stderr: stderrChunks.join("\n"),
    };
  } finally {
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origError;
  }
}

/**
 * Executes CLI command via subprocess.
 */
async function runCli(
  args: string[],
  cwd: string,
): Promise<CapturedOutput> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-net",
      cliMainPath,
      ...args,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    exitCode: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/**
 * Sample fixture with known, non-zero usage numbers.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-13 — resource consumption metrics
 * spec: docs/contracts/platform.contract.md#PLAT-18 — organization and project isolation
 */
function createSampleUsageSummary(): ProjectUsageSummary {
  return {
    orgId: "org_sample_42",
    projectId: "proj_billing_demo",
    periodStart: 1_700_000_000_000,
    periodEnd: 1_702_592_000_000, // +30 days (1 nominal billing month)
    invocations: 50_000,
    cpuTimeMs: 1_000_000, // 1M ms -> $10.00 at default rate ($0.000010/ms)
    memoryMbSeconds: 2_000_000, // 2M MB-s -> $4.00 at default rate ($0.000002/MB-s)
    kvReads: 500_000, // 500k reads -> $0.50 ($0.000001/op)
    kvWrites: 100_000, // 100k writes -> $0.50 ($0.000005/op)
    objectReads: 200_000, // 200k reads -> $0.20 ($0.000001/op)
    objectWrites: 40_000, // 40k writes -> $0.20 ($0.000005/op)
    queueSent: 100_000, // 100k sent -> $0.10 ($0.000001/op)
    queueProcessed: 100_000, // 100k processed -> $0.10 ($0.000001/op)
    storageBytesKv: 10 * 1024 * 1024 * 1024, // 10 GB-mo -> $2.00 ($0.20/GB-mo)
    storageBytesObjects: 100 * 1024 * 1024 * 1024, // 100 GB-mo -> $2.00 ($0.02/GB-mo)
  };
}

/**
 * Sample fixture with calculated costs.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-10 — deterministic pricing calculation
 */
function createSampleCostItemized(): ProjectCostItemized {
  const usage = createSampleUsageSummary();
  return calculateProjectCost(usage, DEFAULT_PRICING_RATES);
}

/**
 * Zero-usage fixture.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-10 — zero usage handling
 */
function createZeroUsageSummary(): ProjectUsageSummary {
  return {
    orgId: "org_zero",
    projectId: "proj_zero",
    periodStart: 1_700_000_000_000,
    periodEnd: 1_702_592_000_000,
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

// =============================================================================
// AC1: formatUsageReport with format: "pretty"
// =============================================================================

Deno.test(
  "AC1 (Unit): formatUsageReport with format: 'pretty' displays human-readable header with project ID, org ID, and period",
  () => {
    // spec: docs/contracts/platform.contract.md#PLAT-10
    // spec: docs/contracts/platform.contract.md#PLAT-18
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC1
    const cost = createSampleCostItemized();
    const output = stripAnsi(formatUsageReport(cost, "pretty"));

    assertStringIncludes(
      output,
      "proj_billing_demo",
      "Pretty report must include the project ID",
    );
    assertStringIncludes(
      output,
      "org_sample_42",
      "Pretty report must include the org ID",
    );

    // Assert period timestamps or ISO representations are present
    const hasTimestamp = output.includes("1700000000000") ||
      output.includes(new Date(1700000000000).toISOString().slice(0, 10)) ||
      output.includes(new Date(1700000000000).toLocaleDateString());
    assert(
      hasTimestamp,
      "Pretty report must display period start date/timestamp",
    );
  },
);

Deno.test(
  "AC1 (Unit): formatUsageReport with format: 'pretty' displays itemized breakdown lines across compute, storage, and operations",
  () => {
    // spec: docs/contracts/platform.contract.md#PLAT-13
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC1
    const cost = createSampleCostItemized();
    const output = stripAnsi(formatUsageReport(cost, "pretty"));

    // Itemized Compute breakdown
    assertMatch(output, /CPU/i, "Must display CPU line");
    assertMatch(output, /\$10\.00/, "Must format CPU cost as $10.00");
    assertMatch(output, /Memory/i, "Must display Memory line");
    assertMatch(output, /\$4\.00/, "Must format Memory cost as $4.00");

    // Itemized Operations breakdown
    assertMatch(output, /KV/i, "Must display KV operations");
    assertMatch(output, /\$1\.00/, "Must format KV ops cost as $1.00");
    assertMatch(output, /Object/i, "Must display Object operations");
    assertMatch(output, /\$0\.40/, "Must format Object ops cost as $0.40");
    assertMatch(output, /Queue/i, "Must display Queue operations");
    assertMatch(output, /\$0\.20/, "Must format Queue ops cost as $0.20");

    // Itemized Storage breakdown
    assertMatch(output, /KV Storage|KV/i, "Must display KV storage line");
    assertMatch(output, /\$2\.00/, "Must format KV storage cost as $2.00");
    assertMatch(
      output,
      /Object Storage|Object/i,
      "Must display Object storage line",
    );
  },
);

Deno.test(
  "AC1 (Unit): formatUsageReport with format: 'pretty' displays category subtotals and total cost in USD ($)",
  () => {
    // spec: docs/contracts/platform.contract.md#PLAT-10
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC1
    const cost = createSampleCostItemized();
    const output = stripAnsi(formatUsageReport(cost, "pretty"));

    // Compute subtotal: $14.00
    assertMatch(
      output,
      /Compute.*\$14\.00|\$14\.00.*Compute/is,
      "Must display Compute subtotal $14.00",
    );

    // Operations subtotal: $1.60
    assertMatch(
      output,
      /Operations.*\$1\.60|\$1\.60.*Operations/is,
      "Must display Operations subtotal $1.60",
    );

    // Storage subtotal: $4.00
    assertMatch(
      output,
      /Storage.*\$4\.00|\$4\.00.*Storage/is,
      "Must display Storage subtotal $4.00",
    );

    // Total cost: $19.60
    assertMatch(
      output,
      /Total.*\$19\.60|\$19\.60.*Total/is,
      "Must display Total cost $19.60",
    );
  },
);

// =============================================================================
// AC2: formatUsageReport with format: "json"
// =============================================================================

Deno.test(
  "AC2 (Unit): formatUsageReport with format: 'json' returns valid JSON adhering to ProjectCostItemized",
  () => {
    // spec: docs/contracts/platform.contract.md#PLAT-10
    // spec: docs/contracts/platform.contract.md#PLAT-12
    // spec: docs/contracts/platform.contract.md#PLAT-13
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC2
    const cost = createSampleCostItemized();
    const jsonString = formatUsageReport(cost, "json");

    // Must be clean JSON without extraneous prefixes or suffixes
    assert(
      jsonString.trim().startsWith("{"),
      "JSON output must start with '{'",
    );
    assert(
      jsonString.trim().endsWith("}"),
      "JSON output must end with '}'",
    );

    const parsed = JSON.parse(jsonString) as ProjectCostItemized;
    assertEquals(parsed.orgId, cost.orgId);
    assertEquals(parsed.projectId, cost.projectId);
    assertEquals(parsed.periodStart, cost.periodStart);
    assertEquals(parsed.periodEnd, cost.periodEnd);
    assertEquals(parsed.computeCostUsd, cost.computeCostUsd);
    assertEquals(parsed.storageCostUsd, cost.storageCostUsd);
    assertEquals(parsed.operationsCostUsd, cost.operationsCostUsd);
    assertEquals(parsed.totalCostUsd, cost.totalCostUsd);

    assertEquals(parsed.itemized.cpuCostUsd, cost.itemized.cpuCostUsd);
    assertEquals(parsed.itemized.memoryCostUsd, cost.itemized.memoryCostUsd);
    assertEquals(parsed.itemized.kvOpsCostUsd, cost.itemized.kvOpsCostUsd);
    assertEquals(
      parsed.itemized.objectOpsCostUsd,
      cost.itemized.objectOpsCostUsd,
    );
    assertEquals(
      parsed.itemized.queueOpsCostUsd,
      cost.itemized.queueOpsCostUsd,
    );
    assertEquals(
      parsed.itemized.kvStorageCostUsd,
      cost.itemized.kvStorageCostUsd,
    );
    assertEquals(
      parsed.itemized.objectStorageCostUsd,
      cost.itemized.objectStorageCostUsd,
    );
  },
);

Deno.test(
  "AC2 (Unit): formatUsageReport with format: 'json' preserves exact numeric values without string conversion",
  () => {
    // spec: docs/contracts/platform.contract.md#PLAT-10
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC2
    const cost = createSampleCostItemized();
    const jsonString = formatUsageReport(cost, "json");
    const parsed = JSON.parse(jsonString);

    assertEquals(typeof parsed.totalCostUsd, "number");
    assertEquals(typeof parsed.computeCostUsd, "number");
    assertEquals(typeof parsed.storageCostUsd, "number");
    assertEquals(typeof parsed.operationsCostUsd, "number");
    assertEquals(typeof parsed.itemized.cpuCostUsd, "number");
  },
);

// =============================================================================
// AC3: Zero usage handling
// =============================================================================

Deno.test(
  "AC3 (Unit): formatUsageReport with zero cost breakdown reports $0.00 without NaN or undefined",
  () => {
    // spec: docs/contracts/platform.contract.md#PLAT-10
    // spec: docs/contracts/platform.contract.md#PLAT-18
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC3
    const zeroUsage = createZeroUsageSummary();
    const zeroCost = calculateProjectCost(zeroUsage, DEFAULT_PRICING_RATES);

    const pretty = stripAnsi(formatUsageReport(zeroCost, "pretty"));
    assertFalse(pretty.includes("NaN"), "Pretty report must not contain NaN");
    assertFalse(
      pretty.includes("undefined"),
      "Pretty report must not contain undefined",
    );
    assertMatch(pretty, /\$0\.00/, "Pretty report must contain $0.00");

    const jsonString = formatUsageReport(zeroCost, "json");
    const parsed = JSON.parse(jsonString);
    assertEquals(parsed.totalCostUsd, 0);
    assertEquals(parsed.computeCostUsd, 0);
    assertEquals(parsed.storageCostUsd, 0);
    assertEquals(parsed.operationsCostUsd, 0);
    assertEquals(parsed.itemized.cpuCostUsd, 0);
    assertEquals(parsed.itemized.memoryCostUsd, 0);
  },
);

Deno.test(
  "AC3 (Integration): runUsage with zero ProjectUsageSummary exits 0 and logs $0.00 in pretty format",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-10
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC3
    const zeroUsage = createZeroUsageSummary();
    const result = await captureRunUsage({
      usageSource: zeroUsage,
      format: "pretty",
    });

    assertEquals(result.exitCode, 0, "runUsage with zero usage must exit 0");
    const out = stripAnsi(result.stdout);
    assertFalse(out.includes("NaN"), "Output must not contain NaN");
    assertFalse(out.includes("undefined"), "Output must not contain undefined");
    assertMatch(out, /\$0\.00/, "Output must display $0.00");
  },
);

Deno.test(
  "AC3 (Integration): runUsage with zero ProjectUsageSummary exits 0 and outputs all-zero JSON",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-10
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC3
    const zeroUsage = createZeroUsageSummary();
    const result = await captureRunUsage({
      usageSource: zeroUsage,
      format: "json",
    });

    assertEquals(result.exitCode, 0, "runUsage with zero usage must exit 0");
    const parsed = JSON.parse(result.stdout);
    assertEquals(parsed.totalCostUsd, 0);
    assertEquals(parsed.computeCostUsd, 0);
    assertEquals(parsed.storageCostUsd, 0);
    assertEquals(parsed.operationsCostUsd, 0);
  },
);

// =============================================================================
// AC4: Source parsing and error containment (PLAT-12)
// =============================================================================

Deno.test(
  "AC4 (Integration): runUsage returns exit code 1 and PLAT-12 VALIDATION_FAILED on invalid JSON string in usageSource",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED error model
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC4
    const result = await captureRunUsage({
      usageSource: "{ invalid json: true, ...",
      format: "pretty",
    });

    assertEquals(
      result.exitCode,
      1,
      "runUsage with malformed JSON source must exit 1",
    );
    const combinedOutput = result.stderr + "\n" + result.stdout;
    assertMatch(
      combinedOutput,
      /VALIDATION_FAILED/,
      "Error output must adhere to PLAT-12 VALIDATION_FAILED error code",
    );
  },
);

Deno.test(
  "AC4 (Integration): runUsage returns exit code 1 and PLAT-12 error on non-existent usageSource file path",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-12 — error model containment
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC4
    const nonExistentPath = "/path/to/missing/railfog-usage-file-404.json";
    const result = await captureRunUsage({
      usageSource: nonExistentPath,
      format: "pretty",
    });

    assertEquals(
      result.exitCode,
      1,
      "runUsage with non-existent file source must exit 1",
    );
    const combinedOutput = result.stderr + "\n" + result.stdout;
    assertMatch(
      combinedOutput,
      /VALIDATION_FAILED|RESOURCE_NOT_FOUND/,
      "Error output must cite PLAT-12 error code (VALIDATION_FAILED or RESOURCE_NOT_FOUND)",
    );
  },
);

Deno.test(
  "AC4 (Integration): runUsage returns exit code 1 and VALIDATION_FAILED when usage data has invalid schema",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-12 — schema validation failure
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC4
    const invalidSchemaJson = JSON.stringify({
      unexpectedKey: "random-data",
      notAProjectUsageSummary: true,
    });
    const result = await captureRunUsage({
      usageSource: invalidSchemaJson,
      format: "json",
    });

    assertEquals(
      result.exitCode,
      1,
      "runUsage with invalid schema must exit 1",
    );
    const combinedOutput = result.stderr + "\n" + result.stdout;
    assertMatch(
      combinedOutput,
      /VALIDATION_FAILED/,
      "Must cite PLAT-12 VALIDATION_FAILED for invalid usage schema",
    );
  },
);

// =============================================================================
// AC5: Local project directory source resolution
// =============================================================================

Deno.test(
  "AC5 (Integration): runUsage resolves usage from .railfog/usage.json in specified projectDir",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-18 — project hierarchy resolution
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC5
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-usage-test-" });
    try {
      // Create railfog.toml
      const tomlContent = `name = "local-project-alpha"\norg = "alpha-org"\n`;
      await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

      // Create .railfog/usage.json
      const dotRailfogDir = join(tempDir, ".railfog");
      await Deno.mkdir(dotRailfogDir, { recursive: true });

      const sampleUsage = createSampleUsageSummary();
      sampleUsage.projectId = "local-project-alpha";
      sampleUsage.orgId = "alpha-org";

      await Deno.writeTextFile(
        join(dotRailfogDir, "usage.json"),
        JSON.stringify(sampleUsage),
      );

      const result = await captureRunUsage({
        projectDir: tempDir,
        format: "json",
      });

      assertEquals(result.exitCode, 0, "runUsage must exit 0");
      const parsed = JSON.parse(result.stdout) as ProjectCostItemized;
      assertEquals(parsed.projectId, "local-project-alpha");
      assertEquals(parsed.orgId, "alpha-org");
      assertEquals(parsed.totalCostUsd, 19.6);
      assertEquals(parsed.computeCostUsd, 14.0);
      assertEquals(parsed.operationsCostUsd, 1.6);
      assertEquals(parsed.storageCostUsd, 4.0);
    } finally {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "AC5 (Integration): runUsage defaults gracefully to zero usage when .railfog/usage.json is missing in projectDir",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-10
    // spec: docs/contracts/platform.contract.md#PLAT-18
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC5
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-usage-test-empty-",
    });
    try {
      // Create railfog.toml without .railfog/usage.json
      const tomlContent = `name = "fresh-project"\norg = "fresh-org"\n`;
      await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

      const result = await captureRunUsage({
        projectDir: tempDir,
        format: "json",
      });

      assertEquals(
        result.exitCode,
        0,
        "Missing usage.json must exit 0 gracefully",
      );
      const parsed = JSON.parse(result.stdout) as ProjectCostItemized;
      assertEquals(parsed.projectId, "fresh-project");
      assertEquals(parsed.orgId, "fresh-org");
      assertEquals(parsed.totalCostUsd, 0);
      assertEquals(parsed.computeCostUsd, 0);
      assertEquals(parsed.operationsCostUsd, 0);
      assertEquals(parsed.storageCostUsd, 0);
    } finally {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "AC5 (Integration): runUsage resolves usage directly from custom file path passed in usageSource",
  async () => {
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC5
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-usage-file-" });
    try {
      const customFilePath = join(tempDir, "custom-usage-report.json");
      const sampleUsage = createSampleUsageSummary();
      await Deno.writeTextFile(
        customFilePath,
        JSON.stringify(sampleUsage),
      );

      const result = await captureRunUsage({
        usageSource: customFilePath,
        format: "json",
      });

      assertEquals(
        result.exitCode,
        0,
        "runUsage must read from file path source",
      );
      const parsed = JSON.parse(result.stdout) as ProjectCostItemized;
      assertEquals(parsed.totalCostUsd, 19.6);
      assertEquals(parsed.computeCostUsd, 14.0);
    } finally {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    }
  },
);

// =============================================================================
// AC6: Custom pricing rates override
// =============================================================================

Deno.test(
  "AC6 (Unit/Integration): runUsage applies custom pricing rates override to calculate cost",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-10
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC6
    const sampleUsage = createSampleUsageSummary();
    // Default cpuMillisecondCostUsd is 0.000010 ($10 per 1M ms)
    // Custom override to 0.000050 ($50 per 1M ms, a 5x increase)
    const customRates: Partial<PricingRates> = {
      cpuMillisecondCostUsd: 0.000050,
    };

    const result = await captureRunUsage({
      usageSource: sampleUsage,
      rates: customRates,
      format: "json",
    });

    assertEquals(result.exitCode, 0, "runUsage with custom rates must exit 0");
    const parsed = JSON.parse(result.stdout) as ProjectCostItemized;
    assertEquals(
      parsed.itemized.cpuCostUsd,
      50.0,
      "CPU cost must reflect custom rate ($0.000050 * 1,000,000 = $50.00)",
    );
    assertEquals(
      parsed.computeCostUsd,
      54.0,
      "Compute cost must reflect custom CPU rate + standard memory ($50 + $4 = $54)",
    );
    assertEquals(
      parsed.totalCostUsd,
      59.6,
      "Total cost must reflect custom CPU rate ($54 + $1.6 + $4 = $59.60)",
    );
  },
);

Deno.test(
  "AC6 (Integration): runUsage with custom rates displays updated costs in pretty format",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-10
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC6
    const sampleUsage = createSampleUsageSummary();
    const customRates: Partial<PricingRates> = {
      cpuMillisecondCostUsd: 0.000050,
    };

    const result = await captureRunUsage({
      usageSource: sampleUsage,
      rates: customRates,
      format: "pretty",
    });

    assertEquals(result.exitCode, 0);
    const out = stripAnsi(result.stdout);
    assertMatch(
      out,
      /\$50\.00/,
      "Pretty output must display custom CPU cost $50.00",
    );
    assertMatch(
      out,
      /\$59\.60/,
      "Pretty output must display custom Total cost $59.60",
    );
  },
);

// =============================================================================
// CLI Dispatcher & Help Output Integration
// =============================================================================

Deno.test(
  "Integration: rail usage --help documents usage options and flags cleanly",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-19 — CLI subcommands
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC5
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-help-test-" });
    try {
      const res = await runCli(["usage", "--help"], tempDir);
      assertEquals(res.exitCode, 0, "rail usage --help must exit 0");
      assertMatch(
        res.stdout,
        /--format/,
        "Help output must document --format flag",
      );
      assertMatch(
        res.stdout,
        /--project-dir/,
        "Help output must document --project-dir flag",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "Integration: rail cost --help alias functions identically to rail usage --help",
  async () => {
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md — scope: rail usage (and rail cost)
    const tempDir = await Deno.makeTempDir({
      prefix: "railfog-cost-help-test-",
    });
    try {
      const res = await runCli(["cost", "--help"], tempDir);
      assertEquals(res.exitCode, 0, "rail cost --help must exit 0");
      assertMatch(
        res.stdout,
        /--format/,
        "rail cost --help must document --format flag",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "Integration: rail usage with invalid flag exits with code 1 and PLAT-12 VALIDATION_FAILED",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-12 — error containment
    // spec: tasks/milestone-0.6-public-beta/T-0607-cli-usage-cost-reporting.md#AC4
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-invalid-flag-" });
    try {
      const res = await runCli(["usage", "--invalid-flag-1234"], tempDir);
      assertEquals(res.exitCode, 1, "Invalid flag must exit with code 1");
      const combined = res.stderr + "\n" + res.stdout;
      assertMatch(
        combined,
        /VALIDATION_FAILED|unknown|invalid/i,
        "Must report validation error adhering to PLAT-12",
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    }
  },
);
