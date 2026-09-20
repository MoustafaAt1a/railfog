// spec: contracts/platform.contract.md#PLAT-3 — Deployment pipeline (Validation, packaging, health check gate: 3 consecutive 200s within 30s)
// spec: contracts/platform.contract.md#PLAT-5 — Network policy allowlist & mandatory SSRF IP blocks (metadata, loopback, RFC1918)
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & deploy-time permission scoping
// spec: contracts/platform.contract.md#PLAT-15 — Secrets management (runtime capability-scoped secret access)
// spec: contracts/objects.contract.md#OBJ-4 — Content addressing (sha256 hex artifact ID & Subresource Integrity string)
// spec: contracts/functions.contract.md#FN-5 — Resource limits & timeout diagnostics
// spec: tasks/milestone-0.5-developer-experience/T-0505-deploy-diagnostics-analyzer.md

import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
} from "@std/assert";
import { join } from "@std/path";
import { deployCommand, type DeployCommandOptions } from "../../cli/deploy.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";

import {
  DeployDiagnosticsAnalyzer,
  type DiagnosticIssue,
  type HealthCheckDiagnosticReport,
  type PreDeployReport,
} from "../../packages/core/diagnostics/deploy-analyzer.ts";

// ============================================================================
// Test Helpers
// ============================================================================

async function createTestSourceDir(
  files: Record<string, string>,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "railfog_analyzer_test_" });
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath);
    const lastSlash = Math.max(
      fullPath.lastIndexOf("/"),
      fullPath.lastIndexOf("\\"),
    );
    if (lastSlash > 0) {
      await Deno.mkdir(fullPath.slice(0, lastSlash), { recursive: true });
    }
    await Deno.writeTextFile(fullPath, content);
  }
  return dir;
}

// ============================================================================
// Group 1: Secret Audit (AC1, PLAT-6, PLAT-15)
// ============================================================================

