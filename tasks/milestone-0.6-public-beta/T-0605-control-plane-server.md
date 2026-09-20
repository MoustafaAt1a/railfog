# T-0605 — Standalone Control Plane Daemon Server

Status: Done
Milestone: 0.6 Public Beta
Depends on: T-0207, T-0407, T-0411
Blocks: T-0609, T-0611

## Spec references

`PLAT-1`, `PLAT-3`, `PLAT-8`, `PLAT-12`, `PLAT-14`, `PLAT-18`, `FN-3`, `ADR-0002`

## Scope

**In scope**:
- `apps/api/control-server.ts`: Standalone HTTP daemon process (`railfog-control` per `PLAT-1`) exposing management REST endpoints for project health, immutable versioned configuration snapshot distribution (`PLAT-8`), revision deployment and rollback (`PLAT-3`), and state backup export/import (`ADR-0002`).
- `apps/api/control-server_test.ts`: Integration tests verifying control endpoints, ETag snapshot caching, deploy gating, rollback, and error handling.

**Out of scope**:
- Executing customer function code (banned in control plane per `PLAT-1`).
- Data plane request handling or proxying (strictly separated per `PLAT-1` and `PLAT-8`).

## Interface to implement

```typescript
import type { DeploymentService } from "./deployment-service.ts";
import type { StateBackupService } from "./state-backup-service.ts";
import type { ProjectSnapshot } from "../../packages/policy/snapshot-store.ts";

export interface ControlServerOptions {
  port?: number;
  host?: string;
  deploymentService: DeploymentService;
  stateBackupService: StateBackupService;
  signal?: AbortSignal;
}

export interface ControlServer {
  port: number;
  close(): Promise<void>;
}

export function startControlServer(options: ControlServerOptions): Promise<ControlServer>;
```

## Acceptance criteria (Given/When/Then)

1. Given `startControlServer` running, when `GET /healthz` is requested, then it returns HTTP 200 with JSON status `{"status": "ok", "service": "railfog-control"}` and a valid ULID `request_id` in header and body (`PLAT-12`, `PLAT-14`).
2. Given a project with active revisions, when `GET /v1/projects/:projectId/snapshot` is requested, then it returns the current `ProjectSnapshot` with an HTTP `ETag` matching the snapshot version; when requested with `If-None-Match: <etag>`, it returns HTTP 304 Not Modified without payload (`PLAT-8`).
3. Given a deployment request submitted to `POST /v1/projects/:projectId/deploy`, when the artifact is uploaded with valid manifest, then the control server executes pre-deploy validation, runs health checks (3 consecutive 200s), updates active revision, and pushes/updates the snapshot version (`PLAT-3`).
4. Given a rollback request submitted to `POST /v1/projects/:projectId/rollback`, when valid target revision is supplied, then it flips the active revision pointer atomically and updates the snapshot (`PLAT-3`, `FN-3`).
5. Given export and import requests submitted to `/v1/projects/:projectId/export` and `/v1/projects/:projectId/import`, then it coordinates with `StateBackupService` to produce or restore valid `StateBackupArchive` archives (`ADR-0002`).
6. Given any customer code execution request directed at the control plane, then it is rejected — the control plane never executes customer isolates (`PLAT-1`).

## Tests required

- [x] Integration — `apps/api/control-server_test.ts`: Test `/healthz`, `/v1/projects/:id/snapshot` (with ETag & 304), `/deploy`, `/rollback`, `/export`, and `/import`.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-3`, `PLAT-8`, `PLAT-12`, `PLAT-14`, `PLAT-18`, `FN-3`, `ADR-0002`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

## Verification Evidence

### 1. Type Check (`deno check apps/api/control-server.ts apps/api/control-server_test.ts`)
```
Exit code: 0 (zero errors)
```

### 2. Integration Test Suite (`deno test -A apps/api/control-server_test.ts`)
```
running 13 tests from ./apps/api/control-server_test.ts
AC1: GET /healthz returns 200 OK with ok status, railfog-control service, and valid ULID request_id ... ok (58ms)
AC1: GET /healthz propagates existing request_id header unchanged per PLAT-12 ... ok (14ms)
AC2: GET /v1/projects/:projectId/snapshot returns 200 with snapshot and ETag header ... ok (26ms)
AC2: GET /v1/projects/:projectId/snapshot returns 304 Not Modified when If-None-Match matches ETag ... ok (29ms)
AC3: POST /v1/projects/:projectId/deploy activates revision and increments snapshot version and ETag ... ok (35ms)
AC3: POST /v1/projects/:projectId/deploy rejects invalid artifact with 400 VALIDATION_FAILED ... ok (17ms)
AC4: POST /v1/projects/:projectId/rollback flips active pointer to target revision without rebuilding ... ok (37ms)
AC4: POST /v1/projects/:projectId/rollback returns 404 RESOURCE_NOT_FOUND for non-existent revision ... ok (11ms)
AC5: POST /v1/projects/:projectId/export and /import round-trips state archive ... ok (37ms)
AC5: POST /v1/projects/:projectId/import rejects malformed archive with 400 VALIDATION_FAILED ... ok (19ms)
AC6: control plane rejects customer invocation requests with 403 or 404 and never executes customer code ... ok (26ms)
Server Lifecycle: startControlServer allocates dynamic port and close() cleanly shuts down ... ok (2s)
Server Lifecycle: startControlServer respects AbortSignal for graceful shutdown ... ok (2s)

ok | 13 passed | 0 failed (4s)
```

### 3. Linter (`deno lint apps/api/control-server.ts apps/api/control-server_test.ts`)
```
Checked 2 files
Exit code: 0 (zero warnings)
```

### 4. Reviewer Verification
- **Verdict:** PASS
- Independent verification against `PLAT-1`, `PLAT-3`, `PLAT-8`, `PLAT-12`, `PLAT-14`, `PLAT-18`, `FN-3`, and `ADR-0002`.
- Apps regression check: 116 passed, 0 failed across `apps/api`, `apps/gateway`, and `apps/worker`.

## Assumptions made

None.
