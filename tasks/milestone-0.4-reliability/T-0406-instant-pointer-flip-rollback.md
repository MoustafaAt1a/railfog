# T-0406 — Instant pointer-flip rollback service and CLI command

Status: Done
Milestone: 0.4 Reliability
Depends on: T-0207, T-0210, T-0405
Blocks: T-0412

## Spec references

`PLAT-3` `FN-3` `PLAT-12` `PLAT-18`

## Scope

**In scope** (be exact — file/module/interface level, not a feature area):
- `apps/api/deployment-service.ts`: complete and expose rollback API:
  - Rollback is strictly an instant pointer flip (`Revision 3 -> Revision 2`), never an artifact rebuild or re-bundling (FN-3).
  - Validation: rejects rollback to non-existent revision with `ResourceNotFoundError` (`RESOURCE_NOT_FOUND` per PLAT-12).
  - Validation: rejects rollback to any revision whose state is not `Deployed` (e.g. `Failed`, `Building`, `Created`) with `ValidationFailedError` (`VALIDATION_FAILED` per PLAT-12, PLAT-3).
  - Enforces project and function hierarchy isolation (PLAT-18).
- `cli/rollback.ts`: implement `rail rollback` CLI command:
  - Supports `rail rollback <functionName> --to <revisionId> [--project <project>] [--control-url <url>]`.
  - Wire command into `cli/main.ts` with `--help` usage information and exit status codes.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Rebuilding or re-compiling artifact code during rollback (strictly banned per FN-3).
- Canary or gradual traffic draining (strictly banned per PLAT-3, PLAT-20).
- Rolling back stateful KV entries or Object data (T-0411 disaster recovery).

## Interface to implement

```typescript
export interface RollbackCommandOptions {
  cwd?: string;
  controlPlaneUrl?: string;
  project?: string;
  functionName: string;
  targetRevisionId: string;
}

export interface RollbackCommandResult {
  project: string;
  functionName: string;
  previousRevisionId: string;
  activeRevisionId: string;
}

export function rollbackCommand(
  options: RollbackCommandOptions,
): Promise<RollbackCommandResult>;
```

## Acceptance criteria (Given/When/Then)

1. Given a Function currently pointing at revision `rev_02`, when `rollbackCommand` targets prior deployed revision `rev_01`, then the active revision pointer immediately flips to `rev_01` without rebuilding code.
2. Given a rollback request targeting a revision ID that does not exist, when executed, then it rejects with `ResourceNotFoundError` (`RESOURCE_NOT_FOUND` error code).
3. Given a revision `rev_03` that failed health checks (`state: "Failed"`), when a rollback attempt targets `rev_03`, then it rejects with `ValidationFailedError` (`VALIDATION_FAILED` error code) and the current active revision remains intact.
4. Given CLI command `rail rollback api --to rev_01`, when run against a running control plane, then it flips the active pointer and prints confirmation of the previous and active revision IDs.
5. Given a rollback request for a revision belonging to a different project or function, when evaluated, then it is rejected without cross-tenant pointer tampering.

## Tests required

