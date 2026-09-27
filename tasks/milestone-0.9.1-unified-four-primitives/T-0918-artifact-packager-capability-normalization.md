# T-0918 — Normalize Capability Aliases in Artifact Packager

Status: Done
Milestone: 0.9.1 Unified Four-Primitives & SDK Specification
Depends on: T-0911, T-0914
Blocks: T-0917, T-0920

## Spec references

`PLAT-3`, `PLAT-6`, `OBJ-4`, `FN-5`, `CONCEPT-2`, `CONCEPT-6`

## Scope

**In scope**:
- Modify `packages/core/artifact/packager.ts`:
  - Extend packaging options permissions type to accept `state`, `data`, and `signal` capability aliases alongside `kv`, `objects`, and `queues`.
  - Normalize conceptual aliases (`state` → `kv`, `data` → `objects`, `signal` → `queues`) during manifest generation.
  - Enforce strict mutual exclusivity per PLAT-6: reject invocations declaring both `kv` and `state`, `objects` and `data`, or `queues` and `signal` with a `ValidationFailedError` (`VALIDATION_FAILED`).
  - Sanitize declared permission identifier strings against path traversal (`../`, `/`, `\`, null bytes) per PLAT-6 and PLAT-7.
  - Preserve canonical manifest format (`kv`, `objects`, `queues`, `secrets`, `network`) in `Manifest.permissions` so runtime and deployment protocol remain 100% backward compatible without changes.
- Update `tests/unit/packages_core_artifact_packager_test.ts` to verify packaging with conceptual aliases, mutual exclusivity enforcement, and traversal rejection.

**Out of scope**:
- Modifying the deployment upload or orchestrator service (`apps/api/deployment-service.ts`).
- Modifying CLI deploy wrapper (handled in T-0920).
- Modifying the runtime isolate bootstrap or execution daemon (`apps/runtime`).

## Interface to implement

```typescript
export interface PackagePermissionsOptions {
  kv?: string[];
  state?: string[];
  objects?: string[];
  data?: string[];
  queues?: string[];
  signal?: string[];
  secrets?: string[];
  network?: string[];
}

export async function packageFunctionArtifact(
  entrypoint: string,
  codeBytes: Uint8Array,
  options?: {
    permissions?: PackagePermissionsOptions;
    limits?: { cpu_ms?: number; timeout_ms?: number; memory_mb?: number };
    lockfileBytes?: Uint8Array;
  },
): Promise<PackagedArtifact>;
```

## Acceptance criteria (Given/When/Then)

1. Given options declaring `permissions: { state: ["sessions"] }`, when `packageFunctionArtifact` packages the code, then the resulting `manifest.permissions.kv` equals `["sessions"]` and `manifest.permissions` contains no raw `state` field.
2. Given options declaring `permissions: { data: ["uploads"], signal: ["jobs"] }`, when `packageFunctionArtifact` packages the code, then `manifest.permissions.objects` equals `["uploads"]` and `manifest.permissions.queues` equals `["jobs"]`.
3. Given options declaring both `kv: ["sessions"]` and `state: ["sessions"]` (or conflicting names), when `packageFunctionArtifact` runs, then it throws `ValidationFailedError` with message citing PLAT-6 mutual exclusivity.
4. Given options declaring a permission identifier containing path traversal (e.g. `state: ["../escape"]` or `data: ["a/b"]`), when `packageFunctionArtifact` runs, then it throws `ValidationFailedError` with message citing PLAT-7 identifier security.
5. Given options declaring existing `kv`, `objects`, and `queues`, when `packageFunctionArtifact` runs, then existing behavior is 100% preserved.

## Tests required

- [x] Unit — `tests/unit/packages_core_artifact_packager_test.ts` verifying alias normalization into canonical manifest permissions and backward compatibility.
- [x] Integration — Packaging a function with conceptual permissions and verifying SHA-256 integrity hash calculation.
- [x] Security — Adversarial test ensuring declaring both alias and primitive throws `VALIDATION_FAILED` (PLAT-6) and traversal strings are rejected (PLAT-7).

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

The physical manifest JSON emitted into deployment artifacts continues to use canonical infrastructure keys (`kv`, `objects`, `queues`) so control plane and runtime loaders require no format migrations.
