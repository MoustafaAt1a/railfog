# T-0505 — Pre-Deploy and Health-Check Diagnostics Analyzer

Status: Done
Milestone: 0.5 Developer Experience
Depends on: T-0207, T-0504
Blocks: T-0511

## Spec references

`PLAT-3`, `PLAT-5`, `PLAT-6`, `PLAT-15`, `OBJ-4`, `FN-5`

## Scope

**In scope**:
- `packages/core/diagnostics/deploy-analyzer.ts`: Implement static pre-deploy analyzer and post-deploy failure diagnostics:
  1. Secret Audit: inspect source code for referenced environment/secret keys (e.g., `ctx.env.get("...")`) and verify they are declared in `permissions.secrets`. Flag any undeclared secret access as a pre-deploy blocking error (`PLAT-6`, `PLAT-15`).
  2. SSRF Network Scan: analyze static outbound URLs against the mandatory blocked IP/hostname ranges (169.254.0.0/16, RFC1918, loopback per `PLAT-5`) and confirm presence in `permissions.network`.
  3. Artifact Manifest & Integrity Diagnostic: output human-readable report of artifact SHA-256 hex and Subresource Integrity string (`OBJ-4`), permission scopes, and limit configuration before transmission.
  4. Health Check Failure Diagnostic: if the deployment health check fails (failing 3 consecutive 200s within 30s per `PLAT-3`), format clear failure diagnostics showing attempt latencies, HTTP status codes, and recent error messages.
- Integration into `cli/deploy.ts` to surface diagnostics in terminal output.
- `packages/core/diagnostics/deploy-analyzer_test.ts`: Unit and security tests for secret audit and SSRF detection.

**Out of scope**:
- Direct secret encryption (handled by `SecretStore`, T-0305).
- Real runtime network filtering (enforced by `EgressProxy`, T-0304).

## Interface to implement

```typescript
// packages/core/diagnostics/deploy-analyzer.ts

export interface DiagnosticIssue {
  category: "secrets" | "network" | "permissions" | "integrity" | "healthcheck";
  severity: "error" | "warning" | "info";
  message: string;
  sourceFile?: string;
}

export interface PreDeployReport {
  passed: boolean;
  issues: DiagnosticIssue[];
  artifactDigest?: {
    sha256Hex: string; // sha256:...
    integrity: string; // sha256-...
  };
}

export interface HealthCheckDiagnosticReport {
  healthy: boolean;
  attemptsCount: number;
  totalDurationMs: number;
  failureReason?: string;
  diagnosticAdvice: string[];
}

export class DeployDiagnosticsAnalyzer {
  analyzeSource(sourceDir: string, manifest: unknown): Promise<PreDeployReport>;
  formatHealthFailure(attempts: Array<{ attempt: number; status: number; durationMs: number; error?: string }>): HealthCheckDiagnosticReport;
}
```

## Acceptance criteria (Given/When/Then)

1. Given a Function referencing `ctx.env.get("STRIPE_KEY")` when `STRIPE_KEY` is not declared in `permissions.secrets` in `railfog.toml`, when analyzed prior to deploy, then it fails pre-deploy diagnostics with an error citing `PLAT-6` and `PLAT-15`.
2. Given a Function referencing an outbound URL pointing to `169.254.169.254` or `http://10.0.0.1`, when analyzed, then it flags a blocking security diagnostic error citing `PLAT-5` mandatory IP block.
3. Given a successful artifact build, when analyzed, then it computes and displays the content-addressed `sha256:` hex and Subresource Integrity `sha256-` base64 string matching `OBJ-4`.
4. Given a deployment whose health checks fail (e.g. 500 error or timeout), when generating failure diagnostics, then it provides a structured breakdown of each attempt, the HTTP status, duration, and advice to inspect Function logs.

## Tests required

- [x] Unit — `packages/core/diagnostics/deploy-analyzer_test.ts`: Test undeclared secret detection, valid secret pass, SSRF IP-range detection, and health-check diagnostic report generation.
- [x] Security — Verify that attempting to deploy code referencing metadata IP ranges or undeclared secrets is rejected at pre-deploy analysis time (`PLAT-5`, `PLAT-6`, `PLAT-15`).

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-3`, `PLAT-5`, `PLAT-6`, `PLAT-15`, `OBJ-4`, `FN-5`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete for PLAT-5/PLAT-6/PLAT-15
- [x] Nothing outside "In scope" touched

## Verification Evidence

```console
$ deno check packages/core/diagnostics/deploy-analyzer.ts packages/core/diagnostics/deploy-analyzer_test.ts cli/deploy.ts
(exit code: 0, 0 errors)

