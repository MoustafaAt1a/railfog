# T-0803 — Integrate Zero-Copy Callback Flow into CLI Login

Status: Not started
Milestone: 0.8 Developer Experience & UX Polish
Depends on: T-0801, T-0802
Blocks: T-0810

## Spec references

`PLAT-1`, `PLAT-15`, `PLAT-17`

## Scope

**In scope**:
- `cli/login.ts` — Wire `startCallbackServer()` into `runLogin()`:
  - Starts local ephemeral listener.
  - Constructs authorization URL with validated loopback callback and cryptographic state nonce.
  - Opens default browser.
  - Awaits callback redirect, verifies token via `GET /v1/auth/verify`, and persists credentials to `~/.railfog/config.json` with restricted permissions (0600 on POSIX).
  - Guarantees listener closure on completion, error, `--manual` flag, or timeout fallback.
  - Suppresses raw token printing in terminal logs (`PLAT-15`).
- `tests/unit/cli_login_test.ts` — Unit tests simulating both callback redirect resolution and manual fallback.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Low-level callback listener implementation (`cli/callback-server.ts` — covered in `T-0801`).
- HTML web page rendering (`apps/api/login-page.ts` — covered in `T-0802`).
- Modifying credential storage format (`cli/auth-config.ts`).

## Interface to implement

```typescript
export interface LoginOptions {
  controlUrl?: string;
  token?: string;       // Non-interactive fallback
  manual?: boolean;      // Skip browser callback server and prompt on stdin
  stdinReader?: () => Promise<string>;
  openBrowser?: (url: string) => Promise<boolean>;
  callbackTimeoutMs?: number;
}

export function runLogin(options?: LoginOptions): Promise<{ ok: boolean; orgId: string }>;
```

## Acceptance criteria (Given/When/Then)

1. Given a user runs `rail login`, when executed interactively without `--manual`, then an ephemeral loopback callback server starts, the browser opens to `${controlUrl}/login?callback=...&state=...`, and the terminal waits for the callback.
2. Given the browser authorizes and redirects to the callback server, then `runLogin` receives the token, validates it against `GET /v1/auth/verify`, writes `~/.railfog/config.json` with mode 0600, prints `✓ Successfully authenticated as <orgId>!`, and exits 0 without requiring manual pasting.
3. Given a user passes `--manual` (or runs in an environment where browser opening fails), then the CLI bypasses the callback server, displays the login URL, and prompts `Paste your API key: ` on stdin.
4. Given the callback server times out before receiving an authorization, then the ephemeral listener is closed and the CLI falls back to the interactive terminal stdin prompt rather than aborting immediately.
5. Given any error occurs during login, then error messages never print raw tokens or secrets (`PLAT-15`).

## Tests required

- [ ] Unit — `tests/unit/cli_login_test.ts`: Test automatic callback loopback flow, `--manual` override, and timeout fallback to stdin.
- [ ] Security — Verify token is written with restricted permissions (0600) and never printed to stdout/stderr or terminal logs (`PLAT-15`).

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-15`, `PLAT-17`)
- [ ] Spec-anchor comments present at each RailFog-specific decision point
- [ ] Unit tests written first (red), then implementation (green)
- [ ] `deno check` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all required tests passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Reviewer pass complete; security-auditor pass complete if triggered
- [ ] Nothing outside "In scope" touched

## Assumptions made

- Default timeout for callback wait before falling back to manual prompt is 120 seconds.
