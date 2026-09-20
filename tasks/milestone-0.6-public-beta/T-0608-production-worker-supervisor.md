# T-0608 — Production Background Worker Supervisor

Status: Done
Milestone: 0.6 Public Beta
Depends on: T-0209, T-0408, T-0606
Blocks: T-0611

## Spec references

`PLAT-1`, `PLAT-2`, `PLAT-10`, `Q-2`, `Q-3`, `FN-2`, `FN-6`

## Scope

**In scope**:
- `apps/worker/worker-supervisor.ts`: Supervisor managing background queue consumer loops, enforcing per-queue concurrency limits, supervising worker lifecycle, restarting crashed workers with backoff, and coordinating graceful drain.
- `apps/worker/worker-supervisor_test.ts`: Integration tests verifying multi-worker concurrency, crash recovery, backoff intervals, and in-flight message draining upon shutdown.

**Out of scope**:
- Separate cron daemon service (banned per `PLAT-2`: triggers target Functions directly).
- Modifying underlying queue redelivery state machine (implemented in `T-0209` / `T-0408`).

## Interface to implement

```typescript
import type { QueueProvider } from "../../primitives/queues/queue-provider.ts";
import type { ComputeProvider } from "../../primitives/compute/compute-provider.ts";

export interface QueueWorkerTarget {
  queueName: string;
  targetFunction: string;
  concurrency?: number; // default: 1
  batchSize?: number; // default: 10
  queueProvider?: QueueProvider;
}

export interface WorkerSupervisorOptions {
  projectId: string;
  orgId?: string;
  queues: QueueWorkerTarget[];
  queueProvider: QueueProvider;
  computeProvider: ComputeProvider;
  signal?: AbortSignal;
}

export interface WorkerSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  getActiveWorkerCount(): number;
}

export function createWorkerSupervisor(
  options: WorkerSupervisorOptions,
): WorkerSupervisor;
```

## Acceptance criteria (Given/When/Then)

1. Given a project configuration with queue consumer triggers, when `supervisor.start()` is invoked, then it spawns dedicated worker loops matching the declared concurrency count per queue (`PLAT-2`, `FN-2`).
2. Given a fatal exception or unhandled crash inside a worker loop, when detected by the supervisor, then the worker is restarted automatically with exponential backoff without crashing the supervisor process or interrupting other active workers.
3. Given `supervisor.stop()` or an abort signal triggered, then all worker loops cease polling for new messages, wait for in-flight tasks to complete within a configurable timeout, and release queue leases cleanly.
4. Given multiple consecutive messages processed by a worker, when dispatched into the compute provider, then each invocation receives a fresh context and isolated bindings per `FN-6`.

## Tests required

- [x] Integration — `apps/worker/worker-supervisor_test.ts`: Test concurrent worker execution, crash recovery with backoff, in-flight message completion during shutdown, and multi-tenant isolation.
- [x] Security — Verify that sequential queue message dispatches in worker loops receive fresh, non-reused contexts with zero cross-job state bleed (`FN-6`).

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-2`, `PLAT-10`, `Q-2`, `Q-3`, `FN-2`, `FN-6`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Verification Transcripts

### `deno check apps/worker/worker-supervisor.ts apps/worker/worker-supervisor_test.ts tests/security/worker_supervisor_adversarial_test.ts`
```
Exit code: 0
Check file:///C:/FM/railfog/apps/worker/worker-supervisor.ts
Check file:///C:/FM/railfog/apps/worker/worker-supervisor_test.ts
Check file:///C:/FM/railfog/tests/security/worker_supervisor_adversarial_test.ts
```

### `deno test -A apps/worker/worker-supervisor_test.ts tests/security/worker_supervisor_adversarial_test.ts`
```
running 9 tests from ./tests/security/worker_supervisor_adversarial_test.ts
Adversarial FN-6: Sequential messages in warm worker receive fresh InvocationRequest references and strictly unique ULIDs ... ok (42ms)
Adversarial FN-6: Malicious compute handler payload buffer mutation cannot corrupt subsequent message payloads ... ok (33ms)
Adversarial FN-6: Header tampering and prototype pollution in message N does not bleed into message N+1 ... ok (30ms)
Adversarial Multi-Tenancy: Worker loop for Tenant/Queue A cannot access, receive, or acknowledge messages from Tenant/Queue B ... ok (2ms)
Adversarial Crash Cascade & Poison Pill: Crashing queue / poison messages cannot crash supervisor or degrade peer queues ... ok (59ms)
Adversarial Poison Payload: Circular reference body does not crash supervisor process ... ok (127ms)
Adversarial PLAT-10: Rapid shutdown / drain guarantees zero duplicate acknowledgments and zero dropped in-flight tasks ... ok (1ms)
Adversarial PLAT-10: Immediate worker sleep interruption prevents hanging shutdown during exponential backoff ... ok (108ms)
Adversarial PLAT-10: AbortSignal pre-aborted or concurrent start/stop races resolve cleanly ... ok (762µs)

running 14 tests from ./apps/worker/worker-supervisor_test.ts
AC1: spawns dedicated worker loops matching declared concurrency per queue (PLAT-2, FN-2) ... ok (81ms)
AC1: Concurrent execution - verifies workers process queue messages concurrently across queues (PLAT-2, FN-2) ... ok (61ms)
AC2: Crash recovery - worker restarts automatically with backoff after fatal error without crashing supervisor ... ok (170ms)
AC2: Crash recovery isolation - crashed worker does not interrupt or degrade peer active workers (PLAT-2, PLAT-10) ... ok (32ms)
AC3: Graceful drain - completes in-flight tasks and acknowledges them before stopping (PLAT-10) ... ok (60ms)
AC3: Graceful shutdown - AbortSignal triggers clean supervisor shutdown and drains workers (PLAT-10) ... ok (94ms)
AC3: Shutdown idempotency - multiple stop() calls and stop() before start() resolve cleanly ... ok (830µs)
AC4 & Security: consecutive invocations receive fresh ULID requestId and distinct context without state bleeding (FN-6) ... ok (61ms)
AC4: Invocation dispatch - passes queue message payload, target function, and request metadata into ComputeProvider (PLAT-2, FN-2) ... ok (62ms)
Config & Default Concurrency: queue target without explicit concurrency defaults to 1 ... ok (794µs)
Config & Default Concurrency: zero queues configuration starts cleanly with 0 workers ... ok (195µs)
Config: multiple queue targets with mixed concurrency configuration sum correctly ... ok (248µs)
Config: fallback queueProvider - workers default to options.queueProvider when target does not specify one ... ok (59ms)
Integration & Q-3: Compute provider failure leaves message unacknowledged for redelivery when attempts < maxReceives ... ok (310µs)

ok | 23 passed | 0 failed (1s)
```

### `deno lint apps/worker/worker-supervisor.ts apps/worker/worker-supervisor_test.ts tests/security/worker_supervisor_adversarial_test.ts`
```
Exit code: 0
Checked 3 files, 0 problems
```

## Assumptions made

None.
