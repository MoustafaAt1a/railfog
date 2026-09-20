// spec: contracts/platform.contract.md#PLAT-3 — Deployment pipeline validation
// spec: contracts/platform.contract.md#PLAT-5 — Network policy allowlist + mandatory SSRF block
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & deploy-time permission scoping
// spec: contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm score = (literal * 2) + (wildcard * 1)
// spec: contracts/platform.contract.md#PLAT-12 — Machine-readable error codes (VALIDATION_FAILED)
// spec: contracts/platform.contract.md#PLAT-15 — Secrets management & valid identifier naming
// spec: contracts/platform.contract.md#PLAT-18 — Resource hierarchy (Organization -> Project -> Function)
// spec: contracts/kv.contract.md#KV-5 — Consistency tier compatibility (reject strong on eventual)
// spec: contracts/functions.contract.md#FN-2 — Trigger declarations (HTTP, Queue, Schedule)
// spec: contracts/functions.contract.md#FN-5 — Resource limits (CPU, memory, timeout ceilings)
// spec: tasks/milestone-0.5-developer-experience/T-0504-cli-config-validator.md

import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";

import {
  checkProject,
  isSsrfBlockedIp,
  runCheck,
  type ValidationIssue,
} from "../../cli/check.ts";

// ============================================================================
// Test Helpers
// ============================================================================

async function createTempProject(
  tomlContent: string,
  extraFiles: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "railfog_check_test_" });
  await Deno.writeTextFile(join(dir, "railfog.toml"), tomlContent);

  for (const [relPath, content] of Object.entries(extraFiles)) {
    const fullPath = join(dir, relPath);
    const lastSlash = fullPath.lastIndexOf("/");
    const lastBackslash = fullPath.lastIndexOf("\\");
    const dirEnd = Math.max(lastSlash, lastBackslash);
    if (dirEnd > 0) {
      await Deno.mkdir(fullPath.slice(0, dirEnd), { recursive: true });
    }
    await Deno.writeTextFile(fullPath, content);
  }

  return dir;
}

const DEFAULT_HANDLER_TS = `
export default async function handler(_req: Request): Promise<Response> {
  await Promise.resolve();
  return new Response("OK");
}
`;

// ============================================================================
// Group 1: Valid Configuration Pass (AC1, PLAT-3, PLAT-6, PLAT-11, FN-1, FN-2, FN-5)
// ============================================================================

