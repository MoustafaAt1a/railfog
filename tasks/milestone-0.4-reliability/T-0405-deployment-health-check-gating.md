# T-0405 — Deployment health check gating

Status: Done
Milestone: 0.4 Reliability
Depends on: T-0207
Blocks: T-0406, T-0412

## Spec references

`PLAT-3` `FN-3` `PLAT-12`

## Scope

**In scope** (be exact — file/module/interface level, not a feature area):
- `apps/api/health-checker.ts`: implement deployment health check probe executor per PLAT-3:
  - Enforces requirement: exactly 3 consecutive HTTP 200 responses within a 30-second total deadline.
  - Any non-200 status code, connection failure, or per-probe timeout resets the consecutive success counter to 0.
  - Returns `HealthCheckResult` with detailed diagnostic summary.
- Integration into `DeploymentService.deploy` (`apps/api/deployment-service.ts`):
  - Drives probe execution against candidate revision endpoints before cutover.
  - Health check pass: revision transitions to `Deployed` (FN-3) and traffic pointer atomically activates (PLAT-3).
  - Health check fail: revision transitions to `Failed` (FN-3), remains inactive, previous active revision continues serving uninterrupted (PLAT-3).

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Canary deployments, percentage-based rollouts, or weighted traffic-splitting (strictly banned in 1.0.0 per PLAT-3, PLAT-20).
- Instant rollback CLI commands (T-0406).
- Customer code execution inside control plane (banned per PLAT-1).

## Interface to implement

```typescript
export interface HealthProbeOptions {
  probeUrl: string;
  consecutiveSuccessesRequired?: number; // default 3 (PLAT-3)
  totalTimeoutMs?: number; // default 30000 (PLAT-3)
  probeIntervalMs?: number; // default 1000
  probeTimeoutMs?: number; // default 5000
  fetchFn?: typeof fetch; // injectable fetch for deterministic testing
}

export interface HealthCheckResult {
  passed: boolean;
  consecutiveSuccesses: number;
  probesAttempted: number;
  elapsedMs: number;
  lastStatusCode?: number;
  lastError?: string;
}

export function executeHealthCheck(
  options: HealthProbeOptions,
): Promise<HealthCheckResult>;
```

## Acceptance criteria (Given/When/Then)

1. Given an endpoint that returns 3 consecutive HTTP 200 responses within 3 seconds, when `executeHealthCheck` runs, then it returns `passed: true` with `consecutiveSuccesses: 3`.
2. Given an endpoint that returns status 200, 500, 200, 200, 200, when `executeHealthCheck` runs, then the non-200 response resets consecutive successes, and it passes only after 3 consecutive 200s are achieved within the 30-second limit.
3. Given an endpoint that continually returns HTTP 500 or times out, when 30 seconds elapse, then `executeHealthCheck` terminates and returns `passed: false`.
4. Given a deployment with a failing health check in `DeploymentService.deploy`, when the health check fails, then the revision state is set to `Failed`, `active` is `false`, and the existing active revision pointer remains unchanged.
5. Given a deployment with a passing health check in `DeploymentService.deploy`, when 3 consecutive 200s are recorded, then the revision state transitions to `Deployed` and becomes the active pointer.

## Tests required

- [x] Unit — 3 consecutive 200 successes satisfy health gating
- [x] Unit — single intermittent failure (e.g. 500 or timeout) resets consecutive counter
- [x] Unit — total 30-second timeout halts probing and returns failure
- [x] Integration — DeploymentService.deploy gates cutover on health check pass and preserves prior revision on fail

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] `deno fmt --check` run, real output attached, zero formatting issues
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

### Verified Tool Outputs

#### `deno check`
```
$ deno check apps/api/health-checker.ts apps/api/health-checker_test.ts apps/api/deployment-service.ts apps/api/deployment-service_test.ts tests/security/deployment_adversarial_test.ts
Check apps/api/health-checker.ts
Check apps/api/health-checker_test.ts
Check apps/api/deployment-service.ts
Check apps/api/deployment-service_test.ts
Check tests/security/deployment_adversarial_test.ts
```

