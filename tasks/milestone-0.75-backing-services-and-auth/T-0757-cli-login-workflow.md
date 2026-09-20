# T-0757 — Implement CLI Interactive Login Flow and Credential Management

Status: Done
Milestone: 0.75 Backing Services and Auth
Depends on: T-0756
Blocks: T-0758

## Spec references

`PLAT-1`, `PLAT-6`, `PLAT-12`, `PLAT-15`, `PLAT-17`

## Scope

**In scope**:
- `cli/auth-config.ts` — Local credential storage (`~/.railfog/config.json`) and token resolution helper (`resolveAuthHeader()`).
- `cli/login.ts` — Interactive login command (`rail login`), session removal (`rail logout`), and identity display (`rail whoami`).
- `cli/main.ts` — Register `rail login`, `rail logout`, `rail whoami` subcommands.
- `cli/deploy.ts`, `cli/rollback.ts`, `cli/state.ts`, `cli/secrets.ts` — Inject `Authorization: Bearer <token>` to outbound HTTP requests.
- `tests/unit/cli_login_test.ts` — Unit tests for interactive login parsing, credential read/write, and header injection.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Web login UI rendering (`apps/api/login-page.ts` — covered in `T-0756`).
- Persistent database schema for tokens (covered in `T-0752` / `T-0753`).
- Modifying local server behavior during `rail dev`.

## Interface to implement

```typescript
export interface CliAuthConfig {
  token?: string;
  controlUrl?: string;
  orgId?: string;
}

export function loadCliConfig(configPath?: string): Promise<CliAuthConfig | null>;
export function saveCliConfig(config: CliAuthConfig, configPath?: string): Promise<void>;
export function clearCliConfig(configPath?: string): Promise<void>;
export function resolveAuthHeader(options?: { token?: string }): Promise<Record<string, string>>;

export interface LoginOptions {
  controlUrl?: string;
  token?: string;     // Non-interactive fallback
  stdinReader?: () => Promise<string>;
  openBrowser?: (url: string) => Promise<boolean>;
}

export function runLogin(options?: LoginOptions): Promise<{ ok: boolean; orgId: string }>;
export function runLogout(): Promise<void>;
export function runWhoami(options?: { controlUrl?: string }): Promise<{ authenticated: boolean; identity?: unknown }>;
```

## Acceptance criteria (Given/When/Then)

1. Given a user runs `rail login`, when executed in an interactive terminal, then the CLI prints the target login URL, attempts to open the default system web browser to `${controlUrl}/login`, and prompts `Paste your API key: ` on stdin.
2. Given a user pastes an API key and presses Enter, when validated against the control server via `GET /v1/auth/verify`, then the token is confirmed valid, saved to `~/.railfog/config.json` with permissions restricted to current user, and logs `✓ Successfully authenticated as <orgId>!`.
3. Given a user pastes an invalid or revoked API key, when checked, then the CLI outputs an error message, does not save the token, and exits with code 1 without leaking secrets (`PLAT-15`).
4. Given saved credentials in `~/.railfog/config.json`, when running `rail deploy`, `rail rollback`, or `rail secrets`, then the CLI automatically sends `Authorization: Bearer <token>` in request headers.
5. Given a user runs `rail whoami`, then the CLI verifies the current token and displays the organization and user details.
6. Given a user runs `rail logout`, then `~/.railfog/config.json` is cleared and subsequent requests are unauthenticated.

## Tests required

- [x] Unit — `tests/unit/cli_login_test.ts`: Verify config serialization, stdin prompt handling, browser launcher command formation, and header injection.
- [x] Integration — End-to-end simulated CLI login against a running control plane mock.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-6`, `PLAT-12`, `PLAT-15`, `PLAT-17`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

## Assumptions made

- Standard user config file location is `~/.railfog/config.json` (or `%USERPROFILE%\.railfog\config.json` on Windows).
- Browser opening uses standard OS commands (`start` on Windows, `open` on macOS, `xdg-open` on Linux).