Deno.test("AC1 (PLAT-6, PLAT-15): Undeclared secret access via ctx.env.get is flagged as a blocking pre-deploy error citing PLAT-6 and PLAT-15", async () => {
  // spec: contracts/platform.contract.md#PLAT-6 — Deploy-time capability injection
  // spec: contracts/platform.contract.md#PLAT-15 — Secrets access restricted to declared permissions.secrets
  const sourceDir = await createTestSourceDir({
    "src/api.ts": `
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const stripeKey = ctx.env.get("STRIPE_KEY");
  return new Response("OK");
}
`,
  });

  const manifest = {
    entrypoint: "src/api.ts",
    permissions: {
      secrets: ["OTHER_SECRET"], // STRIPE_KEY is undeclared
    },
  };

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report: PreDeployReport = await analyzer.analyzeSource(
      sourceDir,
      manifest,
    );

    assertEquals(
      report.passed,
      false,
      "PreDeployReport must fail when undeclared secret is accessed",
    );

    const secretIssue = report.issues.find(
      (issue: DiagnosticIssue) =>
        issue.category === "secrets" &&
        issue.severity === "error" &&
        issue.message.includes("STRIPE_KEY"),
    );

    assertExists(
      secretIssue,
      "Must contain a blocking secret error mentioning STRIPE_KEY",
    );
    assert(
      secretIssue.message.includes("PLAT-6") ||
        secretIssue.message.includes("PLAT-15"),
      "Error message must cite PLAT-6 or PLAT-15",
    );
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("AC1 (PLAT-6, PLAT-15): Undeclared secret access via ctx.env.require is flagged as a blocking pre-deploy error", async () => {
  // spec: contracts/platform.contract.md#PLAT-15 — Secret access via require()
  const sourceDir = await createTestSourceDir({
    "src/api.ts": `
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const dbPassword = ctx.env.require("DATABASE_PASSWORD");
  return new Response("OK");
}
`,
  });

  const manifest = {
    entrypoint: "src/api.ts",
    permissions: {
      secrets: [], // DATABASE_PASSWORD is missing
    },
  };

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report: PreDeployReport = await analyzer.analyzeSource(
      sourceDir,
      manifest,
    );

    assertEquals(report.passed, false);
    const issue = report.issues.find(
      (i: DiagnosticIssue) =>
        i.category === "secrets" &&
        i.severity === "error" &&
        i.message.includes("DATABASE_PASSWORD"),
    );
    assertExists(
      issue,
      "Must flag undeclared secret accessed via ctx.env.require",
    );
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("AC1: All accessed secrets declared in permissions.secrets pass the secret audit without errors", async () => {
  // spec: contracts/platform.contract.md#PLAT-6, PLAT-15 — Authorized secret access
  const sourceDir = await createTestSourceDir({
    "src/api.ts": `
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const stripeKey = ctx.env.get("STRIPE_KEY");
  const authSecret = ctx.env.require("AUTH_SECRET");
  return new Response("OK");
}
`,
  });

  const manifest = {
    entrypoint: "src/api.ts",
    permissions: {
      secrets: ["STRIPE_KEY", "AUTH_SECRET"],
    },
  };

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report: PreDeployReport = await analyzer.analyzeSource(
      sourceDir,
      manifest,
    );

    const secretErrors = report.issues.filter(
      (i: DiagnosticIssue) =>
        i.category === "secrets" && i.severity === "error",
    );
    assertEquals(
      secretErrors.length,
      0,
      "No secret errors should be emitted for declared secrets",
    );
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("PLAT-15: Secret audit inspects multiple files in project directory recursively", async () => {
  // spec: contracts/platform.contract.md#PLAT-15 — Full codebase scan for secrets
  const sourceDir = await createTestSourceDir({
    "src/api.ts": `
import { getAuth } from "./auth.ts";
export default async function handler(req: Request, ctx: any): Promise<Response> {
  return getAuth(ctx);
}
`,
    "src/auth.ts": `
export function getAuth(ctx: any): Response {
  const token = ctx.env.get("LEAKED_JWT_SECRET");
  return new Response(token);
}
`,
  });

  const manifest = {
    entrypoint: "src/api.ts",
    permissions: {
      secrets: ["OTHER_SECRET"],
    },
  };

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report: PreDeployReport = await analyzer.analyzeSource(
      sourceDir,
      manifest,
    );

    assertEquals(report.passed, false);
    const leakedIssue = report.issues.find(
      (i: DiagnosticIssue) =>
        i.category === "secrets" &&
        i.message.includes("LEAKED_JWT_SECRET"),
    );
    assertExists(
      leakedIssue,
      "Must detect undeclared secret accessed in imported sub-file",
    );
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

// ============================================================================
// Group 2: SSRF Network Scan (AC2, PLAT-5)
// ============================================================================

Deno.test("AC2 (PLAT-5): Outbound HTTP request referencing cloud metadata IP (169.254.169.254) is flagged citing PLAT-5", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — Mandatory-block link-local / cloud metadata
  const sourceDir = await createTestSourceDir({
    "src/api.ts": `
export default async function handler(): Promise<Response> {
  const metadata = await fetch("http://169.254.169.254/latest/meta-data/");
  return new Response("OK");
}
`,
  });

  const manifest = {
    entrypoint: "src/api.ts",
    permissions: {
      network: ["169.254.169.254"],
    },
  };

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report: PreDeployReport = await analyzer.analyzeSource(
      sourceDir,
      manifest,
    );

    assertEquals(
      report.passed,
      false,
      "Must block deployment containing SSRF to cloud metadata",
    );

    const ssrfIssue = report.issues.find(
      (i: DiagnosticIssue) =>
        i.category === "network" &&
        i.severity === "error" &&
        (i.message.includes("169.254") || i.message.includes("metadata")),
    );
    assertExists(
      ssrfIssue,
      "Must contain blocking network error for cloud metadata IP",
    );
    assert(
      ssrfIssue.message.includes("PLAT-5"),
      "Error message must cite PLAT-5 mandatory IP block",
    );
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("AC2 (PLAT-5): Outbound requests referencing RFC1918 private ranges (10.0.0.1, 192.168.1.1) are flagged as SSRF errors", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — RFC1918 private ranges
  const sourceDir = await createTestSourceDir({
    "src/api.ts": `
export default async function handler(): Promise<Response> {
  await fetch("http://10.0.0.1/internal-status");
  await fetch("http://192.168.1.1/router-config");
  return new Response("OK");
}
`,
  });

  const manifest = {
    entrypoint: "src/api.ts",
    permissions: {
      network: [],
    },
  };

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report: PreDeployReport = await analyzer.analyzeSource(
      sourceDir,
      manifest,
    );

    assertEquals(report.passed, false);
    const rfc1918Issues = report.issues.filter(
      (i: DiagnosticIssue) =>
        i.category === "network" &&
        i.severity === "error" &&
        (i.message.includes("10.0.0.1") || i.message.includes("192.168.1.1") ||
          i.message.includes("RFC1918")),
    );
    assert(
      rfc1918Issues.length >= 1,
      "Must flag RFC1918 private IP access as SSRF error",
    );
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("AC2 (PLAT-5): Outbound requests referencing loopback addresses (127.0.0.1, localhost) are flagged citing PLAT-5", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — Loopback 127.0.0.0/8 and localhost
  const sourceDir = await createTestSourceDir({
    "src/api.ts": `
export default async function handler(): Promise<Response> {
  await fetch("http://127.0.0.1:8080/debug");
  await fetch("http://localhost:3000/internal");
  return new Response("OK");
}
`,
  });

  const manifest = {
    entrypoint: "src/api.ts",
    permissions: {
      network: [],
    },
  };

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report: PreDeployReport = await analyzer.analyzeSource(
      sourceDir,
      manifest,
    );

    assertEquals(report.passed, false);
    const loopbackIssue = report.issues.find(
      (i: DiagnosticIssue) =>
        i.category === "network" &&
        i.severity === "error" &&
        (i.message.includes("127.0.0.1") || i.message.includes("localhost")),
    );
    assertExists(loopbackIssue, "Must flag loopback access as SSRF error");
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("AC2 (PLAT-5): Outbound request referencing IPv6 metadata address (fd00:ec2::254) is flagged", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — fd00:ec2::/8 AWS IPv6 metadata
  const sourceDir = await createTestSourceDir({
    "src/api.ts": `
export default async function handler(): Promise<Response> {
  await fetch("http://[fd00:ec2::254]/latest/meta-data/");
  return new Response("OK");
}
`,
  });

  const manifest = {
    entrypoint: "src/api.ts",
    permissions: {
      network: [],
    },
  };

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report: PreDeployReport = await analyzer.analyzeSource(
      sourceDir,
      manifest,
    );

    assertEquals(report.passed, false);
    const ipv6Issue = report.issues.find(
      (i: DiagnosticIssue) =>
        i.category === "network" &&
        i.severity === "error" &&
        (i.message.includes("fd00:ec2") || i.message.includes("metadata")),
    );
    assertExists(ipv6Issue, "Must flag IPv6 metadata access as SSRF error");
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("PLAT-5: Declared public outbound domain does not emit SSRF errors", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — Allowlisted public domain
  const sourceDir = await createTestSourceDir({
    "src/api.ts": `
export default async function handler(): Promise<Response> {
  const res = await fetch("https://api.stripe.com/v1/customers");
  return new Response("OK");
}
`,
  });

  const manifest = {
    entrypoint: "src/api.ts",
    permissions: {
      network: ["api.stripe.com"],
    },
  };

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report: PreDeployReport = await analyzer.analyzeSource(
      sourceDir,
      manifest,
    );

    const networkErrors = report.issues.filter(
      (i: DiagnosticIssue) =>
        i.category === "network" && i.severity === "error",
    );
    assertEquals(
      networkErrors.length,
      0,
      "No network errors should be emitted for declared public domains",
    );
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

// ============================================================================
// Group 3: Content-Addressing & Integrity Diagnostics (AC3, OBJ-4)
// ============================================================================

Deno.test("AC3 (OBJ-4): Pre-deploy analyzer computes and formats sha256: hex digest and sha256- Subresource Integrity string", async () => {
  // spec: contracts/objects.contract.md#OBJ-4 — Content addressing
  // artifact_id = "sha256:" + hex(sha256(bytes))
  // integrity   = "sha256-" + base64(sha256(bytes))
  const sourceDir = await createTestSourceDir({
    "src/api.ts": `
export default async function handler(): Promise<Response> {
  return new Response("Hello Content Addressing");
}
`,
  });

  const manifest = {
    entrypoint: "src/api.ts",
    permissions: {},
  };

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report: PreDeployReport = await analyzer.analyzeSource(
      sourceDir,
      manifest,
    );

    assertExists(
      report.artifactDigest,
      "PreDeployReport must include artifactDigest",
    );
    assertExists(report.artifactDigest.sha256Hex, "Must include sha256Hex");
    assertExists(
      report.artifactDigest.integrity,
      "Must include integrity string",
    );

    // Format verification per OBJ-4:
    // sha256:<64 hex characters>
    assertMatch(
      report.artifactDigest.sha256Hex,
      /^sha256:[a-f0-9]{64}$/,
      "sha256Hex must match 'sha256:<64-hex>' per OBJ-4",
    );

    // sha256-<base64 characters>
    assertMatch(
      report.artifactDigest.integrity,
      /^sha256-[A-Za-z0-9+/=]+$/,
      "integrity must match Subresource Integrity format 'sha256-<base64>' per OBJ-4",
    );
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("OBJ-4: Artifact digest computation is deterministic across multiple analysis runs", async () => {
  // spec: contracts/objects.contract.md#OBJ-4 — Deterministic hashing
  const sourceDir = await createTestSourceDir({
    "src/api.ts": `
export default async function handler(): Promise<Response> {
  return new Response("Deterministic Content");
}
`,
  });

  const manifest = { entrypoint: "src/api.ts" };

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report1 = await analyzer.analyzeSource(sourceDir, manifest);
    const report2 = await analyzer.analyzeSource(sourceDir, manifest);

    assertExists(report1.artifactDigest);
    assertExists(report2.artifactDigest);
    assertEquals(
      report1.artifactDigest.sha256Hex,
      report2.artifactDigest.sha256Hex,
    );
    assertEquals(
      report1.artifactDigest.integrity,
      report2.artifactDigest.integrity,
    );
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

// ============================================================================
// Group 4: Health Check Failure Diagnostic (AC4, PLAT-3, FN-5)
// ============================================================================

Deno.test("AC4 (PLAT-3): formatHealthFailure generates structured report for 500 status failure with log inspection advice", () => {
  // spec: contracts/platform.contract.md#PLAT-3 — Health check failure diagnostic
  const analyzer = new DeployDiagnosticsAnalyzer();

  const attempts = [
    {
      attempt: 1,
      status: 500,
      durationMs: 120,
      error: "Internal Server Error",
    },
    {
      attempt: 2,
      status: 500,
      durationMs: 110,
      error: "Internal Server Error",
    },
    {
      attempt: 3,
      status: 500,
      durationMs: 130,
      error: "Internal Server Error",
    },
  ];

  const report: HealthCheckDiagnosticReport = analyzer.formatHealthFailure(
    attempts,
  );

  assertEquals(report.healthy, false);
  assertEquals(report.attemptsCount, 3);
  assertEquals(report.totalDurationMs, 360);

  assertExists(report.failureReason);
  assert(
    report.failureReason.includes("500") ||
      report.failureReason.toLowerCase().includes("server error"),
    "failureReason must indicate HTTP 500 failure",
  );

  assertExists(report.diagnosticAdvice);
  assert(report.diagnosticAdvice.length >= 1);
  const mentionsLogs = report.diagnosticAdvice.some((advice: string) =>
    advice.toLowerCase().includes("log") ||
    advice.toLowerCase().includes("rail logs")
  );
  assert(mentionsLogs, "diagnosticAdvice must suggest inspecting runtime logs");
});

Deno.test("AC4 (PLAT-3, FN-5): formatHealthFailure provides timeout advice when health check attempts exceed timeout limit", () => {
  // spec: contracts/platform.contract.md#PLAT-3, FN-5 — Health check timeout failure
  const analyzer = new DeployDiagnosticsAnalyzer();

  const attempts = [
    {
      attempt: 1,
      status: 0,
      durationMs: 5000,
      error: "Timeout: health check probe exceeded 5000ms",
    },
    { attempt: 2, status: 504, durationMs: 5000, error: "Gateway Timeout" },
  ];

  const report: HealthCheckDiagnosticReport = analyzer.formatHealthFailure(
    attempts,
  );

  assertEquals(report.healthy, false);
  assertEquals(report.attemptsCount, 2);
  assertEquals(report.totalDurationMs, 10000);

  assertExists(report.failureReason);
  assert(
    report.failureReason.toLowerCase().includes("timeout") ||
      report.failureReason.includes("504"),
  );

  const mentionsTimeoutOrLimits = report.diagnosticAdvice.some(
    (advice: string) =>
      advice.toLowerCase().includes("timeout") ||
      advice.toLowerCase().includes("cold start") ||
      advice.toLowerCase().includes("limit"),
  );
  assert(
    mentionsTimeoutOrLimits,
    "diagnosticAdvice must suggest checking timeout limits or cold start duration",
  );
});

Deno.test("PLAT-3: formatHealthFailure reports healthy=true when 3 consecutive 200 attempts succeed", () => {
  // spec: contracts/platform.contract.md#PLAT-3 — 3 consecutive 200s is the success gate
  const analyzer = new DeployDiagnosticsAnalyzer();

  const attempts = [
    { attempt: 1, status: 200, durationMs: 40 },
    { attempt: 2, status: 200, durationMs: 35 },
    { attempt: 3, status: 200, durationMs: 38 },
  ];

  const report: HealthCheckDiagnosticReport = analyzer.formatHealthFailure(
    attempts,
  );

  assertEquals(report.healthy, true);
  assertEquals(report.attemptsCount, 3);
  assertEquals(report.totalDurationMs, 113);
  assertEquals(report.failureReason, undefined);
});

// ============================================================================
// Group 5: Adversarial Secret Audit Evasion (PLAT-6, PLAT-15)
// ============================================================================

Deno.test("PLAT-6, PLAT-15 (Adversarial): Secret audit detects optional chaining syntax (ctx?.env?.get, ctx.env?.get, ctx?.env.get)", async () => {
  const sourceDir = await createTestSourceDir({
    "src/handler.ts": `
export default async function(req: Request, ctx: any): Promise<Response> {
  const s1 = ctx?.env?.get("UNDECLARED_OPT_1");
  const s2 = ctx.env?.get("UNDECLARED_OPT_2");
  const s3 = ctx?.env.get("UNDECLARED_OPT_3");
  return new Response("ok");
}
`,
  });

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report = await analyzer.analyzeSource(sourceDir, {
      permissions: { secrets: [] },
    });

    assertEquals(
      report.passed,
      false,
      "Must fail pre-deploy when undeclared secrets are accessed via optional chaining",
    );
    const issues = report.issues.filter((i) =>
      i.category === "secrets" && i.severity === "error"
    );
    assertEquals(
      issues.length,
      3,
      "Must flag all 3 undeclared secrets accessed with optional chaining",
    );

    const names = issues.map((i) => i.message);
    assert(names.some((m) => m.includes("UNDECLARED_OPT_1")));
    assert(names.some((m) => m.includes("UNDECLARED_OPT_2")));
    assert(names.some((m) => m.includes("UNDECLARED_OPT_3")));
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("PLAT-6, PLAT-15 (Adversarial): Secret audit detects single quotes and template literals (ctx.env.get('...'), ctx.env.get(`...`))", async () => {
  const sourceDir = await createTestSourceDir({
    "src/quotes.ts": `
export default async function(req: Request, ctx: any): Promise<Response> {
  const single = ctx.env.get('SINGLE_QUOTE_SECRET');
  const template = ctx.env.get(\`TEMPLATE_LITERAL_SECRET\`);
  return new Response("ok");
}
`,
  });

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report = await analyzer.analyzeSource(sourceDir, {
      permissions: { secrets: [] },
    });

    assertEquals(report.passed, false);
    const issues = report.issues.filter((i) =>
      i.category === "secrets" && i.severity === "error"
    );
    assertEquals(issues.length, 2);
    assert(issues.some((i) => i.message.includes("SINGLE_QUOTE_SECRET")));
    assert(issues.some((i) => i.message.includes("TEMPLATE_LITERAL_SECRET")));
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("PLAT-6, PLAT-15 (Adversarial): Secret audit detects whitespace and newline variations", async () => {
  const sourceDir = await createTestSourceDir({
    "src/spacing.ts": `
export default async function(req: Request, ctx: any): Promise<Response> {
  const spaced1 = ctx.env.get ("SPACED_SECRET_PAREN");
  const spaced2 = ctx.env.get( \n "NEWLINE_SECRET" \n );
  const chained = ctx
    .env
    .get("MULTILINE_SECRET");
  return new Response("ok");
}
`,
  });

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report = await analyzer.analyzeSource(sourceDir, {
      permissions: { secrets: [] },
    });

    assertEquals(report.passed, false);
    const issues = report.issues.filter((i) =>
      i.category === "secrets" && i.severity === "error"
    );
    assertEquals(issues.length, 3);
    assert(issues.some((i) => i.message.includes("SPACED_SECRET_PAREN")));
    assert(issues.some((i) => i.message.includes("NEWLINE_SECRET")));
    assert(issues.some((i) => i.message.includes("MULTILINE_SECRET")));
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("PLAT-6, PLAT-15 (Adversarial): Secret audit detects require with optional chaining and quote variations", async () => {
  const sourceDir = await createTestSourceDir({
    "src/require_test.ts": `
export default async function(req: Request, ctx: any): Promise<Response> {
  const r1 = ctx?.env?.require("REQ_OPT_1");
  const r2 = ctx.env?.require('REQ_OPT_2');
  const r3 = ctx?.env?.require(\`REQ_OPT_3\`);
  return new Response("ok");
}
`,
  });

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report = await analyzer.analyzeSource(sourceDir, {
      permissions: { secrets: [] },
    });

    assertEquals(report.passed, false);
    const issues = report.issues.filter((i) =>
      i.category === "secrets" && i.severity === "error"
    );
    assertEquals(issues.length, 3);
    assert(issues.some((i) => i.message.includes("REQ_OPT_1")));
    assert(issues.some((i) => i.message.includes("REQ_OPT_2")));
    assert(issues.some((i) => i.message.includes("REQ_OPT_3")));
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("PLAT-6, PLAT-15 (Adversarial): Secret audit detects Deno.env and direct env/secrets calls", async () => {
  const sourceDir = await createTestSourceDir({
    "src/direct.ts": `
export default async function(req: Request, ctx: any): Promise<Response> {
  const d1 = Deno.env.get("DENO_ENV_SECRET");
  const d2 = Deno?.env?.get("DENO_OPT_SECRET");
  const e1 = env.get("DIRECT_ENV_SECRET");
  const s1 = secrets.get("DIRECT_SECRETS_SECRET");
  return new Response("ok");
}
`,
  });

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report = await analyzer.analyzeSource(sourceDir, {
      permissions: { secrets: [] },
    });

    assertEquals(report.passed, false);
    const issues = report.issues.filter((i) =>
      i.category === "secrets" && i.severity === "error"
    );
    assertEquals(issues.length, 4);
    assert(issues.some((i) => i.message.includes("DENO_ENV_SECRET")));
    assert(issues.some((i) => i.message.includes("DENO_OPT_SECRET")));
    assert(issues.some((i) => i.message.includes("DIRECT_ENV_SECRET")));
    assert(issues.some((i) => i.message.includes("DIRECT_SECRETS_SECRET")));
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

// ============================================================================
// Group 6: Adversarial SSRF Scan Evasion (PLAT-5)
// ============================================================================

Deno.test("PLAT-5 (Adversarial): SSRF scan detects URLs with explicit ports", async () => {
  const sourceDir = await createTestSourceDir({
    "src/ports.ts": `
export default async function(): Promise<Response> {
  await fetch("http://169.254.169.254:80/latest/meta-data/");
  await fetch("http://127.0.0.1:8080/admin");
  return new Response("ok");
}
`,
  });

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report = await analyzer.analyzeSource(sourceDir, {
      permissions: { network: [] },
    });

    assertEquals(report.passed, false);
    const errors = report.issues.filter((i) =>
      i.category === "network" && i.severity === "error"
    );
    assertEquals(errors.length, 2);
    assert(errors.some((i) => i.message.includes("169.254.169.254")));
    assert(errors.some((i) => i.message.includes("127.0.0.1")));
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("PLAT-5 (Adversarial): SSRF scan detects URLs with userinfo and non-standard ports", async () => {
  const sourceDir = await createTestSourceDir({
    "src/userinfo.ts": `
export default async function(): Promise<Response> {
  await fetch("http://admin:pass@169.254.169.254/");
  await fetch("http://admin:pass@169.254.169.254:99999");
  return new Response("ok");
}
`,
  });

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report = await analyzer.analyzeSource(sourceDir, {
      permissions: { network: [] },
    });

    assertEquals(report.passed, false);
    const errors = report.issues.filter((i) =>
      i.category === "network" && i.severity === "error"
    );
    assert(errors.length >= 1);
    assert(errors.every((i) => i.message.includes("169.254.169.254")));
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("PLAT-5 (Adversarial): SSRF scan detects IPv6 bracketed addresses", async () => {
  const sourceDir = await createTestSourceDir({
    "src/ipv6.ts": `
export default async function(): Promise<Response> {
  await fetch("http://[::1]:8080/v6");
  await fetch("http://[fd00:ec2::254]:80/meta");
  await fetch("http://[fe80::1]:8080/link");
  return new Response("ok");
}
`,
  });

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report = await analyzer.analyzeSource(sourceDir, {
      permissions: { network: [] },
    });

    assertEquals(report.passed, false);
    const errors = report.issues.filter((i) =>
      i.category === "network" && i.severity === "error"
    );
    assertEquals(errors.length, 3);
    assert(errors.some((i) => i.message.includes("::1")));
    assert(errors.some((i) => i.message.includes("fd00:ec2")));
    assert(errors.some((i) => i.message.includes("fe80:")));
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("PLAT-5 (Adversarial): SSRF scan detects IPv4-mapped IPv6 addresses (dotted-decimal & hex)", async () => {
  const sourceDir = await createTestSourceDir({
    "src/v4mapped.ts": `
export default async function(): Promise<Response> {
  await fetch("http://[::ffff:169.254.169.254]/meta");
  await fetch("http://[::ffff:127.0.0.1]:8080/loop");
  await fetch("http://[::ffff:10.0.0.1]/rfc");
  return new Response("ok");
}
`,
  });

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report = await analyzer.analyzeSource(sourceDir, {
      permissions: { network: [] },
    });

    assertEquals(report.passed, false);
    const errors = report.issues.filter((i) =>
      i.category === "network" && i.severity === "error"
    );
    assertEquals(
      errors.length,
      3,
      "All IPv4-mapped addresses must be caught as blocking errors",
    );
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("PLAT-5 (Adversarial): SSRF scan detects mixed-case and uppercase URL schemes (HTTP://, Http://, HTTPS://)", async () => {
  const sourceDir = await createTestSourceDir({
    "src/schemes.ts": `
export default async function(): Promise<Response> {
  await fetch("HTTP://10.0.0.1/rfc1918");
  await fetch("Http://169.254.169.254/meta");
  await fetch("HTTPS://127.0.0.1:8443/loop");
  return new Response("ok");
}
`,
  });

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report = await analyzer.analyzeSource(sourceDir, {
      permissions: { network: [] },
    });

    assertEquals(report.passed, false);
    const errors = report.issues.filter((i) =>
      i.category === "network" && i.severity === "error"
    );
    assertEquals(
      errors.length,
      3,
      "Mixed-case schemes must not evade SSRF scan",
    );
    assert(errors.some((i) => i.message.includes("10.0.0.1")));
    assert(errors.some((i) => i.message.includes("169.254.169.254")));
    assert(errors.some((i) => i.message.includes("127.0.0.1")));
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

Deno.test("PLAT-5 (Adversarial): SSRF scan detects localhost and 0.0.0.0/8 variations", async () => {
  const sourceDir = await createTestSourceDir({
    "src/zeros.ts": `
export default async function(): Promise<Response> {
  await fetch("http://localhost:3000/internal");
  await fetch("http://127.0.0.1:8080/loop");
  await fetch("http://0.0.0.0:8080/all");
  await fetch("http://0.42.0.1:8080/zero-network");
  return new Response("ok");
}
`,
  });

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report = await analyzer.analyzeSource(sourceDir, {
      permissions: { network: [] },
    });

    assertEquals(report.passed, false);
    const errors = report.issues.filter((i) =>
      i.category === "network" && i.severity === "error"
    );
    assertEquals(errors.length, 4);
    assert(errors.some((i) => i.message.includes("localhost")));
    assert(errors.some((i) => i.message.includes("127.0.0.1")));
    assert(errors.some((i) => i.message.includes("0.0.0.0")));
    assert(errors.some((i) => i.message.includes("0.42.0.1")));
  } finally {
    await Deno.remove(sourceDir, { recursive: true });
  }
});

// ============================================================================
// Group 7: Pre-Deploy Diagnostics Blocking Enforcement in deployCommand (PLAT-3)
// ============================================================================

Deno.test("PLAT-3, PLAT-6, PLAT-15 (Adversarial): deployCommand blocks artifact transmission when undeclared secret is accessed", async () => {
  const projectDir = await createTestSourceDir({
    "railfog.toml": `
name = "deploy-secret-test"
[functions.api]
entry = "src/api.ts"
[functions.api.permissions]
secrets = ["ALLOWED_KEY"]
`,
    "src/api.ts": `
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const leaked = ctx?.env?.get("FORBIDDEN_LEAKED_KEY");
  return new Response(leaked);
}
`,
  });

  let deploymentServiceCalled = false;
  const mockService = {
    deploy: () => {
      deploymentServiceCalled = true;
      return Promise.resolve({ revisionId: "rev_MOCK", state: "Deployed" });
    },
  } as unknown as DeployCommandOptions["deploymentService"];

  try {
    await assertRejects(
      async () => {
        await deployCommand({
          cwd: projectDir,
          deploymentService: mockService,
        });
      },
      ValidationFailedError,
      "Pre-deploy security diagnostics failed",
    );

    assertEquals(
      deploymentServiceCalled,
      false,
      "Deployment service MUST NOT be invoked when pre-deploy diagnostics fail (PLAT-3)",
    );
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});

Deno.test("PLAT-3, PLAT-5 (Adversarial): deployCommand blocks artifact transmission when mandatory SSRF target is present", async () => {
  const projectDir = await createTestSourceDir({
    "railfog.toml": `
name = "deploy-ssrf-test"
[functions.api]
entry = "src/api.ts"
[functions.api.permissions]
network = ["169.254.169.254"]
`,
    "src/api.ts": `
export default async function handler(): Promise<Response> {
  await fetch("http://169.254.169.254/latest/meta-data/");
  return new Response("ok");
}
`,
  });

  let deploymentServiceCalled = false;
  const mockService = {
    deploy: () => {
      deploymentServiceCalled = true;
      return Promise.resolve({ revisionId: "rev_MOCK", state: "Deployed" });
    },
  } as unknown as DeployCommandOptions["deploymentService"];

  try {
    await assertRejects(
      async () => {
        await deployCommand({
          cwd: projectDir,
          deploymentService: mockService,
        });
      },
      ValidationFailedError,
      "Pre-deploy security diagnostics failed",
    );

    assertEquals(
      deploymentServiceCalled,
      false,
      "Deployment service MUST NOT be invoked when mandatory SSRF target is present (PLAT-3, PLAT-5)",
    );
  } finally {
    await Deno.remove(projectDir, { recursive: true });
  }
});