#### `deno test`
```
$ deno test --allow-read --allow-write --allow-net apps/api/health-checker_test.ts apps/api/deployment-service_test.ts
Check apps/api/health-checker_test.ts
Check apps/api/deployment-service_test.ts
running 5 tests from ./apps/api/health-checker_test.ts
Unit - health check passes after 3 consecutive 200s ... ok (103ms)
Unit - non-200 response resets consecutive counter ... ok (59ms)
Unit - network error resets consecutive counter ... ok (62ms)
Unit - per-probe timeout resets consecutive counter ... ok (62ms)
Unit - total 30-second timeout halts probing and returns failure ... ok (107ms)
running 22 tests from ./apps/api/deployment-service_test.ts
Unit: AC1 - deploy creates revision with valid ULID and stores artifact under artifacts/{artifact_id} ... ok (18ms)
Unit: AC1 - multiple deployments generate unique, monotonically sortable ULID revision IDs ... ok (11ms)
Unit: AC2 - passing health check (3 consecutive successes) activates revision and transitions to Deployed ... ok (6ms)
Unit: AC2 - deploy without explicit healthCheck probe defaults to passing ... ok (6ms)
Unit: AC3 - health check failing on attempt 1 transitions to Failed and is not activated ... ok (7ms)
Unit: AC3 - health check failing on attempt 2 transitions to Failed and is not activated ... ok (6ms)
Unit: AC3 - health check failing on attempt 3 transitions to Failed and is not activated ... ok (5ms)
Unit: AC3 - health check throwing an error transitions to Failed and does not crash service ... ok (8ms)
Unit: AC3 - failing deployment preserves existing active revision ... ok (8ms)
Unit: AC4 - rollback flips active pointer to target revision without rebuilding ... ok (9ms)
Unit: AC5 - rollback to non-existent revision throws ResourceNotFoundError with code RESOURCE_NOT_FOUND ... ok (7ms)
Unit: AC5 - rollback on non-existent project or function throws ResourceNotFoundError ... ok (5ms)
Unit: AC5 - rollback cannot target revision of another project or function ... ok (17ms)
Unit: Query methods return null when revision or active revision does not exist ... ok (1ms)
Unit: Multi-tenancy isolation - revisions and active pointers are strictly scoped by project and function ... ok (10ms)
Integration: deploy artifact to real ObjectProvider and verify stored bytes match sha256 integrity ... ok (9ms)
Integration: Sequential deployments and rollback on real ObjectProvider preserve all artifacts ... ok (15ms)
Security: PLAT-1 - Control plane deploy never evaluates, imports, or executes customer code bytes ... ok (6ms)
Security: PLAT-1 - Control plane deploy accepts non-JS/corrupt bytes without parse or eval attempt ... ok (5ms)
Security: PLAT-1 - Control plane rollback never evaluates customer code ... ok (10ms)
Integration: AC4 - Failing health check with HealthProbeOptions transitions revision to Failed, active: false and preserves prior revision ... ok (127ms)
Integration: AC5 - Passing health check with HealthProbeOptions transitions revision to Deployed, active: true ... ok (44ms)

ok | 27 passed | 0 failed (958ms)
```

#### `deno lint`
```
$ deno lint apps/api/health-checker.ts apps/api/health-checker_test.ts apps/api/deployment-service.ts apps/api/deployment-service_test.ts
Checked 4 files
```

#### `deno fmt --check`
```
$ deno fmt --check apps/api/health-checker.ts apps/api/health-checker_test.ts apps/api/deployment-service.ts apps/api/deployment-service_test.ts
Checked 4 files
```

## Assumptions made

- `fetchFn` defaults to global `fetch` with an `AbortSignal.timeout(probeTimeoutMs)`.
- Probing stops immediately once `consecutiveSuccessesRequired` is achieved without waiting for the full 30 seconds to expire.
- `HealthProbeOptions` is supported in `DeploymentService.deploy(..., healthCheck)` alongside legacy boolean probe functions for backward compatibility.
