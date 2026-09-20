# T-0201 — ComputeProvider interface definition

Status: Done
Milestone: 0.2 Cloud Prototype
Depends on: T-0101
Blocks: T-0211

## Spec references

`PLAT-4` `PLAT-16` `FN-5`

## Scope

**In scope:**
- `primitives/compute/compute-provider.ts`: define the `ComputeProvider` and `IsolationProvider` interfaces per `docs/contracts/platform.contract.md` PLAT-16 and PLAT-4.
- Define `Limits` interface matching the `docs/contracts/functions.contract.md` FN-5 limits table (`cpuMs`, `timeoutMs`, `memoryMb`, `concurrency`).
- Define `Artifact` interface matching the deployment artifact structure (`id`, `integrity`, `entrypoint`, `code`).
- Define `ExecutionResult` interface (`statusCode`, `headers`, `body`, `cpuTimeMs`, `wallClockMs`).

**Out of scope:**
- Any concrete compute or microVM isolation implementation (DenoProvider, GVisorIsolation, FirecrackerIsolation — Milestone 0.3).
- Artifact packing and bundling logic (T-0202).
- Dynamic limit killing or cgroup enforcement (0.3).

## Interface to implement

```typescript
export interface Limits {
  cpuMs: number;
  timeoutMs: number;
  memoryMb: number;
  concurrency?: number;
}

export interface Artifact {
  id: string; // sha256:... (OBJ-4)
  integrity: string; // sha256-... (OBJ-4)
  entrypoint: string;
  code: Uint8Array | ReadableStream<Uint8Array>;
}

export interface ExecutionResult {
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
  cpuTimeMs: number;
  wallClockMs: number;
}

export interface ComputeProvider {
  run(artifact: Artifact, limits: Limits): Promise<ExecutionResult>;
}

export interface IsolationProvider {
  run(artifact: Artifact, limits: Limits): Promise<ExecutionResult>;
}
```

## Acceptance criteria

1. Given the `ComputeProvider` and `IsolationProvider` interfaces, when a conforming mock implements `run(artifact, limits)`, then `deno check` succeeds with zero type errors.
2. Given a `Limits` object instantiated with the MVP defaults from FN-5 (`cpuMs: 200`, `timeoutMs: 30000`, `memoryMb: 128`, `concurrency: 50`), then it passes static type checking.
3. Given the `Artifact` interface, when constructed with `id` (`sha256:...`) and `integrity` (`sha256-...`) per OBJ-4, then it satisfies the interface contract.

## Tests required

- [x] Unit — type assignment and interface validation test
- [x] Integration — none (interface definition only)
- [x] Security — verify interface signatures expose no direct host filesystem, process, or ambient credential objects (PLAT-4, PLAT-16)

## Definition of Done

- [x] Implementation matches cited clause IDs (`PLAT-4`, `PLAT-16`, `FN-5`)
- [x] Spec-anchor comments present on each interface and type definition
- [x] Interfaces live under `primitives/compute/` per repo structure (PLAT-19)
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches PLAT-4/PLAT-16)
- [x] Nothing outside "In scope" touched

```
$ deno check primitives/compute/compute-provider.ts primitives/compute/compute-provider_test.ts
Check primitives/compute/compute-provider.ts
Check primitives/compute/compute-provider_test.ts
EXIT:0

$ deno test primitives/compute/
running 8 tests from ./primitives/compute/compute-provider_test.ts
AC1 & AC2: ComputeProvider conforming mock implementation and Limits validation ... ok (33ms)
AC1: IsolationProvider conforming mock implementation ... ok (178µs)
Security: Interface signatures expose no direct host filesystem, process, or ambient credentials (PLAT-4, PLAT-16) ... ok (141µs)
Adversarial PLAT-4/PLAT-16: Artifact.code rejects host filesystem paths, file descriptors, and OS handles ... ok (51µs)
Adversarial PLAT-4/FN-5: Limits and Artifact reject ambient process, cwd, env, and credentials ... ok (84µs)
Adversarial PLAT-4/PLAT-16: ExecutionResult bounds HTTP response without leaking host process handles or signals ... ok (78µs)
Adversarial PLAT-16: Provider signatures strictly reject ambient parameter smuggling ... ok (71µs)
Adversarial PLAT-4: Artifact stream consumption enforces pure in-memory chunking without host FS dependency ... ok (1ms)

ok | 8 passed | 0 failed (48ms)
EXIT:0

$ deno task test
Task test deno test --allow-read --allow-write --allow-net --allow-run
...
ok | 98 passed | 0 failed (14s)
EXIT:0

$ deno task check
Task check deno check **/*.ts
EXIT:0

$ deno lint
Checked 38 files
EXIT:0

$ deno fmt --check
Checked 39 files
EXIT:0
```

## Assumptions made

None. All types and signatures are strictly mapped to contracts `PLAT-4`, `PLAT-16`, `FN-5`, and `OBJ-4`.