Deno.test("AC1 (PLAT-3, PLAT-11): Given a valid railfog.toml and existing entrypoint files, checkProject reports valid=true and outputs route specificity summary", async () => {
  // spec: contracts/platform.contract.md#PLAT-3 — Schema validation
  // spec: contracts/platform.contract.md#PLAT-11 — Route specificity evaluation
  const toml = `
name = "production-app"

[functions.api]
entry = "src/api.ts"

[functions.api.permissions]
kv = ["app:sessions"]
objects = ["app:uploads"]
queues = ["app:jobs"]
network = ["api.example.com"]
secrets = ["STRIPE_KEY", "AUTH_SECRET"]

[functions.api.limits]
cpu_ms = 200
timeout_ms = 15000
memory_mb = 256
concurrency = 50

[functions.worker]
entry = "src/worker.ts"

[functions.worker.triggers]
queue = "app:jobs"
schedule = "*/10 * * * *"

[functions.worker.limits]
timeout_ms = 600000

[[routes]]
pattern = "/api/v1/users"
function = "api"

[[routes]]
pattern = "/api/*"
function = "api"
`;

  const dir = await createTempProject(toml, {
    "src/api.ts": DEFAULT_HANDLER_TS,
    "src/worker.ts": DEFAULT_HANDLER_TS,
  });

  try {
    // Test directory path
    const resultDir = await checkProject(dir);
    assertEquals(resultDir.valid, true);
    assertEquals(resultDir.errors.length, 0);
    assertExists(resultDir.routeSummary);
    assertEquals(resultDir.routeSummary.length, 2);

    // Route specificity verification per PLAT-11:
    // /api/v1/users: 3 literal segments -> score 6
    // /api/*: 1 literal segment + 1 wildcard -> score 3
    assertEquals(resultDir.routeSummary[0].pattern, "/api/v1/users");
    assertEquals(resultDir.routeSummary[0].score, 6);
    assertEquals(resultDir.routeSummary[1].pattern, "/api/*");
    assertEquals(resultDir.routeSummary[1].score, 3);

    // Test direct railfog.toml file path
    const resultFile = await checkProject(join(dir, "railfog.toml"));
    assertEquals(resultFile.valid, true);
    assertEquals(resultFile.errors.length, 0);

    // Test runCheck exit code 0
    const exitCode = await runCheck(dir);
    assertEquals(exitCode, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Group 2: Missing Entrypoint File Resolution (AC2, PLAT-3, PLAT-6)
// ============================================================================

Deno.test("AC2 (PLAT-3): Given a railfog.toml pointing to a non-existent entrypoint file, checkProject rejects with VALIDATION_FAILED and exit code 1", async () => {
  // spec: contracts/platform.contract.md#PLAT-3 — Entrypoint verification
  const toml = `
name = "broken-app"

[functions.api]
entry = "src/missing.ts"

[[routes]]
pattern = "/api/*"
function = "api"
`;

  const dir = await createTempProject(toml); // Do not create src/missing.ts

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    assert(result.errors.length > 0);

    const missingError = result.errors.find(
      (e: ValidationIssue) =>
        e.code === "VALIDATION_FAILED" &&
        (e.path.includes("entry") || e.path.includes("functions.api")),
    );
    assertExists(
      missingError,
      "Must contain error indicating missing entrypoint",
    );
    assert(
      missingError.message.toLowerCase().includes("missing.ts") ||
        missingError.message.toLowerCase().includes("does not exist") ||
        missingError.message.toLowerCase().includes("not found"),
    );

    const exitCode = await runCheck(dir);
    assertEquals(exitCode, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("PLAT-6: Entrypoint escaping project root directory via path traversal is rejected with VALIDATION_FAILED", async () => {
  // spec: contracts/platform.contract.md#PLAT-6 — Path traversal isolation
  const toml = `
name = "traversal-app"

[functions.api]
entry = "../../outside.ts"

[[routes]]
pattern = "/api/*"
function = "api"
`;

  const dir = await createTempProject(toml);

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    const traversalError = result.errors.find(
      (e: ValidationIssue) =>
        e.code === "VALIDATION_FAILED" &&
        (e.path.includes("entry") ||
          e.message.toLowerCase().includes("escape")),
    );
    assertExists(
      traversalError,
      "Must reject entrypoint path escaping project directory",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Group 3: Consistency Tier Compatibility (AC3, KV-5)
// ============================================================================

Deno.test("AC3 (KV-5): Given a KV namespace configured with consistency 'strong' on an 'eventual' provider, rejects with KV-5 deploy-time error", async () => {
  // spec: contracts/kv.contract.md#KV-5 — Requesting strong against eventual provider is a deploy-time validation error
  const toml = `
name = "kv-mismatch-app"

[kv.sessions]
consistency = "strong"
provider = "cloudflare"

[functions.api]
entry = "api.ts"

[[routes]]
pattern = "/api/*"
function = "api"
`;

  const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);

    const kvError = result.errors.find(
      (e: ValidationIssue) =>
        (e.code === "KV-5" || e.code === "VALIDATION_FAILED") &&
        (e.path.includes("kv.sessions") ||
          e.message.toLowerCase().includes("strong") ||
          e.message.toLowerCase().includes("kv-5")),
    );
    assertExists(
      kvError,
      "Must reject strong consistency requested on eventual provider per KV-5",
    );
    assert(
      kvError.message.toLowerCase().includes("strong") ||
        kvError.message.toLowerCase().includes("eventual") ||
        kvError.message.includes("KV-5"),
    );

    const exitCode = await runCheck(dir);
    assertEquals(exitCode, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("AC3 (KV-5): Given a KV namespace configured with consistency 'strong' on Workers KV provider alias, rejects with KV-5", async () => {
  // spec: contracts/kv.contract.md#KV-5 — Cloudflare Workers KV free tier / eventual consistency rejection
  const toml = `
name = "workers-kv-app"

[kv.tokens]
consistency = "strong"
provider = "workers-kv"

[functions.api]
entry = "api.ts"

[[routes]]
pattern = "/api/*"
function = "api"
`;

  const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    const kvError = result.errors.find(
      (e: ValidationIssue) =>
        e.code === "KV-5" ||
        (e.code === "VALIDATION_FAILED" && e.path.includes("kv.tokens")),
    );
    assertExists(
      kvError,
      "Must reject strong consistency on workers-kv provider",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("KV-5: Given consistency 'strong' on a CAS-capable provider (deno-deploy or sqlite), validation passes", async () => {
  // spec: contracts/kv.contract.md#KV-5 — Deno Deploy KV and SQLite support strong consistency
  const toml = `
name = "kv-valid-app"

[kv.sessions]
consistency = "strong"
provider = "deno-deploy"

[kv.cache]
consistency = "eventual"
provider = "cloudflare"

[functions.api]
entry = "api.ts"

[[routes]]
pattern = "/api/*"
function = "api"
`;

  const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, true);
    assertEquals(result.errors.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Group 4: Limit Boundary Violations (AC4, FN-5)
// ============================================================================

Deno.test("AC4 (FN-5): Function declaring memory_mb > 1024 is rejected with error citing 1024 MB ceiling", async () => {
  // spec: contracts/functions.contract.md#FN-5 — memory_mb default 128, max 1024
  const toml = `
name = "high-memory-app"

[functions.api]
entry = "api.ts"

[functions.api.limits]
memory_mb = 2048

[[routes]]
pattern = "/api/*"
function = "api"
`;

  const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);

    const memError = result.errors.find(
      (e: ValidationIssue) =>
        (e.code === "FN-5" || e.code === "VALIDATION_FAILED") &&
        (e.path.includes("memory_mb") || e.message.includes("1024")),
    );
    assertExists(memError, "Must reject memory_mb > 1024 per FN-5");
    assert(
      memError.message.includes("1024") || memError.message.includes("memory"),
    );

    const exitCode = await runCheck(dir);
    assertEquals(exitCode, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("FN-5: Function declaring memory_mb <= 0 is rejected", async () => {
  // spec: contracts/functions.contract.md#FN-5 — memory_mb must be a positive integer
  const toml = `
name = "zero-memory-app"

[functions.api]
entry = "api.ts"

[functions.api.limits]
memory_mb = 0

[[routes]]
pattern = "/api/*"
function = "api"
`;

  const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    const err = result.errors.find(
      (e: ValidationIssue) =>
        (e.code === "FN-5" || e.code === "VALIDATION_FAILED") &&
        e.path.includes("memory_mb"),
    );
    assertExists(err, "Must reject memory_mb <= 0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("FN-5: HTTP Function declaring timeout_ms > 30000 is rejected with max 30s ceiling", async () => {
  // spec: contracts/functions.contract.md#FN-5 — timeout_ms 30,000 for HTTP triggers
  const toml = `
name = "long-http-timeout-app"

[functions.api]
entry = "api.ts"

[functions.api.limits]
timeout_ms = 45000

[[routes]]
pattern = "/api/*"
function = "api"
`;

  const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);

    const timeoutError = result.errors.find(
      (e: ValidationIssue) =>
        (e.code === "FN-5" || e.code === "VALIDATION_FAILED") &&
        (e.path.includes("timeout_ms") || e.message.includes("30000") ||
          e.message.includes("30,000")),
    );
    assertExists(timeoutError, "Must reject HTTP timeout_ms > 30000 per FN-5");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("FN-5: Background trigger Function declaring timeout_ms > 900000 is rejected", async () => {
  // spec: contracts/functions.contract.md#FN-5 — timeout_ms 900,000 (15 min) for queue/schedule triggers
  const toml = `
name = "long-worker-timeout-app"

[functions.worker]
entry = "worker.ts"

[functions.worker.triggers]
queue = "app:jobs"

[functions.worker.limits]
timeout_ms = 1200000

[[routes]]
pattern = "/health"
function = "worker"
`;

  const dir = await createTempProject(toml, {
    "worker.ts": DEFAULT_HANDLER_TS,
  });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);

    const timeoutError = result.errors.find(
      (e: ValidationIssue) =>
        (e.code === "FN-5" || e.code === "VALIDATION_FAILED") &&
        (e.path.includes("timeout_ms") || e.message.includes("900000")),
    );
    assertExists(
      timeoutError,
      "Must reject background trigger timeout_ms > 900000 per FN-5",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("FN-5: Background trigger Function accepting timeout_ms <= 900000 passes validation", async () => {
  // spec: contracts/functions.contract.md#FN-5 — background timeout within 900,000 ms ceiling
  const toml = `
name = "valid-worker-timeout-app"

[functions.worker]
entry = "worker.ts"

[functions.worker.triggers]
schedule = "0 * * * *"

[functions.worker.limits]
timeout_ms = 600000

[[routes]]
pattern = "/health"
function = "worker"
`;

  const dir = await createTempProject(toml, {
    "worker.ts": DEFAULT_HANDLER_TS,
  });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, true);
    assertEquals(result.errors.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("FN-5: Function declaring cpu_ms <= 0 is rejected", async () => {
  // spec: contracts/functions.contract.md#FN-5 — cpu_ms must be positive
  const toml = `
name = "zero-cpu-app"

[functions.api]
entry = "api.ts"

[functions.api.limits]
cpu_ms = 0

[[routes]]
pattern = "/api/*"
function = "api"
`;

  const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    const err = result.errors.find(
      (e: ValidationIssue) =>
        (e.code === "FN-5" || e.code === "VALIDATION_FAILED") &&
        e.path.includes("cpu_ms"),
    );
    assertExists(err, "Must reject cpu_ms <= 0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Group 5: Route Specificity and Overlap Analysis (AC5, PLAT-11)
// ============================================================================

Deno.test("AC5 (PLAT-11): Multiple routes are evaluated and sorted by specificity score = (literal * 2) + (wildcard_or_named * 1)", async () => {
  // spec: contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm
  // /api/v1/users/profile: 4 literal -> score 8
  // /api/v1/users: 3 literal -> score 6
  // /api/v1/*: 2 literal + 1 wildcard -> score 5
  // /api/:userId: 1 literal + 1 named segment -> score 3
  // /api/*: 1 literal + 1 wildcard -> score 3
  // /*: 0 literal + 1 wildcard -> score 1
  const toml = `
name = "routing-app"

[functions.handler]
entry = "handler.ts"

[[routes]]
pattern = "/*"
function = "handler"

[[routes]]
pattern = "/api/*"
function = "handler"

[[routes]]
pattern = "/api/v1/users"
function = "handler"

[[routes]]
pattern = "/api/v1/users/profile"
function = "handler"

[[routes]]
pattern = "/api/:userId"
function = "handler"

[[routes]]
pattern = "/api/v1/*"
function = "handler"
`;

  const dir = await createTempProject(toml, {
    "handler.ts": DEFAULT_HANDLER_TS,
  });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, true);
    assertExists(result.routeSummary);
    assertEquals(result.routeSummary.length, 6);

    const patterns = result.routeSummary.map(
      (r: { pattern: string; score: number }) => r.pattern,
    );
    const scores = result.routeSummary.map(
      (r: { pattern: string; score: number }) => r.score,
    );

    // Verify descending sort order
    assertEquals(patterns[0], "/api/v1/users/profile");
    assertEquals(scores[0], 8);

    assertEquals(patterns[1], "/api/v1/users");
    assertEquals(scores[1], 6);

    assertEquals(patterns[2], "/api/v1/*");
    assertEquals(scores[2], 5);

    // /api/:userId and /api/* both have score 3
    assertEquals(scores[3], 3);
    assertEquals(scores[4], 3);

    assertEquals(patterns[5], "/*");
    assertEquals(scores[5], 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("PLAT-11: Duplicate or shadowed route patterns generate warnings in route analysis", async () => {
  // spec: contracts/platform.contract.md#PLAT-11 — Deterministic route resolution & duplicate pattern detection
  const toml = `
name = "shadowed-route-app"

[functions.api]
entry = "api.ts"

[[routes]]
pattern = "/api/users"
function = "api"

[[routes]]
pattern = "/api/users"
function = "api"
`;

  const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

  try {
    const result = await checkProject(dir);
    // Duplicate pattern should register a warning
    assertExists(result.warnings);
    const shadowWarning = result.warnings.find(
      (w: ValidationIssue) =>
        w.severity === "warning" &&
        (w.path.includes("routes") ||
          w.message.toLowerCase().includes("duplicate") ||
          w.message.toLowerCase().includes("shadow")),
    );
    assertExists(
      shadowWarning,
      "Must generate warning for duplicate / shadowed route",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Group 6: Trigger Specifications (FN-2)
// ============================================================================

Deno.test("FN-2: Malformed cron schedule syntax is rejected with validation error", async () => {
  // spec: contracts/functions.contract.md#FN-2 — Schedule trigger standard 5-field cron syntax
  const toml = `
name = "cron-fail-app"

[functions.worker]
entry = "worker.ts"

[functions.worker.triggers]
schedule = "invalid-cron-syntax"

[[routes]]
pattern = "/health"
function = "worker"
`;

  const dir = await createTempProject(toml, {
    "worker.ts": DEFAULT_HANDLER_TS,
  });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);

    const cronErr = result.errors.find(
      (e: ValidationIssue) =>
        (e.code === "FN-2" || e.code === "VALIDATION_FAILED") &&
        (e.path.includes("schedule") ||
          e.message.toLowerCase().includes("cron") ||
          e.message.toLowerCase().includes("schedule")),
    );
    assertExists(
      cronErr,
      "Must reject malformed cron schedule syntax per FN-2",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("FN-2: Cron schedule with fewer or more than 5 fields is rejected", async () => {
  // spec: contracts/functions.contract.md#FN-2 — Cron syntax requires 5 fields
  const toml = `
name = "three-field-cron-app"

[functions.worker]
entry = "worker.ts"

[functions.worker.triggers]
schedule = "* * *"

[[routes]]
pattern = "/health"
function = "worker"
`;

  const dir = await createTempProject(toml, {
    "worker.ts": DEFAULT_HANDLER_TS,
  });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    const cronErr = result.errors.find(
      (e: ValidationIssue) =>
        (e.code === "FN-2" || e.code === "VALIDATION_FAILED") &&
        e.path.includes("schedule"),
    );
    assertExists(cronErr, "Must reject non-5-field cron string");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("FN-2: Empty or non-string queue binding trigger name is rejected", async () => {
  // spec: contracts/functions.contract.md#FN-2 — Queue trigger syntax
  const toml = `
name = "empty-queue-app"

[functions.worker]
entry = "worker.ts"

[functions.worker.triggers]
queue = ""

[[routes]]
pattern = "/health"
function = "worker"
`;

  const dir = await createTempProject(toml, {
    "worker.ts": DEFAULT_HANDLER_TS,
  });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    const queueErr = result.errors.find(
      (e: ValidationIssue) =>
        (e.code === "FN-2" || e.code === "VALIDATION_FAILED") &&
        e.path.includes("queue"),
    );
    assertExists(queueErr, "Must reject empty queue trigger string");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Group 7: Permission Syntax & Scoping (PLAT-5, PLAT-6, PLAT-15)
// ============================================================================

Deno.test("PLAT-5 & PLAT-6: Network permission containing SSRF-blocked IP addresses (metadata, loopback, RFC1918) is rejected", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — Mandatory-block IP ranges (link-local, cloud metadata, RFC1918, loopback)
  const blockedIps = [
    "169.254.169.254", // Cloud metadata (AWS / GCP)
    "127.0.0.1", // Loopback
    "10.0.0.1", // RFC1918
    "172.16.0.1", // RFC1918
    "192.168.1.1", // RFC1918
    "::1", // IPv6 loopback
    "fd00:ec2::254", // IPv6 AWS metadata
  ];

  for (const ip of blockedIps) {
    const toml = `
name = "ssrf-app"

[functions.api]
entry = "api.ts"

[functions.api.permissions]
network = ["${ip}"]

[[routes]]
pattern = "/api/*"
function = "api"
`;

    const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

    try {
      const result = await checkProject(dir);
      assertEquals(
        result.valid,
        false,
        `Network permission with blocked IP ${ip} must be rejected`,
      );
      const ssrfError = result.errors.find(
        (e: ValidationIssue) =>
          (e.code === "PLAT-5" || e.code === "VALIDATION_FAILED" ||
            e.code === "PLAT-6") &&
          (e.path.includes("network") ||
            e.message.toLowerCase().includes("ssrf") ||
            e.message.toLowerCase().includes("blocked")),
      );
      assertExists(ssrfError, `Must contain error for blocked IP ${ip}`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("PLAT-6 & PLAT-15: Secret names containing invalid characters or whitespace are rejected", async () => {
  // spec: contracts/platform.contract.md#PLAT-15 — Secrets identifiers
  const invalidSecretNames = [
    "bad secret!",
    "INVALID@NAME",
    "secret with spaces",
    "",
  ];

  for (const badSecret of invalidSecretNames) {
    const toml = `
name = "bad-secret-app"

[functions.api]
entry = "api.ts"

[functions.api.permissions]
secrets = ["${badSecret}"]

[[routes]]
pattern = "/api/*"
function = "api"
`;

    const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

    try {
      const result = await checkProject(dir);
      assertEquals(
        result.valid,
        false,
        `Secret name '${badSecret}' must be rejected`,
      );
      const secretError = result.errors.find(
        (e: ValidationIssue) =>
          (e.code === "PLAT-15" || e.code === "VALIDATION_FAILED" ||
            e.code === "PLAT-6") &&
          e.path.includes("secrets"),
      );
      assertExists(
        secretError,
        `Must contain error for invalid secret name '${badSecret}'`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("PLAT-6: Multiple KV namespaces or Objects buckets declared for a single function are rejected as ambiguous scope", async () => {
  // spec: contracts/platform.contract.md#PLAT-6 — Ambiguous scope rejection: Function bindings close over exactly one declared resource
  const toml = `
name = "ambiguous-scope-app"

[functions.api]
entry = "api.ts"

[functions.api.permissions]
kv = ["app:sessions", "app:cache"]

[[routes]]
pattern = "/api/*"
function = "api"
`;

  const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    const ambiguousError = result.errors.find(
      (e: ValidationIssue) =>
        (e.code === "PLAT-6" || e.code === "VALIDATION_FAILED") &&
        (e.path.includes("kv") ||
          e.message.toLowerCase().includes("ambiguous")),
    );
    assertExists(
      ambiguousError,
      "Must reject multiple KV namespaces per function as ambiguous scope",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ============================================================================
// Group 8: Schema Structure & Required Fields (PLAT-3, PLAT-18, PLAT-12)
// ============================================================================

Deno.test("PLAT-18: Missing or empty 'name' attribute is rejected with VALIDATION_FAILED", async () => {
  // spec: contracts/platform.contract.md#PLAT-18 — Project resource name required
  const toml = `
[functions.api]
entry = "api.ts"

[[routes]]
pattern = "/api/*"
function = "api"
`;

  const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    const nameErr = result.errors.find(
      (e: ValidationIssue) =>
        e.code === "VALIDATION_FAILED" &&
        (e.path === "name" || e.path.includes("name")),
    );
    assertExists(nameErr, "Must contain error for missing 'name'");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("PLAT-3: Missing or empty 'functions' table is rejected with VALIDATION_FAILED", async () => {
  // spec: contracts/platform.contract.md#PLAT-3 — Project must define at least one function
  const toml = `
name = "no-functions-app"

[[routes]]
pattern = "/api/*"
function = "api"
`;

  const dir = await createTempProject(toml);

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    const fnErr = result.errors.find(
      (e: ValidationIssue) =>
        e.code === "VALIDATION_FAILED" &&
        (e.path === "functions" || e.path.includes("functions")),
    );
    assertExists(fnErr, "Must contain error for missing 'functions'");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("PLAT-3: Missing 'routes' table is rejected with VALIDATION_FAILED", async () => {
  // spec: contracts/platform.contract.md#PLAT-3 — Project must declare routing table
  const toml = `
name = "no-routes-app"

[functions.api]
entry = "api.ts"
`;

  const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    const routeErr = result.errors.find(
      (e: ValidationIssue) =>
        e.code === "VALIDATION_FAILED" &&
        (e.path === "routes" || e.path.includes("routes")),
    );
    assertExists(routeErr, "Must contain error for missing 'routes'");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("PLAT-3: Route referencing non-existent function name is rejected with VALIDATION_FAILED", async () => {
  // spec: contracts/platform.contract.md#PLAT-3 — Route target must resolve to declared function
  const toml = `
name = "unresolved-route-app"

[functions.api]
entry = "api.ts"

[[routes]]
pattern = "/api/*"
function = "does_not_exist"
`;

  const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    const targetErr = result.errors.find(
      (e: ValidationIssue) =>
        e.code === "VALIDATION_FAILED" &&
        (e.path.includes("routes") || e.message.includes("does_not_exist")),
    );
    assertExists(
      targetErr,
      "Must reject route pointing to undeclared function",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("PLAT-12: Invalid TOML syntax is caught and reported as VALIDATION_FAILED with exit code 1", async () => {
  // spec: contracts/platform.contract.md#PLAT-12 — Syntax error handling
  const badToml = `
name = "broken-toml"
functions = { unclosed table
`;

  const dir = await createTempProject(badToml);

  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    const syntaxErr = result.errors.find((e: ValidationIssue) =>
      e.code === "VALIDATION_FAILED"
    );
    assertExists(syntaxErr, "Must report VALIDATION_FAILED for malformed TOML");

    const exitCode = await runCheck(dir);
    assertEquals(exitCode, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("PLAT-12: Non-existent directory or missing railfog.toml is reported as error with exit code 1", async () => {
  // spec: contracts/platform.contract.md#PLAT-12 — File access error handling
  const nonExistentPath = join(Deno.makeTempDirSync(), "does_not_exist_dir");

  const result = await checkProject(nonExistentPath);
  assertEquals(result.valid, false);
  assert(result.errors.length > 0);

  const exitCode = await runCheck(nonExistentPath);
  assertEquals(exitCode, 1);
});

// ============================================================================
// Group 9: Adversarial Security Audit Tests (T-0504 Checklist)
// ============================================================================

Deno.test("Adversarial (PLAT-5): isSsrfBlockedIp strictly blocks all metadata, loopback, RFC1918, link-local, and URL obfuscations", () => {
  // Checklist Attack Vectors:
  // 1. AWS/GCP metadata
  assert(
    isSsrfBlockedIp("169.254.169.254"),
    "AWS/GCP metadata 169.254.169.254 must be blocked",
  );
  assert(
    isSsrfBlockedIp("169.254.1.1"),
    "Link-local 169.254.1.1 must be blocked",
  );
  assert(
    isSsrfBlockedIp("fd00:ec2::254"),
    "AWS IPv6 metadata fd00:ec2::254 must be blocked",
  );

  // 2. RFC1918 subnets
  assert(isSsrfBlockedIp("10.0.0.1"), "10.0.0.1 (Class A) must be blocked");
  assert(
    isSsrfBlockedIp("172.16.0.1"),
    "172.16.0.1 (Class B start) must be blocked",
  );
  assert(
    isSsrfBlockedIp("172.31.255.255"),
    "172.31.255.255 (Class B end) must be blocked",
  );
  assert(
    isSsrfBlockedIp("192.168.1.1"),
    "192.168.1.1 (Class C) must be blocked",
  );

  // 3. Loopback
  assert(isSsrfBlockedIp("127.0.0.1"), "127.0.0.1 must be blocked");
  assert(isSsrfBlockedIp("127.255.255.255"), "127.255.255.255 must be blocked");
  assert(isSsrfBlockedIp("::1"), "::1 must be blocked");
  assert(isSsrfBlockedIp("localhost"), "localhost must be blocked");
  assert(isSsrfBlockedIp("0.0.0.0"), "0.0.0.0 must be blocked");

  // 4. IPv6 link-local
  assert(isSsrfBlockedIp("fe80::1"), "fe80::1 must be blocked");
  assert(isSsrfBlockedIp("fe80::dead:beef"), "fe80::dead:beef must be blocked");

  // 5. URL scheme / port / bracket obfuscations
  assert(
    isSsrfBlockedIp("http://169.254.169.254"),
    "http://169.254.169.254 must be blocked",
  );
  assert(
    isSsrfBlockedIp("https://127.0.0.1:8080/"),
    "https://127.0.0.1:8080/ must be blocked",
  );
  assert(
    isSsrfBlockedIp("http://[fe80::1]:80"),
    "http://[fe80::1]:80 must be blocked",
  );
  assert(
    isSsrfBlockedIp("http://[fd00:ec2::254]:8080/latest/meta-data"),
    "bracketed AWS IPv6 with port and path must be blocked",
  );
  assert(
    isSsrfBlockedIp("169.254.169.254:80"),
    "169.254.169.254:80 must be blocked",
  );
  assert(isSsrfBlockedIp("10.1.2.3:443"), "10.1.2.3:443 must be blocked");

  // Valid external domains / public IPs must NOT be blocked
  assertEquals(isSsrfBlockedIp("api.stripe.com"), false);
  assertEquals(isSsrfBlockedIp("example.com"), false);
  assertEquals(isSsrfBlockedIp("172.15.0.1"), false); // Outside 172.16.0.0/12
  assertEquals(isSsrfBlockedIp("172.32.0.1"), false); // Outside 172.16.0.0/12
  assertEquals(isSsrfBlockedIp("8.8.8.8"), false);
  assertEquals(isSsrfBlockedIp("1.1.1.1"), false);
});

Deno.test("Adversarial (PLAT-6): Path traversal and capability boundary escape attacks are strictly rejected", async () => {
  const traversalAttacks = [
    { name: "relative parent dir", entry: "../outside.ts" },
    { name: "nested relative traversal", entry: "subdir/../../outside.ts" },
    { name: "windows backslash traversal", entry: "..\\..\\outside.ts" },
    { name: "unix absolute root path", entry: "/etc/passwd" },
    {
      name: "windows absolute system path",
      entry: "C:\\Windows\\System32\\calc.exe",
    },
  ];

  for (const { name, entry } of traversalAttacks) {
    const toml = `
name = "traversal-attack-app"

[functions.api]
entry = "${entry.replace(/\\/g, "\\\\")}"

[[routes]]
pattern = "/api/*"
function = "api"
`;

    const dir = await createTempProject(toml);
    try {
      const result = await checkProject(dir);
      assertEquals(
        result.valid,
        false,
        `Path traversal attack '${name}' with entry '${entry}' must be rejected`,
      );
      const err = result.errors.find(
        (e: ValidationIssue) =>
          e.code === "VALIDATION_FAILED" &&
          (e.path.includes("entry") || e.message.includes("escapes")),
      );
      assertExists(
        err,
        `Must register VALIDATION_FAILED error for traversal '${name}'`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("Adversarial (PLAT-6): Ambiguous capability scope injection across KV, Objects, and Queues is strictly rejected", async () => {
  // Test multiple KV namespaces
  const multiKvToml = `
name = "ambiguous-kv-app"
[functions.api]
entry = "api.ts"
[functions.api.permissions]
kv = ["app:sessions", "app:tokens"]
[[routes]]
pattern = "/api/*"
function = "api"
`;
  const dirKv = await createTempProject(multiKvToml, {
    "api.ts": DEFAULT_HANDLER_TS,
  });
  try {
    const res = await checkProject(dirKv);
    assertEquals(res.valid, false);
    assert(
      res.errors.some((e: ValidationIssue) =>
        e.code === "PLAT-6" && e.path.includes("kv") &&
        e.message.includes("Ambiguous")
      ),
    );
  } finally {
    await Deno.remove(dirKv, { recursive: true });
  }

  // Test multiple Objects stores
  const multiObjToml = `
name = "ambiguous-obj-app"
[functions.api]
entry = "api.ts"
[functions.api.permissions]
objects = ["app:uploads", "app:backups"]
[[routes]]
pattern = "/api/*"
function = "api"
`;
  const dirObj = await createTempProject(multiObjToml, {
    "api.ts": DEFAULT_HANDLER_TS,
  });
  try {
    const res = await checkProject(dirObj);
    assertEquals(res.valid, false);
    assert(
      res.errors.some((e: ValidationIssue) =>
        e.code === "PLAT-6" && e.path.includes("objects") &&
        e.message.includes("Ambiguous")
      ),
    );
  } finally {
    await Deno.remove(dirObj, { recursive: true });
  }

  // Test multiple Queues
  const multiQueueToml = `
name = "ambiguous-queue-app"
[functions.api]
entry = "api.ts"
[functions.api.permissions]
queues = ["app:jobs", "app:events"]
[[routes]]
pattern = "/api/*"
function = "api"
`;
  const dirQueue = await createTempProject(multiQueueToml, {
    "api.ts": DEFAULT_HANDLER_TS,
  });
  try {
    const res = await checkProject(dirQueue);
    assertEquals(res.valid, false);
    assert(
      res.errors.some((e: ValidationIssue) =>
        e.code === "PLAT-6" && e.path.includes("queues") &&
        e.message.includes("Ambiguous")
      ),
    );
  } finally {
    await Deno.remove(dirQueue, { recursive: true });
  }

  // Test empty string entries
  const emptyKvToml = `
name = "empty-kv-app"
[functions.api]
entry = "api.ts"
[functions.api.permissions]
kv = [""]
[[routes]]
pattern = "/api/*"
function = "api"
`;
  const dirEmpty = await createTempProject(emptyKvToml, {
    "api.ts": DEFAULT_HANDLER_TS,
  });
  try {
    const res = await checkProject(dirEmpty);
    assertEquals(res.valid, false);
    assert(
      res.errors.some((e: ValidationIssue) =>
        e.code === "PLAT-6" && e.path.includes("kv")
      ),
    );
  } finally {
    await Deno.remove(dirEmpty, { recursive: true });
  }
});

Deno.test("Adversarial (PLAT-15): Secret name injection and smuggling tokens are strictly rejected", async () => {
  const maliciousSecretTokens = [
    "SECRET; rm -rf",
    "FOO$BAR",
    "TEST\nNAME",
    "AWS_KEY|echo",
    "API`KEY",
    "KEY=VALUE",
    "123BAD",
    "-FLAG",
    "DROP TABLE",
  ];

  for (const maliciousName of maliciousSecretTokens) {
    const toml = `
name = "malicious-secrets-app"
[functions.api]
entry = "api.ts"
[functions.api.permissions]
secrets = ["${maliciousName.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}"]
[[routes]]
pattern = "/api/*"
function = "api"
`;

    const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });
    try {
      const result = await checkProject(dir);
      assertEquals(
        result.valid,
        false,
        `Malicious secret name '${maliciousName}' must be rejected`,
      );
      assert(
        result.errors.some((e: ValidationIssue) =>
          e.code === "PLAT-15" && e.path.includes("secrets")
        ),
        `Must report PLAT-15 error for malicious secret token '${maliciousName}'`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("Adversarial (KV-5): Consistency downgrade evasion across case variations and aliases is strictly caught", async () => {
  const providerVariations = [
    "cloudflare",
    "workers-kv",
    "Cloudflare",
    "WORKERS-KV",
    " cloudflare ",
    "cloudflare-kv",
    "cf-workers-kv",
    "cf-kv",
    "workers_kv",
    "cloudflare_kv",
  ];

  for (const provider of providerVariations) {
    const toml = `
name = "kv-evasion-app"

[kv.data]
consistency = "strong"
provider = "${provider}"

[functions.api]
entry = "api.ts"

[[routes]]
pattern = "/api/*"
function = "api"
`;

    const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });
    try {
      const result = await checkProject(dir);
      assertEquals(
        result.valid,
        false,
        `Consistency downgrade attempt with provider '${provider}' must be rejected`,
      );
      assert(
        result.errors.some(
          (e: ValidationIssue) =>
            e.code === "KV-5" &&
            (e.path.includes("kv.data") || e.message.includes("strong") ||
              e.message.includes("eventual")),
        ),
        `Must report KV-5 error for provider alias '${provider}'`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("Adversarial (FN-5): Resource limit smuggling via NaN, Infinity, floats, and non-positive numbers is strictly rejected", async () => {
  const invalidLimitsToml = [
    {
      name: "memory_mb = 2048 (> 1024 ceiling)",
      key: "memory_mb",
      val: "2048",
    },
    {
      name: "memory_mb = 1025 (> 1024 ceiling)",
      key: "memory_mb",
      val: "1025",
    },
    { name: "memory_mb = 0 (zero memory)", key: "memory_mb", val: "0" },
    { name: "memory_mb = -1 (negative memory)", key: "memory_mb", val: "-1" },
    { name: "memory_mb = nan (NaN smuggling)", key: "memory_mb", val: "nan" },
    {
      name: "memory_mb = inf (Infinity smuggling)",
      key: "memory_mb",
      val: "inf",
    },
    {
      name: "memory_mb = 256.5 (fractional memory)",
      key: "memory_mb",
      val: "256.5",
    },
    {
      name: "timeout_ms = 30001 (HTTP timeout > 30s)",
      key: "timeout_ms",
      val: "30001",
    },
    {
      name: "timeout_ms = nan (NaN timeout smuggling)",
      key: "timeout_ms",
      val: "nan",
    },
    { name: "timeout_ms = 0 (zero timeout)", key: "timeout_ms", val: "0" },
    {
      name: "timeout_ms = -500 (negative timeout)",
      key: "timeout_ms",
      val: "-500",
    },
    { name: "cpu_ms = nan (NaN CPU smuggling)", key: "cpu_ms", val: "nan" },
    { name: "cpu_ms = 0 (zero CPU)", key: "cpu_ms", val: "0" },
    { name: "cpu_ms = -10 (negative CPU)", key: "cpu_ms", val: "-10" },
    {
      name: "concurrency = 0 (zero concurrency)",
      key: "concurrency",
      val: "0",
    },
    {
      name: "concurrency = nan (NaN concurrency)",
      key: "concurrency",
      val: "nan",
    },
    {
      name: "concurrency = -10 (negative concurrency)",
      key: "concurrency",
      val: "-10",
    },
  ];

  for (const { name, key, val } of invalidLimitsToml) {
    const toml = `
name = "limits-smuggle-app"

[functions.api]
entry = "api.ts"

[functions.api.limits]
${key} = ${val}

[[routes]]
pattern = "/api/*"
function = "api"
`;

    const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });
    try {
      const result = await checkProject(dir);
      assertEquals(
        result.valid,
        false,
        `Resource limit smuggling '${name}' must be rejected`,
      );
      assert(
        result.errors.some((e: ValidationIssue) =>
          e.code === "FN-5" && e.path.includes(key)
        ),
        `Must report FN-5 error for '${name}'`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("PLAT-3, PLAT-11: Per-function routes array without top-level routes table passes validation", async () => {
  const toml = `
name = "per-function-routes-app"

[limits]
memory_mb = 128
timeout_ms = 5000

[functions.api]
entry = "api.ts"
routes = ["/api/hello", "/api/data", "/api/counter"]
capabilities = ["kv:read", "kv:write"]
`;

  const dir = await createTempProject(toml, { "api.ts": DEFAULT_HANDLER_TS });
  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, true, "Per-function routes must validate successfully");
    assertEquals(result.errors.length, 0);
    assertExists(result.routeSummary);
    assertEquals(result.routeSummary.length, 3);
    assertEquals(result.routeSummary.map((r) => r.pattern).sort(), [
      "/api/counter",
      "/api/data",
      "/api/hello",
    ]);

    const exitCode = await runCheck(dir);
    assertEquals(exitCode, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("FN-5: Global limits table validates invalid limits and cascades valid limits", async () => {
  const badToml = `
name = "bad-global-limits-app"

[limits]
memory_mb = -64
timeout_ms = 0

[functions.api]
entry = "api.ts"
route = "/api/*"
`;

  const dir = await createTempProject(badToml, { "api.ts": DEFAULT_HANDLER_TS });
  try {
    const result = await checkProject(dir);
    assertEquals(result.valid, false);
    assert(result.errors.some((e) => e.path === "limits.memory_mb"));
    assert(result.errors.some((e) => e.path === "limits.timeout_ms"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

