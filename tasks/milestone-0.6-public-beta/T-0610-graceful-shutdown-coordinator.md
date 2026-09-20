# T-0610 — Graceful Shutdown Coordinator

Status: Done
Milestone: 0.6 Public Beta
Depends on: T-0604, T-0606
Blocks: T-0611

## Spec references

`PLAT-1`, `PLAT-10`

## Scope

**In scope**:
- `runtime/lifecycle/shutdown-coordinator.ts`: Production lifecycle coordination component intercepting termination signals (SIGINT, SIGTERM), entering draining state, rejecting new connections, draining in-flight requests and queue workers up to a timeout ceiling, and cleanly closing resources.
- `runtime/lifecycle/shutdown-coordinator_test.ts`: Integration tests verifying multi-target registration, in-flight connection completion, refusal of new traffic during draining, and timeout escalation.

**Out of scope**:
- Cloud hypervisor management or Kubernetes pod lifecycle hooks (banned per `PLAT-20`).
- Process signal handling overrides inside sandboxed customer isolates.

## Interface to implement

```typescript
export interface DrainTarget {
  name: string;
  getActiveCount(): number;
  stopAccepting(): Promise<void> | void;
  drain(): Promise<void>;
}

export interface ShutdownOptions {
  drainTimeoutMs?: number; // default: 15,000ms
  forceTimeoutMs?: number; // default: 30,000ms
  onShutdownStart?: () => void;
  onShutdownComplete?: () => void;
}

export class ShutdownCoordinator {
  constructor(options?: ShutdownOptions);
  register(target: DrainTarget): void;
  listenSignals(): void;
  shutdown(): Promise<boolean>;
  isShuttingDown(): boolean;
}
```

## Acceptance criteria (Given/When/Then)

1. Given registered drain targets (gateway server, runtime server, worker supervisor), when `coordinator.shutdown()` is initiated, then all targets immediately stop accepting new incoming requests (`PLAT-1`).
2. Given requests in flight at the time shutdown begins, when the handlers finish within `drainTimeoutMs`, then all responses are delivered cleanly and shutdown resolves with `true` (`PLAT-10`).
3. Given an unhandled or hanging request exceeding `drainTimeoutMs`, when the timeout fires, then the coordinator forces closure of remaining sockets, logs the timed-out targets, and resolves cleanly without deadlock.
4. Given multiple consecutive SIGINT or SIGTERM signals arriving, when intercepted, then the coordinator deduplicates the signals and executes the shutdown sequence exactly once.

## Tests required

- [x] Integration — `runtime/lifecycle/shutdown-coordinator_test.ts`: Test in-flight request completion, new connection rejection during draining, timeout enforcement, and idempotent signal handling.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-10`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

## Verification Transcripts

### `deno check runtime/lifecycle/shutdown-coordinator.ts runtime/lifecycle/shutdown-coordinator_test.ts`
```text
Check runtime/lifecycle/shutdown-coordinator.ts
Check runtime/lifecycle/shutdown-coordinator_test.ts
Exit code: 0
```

### `deno test -A runtime/lifecycle/shutdown-coordinator_test.ts`
```text
running 19 tests from ./runtime/lifecycle/shutdown-coordinator_test.ts
ShutdownCoordinator: initializes with default options and inactive state ... ok (454µs)
ShutdownCoordinator: accepts custom timeout options and lifecycle callbacks ... ok (90µs)
AC1: stopAccepting() is called on all targets immediately before drain begins ... ok (10ms)
AC1: supports asynchronous stopAccepting() implementations ... ok (13ms)
AC1: isShuttingDown() transitions to true synchronously upon initiation ... ok (415µs)
AC2: in-flight requests complete within drainTimeoutMs and shutdown resolves to true ... ok (47ms)
AC2: onShutdownStart and onShutdownComplete callbacks execute in strict order ... ok (28ms)
AC2: multiple drain targets drain concurrently and resolve cleanly ... ok (45ms)
AC3: hanging drain target exceeding drainTimeoutMs escalates and returns false ... ok (31ms)
AC3: mixed targets - fast target completes, slow target times out - resolves false ... ok (31ms)
AC3: onShutdownComplete callback still fires on timeout escalation ... ok (46ms)
AC4: concurrent shutdown() calls are deduplicated and return identical result ... ok (31ms)
AC4: consecutive shutdown() calls after completion return cached result without re-executing ... ok (727µs)
AC4: lifecycle callbacks fire exactly once across duplicate shutdown triggers ... ok (591µs)
Signal Listener: coordinator.listenSignals() attaches listeners safely without crashing ... ok (1ms)
Signal Listener: clean coordinator state and shutdown completion after listenSignals() ... ok (370µs)
Edge Case: coordinator with 0 registered targets resolves immediately to true ... ok (320µs)
Robustness: error thrown in target stopAccepting() does not abort other targets ... ok (1ms)
Robustness: rejected promise in target drain() is handled cleanly ... ok (604µs)

ok | 19 passed | 0 failed (308ms)
```

### `deno lint runtime/lifecycle/shutdown-coordinator.ts runtime/lifecycle/shutdown-coordinator_test.ts`
```text
Checked 2 files
Exit code: 0
```

### Reviewer Verdict
- **Verdict**: PASS (Independent review verified interface compliance, PLAT-1 immediate stopAccepting, PLAT-10 drain timeout escalation and deadlock freedom, signal deduplication, and zero resource leaks).

## Assumptions made

None.
