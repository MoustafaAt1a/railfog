# T-0801 — Implement Ephemeral Localhost Callback Server

Status: Not started
Milestone: 0.8 Developer Experience & UX Polish
Depends on: none
Blocks: T-0803

## Spec references

`PLAT-1`, `PLAT-15`, `PLAT-19`

## Scope

**In scope**:
- `cli/callback-server.ts` — Ephemeral loopback HTTP server that binds to `127.0.0.1:0` (random unprivileged OS port), generates a cryptographically random `state` nonce (`crypto.randomUUID()`), listens for incoming `GET /callback?token=rfk_...&state=...`, renders a self-contained HTML confirmation response, and returns the received token.
- Incorporates mandatory security controls:
  - Single-use listener (closes immediately on first valid matching callback).
  - Probe resilience (mismatched/invalid state queries return `400 Bad Request` without aborting the pending server).
  - `Referrer-Policy: no-referrer` and `Cache-Control: no-store, private` headers on all HTML responses.
  - Zero token logging in server logs or error payloads (`PLAT-15`).
  - Active `clearTimeout` cleanup preventing event-loop hangs.
- `tests/unit/cli_callback_server_test.ts` — Unit tests covering server startup, callback token resolution, state validation, and timeout handling.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Modifying the web login page UI (`apps/api/login-page.ts` — covered in `T-0802`).
- Browser process launching (`cli/login.ts` — covered in `T-0803`).
- Credential file storage (`cli/auth-config.ts`).

## Interface to implement

```typescript
export interface CallbackServerOptions {
  timeoutMs?: number;        // Maximum wait time before aborting (default: 120_000 ms)
  state?: string;            // Optional predefined CSRF state nonce (must have >= 128-bit entropy)
}

export interface CallbackServerSession {
  port: number;
  callbackUrl: string;       // e.g. http://127.0.0.1:49152/callback
  state: string;             // Cryptographically random nonce to match in callback
  waitForToken(): Promise<{ token: string; orgId?: string }>;
  close(): Promise<void>;
}

export function startCallbackServer(
  options?: CallbackServerOptions,
): Promise<CallbackServerSession>;
```

## Acceptance criteria (Given/When/Then)

1. Given `startCallbackServer()` is called, when listening, then it binds to an ephemeral OS port on `127.0.0.1`, generates a 128-bit cryptographic state nonce via `crypto.randomUUID()`, and provides a valid loopback callback URL (`http://127.0.0.1:<port>/callback`).
2. Given an incoming HTTP request to `GET /callback?token=rfk_abc123&state=<matchingState>`, when state matches, then the server responds with `200 OK`, `Referrer-Policy: no-referrer`, and a clean HTML message ("You can now close this tab and return to your terminal"), fulfills `waitForToken()`, and shuts down cleanly.
3. Given an incoming request with an invalid or mismatched `state` query parameter, when evaluated, then the server responds with `400 Bad Request`, rejects the attempt without leaking secrets (`PLAT-15`), and does not fulfill `waitForToken()`, keeping the listener active for the legitimate callback.
4. Given no callback request is received before `timeoutMs` elapses, when the timeout fires, then `waitForToken()` rejects with a `TIMEOUT` error, active timers are cleared, and the server is automatically closed.
5. Given `close()` is called explicitly, then any active listener is closed idempotently without resource leaks (`PLAT-19`).

## Tests required

- [ ] Unit — `tests/unit/cli_callback_server_test.ts`: Test server port allocation, successful token receipt with state verification, invalid state rejection, and timeout cleanup.
- [ ] Security — Verify zero token leakage in server logs, 400 Bad Request error pages, and timeout rejection paths; verify single-use listener termination (`PLAT-15`).

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-15`, `PLAT-19`)
- [ ] Spec-anchor comments present at each RailFog-specific decision point
- [ ] Unit tests written first (red), then implementation (green)
- [ ] `deno check` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all required tests passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Reviewer pass complete; security-auditor pass complete if triggered
- [ ] Nothing outside "In scope" touched

## Assumptions made

- `127.0.0.1` is used rather than `localhost` to avoid IPv6/IPv4 lookup delays or hosts-file ambiguities.
- HTML response served to the browser on successful login uses pure inline CSS with zero external assets to prevent referer leakage.
