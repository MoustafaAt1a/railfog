# T-0814 — Implement CLI Self-Upgrade Mechanism (rail update / rail upgrade)

Status: Completed
Milestone: 0.8 Developer Experience & UX Polish
Depends on: T-0813
Blocks: none

## Spec references

`PLAT-19`

## Scope

**In scope**:
- `cli/version.ts` — CLI version definition:
  - `CLI_VERSION`: Current semantic version string (e.g. `"0.8.0"`).
- `cli/upgrade.ts` — Self-upgrade and version checking engine:
  - `UpgradeOptions`: Configuration interface (`version`, `ref`, `force`, `checkOnly`, `root`, `compile`).
  - `checkLatestVersion(options?: { repo?: string; ref?: string })`: Queries GitHub for the latest version/commit.
  - `runUpgrade(options?: UpgradeOptions)`: Orchestrates version checking, animated status spinner, binary download/recompilation via `scripts/install.ts`, post-upgrade verification, and styled success output.
- `cli/main.ts` — CLI command dispatch:
  - Register `upgrade` command and `update` alias.
  - Add `--version` / `-v` flag to print current CLI version.
- `tests/unit/cli_upgrade_test.ts` — Unit test suite verifying:
  - `CLI_VERSION` semantic format and export.
  - `--version` / `-v` CLI flag handling.
  - `checkLatestVersion` resolution.
  - `runUpgrade` with `--check-only` reporting status without modifying files.
  - `runUpgrade` with isolated `--root` and `--force` upgrading binary and verifying output.
- `README.md` — Document `rail update` / `rail upgrade` and `rail --version`.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Automatic background auto-update daemons (must be explicitly invoked by the user).
- Modifying OS-level package managers (Homebrew, Apt).

## Interface to implement

```typescript
// cli/version.ts
export const CLI_VERSION: string;

// cli/upgrade.ts
export interface UpgradeOptions {
  version?: string;
  ref?: string;
  force?: boolean;
  checkOnly?: boolean;
  root?: string;
  compile?: boolean;
  repo?: string;
}

export interface UpgradeResult {
  ok: boolean;
  upToDate: boolean;
  currentVersion: string;
  targetVersion: string;
  installedPath?: string;
  message?: string;
}

export async function checkLatestVersion(options?: {
  repo?: string;
  ref?: string;
}): Promise<string>;

export async function runUpgrade(
  options?: UpgradeOptions,
): Promise<UpgradeResult>;
```

## Acceptance criteria (Given/When/Then)

1. Given a user running `rail --version` or `rail -v`, when executed, then the CLI outputs `rail 0.8.0` and exits with code 0.
2. Given a user running `rail update --check` or `rail upgrade --check`, when executed, then it queries the remote repository and reports whether an update is available without modifying local installations.
3. Given a user running `rail update` or `rail upgrade`, when already on the latest version and `--force` is not set, then it informs the user that the CLI is already up to date.
4. Given a user running `rail update --force`, when executed, then it re-downloads and updates the CLI binary in-place, verifies the new binary with `--help`, and prints a styled success confirmation.
5. Given a user running `rail update --ref <branch_or_tag>`, when executed, then it upgrades to the specified git ref.

## Tests required

- [x] Unit — `tests/unit/cli_upgrade_test.ts`:
  - `CLI_VERSION` export and semver validation.
  - `checkLatestVersion` remote resolution.
  - `runUpgrade` check-only mode.
  - `runUpgrade` isolated installation with `--root`.
  - `rail upgrade` / `rail update` CLI command dispatch in `cli/main.ts`.

## Definition of Done

- [x] Implementation matches PLAT-19
- [x] Spec-anchor comments present at each decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, zero errors
- [x] `deno test` run, all tests pass
- [x] `deno lint` run, zero warnings
- [x] Anti-slop and contract lock principles strictly followed
- [x] Multi-agent review (reviewer, security-auditor) passed

## Assumptions made

- Network access to GitHub is available when running `rail update`.
- Local installation directory is writable by the running user.
