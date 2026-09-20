# T-0754 — Implement API Key Authentication Middleware for Control and Runtime Servers

Status: Not started
Milestone: 0.75 Backing Services and Auth
Depends on: T-0753
Blocks: T-0755

## Spec references

`PLAT-1`, `PLAT-6`, `PLAT-12`, `PLAT-14`, `PLAT-15`

## Scope

**In scope**:
- `packages/auth/middleware.ts` — Standardized HTTP authentication middleware for daemon servers.
- `packages/auth/mod.ts` — Re-export middleware components.
- `tests/unit/packages_auth_middleware_test.ts` — Unit tests covering bearer extraction, header validation, unauthenticated route bypass (`/healthz`), and canonical error generation.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Modifying `packages/auth/store.ts` implementation (covered in `T-0753`).
- Editing server daemon processes directly (`apps/api/control-server.ts` — covered in `T-0755`).
- Deploy-time capability injection verification (covered in `PLAT-6` runtime dispatch).

## Interface to implement

```typescript
import type { IdentityContext } from "./verifier.ts";
import type { ApiKeyStore } from "./store.ts";

export interface AuthMiddlewareOptions {
  apiKeyStore?: ApiKeyStore;
  staticTokens?: Record<string, IdentityContext>; // Fallback or bootstrap static keys
  allowAnonymousPaths?: string[];                // Default: ["/healthz"]
  requireMatchingProject?: boolean;             // Ensure token has access to requested projectId
}

export type AuthResult =
  | { ok: true; context: IdentityContext }
  | { ok: false; response: Response };

export function createAuthMiddleware(
  options: AuthMiddlewareOptions,
): (req: Request, requestId: string) => Promise<AuthResult>;
```

## Acceptance criteria (Given/When/Then)

1. Given an unauthenticated request to an allowed anonymous path (e.g. `/healthz`), when the auth middleware runs, then it returns `{ ok: true, context: { callerId: "anonymous", orgId: "", callerType: "anonymous" } }` without checking keys (`PLAT-1`).
2. Given a request with valid `Authorization: Bearer <token>` or `x-api-key: <token>`, when evaluated against the `ApiKeyStore`, then it resolves the caller's `IdentityContext` and returns `{ ok: true, context }` (`PLAT-6`).
3. Given a request with missing credentials to a protected path (e.g. `/v1/projects/my-proj/deploy`), when the middleware runs, then it returns `{ ok: false, response }` with status `403 FORBIDDEN` and error code `PERMISSION_DENIED` matching `PLAT-12`.
4. Given a request with an invalid or revoked token, when evaluated, then it returns `{ ok: false, response }` with status `403 FORBIDDEN` and error code `PERMISSION_DENIED` matching `PLAT-12`, propagating `x-request-id` (`PLAT-14`).
5. Given any authentication failure response, when rendered to JSON, then no secret or authorization token is included in the message body or headers (`PLAT-15`).

## Tests required

- [ ] Unit — `tests/unit/packages_auth_middleware_test.ts`: Health check bypass, Bearer header parsing, `x-api-key` header parsing, project scope matching, and canonical PLAT-12 error response format.
- [ ] Security — Verify `PLAT-15` secret redaction on invalid auth attempts.

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-6`, `PLAT-12`, `PLAT-14`, `PLAT-15`)
- [ ] Spec-anchor comments present at each RailFog-specific decision point
- [ ] Unit tests written first (red), then implementation (green)
- [ ] `deno check` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all required tests passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Security-auditor pass complete for PLAT-6 and PLAT-15 compliance
- [ ] Nothing outside "In scope" touched

## Assumptions made

- Protected endpoints accept tokens via either `Authorization: Bearer <token>` or `x-api-key: <token>`.
- Public health probes (`/healthz`) are exempted from token authentication to support orchestrator liveness checks.
