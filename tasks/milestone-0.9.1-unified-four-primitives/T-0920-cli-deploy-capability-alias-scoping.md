# T-0920 — Scope Conceptual Capability Aliases in CLI Deploy

Status: Done
Milestone: 0.9.1 Unified Four-Primitives & SDK Specification
Depends on: T-0918, T-0919
Blocks: T-0917

## Spec references

`PLAT-1`, `PLAT-3`, `PLAT-6`, `PLAT-8`, `PLAT-15`, `PLAT-18`, `CONCEPT-2`, `CONCEPT-6`

## Scope

**In scope**:
- Modify `cli/deploy.ts`:
  - Update `FunctionConfig` interface to accept `state`, `data`, and `signal` capability arrays under `permissions`.
  - Pass the declared permissions including conceptual aliases to `packageFunctionArtifact` during packaging stage.
  - Update deployment summary logging and dry-run output to report bound capabilities using their conceptual or infrastructure names without undefined errors.
  - Verify `SecretRedactor` continues to scrub secret values and sensitive data when conceptual aliases are present (PLAT-15).
- Update `tests/unit/cli_deploy_test.ts` to test deployment dry-run and mock upload of functions declaring `state`, `data`, and `signal`.

**Out of scope**:
- Modifying `apps/api/deployment-service.ts` or database persistence layer.
- Changing the binary artifact upload protocol or SRI digest calculation (OBJ-4).

## Interface to implement

```typescript
interface FunctionConfig {
  entry?: string;
  auth?: "bearer" | "none";
  permissions?: {
    kv?: string[];
    state?: string[];
    objects?: string[];
    data?: string[];
    queues?: string[];
    signal?: string[];
    network?: string[];
    secrets?: string[];
  };
  limits?: {
    cpu_ms?: number;
    timeout_ms?: number;
    memory_mb?: number;
    rate?: number;
    burst?: number;
  };
  triggers?: {
    queue?: string;
    schedule?: string;
  };
}
```

## Acceptance criteria (Given/When/Then)

1. Given a project with functions declaring `permissions = { state = ["sessions"], data = ["blobs"], signal = ["events"] }`, when `rail deploy --dry-run` runs, then packaging completes, canonical manifest permissions are produced, and validation succeeds.
2. Given a project declaring `state = ["db"]`, when `rail deploy` executes, then the artifact is built without type or runtime errors and successfully uploaded to the mock control plane.
3. Given a project using existing `kv`, `objects`, `queues` syntax, when `rail deploy` executes, then deployment proceeds identically with zero regressions.

## Tests required

- [x] Unit — `tests/unit/cli_deploy_test.ts` verifying dry-run packaging and artifact metadata generation for functions using conceptual capability syntax.
- [x] Integration — Mock deployment flow with `DeploymentService` asserting that normalized permissions reach the control plane intact.
- [x] Security — Verify that secret redaction (PLAT-15) and deployment validation gates remain intact when conceptual aliases are used.

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

The Control Plane deployment API expects canonical manifest permissions produced by `packageFunctionArtifact` (T-0918).
