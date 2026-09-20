# T-0706 — Deno Compute Provider Adapter

Status: Complete
Milestone: 0.7 Repo Consolidation
Depends on: T-0701
Blocks: T-0708, T-0709, T-0710

## Spec references

`PLAT-4`, `PLAT-16`, `PLAT-19`, `ADR-0001`

## Scope

**In scope**:
- `providers/compute/deno-compute-provider.ts`: Implementation of `ComputeProvider` interface (defined in `primitives/compute/compute-provider.ts`) wrapping an `IsolationProvider` (`LocalIsolation`, `ProcessIsolation`, or `GVisorIsolation`) to execute function artifacts under resource limits per `PLAT-4`, `PLAT-16`, and `ADR-0001`.
- `providers/compute/mod.ts`: Barrel export for the Deno compute provider.
- Remove redundant placeholder `providers/compute/.gitkeep`.

**Out of scope**:
- Modifying the existing `ComputeProvider` or `IsolationProvider` interface signatures in `primitives/compute/compute-provider.ts`.
- Direct implementation of low-level sandbox mechanics (handled inside the underlying `IsolationProvider`).

## Interface to implement

```typescript
import type {
  Artifact,
  ComputeProvider,
  ExecutionResult,
  InvocationRequest,
  IsolationProvider,
  Limits,
} from "../../primitives/compute/compute-provider.ts";

export interface DenoComputeProviderOptions {
  isolationProvider: IsolationProvider;
}

export class DenoComputeProvider implements ComputeProvider {
  constructor(options: DenoComputeProviderOptions);

  get isolation(): IsolationProvider;

  run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult>;
}
```

## Acceptance criteria (Given/When/Then)

1. Given a `DenoComputeProvider` initialized with an `IsolationProvider`, when `run` is called with an `Artifact`, `Limits`, and `InvocationRequest`, then it forwards the call directly to `IsolationProvider.run` and returns the resulting `ExecutionResult` (`PLAT-4`, `PLAT-16`).
2. Given a call to `run` without an `invocation` argument, when executed, then it synthesizes a default GET `InvocationRequest` preserving backward compatibility with `ADR-0001`.
3. Given an execution timeout or sandbox error thrown by the underlying `IsolationProvider`, when caught by `DenoComputeProvider`, then it cleanly bubbles or formats the error without masking execution resource metrics.

## Tests required

- [x] Unit — `tests/unit/deno_compute_provider_test.ts`: Validate that `DenoComputeProvider` correctly wraps `IsolationProvider`, forwards invocation arguments and limits, and returns `ExecutionResult`.
- [x] Security — `tests/security/compute_provider_isolation_test.ts`: Assert that `DenoComputeProvider` strictly enforces the isolation boundary and does not execute uncontained code outside the configured `IsolationProvider` (`PLAT-4`).

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Assumptions made

None.
