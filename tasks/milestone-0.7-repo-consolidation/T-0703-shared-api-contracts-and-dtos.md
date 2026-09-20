# T-0703 — Shared API Contracts and DTOs

Status: Complete
Milestone: 0.7 Repo Consolidation
Depends on: T-0701
Blocks: T-0707, T-0708, T-0709, T-0710

## Spec references

`PLAT-1`, `PLAT-12`, `PLAT-14`, `PLAT-19`

## Scope

**In scope**:
- `packages/api/routes.ts`: Standard API endpoint path constants (`/v1/projects`, `/v1/functions`, `/v1/deployments`, `/v1/invocations`, `/healthz`) shared between control plane and data plane per `PLAT-1`.
- `packages/api/types.ts`: Strongly typed API request/response DTOs, including ULID request identifier tracking (`request_id` per `PLAT-14`), deployment manifests, invocation payloads, and standard error responses (`RailFogErrorResponse` matching the exhaustive code table in `PLAT-12`).
- `packages/api/mod.ts`: Barrel export for shared routes, DTOs, and error response helper.
- Remove redundant placeholder `packages/api/.gitkeep`.

**Out of scope**:
- HTTP server listening, socket handling, or middleware execution (belongs in `apps/api` or `apps/gateway`).
- Adding unapproved error codes outside the `PLAT-12` specification table.

## Interface to implement

```typescript
export const API_ROUTES = {
  HEALTH: "/healthz",
  PROJECTS: "/v1/projects",
  FUNCTIONS: "/v1/functions",
  DEPLOYMENTS: "/v1/deployments",
  INVOCATIONS: "/v1/invocations",
} as const;

export type RailFogErrorCode =
  | "RESOURCE_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "CALL_DEPTH_EXCEEDED"
  | "TIMEOUT"
  | "PAYLOAD_TOO_LARGE"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "INTERNAL";

export interface RailFogErrorResponse {
  error: {
    code: RailFogErrorCode;
    message: string;
    request_id: string; // ULID (PLAT-14)
    details?: unknown;
    retry_after?: number; // Present on RATE_LIMITED (PLAT-9, PLAT-12)
  };
}

export interface DeploymentManifestDto {
  projectId: string;
  revision: string; // ULID
  functions: Record<string, {
    entrypoint: string;
    integrity: string;
    limits: { cpuMs: number; timeoutMs: number; memoryMb: number };
  }>;
}

export interface InvocationRequestDto {
  requestId: string;
  projectId: string;
  functionName: string;
  payload?: unknown;
}

export interface InvocationResponseDto {
  requestId: string;
  statusCode: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

export function createErrorResponse(
  code: RailFogErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
  retryAfter?: number,
): RailFogErrorResponse;
```

## Acceptance criteria (Given/When/Then)

1. Given an error condition, when `createErrorResponse` is invoked, then it produces a `RailFogErrorResponse` containing a 26-character Crockford Base32 ULID `request_id` (`PLAT-14`) and a valid `PLAT-12` machine-readable error code.
2. Given a `RATE_LIMITED` error condition with a retry delay, when `createErrorResponse` is invoked, then the returned error response includes the specified `retry_after` parameter.
3. Given API route constants in `API_ROUTES`, when referenced across packages, then endpoint paths for control plane and health routes are immutably defined and consistent.
4. Given `RailFogErrorCode` union type, when compared with `docs/contracts/platform.contract.md` PLAT-12, then it contains exactly the 10 exhaustive spec error codes with no extra codes.

## Tests required

- [x] Unit — `tests/unit/packages_api_test.ts`: Validate route constants, error DTO formatting with ULID validation, PLAT-12 exhaustive code enum matching, and serialization.

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
