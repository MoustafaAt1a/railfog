# T-0813 — Implement Universal Deno CLI Installer and Repository Install Task

Status: Complete
Milestone: 0.8 Developer Experience & UX Polish
Depends on: T-0808, T-0809
Blocks: none

## Spec references

`PLAT-19`

## Scope

**In scope**:
- `scripts/install.ts` — Cross-platform universal Deno installer script:
  - Supports remote 1-line execution: `deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts`
  - Supports local execution: `deno run -A scripts/install.ts` or `deno task install`
  - CLI flags: `--root <dir>`, `--force` / `-f`, `--compile`, `--ref <gitRef>`, `--repo <user/repo>`, `--help` / `-h`
  - Environment variables: `DENO_INSTALL_ROOT`, `RAILFOG_INSTALL_DIR`
  - Handles Deno 2 bare specifier isolation by fetching/using `deno.json` configuration
  - Compiles standalone binary (`--compile`) or installs Deno runner script into target bin directory
  - Validates installed binary via `--help` execution and exit code verification
  - Cleans up temporary files and directories in `finally` blocks
  - Prints styled Unicode installation confirmation card and PATH instructions
- `deno.json` — Add `"install": "deno install -g -A -f --config deno.json -n rail cli/main.ts"` under `"tasks"`
- `scripts/install.sh` & `scripts/install.ps1` — Update Deno fallback commands to supply `--config`
- `tests/unit/installer_deno_test.ts` — Unit test suite verifying:
  - Argument parsing (`parseInstallerArgs`)
  - Target URL resolution for local and remote repositories
  - Installation execution with custom `--root` directory
  - Output binary execution verification (`rail --help`)
  - Cleanup of temporary directory
- `README.md` — Document Deno 1-line installer and `deno task install`

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Homebrew / APT packaging
- Binary CDN distribution infrastructure
- Modifying core CLI subcommands or runtime primitives

## Interface to implement

```typescript
// scripts/install.ts

export interface InstallerOptions {
  root?: string;
  compile?: boolean;
  force?: boolean;
  ref?: string;
  repo?: string;
  local?: boolean;
  help?: boolean;
}

export function parseInstallerArgs(args: string[]): InstallerOptions;

export function resolveInstallPaths(options: InstallerOptions): {
  installDir: string;
  binDir: string;
  binaryName: string;
  fullBinaryPath: string;
};

export async function runInstaller(options: InstallerOptions): Promise<{
  ok: boolean;
  installedPath: string;
  output: string;
}>;
```

## Acceptance criteria (Given/When/Then)

1. Given a developer running `deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts`, when executed, then the `rail` CLI is installed to `$DENO_INSTALL_ROOT/bin` or `$HOME/.deno/bin` with valid configuration.
2. Given a user passing `--root <custom-dir>`, when the installer runs, then the executable is placed in `<custom-dir>/bin` without touching default user directories.
3. Given a user passing `--compile`, when the installer runs, then a standalone native binary is compiled into the bin directory.
4. Given a cloned repository, when running `deno task install`, then `rail` is installed globally using the local `deno.json` and `cli/main.ts`.
5. Given the installation completes, when the installer validates the binary, then it runs `rail --help` and asserts exit code 0 and presence of `RailFog CLI`.
6. Given an error occurs during installation, then all temporary files are cleaned up and an informative error message is displayed.

## Tests required

- [x] Unit — `tests/unit/installer_deno_test.ts`:
  - `parseInstallerArgs` parses `--root`, `--compile`, `--force`, `--ref`, `--repo` correctly.
  - `resolveInstallPaths` selects correct path based on OS and options.
  - `runInstaller` in an isolated temporary root installs `rail` and verifies `--help` output with exit code 0.
  - `deno task install` command is defined in `deno.json`.
- [x] Integration / E2E — Verify `tests/e2e/ux_dx_milestone_08_test.ts` validates `scripts/install.ts`.

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

- Deno 2.x is present on the host system.
- Network access to GitHub raw content is available for remote installation.
