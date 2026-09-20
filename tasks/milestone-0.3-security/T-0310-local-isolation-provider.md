# T-0310 — LocalIsolation provider with warm-isolate reuse manager

Status: Done
Milestone: 0.3 Security
Depends on: T-0301, T-0306, T-0307, T-0308
Blocks: T-0313

## Spec references

`PLAT-4` `PLAT-17` `FN-6`

## Scope

**In scope:**
- `runtime/sandbox/local-isolation.ts`:
  - Implement `IsolationProvider` for local in-process execution (`PLAT-17`: "Local: none (trusted dev machine)").
  - Warm-isolate lifecycle management strictly complying with FN-6:
    - Reuse isolate instances *only* for identical `{project}:{function}:{revision}` tuples.
    - Re-inject fresh `RailFogContext`, capability bindings, and secrets on *every* invocation.
    - Strictly reject isolate reuse across distinct projects, functions, or revisions.
  - Wire `KillEnforcer` (T-0308) for deadline enforcement and `InvocationTracker` (T-0307) for per-invocation operation quotas.
  - Expose lifecycle management methods for testing and cache eviction (`getWarmCount`, `clearWarm`).

**Out of scope:**
- Subprocess sandboxing via `Deno.Command` (T-0311).
- Production gVisor OCI container isolation (T-0312).
- Egress proxy network interception (T-0304).

## Interface to implement

```typescript
import type {
  Artifact,
  ExecutionResult,
  IsolationProvider,
  Limits,
  InvocationRequest,
} from "../../primitives/compute/compute-provider.ts";
import type { SecretStore } from "../../packages/policy/secret-store.ts";

export interface LocalIsolationOptions {
  maxWarmInstances?: number;
  secretStore?: SecretStore;
}

export class LocalIsolationProvider implements IsolationProvider {
  constructor(options?: LocalIsolationOptions);
  run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult>;
  getWarmCount(): number;
  clearWarm(): void;
}
```

## Acceptance criteria (Given/When/Then)

1. Given two consecutive invocations for the same `{project, function, revision}`, when executed, then the warm isolate instance is reused without re-importing the code bundle.
2. Given two invocations for different revisions (`rev_1` then `rev_2`) of the same function, when executed, then they execute in separate isolates; `rev_1`'s isolate is never reused for `rev_2` (FN-6).
3. Given two invocations for different projects, when executed, then isolate reuse is rejected and separate instances are instantiated.
4. Given a warm isolate reused for a second invocation, when `ctx` is inspected, then `ctx.requestId` is a new ULID, operation counters are reset to zero, and bindings are freshly injected (FN-6).

## Tests required

- [x] Unit — warm isolate cache keying, evicting on revision flip, and verifying fresh context construction per invocation
- [x] Integration — sequential invocations validating module-level global state caching while ensuring bindings are re-injected
- [x] Security — state bleeding prevention: verify global variable mutations and stored references do not leak capabilities or secrets across distinct functions or revisions (PLAT-4, FN-6)

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches PLAT-4, FN-6)
- [x] Nothing outside "In scope" touched

## Assumptions made

- In-process module evaluation uses dynamic module imports with instance cache keyed by JSON-encoded `[orgId, project, function, revision]` to prevent delimiter collision across names.
- Tenant `orgId` is resolved from artifact (`orgId`, `org`), headers (`x-railfog-org`, `x-railfog-org-id`), or configured options; SecretStore access is strictly tenant-scoped when `orgId` is provided.
- Global scope (`globalThis`) and prototype chain (`Object.prototype`) are snapshotted prior to invocation and cleansed in `finally` to prevent prototype pollution bleeding across executions.
- `ctx.env` is deactivated via an `activeEnv` guard and `secretsMap` entries are deleted in `finally` to ensure persisted references cannot leak unrotated or stale credentials.
