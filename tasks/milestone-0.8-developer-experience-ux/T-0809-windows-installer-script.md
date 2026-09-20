# T-0809 — Implement Windows PowerShell Universal Installer Script

Status: Not started
Milestone: 0.8 Developer Experience & UX Polish
Depends on: none
Blocks: T-0810

## Spec references

`PLAT-19`

## Scope

**In scope**:
- `scripts/install.ps1` — PowerShell installer script for 1-line installation on Windows systems:
  - Detects Windows architecture (`$env:PROCESSOR_ARCHITECTURE` -> `AMD64`, `ARM64`).
  - Downloads the compiled `rail.exe` binary.
  - Installs binary to `$HOME\.railfog\bin\rail.exe`.
  - Updates the user-level persistent `PATH` environment variable via `[Environment]::SetEnvironmentVariable` if not already present.
  - Verifies installation by running `rail --help`.
- `tests/unit/installer_windows_test.ts` — Validation test checking PowerShell script structure and PATH modification safety.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- POSIX shell installer (`scripts/install.sh` — covered in `T-0808`).
- Windows MSI or Chocolatey / Winget packages.

## Interface to implement

PowerShell invocation interface:
```powershell
irm https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ps1 | iex
# Optional parameters:
# $env:RAILFOG_INSTALL_DIR = "C:\custom\bin"
```

## Acceptance criteria (Given/When/Then)

1. Given a user runs the installer in PowerShell 5.1 or PowerShell 7+, when executed, then it creates `$HOME\.railfog\bin` if missing and downloads `rail.exe`.
2. Given `$HOME\.railfog\bin` is not yet in the User `PATH`, then the script appends it persistently to the User Environment registry key without overwriting or duplicating existing PATH entries.
3. Given `rail.exe` is installed, then the installer refreshes the current session `$env:Path` so the user can immediately run `rail` in the same terminal.
4. Given network or permission errors, then the installer provides clear actionable feedback and aborts cleanly.

## Tests required

- [ ] Unit — `tests/unit/installer_windows_test.ts`: Verify PowerShell script syntax, target directory resolution, and PATH modification logic.

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly (`PLAT-19`)
- [ ] Spec-anchor comments present at each RailFog-specific decision point
- [ ] Unit tests written first (red), then implementation (green)
- [ ] PowerShell script runs cleanly without warnings under strict mode
- [ ] `deno check` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all required tests passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Reviewer pass complete; security-auditor pass complete if triggered
- [ ] Nothing outside "In scope" touched

## Assumptions made

- PowerShell `Invoke-RestMethod` and `Invoke-WebRequest` are available on standard Windows installations.