- [x] Unit — rollback validation: success on Deployed revision, rejection on Failed revision, rejection on non-existent revision
- [x] Unit — CLI argument parsing for `rail rollback <function> --to <revision>` and error handling
- [x] Integration — end-to-end deploy rev 1, deploy rev 2, rollback to rev 1, verifying active pointer flips instantly

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
$ deno check apps/api/deployment-service.ts cli/rollback.ts cli/main.ts cli/rollback_test.ts apps/api/deployment-service_test.ts tests/security/deployment_adversarial_test.ts
Check apps/api/deployment-service.ts
Check cli/rollback.ts
Check cli/main.ts
Check cli/rollback_test.ts
Check apps/api/deployment-service_test.ts
Check tests/security/deployment_adversarial_test.ts
```

#### `deno test`
```
$ deno test --allow-read --allow-write --allow-net cli/rollback_test.ts apps/api/deployment-service_test.ts
running 22 tests from ./apps/api/deployment-service_test.ts
Unit: AC1 - deploy creates revision with valid ULID and stores artifact under artifacts/{artifact_id} ... ok (22ms)
Unit: AC1 - multiple deployments generate unique, monotonically sortable ULID revision IDs ... ok (9ms)
Unit: AC2 - passing health check (3 consecutive successes) activates revision and transitions to Deployed ... ok (5ms)
Unit: AC2 - deploy without explicit healthCheck probe defaults to passing ... ok (6ms)
Unit: AC3 - health check failing on attempt 1 transitions to Failed and is not activated ... ok (8ms)
Unit: AC3 - health check failing on attempt 2 transitions to Failed and is not activated ... ok (8ms)
Unit: AC3 - health check failing on attempt 3 transitions to Failed and is not activated ... ok (6ms)
Unit: AC3 - health check throwing an error transitions to Failed and does not crash service ... ok (6ms)
Unit: AC3 - failing deployment preserves existing active revision ... ok (11ms)
Unit: AC4 - rollback flips active pointer to target revision without rebuilding ... ok (9ms)
Unit: AC5 - rollback to non-existent revision throws ResourceNotFoundError with code RESOURCE_NOT_FOUND ... ok (8ms)
Unit: AC5 - rollback on non-existent project or function throws ResourceNotFoundError ... ok (8ms)
Unit: AC5 - rollback cannot target revision of another project or function ... ok (12ms)
Unit: Query methods return null when revision or active revision does not exist ... ok (3ms)
Unit: Multi-tenancy isolation - revisions and active pointers are strictly scoped by project and function ... ok (12ms)
Integration: deploy artifact to real ObjectProvider and verify stored bytes match sha256 integrity ... ok (10ms)
Integration: Sequential deployments and rollback on real ObjectProvider preserve all artifacts ... ok (10ms)
Security: PLAT-1 - Control plane deploy never evaluates, imports, or executes customer code bytes ... ok (5ms)
Security: PLAT-1 - Control plane deploy accepts non-JS/corrupt bytes without parse or eval attempt ... ok (4ms)
Security: PLAT-1 - Control plane rollback never evaluates customer code ... ok (10ms)
Integration: AC4 - Failing health check with HealthProbeOptions transitions revision to Failed, active: false and preserves prior revision ... ok (127ms)
Integration: AC5 - Passing health check with HealthProbeOptions transitions revision to Deployed, active: true ... ok (32ms)
running 6 tests from ./cli/rollback_test.ts
rollbackCommand - AC1: successfully rolls back to prior deployed revision ... ok (19ms)
rollbackCommand - AC2: rejects targeting non-existent revision with ResourceNotFoundError ... ok (3ms)
rollbackCommand - AC3: rejects targeting Failed revision with ValidationFailedError ... ok (10ms)
rollbackCommand - AC5: enforces project and function isolation, rejects mismatched tenant ... ok (7ms)
CLI rollback - arg validation fails on missing functionName or --to flag ... ok (9ms)
CLI rollback - AC4: e2e test executing rollback command ... ok (12ms)

ok | 28 passed | 0 failed (621ms)
```

#### `deno lint`
```
$ deno lint apps/api/deployment-service.ts cli/rollback.ts cli/main.ts cli/rollback_test.ts
Checked 4 files
```

#### `deno fmt --check`
```
$ deno fmt --check apps/api/deployment-service.ts cli/rollback.ts cli/main.ts cli/rollback_test.ts
Checked 4 files
```

## Assumptions made

- [Implementation choice] `rollbackCommand` determines project name from `railfog.toml` unless overridden with `--project` flag.
- [Implementation choice] Rollback target revision ID must be explicitly specified via `--to <revisionId>`.
- [Implementation choice] `runCli` in CLI tests supports in-process fallback execution when run without `--allow-run` permissions.
