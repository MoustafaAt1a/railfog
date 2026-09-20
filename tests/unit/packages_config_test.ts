// spec: contracts/platform.contract.md#PLAT-12 — Error model (VALIDATION_FAILED)
// spec: contracts/platform.contract.md#PLAT-18 — Resource hierarchy (Organization -> Project -> Function)
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: packages/config
// spec: contracts/functions.contract.md#FN-5 — Resource limits (CPU, memory, timeout ceilings)
// spec: tasks/milestone-0.7-repo-consolidation/T-0702-configuration-package-extraction.md

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  parseRailFogConfig,
  type RailFogConfig,
  validateRailFogConfig,
} from "@railfog/config";

const VALID_TOML = `
[project]
id = "proj_01J8Z"
name = "api-service"
orgId = "org_01J8Z"

[functions.api]
entrypoint = "functions/api.ts"

[functions.api.triggers]
http = "/api/*"

[functions.api.limits]
cpuMs = 200
timeoutMs = 30000
memoryMb = 128
concurrency = 50

[functions.api.permissions]
kv = ["app:sessions"]
objects = ["app:uploads"]
queues = ["app:jobs"]
network = ["api.example.com"]
secrets = ["STRIPE_API_KEY"]

[kv."app:sessions"]
consistency = "strong"

[objects."app:uploads"]
public = false

[queues."app:jobs"]
maxDeliveryAttempts = 5
retryBackoffMs = 1000
`;

Deno.test("T-0702: parseRailFogConfig parses valid TOML into RailFogConfig (PLAT-18)", () => {
  const result = parseRailFogConfig(VALID_TOML);

  assertEquals(result.valid, true);
  assertEquals(result.diagnostics.length, 0);
  assert(result.config !== undefined);

  const cfg: RailFogConfig = result.config;
  assertEquals(cfg.project.id, "proj_01J8Z");
  assertEquals(cfg.project.orgId, "org_01J8Z");
  assertEquals(cfg.project.name, "api-service");

  assert(cfg.functions.api !== undefined);
  assertEquals(cfg.functions.api.entrypoint, "functions/api.ts");
  assertEquals(cfg.functions.api.triggers?.http, "/api/*");
  assertEquals(cfg.functions.api.limits?.cpuMs, 200);
  assertEquals(cfg.functions.api.limits?.memoryMb, 128);
  assertEquals(cfg.functions.api.limits?.timeoutMs, 30000);
  assertEquals(cfg.functions.api.limits?.concurrency, 50);

  assertEquals(cfg.functions.api.permissions?.kv, ["app:sessions"]);
  assertEquals(cfg.functions.api.permissions?.network, ["api.example.com"]);
  assertEquals(cfg.functions.api.permissions?.secrets, ["STRIPE_API_KEY"]);

  assertEquals(cfg.kv?.["app:sessions"]?.consistency, "strong");
  assertEquals(cfg.objects?.["app:uploads"]?.public, false);
  assertEquals(cfg.queues?.["app:jobs"]?.maxDeliveryAttempts, 5);
});

Deno.test("T-0702: parseRailFogConfig handles snake_case TOML keys cleanly", () => {
  const snakeCaseToml = `
[project]
id = "proj_01"
org_id = "org_01"

[functions.worker]
entry = "worker.ts"

[functions.worker.limits]
cpu_ms = 300
timeout_ms = 60000
memory_mb = 256
`;
  const result = parseRailFogConfig(snakeCaseToml);
  assertEquals(result.valid, true);
  assert(result.config !== undefined);
  assertEquals(result.config.project.orgId, "org_01");
  assertEquals(result.config.functions.worker.entrypoint, "worker.ts");
  assertEquals(result.config.functions.worker.limits?.cpuMs, 300);
  assertEquals(result.config.functions.worker.limits?.timeoutMs, 60000);
  assertEquals(result.config.functions.worker.limits?.memoryMb, 256);
});

Deno.test("T-0702: parseRailFogConfig returns VALIDATION_FAILED on syntax error (PLAT-12)", () => {
  const malformedToml = `
[project
id = "unclosed
`;
  const result = parseRailFogConfig(malformedToml);

  assertFalse(result.valid);
  assertEquals(result.config, undefined);
  assert(result.diagnostics.length > 0);
  const diag = result.diagnostics.find((d) => d.code === "VALIDATION_FAILED");
  assert(diag !== undefined, "Must contain a VALIDATION_FAILED diagnostic");
  assertEquals(diag.severity, "error");
});

Deno.test("T-0702: validateRailFogConfig validates resource hierarchy (PLAT-18)", () => {
  // Missing project.id
  const missingId = {
    project: { orgId: "org_01" },
    functions: {
      api: { entrypoint: "api.ts" },
    },
  };
  const res1 = validateRailFogConfig(missingId);
  assertFalse(res1.valid);
  const diag1 = res1.diagnostics.find(
    (d) => d.path === "project.id" && d.code === "VALIDATION_FAILED",
  );
  assert(diag1 !== undefined, "Must flag missing project.id");

  // Missing project.orgId
  const missingOrg = {
    project: { id: "proj_01" },
    functions: {
      api: { entrypoint: "api.ts" },
    },
  };
  const res2 = validateRailFogConfig(missingOrg);
  assertFalse(res2.valid);
  const diag2 = res2.diagnostics.find(
    (d) => d.path === "project.orgId" && d.code === "VALIDATION_FAILED",
  );
  assert(diag2 !== undefined, "Must flag missing project.orgId");
});

Deno.test("T-0702: validateRailFogConfig validates limits ceilings (FN-5)", () => {
  // Memory ceiling max 1024 MB
  const excessiveMemory = {
    project: { id: "proj_01", orgId: "org_01" },
    functions: {
      api: {
        entrypoint: "api.ts",
        limits: {
          memoryMb: 2048,
        },
      },
    },
  };
  const res1 = validateRailFogConfig(excessiveMemory);
  assertFalse(res1.valid);
  const memDiag = res1.diagnostics.find(
    (d) => d.path.includes("memoryMb") && d.code === "VALIDATION_FAILED",
  );
  assert(memDiag !== undefined, "Must flag memoryMb exceeding 1024 MB");

  // Timeout ceiling max 900,000 ms
  const excessiveTimeout = {
    project: { id: "proj_01", orgId: "org_01" },
    functions: {
      api: {
        entrypoint: "api.ts",
        limits: {
          timeoutMs: 1_000_000,
        },
      },
    },
  };
  const res2 = validateRailFogConfig(excessiveTimeout);
  assertFalse(res2.valid);
  const timeoutDiag = res2.diagnostics.find(
    (d) => d.path.includes("timeoutMs") && d.code === "VALIDATION_FAILED",
  );
  assert(timeoutDiag !== undefined, "Must flag timeoutMs exceeding 900,000 ms");
});

Deno.test("T-0702: validateRailFogConfig rejects non-object or missing functions", () => {
  const nullResult = validateRailFogConfig(null);
  assertFalse(nullResult.valid);
  assertEquals(nullResult.diagnostics[0].code, "VALIDATION_FAILED");

  const noFunctions = {
    project: { id: "proj_01", orgId: "org_01" },
  };
  const fnResult = validateRailFogConfig(noFunctions);
  assertFalse(fnResult.valid);
  assert(fnResult.diagnostics.some((d) => d.path === "functions"));
});
