# T-0803 — Integrate Zero-Copy Callback Flow into CLI Login

Status: Not started
Milestone: 0.8 Developer Experience & UX Polish
Depends on: T-0801, T-0802
Blocks: T-0809

## Spec references

`PLAT-1`, `PLAT-15`, `PLAT-17`

## Scope

**In scope**:
- `cli/login.ts` — Wire `startCallbackServer()` into `runLogin()`: start local listener, construct authorization URL with `callback` and `state`, open default browser, await callback redirect, verify token via `GET /v1/auth/verify`, and persist credentials to `~/.railfog/config.json`.
- Provide `--manual` flag and timeout/error fallback to stdin prompt.
- `tests/unit/cli_login_test.ts` — Integration unit tests simulating both callback redirect resolution and manual fallback.

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
2. Given the browser authorizes and redirects to the callback server, then `runLogin` receives the token, validates it against `GET /v1/auth/verify`, writes `~/.railfog/config.json`, prints `✓ Successfully authenticated as <orgId>!`, and exits 0 without requiring manual pasting.
3. Given a user passes `--manual` (or runs in an environment where browser opening fails), then the CLI bypasses the callback server, displays the login URL, and prompts `Paste your API key: ` on stdin.
4. Given the callback server times out before receiving an authorization, then the CLI falls back to the interactive terminal stdin prompt rather than aborting immediately.

## Tests required

- [ ] Unit — `tests/unit/cli_login_test.ts`: Test automatic callback loopback flow, `--manual` override, and timeout fallback to stdin.

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-15`, `PLAT-17`)
- [ ] Spec-anchor comments present at each RailFog-specific decision point
- [ ] Unit tests written first (red), then implementation (green)
- [ ] `deno check` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all required tests passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Reviewer pass complete
- [ ] Nothing outside "In scope" touched

## Assumptions made

- Default timeout for callback wait before falling back to manual prompt is 120 seconds.
