# T-0802 — Add Web Login Callback Authorization Flow

Status: Not started
Milestone: 0.8 Developer Experience & UX Polish
Depends on: none
Blocks: T-0803

## Spec references

`PLAT-1`, `PLAT-15`

## Scope

**In scope**:
- `apps/api/login-page.ts` — Update the HTML template and client-side logic in the control plane's `/login` route to support `callback` and `state` query parameters.
- Incorporates mandatory security controls:
  - Strict loopback URL validation: enforces `http:`, empty username/password, hostname strictly `127.0.0.1` or `localhost`, unprivileged port (`1024 <= port <= 65535`), explicit blacklist of sensitive internal ports (`5432`, `6379`, `8081`), pathname strictly `/callback`, zero pre-existing search queries or hashes.
  - Reflected XSS defense: strictly sanitizes `state` (`^[a-zA-Z0-9_-]+$`) and escapes callback URL before DOM injection.
  - Drive-by token defense: requires an explicit user click on an "Authorize CLI" button (no silent zero-click automatic redirect).
  - History protection: browser navigation uses `window.location.replace(...)` to prevent token leakage in back-button browser history.
- `tests/unit/apps_control_server_login_test.ts` — Tests asserting safe callback parameter reflection, open-redirect prevention, and callback query string construction.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- CLI-side loopback listener (`cli/callback-server.ts` — covered in `T-0801`).
- Generating the API key record (`packages/auth/store.ts` — completed in `T-0753`).
- Changing backend authentication models.

## Interface to implement

```typescript
export interface LoginPageOptions {
  callbackUrl?: string; // Validated loopback URL, e.g. http://127.0.0.1:54321/callback
  state?: string;       // Nonce string to pass through to the callback
  orgId?: string;
}

export function renderLoginPage(options?: LoginPageOptions): string;
export function isValidCallbackUrl(urlStr: string): boolean;
```

## Acceptance criteria (Given/When/Then)

1. Given a user accesses `GET /login?callback=http://127.0.0.1:49152/callback&state=nonce_123`, when rendered, then `isValidCallbackUrl` validates the loopback host and unprivileged port, displays an "Authorize CLI" action button, and sanitizes embedded parameters against reflected XSS.
2. Given a malicious user accesses `GET /login?callback=https://evil.com/steal` or `http://127.0.0.1:password@evil.com` or `http://127.0.0.1:6379/callback`, when evaluated, then `isValidCallbackUrl` returns `false`, the open redirect is rejected, and the page renders in safe fallback mode without redirecting.
3. Given an authorized token generation in callback mode, when the user clicks "Authorize CLI", then the browser navigates via `window.location.replace()` to `${callback}?token=${encodeURIComponent(rawToken)}&state=${encodeURIComponent(state)}`.
4. Given no callback parameters are provided in the URL, then the page renders the standard 1-click copy-to-clipboard view with zero behavioral regressions.

## Tests required

- [ ] Unit — `tests/unit/apps_control_server_login_test.ts`: Verify `isValidCallbackUrl` rejects remote hosts, userinfo spoofs, sensitive ports (5432, 6379, 8081), and permits safe local loopbacks; verify rendered HTML embeds callback and state parameters safely without XSS.
- [ ] Security — Verify open-redirect defense, sensitive port blacklisting, and reflected XSS neutralization (`PLAT-15`).

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-15`)
- [ ] Spec-anchor comments present at each RailFog-specific decision point
- [ ] Unit tests written first (red), then implementation (green)
- [ ] `deno check` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all required tests passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Reviewer pass complete; security-auditor pass complete if triggered
- [ ] Nothing outside "In scope" touched

## Assumptions made

- Callback URLs are strictly restricted to unprivileged HTTP loopback addresses to prevent open-redirect and SSRF vulnerabilities.
