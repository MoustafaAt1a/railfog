# T-0707 — Runtime API Execution Boundary

Status: Complete
Milestone: 0.7 Repo Consolidation
Depends on: T-0701, T-0703, T-0704, T-0705
Blocks: T-0708, T-0709, T-0710

## Spec references

`PLAT-1`, `PLAT-4`, `PLAT-19`

## Scope

**In scope**:
- `runtime/api/dispatch.ts`: Layer 2 Runtime API execution boundary dispatch controller coordinating live request handling:
  - Ingress request validation and ULID `request_id` extraction or generation (`PLAT-14`).
  - Caller identity extraction and validation via `@railfog/auth`.
  - Call depth inspection and enforcement (`X-RailFog-Call-Depth`, default limit 8 per `FN-7`).
  - Invocation dispatch to the registered `ComputeProvider` with enforced resource limits (`FN-5`).
  - Response formatting and standard error mapping (`PLAT-12`).
- `runtime/api/mod.ts`: Barrel export for the runtime API execution boundary.
- Remove redundant placeholder `runtime/api/.gitkeep`.

**Out of scope**:
- Ingress gateway reverse proxy routing, rate limiting, and TLS termination (belongs in `apps/gateway`).
- Snapshot polling or background cache invalidation (handled in `runtime/snapshot/`).

## Interface to implement

```typescript
import type { ComputeProvider, Artifact, Limits } from "@railfog/providers/compute";
import type { IdentityContext } from "@railfog/auth";

export interface RouteTarget {
  projectId: string;
  functionName: string;
  revision: string;
  artifact: Artifact;
  limits: Limits;
}

export interface RuntimeDispatcherOptions {
  computeProvider: ComputeProvider;
  resolveRoute: (url: URL) => RouteTarget | null;
  authenticateCaller?: (req: Request) => Promise<IdentityContext | null>;
  callDepthMax?: number;
}

export class RuntimeDispatcher {
  constructor(options: RuntimeDispatcherOptions);

  handleRequest(request: Request): Promise<Response>;
}
```

## Acceptance criteria (Given/When/Then)

1. Given an incoming HTTP `Request`, when `handleRequest` is called on `RuntimeDispatcher`, then it resolves the target route, attaches a ULID `request_id` (`PLAT-14`), and invokes the target function inside the isolation boundary via `ComputeProvider` (`PLAT-1`, `PLAT-4`).
2. Given a request to an unknown or unmatched URL path, when `handleRequest` is called, then it returns a `404 RESOURCE_NOT_FOUND` response formatted according to `PLAT-12`.
3. Given a request with header `X-RailFog-Call-Depth` equal to or exceeding `callDepthMax` (default 8), when evaluated, then it rejects immediately with status `429` and machine-readable code `CALL_DEPTH_EXCEEDED` (`FN-7`, `PLAT-12`).
4. Given successful isolate execution, when returning the response to the caller, then it propagates `request_id` and the incremented `X-RailFog-Call-Depth` header.

## Tests required

- [x] Unit — `tests/unit/runtime_api_dispatch_test.ts`: Test route dispatching, ULID propagation, 404 error formatting, and call-depth guard enforcement.
- [x] Security — `tests/security/runtime_api_boundary_test.ts`: Validate that untrusted request parameters cannot escape the dispatch boundary into host memory or bypass capability constraints (`PLAT-4`).

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
