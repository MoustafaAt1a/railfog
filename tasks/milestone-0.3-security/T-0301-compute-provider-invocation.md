# T-0301 — ComputeProvider InvocationRequest interface extension

Status: Done
Milestone: 0.3 Security
Depends on: T-0201
Blocks: T-0310, T-0311, T-0312, T-0313

## Spec references

`PLAT-4` `PLAT-16`

## Scope

**In scope:**
- `primitives/compute/compute-provider.ts`: define the `InvocationRequest` interface per ADR-0001 (`requestId`, `method`, `url`, `headers`, `body`).
- Extend `ComputeProvider.run` and `IsolationProvider.run` to accept an optional `invocation?: InvocationRequest` parameter.
- Ensure 100% backward compatibility: when `invocation` is omitted, providers default to an empty GET request.
- Update unit tests in `primitives/compute/compute-provider_test.ts` to cover `InvocationRequest` assignment and default behavior.

**Out of scope:**
- Concrete isolation provider implementations (`LocalIsolation`, `ProcessIsolation`, `GVisorIsolation` — T-0310, T-0311, T-0312).
- Inter-process communication protocol or serialization wire format (T-0311).
- Modifying `Artifact` or `Limits` definitions.

## Interface to implement

```typescript
export interface InvocationRequest {
  requestId: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

export interface ComputeProvider {
  run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult>;
}

export interface IsolationProvider {
  run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult>;
}
```

## Acceptance criteria (Given/When/Then)

1. Given an `InvocationRequest` containing `requestId`, `method`, `url`, `headers`, and `body`, when passed to `ComputeProvider.run(artifact, limits, invocation)`, then the provider signature accepts the request with zero type errors.
2. Given a call to `IsolationProvider.run(artifact, limits)` where `invocation` is omitted, when checked against existing code, then it satisfies static type checking and defaults safely to an empty GET request.
3. Given `InvocationRequest`, when inspected, then it contains no host-level filesystem paths, process handles, or ambient credentials, preventing ambient authority leaks across the provider boundary.

## Tests required

- [x] Unit — verify `ComputeProvider` and `IsolationProvider` interfaces accept `InvocationRequest` and remain backward-compatible when omitted
- [x] Integration — none (interface definition only)
- [x] Security — verify interface signatures expose no ambient process handles, host paths, or credential objects across the isolation boundary (PLAT-4, PLAT-16)

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

```
$ deno check primitives/compute/compute-provider.ts primitives/compute/compute-provider_test.ts
Check primitives/compute/compute-provider.ts
Check primitives/compute/compute-provider_test.ts
EXIT:0

$ deno test primitives/compute/
running 11 tests from ./primitives/compute/compute-provider_test.ts
AC1 & AC2: ComputeProvider conforming mock implementation and Limits validation ... ok (41ms)
AC1: IsolationProvider conforming mock implementation ... ok (424µs)
Security: Interface signatures expose no direct host filesystem, process, or ambient credentials (PLAT-4, PLAT-16) ... ok (221µs)
Adversarial PLAT-4/PLAT-16: Artifact.code rejects host filesystem paths, file descriptors, and OS handles ... ok (117µs)
Adversarial PLAT-4/FN-5: Limits and Artifact reject ambient process, cwd, env, and credentials ... ok (130µs)
Adversarial PLAT-4/PLAT-16: ExecutionResult bounds HTTP response without leaking host process handles or signals ... ok (93µs)
Adversarial PLAT-16: Provider signatures strictly reject ambient parameter smuggling ... ok (93µs)
Adversarial PLAT-4: Artifact stream consumption enforces pure in-memory chunking without host FS dependency ... ok (1ms)
T-0301 AC1: InvocationRequest interface structure and ComputeProvider / IsolationProvider acceptance ... ok (326µs)
T-0301 AC2: Backward compatibility when invocation is omitted, defaulting safely to empty GET per ADR-0001 ... ok (351µs)
T-0301 AC3 & Security: InvocationRequest strictly rejects host paths, process handles, ambient credentials, env, tokens, and sockets (PLAT-4, PLAT-16) ... ok (170µs)

ok | 11 passed | 0 failed (56ms)
EXIT:0

$ deno task test
ok | 303 passed | 0 failed (46s)
EXIT:0

$ deno task check
Task check deno check **/*.ts
...
Checked 61 files
EXIT:0

$ deno lint
Checked 61 files
EXIT:0

$ deno fmt --check
Checked 62 files
EXIT:0
```

## Assumptions made

- Default HTTP method when omitted is GET, matching ADR-0001.
- `InvocationRequest` contains no ambient authority, host filesystem handles, OS process references, or host environment maps, preserving the isolation boundary specified in PLAT-4 and PLAT-16.
