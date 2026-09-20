# T-0704 — Authentication and Identity Context

Status: Complete
Milestone: 0.7 Repo Consolidation
Depends on: T-0701
Blocks: T-0707, T-0708, T-0709, T-0710

## Spec references

`PLAT-6`, `PLAT-9`, `PLAT-15`, `PLAT-19`

## Scope

**In scope**:
- `packages/auth/token.ts`: Cryptographic SHA-256 token hashing using standard Web Crypto (`crypto.subtle.digest("SHA-256", ...)`) to derive token hashes for rate limiting keys (`PLAT-9`) without storing or exposing raw secrets.
- `packages/auth/verifier.ts`: Authentication verifier extracting caller identity context (`IdentityContext`) from `Authorization: Bearer <token>` headers, supporting token lookup and project-level association while enforcing zero raw token leakage into logs or error payloads (`PLAT-15`).
- `packages/auth/mod.ts`: Barrel export for authentication types, verifier, and token hashing functions.
- Remove redundant placeholder `packages/auth/.gitkeep`.

**Out of scope**:
- External third-party OAuth providers, OpenID Connect, or SAML flows (explicitly banned per `PLAT-20`).
- User database schema management.

## Interface to implement

```typescript
export type CallerType = "anonymous" | "token" | "project" | "internal";

export interface IdentityContext {
  callerId: string;
  orgId: string;
  projectId?: string;
  tokenHash?: string;
  callerType: CallerType;
}

export interface AuthRecord {
  tokenHash: string;
  orgId: string;
  projectId?: string;
  name: string;
}

export function hashApiToken(rawToken: string): Promise<string>;

export function extractBearerToken(authHeader: string | null): string | null;

export function deriveRateLimitKey(
  scope: "ip" | "identity" | "project",
  context: IdentityContext,
  clientIp?: string,
): string;

export function verifyApiToken(
  token: string,
  records: Record<string, AuthRecord>,
): IdentityContext | null;

export function sanitizeIdentityForLogging(
  context: IdentityContext,
): Omit<IdentityContext, "tokenHash"> & { tokenHashRedacted: boolean };
```

## Acceptance criteria (Given/When/Then)

1. Given a raw API token, when `hashApiToken` is invoked, then it produces a deterministic 64-character lowercase SHA-256 hex digest, preventing raw secrets from persisting in rate limit buckets or caches (`PLAT-9`, `PLAT-15`).
2. Given a valid bearer token matching a registered `AuthRecord`, when `verifyApiToken` is called, then it returns an `IdentityContext` with `callerType: "token"` and populated `orgId` and `projectId`.
3. Given an invalid or missing token, when `verifyApiToken` is called, then it returns `null` without throwing unhandled exceptions.
4. Given an `IdentityContext` passed to `sanitizeIdentityForLogging`, when executed, then the raw token hash is redacted and secrets cannot leak into structured logs (`PLAT-15`).

## Tests required

- [x] Unit — `tests/unit/packages_auth_test.ts`: Test SHA-256 token hashing, bearer token header extraction, identity lookup, and rate limit key derivation.
- [x] Security — `tests/security/auth_zero_leakage_test.ts`: Verify raw tokens and sensitive auth hashes never leak in stringified identity context, error returns, or diagnostic outputs (`PLAT-15`).

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