$ deno test -A packages/core/diagnostics/deploy-analyzer_test.ts
running 27 tests from ./packages/core/diagnostics/deploy-analyzer_test.ts
AC1 (PLAT-6, PLAT-15): Undeclared secret access via ctx.env.get is flagged as a blocking pre-deploy error citing PLAT-6 and PLAT-15 ... ok (20ms)
AC1 (PLAT-6, PLAT-15): Undeclared secret access via ctx.env.require is flagged as a blocking pre-deploy error ... ok (6ms)
AC1: All accessed secrets declared in permissions.secrets pass the secret audit without errors ... ok (7ms)
PLAT-15: Secret audit inspects multiple files in project directory recursively ... ok (19ms)
AC2 (PLAT-5): Outbound HTTP request referencing cloud metadata IP (169.254.169.254) is flagged citing PLAT-5 ... ok (9ms)
AC2 (PLAT-5): Outbound requests referencing RFC1918 private ranges (10.0.0.1, 192.168.1.1) are flagged as SSRF errors ... ok (6ms)
AC2 (PLAT-5): Outbound requests referencing loopback addresses (127.0.0.1, localhost) are flagged citing PLAT-5 ... ok (7ms)
AC2 (PLAT-5): Outbound request referencing IPv6 metadata address (fd00:ec2::254) is flagged ... ok (10ms)
PLAT-5: Declared public outbound domain does not emit SSRF errors ... ok (22ms)
AC3 (OBJ-4): Pre-deploy analyzer computes and formats sha256: hex digest and sha256- Subresource Integrity string ... ok (11ms)
OBJ-4: Artifact digest computation is deterministic across multiple analysis runs ... ok (10ms)
AC4 (PLAT-3): formatHealthFailure generates structured report for 500 status failure with log inspection advice ... ok (962µs)
AC4 (PLAT-3, FN-5): formatHealthFailure provides timeout advice when health check attempts exceed timeout limit ... ok (243µs)
PLAT-3: formatHealthFailure reports healthy=true when 3 consecutive 200 attempts succeed ... ok (143µs)
PLAT-6, PLAT-15 (Adversarial): Secret audit detects optional chaining syntax (ctx?.env?.get, ctx.env?.get, ctx?.env.get) ... ok (7ms)
PLAT-6, PLAT-15 (Adversarial): Secret audit detects single quotes and template literals (ctx.env.get('...'), ctx.env.get(`...`)) ... ok (7ms)
PLAT-6, PLAT-15 (Adversarial): Secret audit detects whitespace and newline variations ... ok (6ms)
PLAT-6, PLAT-15 (Adversarial): Secret audit detects require with optional chaining and quote variations ... ok (6ms)
PLAT-6, PLAT-15 (Adversarial): Secret audit detects Deno.env and direct env/secrets calls ... ok (11ms)
PLAT-5 (Adversarial): SSRF scan detects URLs with explicit ports ... ok (9ms)
PLAT-5 (Adversarial): SSRF scan detects URLs with userinfo and non-standard ports ... ok (13ms)
PLAT-5 (Adversarial): SSRF scan detects IPv6 bracketed addresses ... ok (8ms)
PLAT-5 (Adversarial): SSRF scan detects IPv4-mapped IPv6 addresses (dotted-decimal & hex) ... ok (7ms)
PLAT-5 (Adversarial): SSRF scan detects mixed-case and uppercase URL schemes (HTTP://, Http://, HTTPS://) ... ok (5ms)
PLAT-5 (Adversarial): SSRF scan detects localhost and 0.0.0.0/8 variations ... ok (9ms)
PLAT-3, PLAT-6, PLAT-15 (Adversarial): deployCommand blocks artifact transmission when undeclared secret is accessed ... ok (23ms)
PLAT-3, PLAT-5 (Adversarial): deployCommand blocks artifact transmission when mandatory SSRF target is present ... ok (9ms)

ok | 27 passed | 0 failed (286ms)

$ deno test -A cli/deploy_test.ts
running 29 tests from ./cli/deploy_test.ts
...
ok | 29 passed | 0 failed (3s)

$ deno lint packages/core/diagnostics/ cli/deploy.ts
Checked 3 files
(0 problems found)
```

## Assumptions made

None.
