# T-0311 — ProcessIsolation provider with restricted Deno subprocess and stdio IPC

Status: Done
Milestone: 0.3 Security
Depends on: T-0301, T-0304, T-0306, T-0307, T-0308
Blocks: T-0313

## Spec references

`PLAT-4` `PLAT-5` `ADR-0001` `FN-6`

## Scope

**In scope:**
- `runtime/sandbox/process-isolation.ts`:
  - Implement `IsolationProvider` using isolated Deno child processes spawned via `Deno.Command`.
  - Enforce strict security flags on worker subprocesses:
    - `--no-prompt`
    - `--deny-read`
    - `--deny-write`
    - `--deny-run`
    - `--deny-sys`
    - `--deny-env`
  - Restrict network surface: configure `--allow-net=127.0.0.1:<egress-proxy-port>` directed exclusively to the local egress proxy (T-0304), or `--deny-net` when network permissions are omitted.
  - Implement host-sandbox communication over standard I/O (stdin/stdout JSON-RPC protocol per ADR-0001), ensuring customer code has zero direct host memory access.
  - Warm-process pooling: reuse subprocess instances *only* for the same `{project}:{function}:{revision}` tuple per FN-6.
  - Subprocess lifecycle management: process kill on timeout, crash recovery, and graceful worker pool shutdown.

**Out of scope:**
- gVisor / `runsc` container virtualization (T-0312).
- In-process `LocalIsolation` execution (T-0310).
- Egress proxy implementation (T-0304).

## Interface to implement

```typescript
import type {
  Artifact,
  ExecutionResult,
  IsolationProvider,
  Limits,
  InvocationRequest,
} from "../../primitives/compute/compute-provider.ts";

export interface ProcessIsolationOptions {
  egressProxyPort?: number;
  denoExecutablePath?: string;
  maxIdleProcesses?: number;
}

export class ProcessIsolationProvider implements IsolationProvider {
  constructor(options?: ProcessIsolationOptions);
  run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult>;
  shutdown(): Promise<void>;
}
```

## Acceptance criteria (Given/When/Then)

1. Given a customer function attempting `Deno.readTextFile` or writing files to disk, when executed in `ProcessIsolation`, then the operation is rejected with a permission error by Deno security flags.
2. Given a customer function attempting an ambient `fetch` to `169.254.169.254`, when executed, then outbound network traffic is constrained by `--allow-net` to the egress proxy and blocked.
3. Given an invocation payload transmitted across stdin, when the subprocess executes and returns the HTTP response over stdout, then the host receives `ExecutionResult` without the child holding host memory references.
4. Given a subprocess crashing or exceeding `timeoutMs`, when killed, then the host terminates the child process and returns `504 TIMEOUT` without hanging.

## Tests required

- [x] Unit — Deno command CLI argument generation, JSON-RPC IPC message serialization/deserialization, and error code mapping
- [x] Integration — spawning real Deno worker subprocesses, executing untrusted scripts, and receiving execution results
- [x] Security — sandbox escape verification: prove filesystem access denied, subprocess execution denied, ambient environment variables denied, and raw outbound networking denied (PLAT-4, PLAT-5, FN-6)

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches PLAT-4, PLAT-5, FN-6)
- [x] Nothing outside "In scope" touched

## Assumptions made

- Child process executes a lightweight bootstrap runner bundled in the repo (`runtime/sandbox/process-worker.ts`) that reads requests from stdin and sends JSON responses to stdout.
- Process pooling in the host and module caching in the worker are strictly scoped by `[orgId, project, function, revision]` to enforce tenant isolation (FN-6, PLAT-7).
- `Deno.stdout.write` and `writeSync` in the worker are redirected to `stderr` for customer code, and host verifies message ID matching to prevent IPC response frame spoofing (PLAT-4, ADR-0001).
- A periodic keepalive timer (`setInterval`) in the worker runner keeps the Deno event loop active when customer handlers await hanging promises, allowing the host-side wall-clock deadline to kill the process reliably at `timeoutMs`.
- Stderr from worker subprocesses is drained continuously in background tasks to prevent OS pipe buffer saturation and deadlocks.
