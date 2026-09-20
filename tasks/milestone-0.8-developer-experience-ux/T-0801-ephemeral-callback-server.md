# T-0801 — Implement Ephemeral Localhost Callback Server

Status: Complete Milestone: 0.8 Developer Experience & UX Polish Depends on:
none Blocks: T-0803

## Spec references

`PLAT-1`, `PLAT-15`, `PLAT-19`

## Scope

**In scope**:

- `cli/callback-server.ts` — Implement `startCallbackServer()`:
  - Spawns local ephemeral HTTP server on `127.0.0.1:0`.
  - Generates 128-bit cryptographic state nonce (`crypto.randomUUID()`).
  - Provides `callbackUrl` pointing to `http://127.0.0.1:<port>/callback`.
  - Handles `GET /callback`:
    - Validates `state` parameter matches session nonce.
    - Extracts `token` parameter (and optional `orgId`).
    - Returns minimal, zero-asset static HTML response ("Authentication
      successful! You may return to your terminal.").
    - Automatically closes listener upon first valid token receipt (single-use
      listener).
  - Handles probe resilience: returns `400 Bad Request` on invalid state without
    aborting the pending listener.
  - Implements configurable timeout (default 120s) rejecting with canonical
    `TIMEOUT` error (`PLAT-12`) and cleaning up resources.
  - Guarantees zero raw token leakage in server logs or error outputs
    (`PLAT-15`).
  - Sets `Referrer-Policy: no-referrer` and `Cache-Control: no-store, private`
    headers.
- `tests/unit/cli_callback_server_test.ts` — Comprehensive unit test suite.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):

- CLI command wiring (`cli/login.ts` — covered in `T-0803`).
- HTML web page rendering (`apps/api/login-page.ts` — covered in `T-0802`).
- Opening the desktop browser (covered in `T-0803`).

## Interface to implement

```typescript
export interface CallbackServerOptions {
  timeoutMs?: number;
  state?: string;
}

export interface CallbackServerSession {
  port: number;
  callbackUrl: string;
  state: string;
  waitForToken(): Promise<{ token: string; orgId?: string }>;
  close(): Promise<void>;
}

export function startCallbackServer(
  options?: CallbackServerOptions,
): Promise<CallbackServerSession>;
```

## Acceptance criteria (Given/When/Then)

1. Given `startCallbackServer()` is called, when the server boots, then it binds
   to `127.0.0.1` on an unprivileged OS-assigned port (port 0), constructs a
   valid loopback callback URL, and returns a session with a 128-bit random
   state nonce.
2. Given a request to `GET /callback?token=rfk_...&state=<nonce>`, when `state`
   matches the session nonce, then the server resolves `waitForToken()` with the
   token, responds with HTTP 200 and a friendly HTML page, and automatically
   shuts down the HTTP server.
3. Given a request to `GET /callback` with a missing or mismatched `state`, when
   received, then the server responds with HTTP 400 Bad Request and keeps the
   listener open for the legitimate callback (probe resilience).
4. Given no callback request is received before `timeoutMs` elapses, when the
   timeout fires, then `waitForToken()` rejects with a `TIMEOUT` error, active
   timers are cleared, and the server is automatically closed.
5. Given `close()` is called explicitly, then any active listener is closed
   idempotently without resource leaks (`PLAT-19`).

## Tests required

- [x] Unit — `tests/unit/cli_callback_server_test.ts`: Test server port
      allocation, successful token receipt with state verification, invalid
      state rejection, and timeout cleanup.
- [x] Security — Verify zero token leakage in server logs, 400 Bad Request error
      pages, and timeout rejection paths; verify single-use listener termination
      (`PLAT-15`).

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-15`,
      `PLAT-19`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Assumptions made

- `127.0.0.1` is used rather than `localhost` to avoid IPv6/IPv4 lookup delays
  or hosts-file ambiguities.
- HTML response served to the browser on successful login uses pure inline CSS
  with zero external assets to prevent referer leakage.
