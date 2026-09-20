# T-0756 — Implement Control Plane Web Login Page and API Key Issuance UI

Status: Done
Milestone: 0.75 Backing Services and Auth
Depends on: T-0753, T-0754, T-0755
Blocks: T-0757, T-0758

## Spec references

`PLAT-1`, `PLAT-6`, `PLAT-12`, `PLAT-14`, `PLAT-15`

## Scope

**In scope**:
- `apps/api/login-page.ts` — Minimalist, responsive web UI served at `GET /login` displaying login form, instant API key generation, and single-click copy button.
- `apps/api/control-server.ts` — Register `GET /login`, `POST /v1/auth/keys`, and `GET /v1/auth/verify` routes.
- `tests/unit/apps_control_server_login_test.ts` — Unit tests verifying HTML response, key issuance endpoint, and token verification endpoint.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- CLI client command implementation (`cli/login.ts` — covered in `T-0757`).
- Third-party OAuth or external identity providers (`PLAT-20`).
- Customer function invocation handling (`PLAT-1`).

## Interface to implement

```typescript
import type { ApiKeyStore, CreateApiKeyResult } from "../../packages/auth/store.ts";
import type { IdentityContext } from "../../packages/auth/verifier.ts";

export interface LoginPageOptions {
  serviceName: string;
  defaultOrgId?: string;
}

export function renderLoginPageHtml(options?: LoginPageOptions): string;

export interface AuthVerifyResult {
  ok: boolean;
  identity?: IdentityContext;
  requestId: string;
}
```

## Acceptance criteria (Given/When/Then)

1. Given a web browser request to `GET /login`, when received by `railfog-control`, then it returns an `HTML` page with `200 OK` featuring a modern, dark-mode terminal aesthetic, account input, "Generate API Key" button, and copy-to-clipboard button.
2. Given a user on the login page submitting credentials or requesting a new key, when `POST /v1/auth/keys` is triggered, then a fresh `rfk_...` API key is generated via `ApiKeyStore`, stored persistently, and returned to the browser with instructions to copy and paste into the CLI (`PLAT-15`).
3. Given a request to `GET /v1/auth/verify` with `Authorization: Bearer <token>`, when the token is valid, then it returns `200 OK` with JSON `{ ok: true, identity: { callerId, orgId, callerType }, request_id }` (`PLAT-12`, `PLAT-14`).
4. Given a request to `GET /v1/auth/verify` with an invalid or expired token, then it returns `403 FORBIDDEN` with canonical error `PERMISSION_DENIED` (`PLAT-12`).
5. Given any HTML or JSON response, then raw secret hashes or system credentials are never exposed (`PLAT-15`).

## Tests required

- [x] Unit — `tests/unit/apps_control_server_login_test.ts`: Verify `GET /login` HTML generation, `POST /v1/auth/keys` API key creation, and `GET /v1/auth/verify` token validation.
- [x] Integration — HTTP browser fetch simulating login and token issuance roundtrip.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-6`, `PLAT-12`, `PLAT-14`, `PLAT-15`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

## Assumptions made

- The web UI is self-contained with inline CSS and zero external CDN script dependencies.
