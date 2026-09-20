# T-0312 — gVisor OCI isolation adapter with platform detection

Status: Done
Milestone: 0.3 Security
Depends on: T-0301
Blocks: T-0313

## Spec references

`PLAT-4` `PLAT-16` `PLAT-17`

## Scope

**In scope:**
- `runtime/sandbox/gvisor-isolation.ts`:
  - Implement `IsolationProvider` for production containerized sandboxing using gVisor (`runsc`).
  - OCI bundle specification generator: produces valid OCI `config.json` defining:
    - Read-only root filesystem
    - Linux namespaces (pid, network, ipc, mount)
    - Memory ceiling mapped from `limits.memoryMb` (default 128MB per FN-5)
    - Seccomp syscall filtering profiles
  - Platform detection: detect presence of Linux OS and `runsc` executable in PATH.
  - Development fallback emulation per PLAT-17: when running on non-Linux platforms (Windows, macOS) or when `runsc` is absent, validate OCI bundle configuration and provide safe structural execution emulation for local testability.

**Out of scope:**
- Deno subprocess stdio IPC protocol (T-0311).
- HTTP forward egress proxy (T-0304).
- Host Linux kernel packaging or container image build infrastructure.

## Interface to implement

```typescript
import type {
  Artifact,
  ExecutionResult,
  IsolationProvider,
  Limits,
  InvocationRequest,
} from "../../primitives/compute/compute-provider.ts";

export interface OciBundleConfig {
  ociVersion: string;
  process: { args: string[]; env: string[]; cwd: string };
  root: { path: string; readonly: boolean };
  linux?: {
    resources?: { memory?: { limit?: number } };
    seccomp?: unknown;
    namespaces?: { type: string }[];
  };
}

export interface GVisorIsolationOptions {
  runscPath?: string;
  bundleRootDir?: string;
}

export class GVisorIsolationProvider implements IsolationProvider {
  constructor(options?: GVisorIsolationOptions);
  isAvailable(): boolean;
  generateBundle(artifact: Artifact, limits: Limits): OciBundleConfig;
  run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult>;
}
```

## Acceptance criteria (Given/When/Then)

1. Given an `Artifact` and `Limits` with `memoryMb: 128`, when `generateBundle` is called, then the generated OCI bundle specifies a read-only root filesystem, memory limit of `134217728` bytes (128 MB), and seccomp syscall constraints.
2. Given a host environment without `runsc` (e.g. Windows/macOS development machine), when `isAvailable()` is called, then it returns `false` cleanly without throwing an unhandled exception.
3. Given `runsc` unavailable on the host, when `run(artifact, limits)` is called, then it validates the bundle structure and executes via safe emulation, returning a valid `ExecutionResult`.

## Tests required

- [x] Unit — OCI bundle specification generation, memory limit byte calculation, namespace declarations, and platform detection logic
- [x] Integration — bundle generation from real Artifact bundles
- [x] Security — verify OCI config enforces readonly rootfs, drops capabilities, isolates network namespaces, and sets hard memory limits (PLAT-4, PLAT-16, PLAT-17)

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches PLAT-4, PLAT-16, PLAT-17)
- [x] Nothing outside "In scope" touched

## Assumptions made

- Platform detection checks `Deno.build.os === "linux"` and probes for the `runsc` executable in system PATH.
- Safe emulation fallback delegates execution to `LocalIsolationProvider` when `runsc` is unavailable on non-Linux hosts (Windows, macOS), verifying full OCI bundle structural compliance before executing.
