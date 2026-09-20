# T-0606 — Standalone Runtime Data Plane Daemon Server

Status: Done
Milestone: 0.6 Public Beta
Depends on: T-0208, T-0301, T-0407, T-0508
Blocks: T-0608, T-0609, T-0610, T-0611

## Spec references

`PLAT-1`, `PLAT-4`, `PLAT-8`, `PLAT-10`, `PLAT-11`, `PLAT-12`, `PLAT-14`, `FN-1`, `FN-6`, `FN-8`

## Scope

**In scope**:
- `apps/runtime/runtime-server.ts`: Standalone HTTP daemon process (`railfog-runtime` per `PLAT-1`) serving live customer requests from locally cached immutable configuration snapshots, polling the control plane in the background (~5s), operating completely fail-static if the control plane fails (`PLAT-8`), and dispatching requests into `IsolationProvider` (`PLAT-4`) with fresh per-invocation capability bindings (`FN-6`).
- `apps/runtime/runtime-server_test.ts`: Integration tests verifying request dispatch, route matching specificity (`PLAT-11`), fail-static behavior during control plane outage (`PLAT-8`), and warm isolate context isolation (`FN-6`).

**Out of scope**:
- Synchronous calls to the control plane on the per-request hot path (strictly banned per `PLAT-1` and `PLAT-8`).
- Building deployment artifacts or mutating revisions (owned by control plane).

## Interface to implement

```typescript
import type { IsolationProvider } from "../../primitives/compute/compute-provider.ts";

export interface RuntimeServerOptions {
  port?: number;
  host?: string;
  controlPlaneUrl?: string;
  projectId: string;
  orgId?: string;
  snapshotDiskCachePath?: string;
  isolationProvider: IsolationProvider;
  pollIntervalMs?: number; // default: 5000ms
  signal?: AbortSignal;
}

export interface RuntimeServer {
  port: number;
  getSnapshotVersion(): number;
  close(): Promise<void>;
}

export function startRuntimeServer(options: RuntimeServerOptions): Promise<RuntimeServer>;
```

## Acceptance criteria (Given/When/Then)

1. Given `startRuntimeServer` initialized with a valid project ID, when started, then it loads the latest snapshot from disk cache or the control plane, initializes route tables, and listens on the designated port.
2. Given incoming HTTP requests, when processed, then the runtime matches routes according to specificity score (`PLAT-11`), executes the handler inside `IsolationProvider` (`PLAT-4`), and returns the response with Crockford Base32 ULID `x-request-id` headers (`PLAT-14`).
3. Given the control plane becoming completely unavailable (network drop or 503 `UNAVAILABLE`), when live traffic arrives, then the runtime data plane continues serving requests from its cached snapshot indefinitely with zero errors and zero latency degradation (`PLAT-8`, `PLAT-10`).
4. Given sequential requests to the same function in a warm isolate, when executed, then the handler is reused while `RailFogContext` and scoped bindings are freshly injected for every invocation without reference reuse or state bleeding (`FN-6`).
5. Given a new snapshot version published by the control plane, when the background poller detects an updated ETag, then the runtime atomically updates its routing and permission snapshot without restarting or dropping in-flight connections (`PLAT-8`).

## Tests required

- [x] Integration — `apps/runtime/runtime-server_test.ts`: Test route dispatch, fail-static operation during control plane down, background snapshot update, and warm-isolate context freshness (FN-6).
- [x] Security — Verify that repeated invocations in warm isolates receive fresh, non-reused RailFogContext instances with completely isolated bindings, preventing cross-request state leakage (`PLAT-4`, `FN-6`).

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-4`, `PLAT-8`, `PLAT-10`, `PLAT-11`, `PLAT-12`, `PLAT-14`, `FN-1`, `FN-6`, `FN-8`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Verification Transcripts

### `deno check apps/runtime/runtime-server.ts apps/runtime/runtime-server_test.ts tests/security/runtime_server_adversarial_test.ts`
```
Exit code: 0
Check file:///C:/FM/railfog/apps/runtime/runtime-server.ts
Check file:///C:/FM/railfog/apps/runtime/runtime-server_test.ts
Check file:///C:/FM/railfog/tests/security/runtime_server_adversarial_test.ts
```

### `deno test -A apps/runtime/runtime-server_test.ts tests/security/runtime_server_adversarial_test.ts`
```
running 13 tests from ./apps/runtime/runtime-server_test.ts
AC1: startRuntimeServer loads initial snapshot and serves /healthz with valid ULID ... ok (55ms)
AC1: GET /healthz propagates existing request_id header unchanged per PLAT-12 ... ok (26ms)
AC2: dispatches requests according to PLAT-11 specificity score ... ok (38ms)
AC2: unmapped route returns HTTP 404 RESOURCE_NOT_FOUND per PLAT-12 ... ok (18ms)
AC2: propagates HTTP method, request headers, and body to IsolationProvider ... ok (21ms)
PLAT-12: unhandled error in isolation provider returns HTTP 500 INTERNAL with valid ULID ... ok (13ms)
AC3: continues serving traffic indefinitely during complete control plane outage (PLAT-8) ... ok (181ms)
AC3: cold starts from disk cache when control plane is completely unavailable (PLAT-8, PLAT-10) ... ok (33ms)
AC4 & Security: consecutive invocations in warm isolates receive fresh request context and distinct ULID (FN-6) ... ok (20ms)
AC5: dynamically updates routing snapshot in background without dropped connections (PLAT-8) ... ok (84ms)
AC5: poller includes If-None-Match header and handles 304 Not Modified efficiently (PLAT-8) ... ok (121ms)
Server Lifecycle: close() terminates cleanly and stops polling without hanging ... ok (2s)
Server Lifecycle: respects AbortSignal for graceful shutdown ... ok (7ms)

running 9 tests from ./tests/security/runtime_server_adversarial_test.ts
Attack 1a: Mutated headers in warm isolate never bleed to subsequent invocations ... ok (63ms)
Attack 1b: Request body buffer mutation does not bleed across warm invocations ... ok (56ms)
Attack 1c: Distinct Crockford Base32 ULID request_ids assigned to consecutive requests ... ok (67ms)
Attack 2a: Path traversal attempts cannot access files or bypass router ... ok (85ms)
Attack 2b: Runtime server does not serve control plane endpoints or leak credentials ... ok (34ms)
Attack 2c: Snapshot route pointing to prototype property (toString) returns canonical 404, not unhandled crash ... ok (47ms)
Attack 3a: Version downgrade replay is rejected by runtime server ... ok (204ms)
Attack 3b: Identical version number does not overwrite active snapshot ... ok (153ms)
Attack 3c: Ingestion of corrupted/malformed snapshots does not crash daemon or corrupt disk cache ... ok (245ms)

ok | 22 passed | 0 failed (3s)
```

### `deno lint apps/runtime/runtime-server.ts apps/runtime/runtime-server_test.ts tests/security/runtime_server_adversarial_test.ts`
```
Exit code: 0
Checked 3 files, 0 problems
```

## Assumptions made

None.

