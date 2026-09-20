# T-0202 — Deployment artifact packaging

Status: Done
Milestone: 0.2 Cloud Prototype
Depends on: T-0101, T-0102, T-0103
Blocks: T-0207, T-0210

## Spec references

`PLAT-3` `OBJ-4` `FN-5`

## Scope

**In scope:**
- `packages/core/artifact/packager.ts`: build a self-contained deployment artifact bundle from source code bytes and function configuration.
- Content-addressing calculation per `docs/contracts/objects.contract.md` OBJ-4:
  `artifact_id = "sha256:" + hex(sha256(bytes))` and
  `integrity = "sha256-" + base64(sha256(bytes))`.
- Manifest generation conforming to `docs/contracts/platform.contract.md` PLAT-3:
  `runtime: "railfog-deno"`, `runtimeVersion: "1.0"`, `entrypoint`, `integrity`, `permissions`, `limits`, `dependencies`.
- Defaults enforcement for limits per `docs/contracts/functions.contract.md` FN-5:
  `cpu_ms: 200`, `timeout_ms: 30000`, `memory_mb: 128`.
- Validation errors using `packages/errors` taxonomy (`VALIDATION_FAILED`) on invalid inputs.

**Out of scope:**
- Storing artifact into ObjectProvider (handled by T-0207).
- Cryptographic private-key signature generation (Milestone 0.3).
- MicroVM execution of the packaged artifact (Milestone 0.3).

## Interface to implement

```typescript
export interface Manifest {
  runtime: "railfog-deno";
  runtimeVersion: string;
  entrypoint: string;
  integrity: string;
  permissions: {
    kv?: string[];
    objects?: string[];
    queues?: string[];
  };
  limits: {
    cpu_ms: number;
    timeout_ms: number;
    memory_mb: number;
  };
  dependencies: {
    lockfile?: string;
  };
}

export interface PackagedArtifact {
  id: string; // sha256:... (OBJ-4)
  integrity: string; // sha256-... (OBJ-4)
  bytes: Uint8Array;
  manifest: Manifest;
}

export function packageFunctionArtifact(
  entrypoint: string,
  codeBytes: Uint8Array,
  options?: {
    permissions?: { kv?: string[]; objects?: string[]; queues?: string[] };
    limits?: { cpu_ms?: number; timeout_ms?: number; memory_mb?: number };
    lockfileBytes?: Uint8Array;
  },
): Promise<PackagedArtifact>;
```

## Acceptance criteria

1. Given valid function entrypoint and code bytes, when `packageFunctionArtifact` is executed, then `id` matches `sha256:[0-9a-f]{64}` and `integrity` matches `sha256-[A-Za-z0-9+/=]+` (OBJ-4).
2. Given omitted `limits` in options, when packaged, then manifest limits default to `cpu_ms: 200`, `timeout_ms: 30000`, and `memory_mb: 128` per FN-5.
3. Given empty code bytes or whitespace entrypoint, when `packageFunctionArtifact` is invoked, then it throws `VALIDATION_FAILED` (PLAT-12).
4. Given provided `lockfileBytes`, when packaged, then `dependencies.lockfile` contains the SHA-256 hash of the lockfile per PLAT-3.

## Tests required

- [x] Unit — OBJ-4 content addressing calculation, PLAT-3 manifest JSON schema verification, default limits injection
- [x] Integration — package a representative starter function fixture and verify uncorrupted byte extraction
- [x] Security — none (no isolation or credentials handled in this module)

## Definition of Done

- [x] Implementation matches cited clause IDs (`PLAT-3`, `OBJ-4`, `FN-5`)
- [x] Spec-anchor comments present at content addressing and manifest construction sites
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched

```
$ deno check packages/core/artifact/packager.ts packages/core/artifact/packager_test.ts
Check packages/core/artifact/packager.ts
Check packages/core/artifact/packager_test.ts
EXIT:0

$ deno test --allow-read packages/core/artifact/
running 4 tests from ./packages/core/artifact/packager_test.ts
Unit: AC1 & AC2 - packageFunctionArtifact calculates OBJ-4 hashes and injects FN-5 default limits ... ok (1ms)
Unit: Custom permissions, custom limits, and AC4 lockfile dependencies ... ok (770µs)
Unit: AC3 - Validation errors for empty code or whitespace entrypoint ... ok (2ms)
Integration: Package starter function fixture and verify uncorrupted byte extraction ... ok (2ms)

ok | 4 passed | 0 failed (18ms)
EXIT:0

$ deno task test
Task test deno test --allow-read --allow-write --allow-net --allow-run
...
ok | 89 passed | 0 failed (14s)
EXIT:0

$ deno task check
Task check deno check **/*.ts
EXIT:0

$ deno lint
Checked 36 files
EXIT:0

$ deno fmt --check
Checked 37 files
EXIT:0
```

## Assumptions made

None. Implementation strictly implements PLAT-3 manifest shape, OBJ-4 content-addressing SRI hash format, and FN-5 MVP resource limit defaults.
