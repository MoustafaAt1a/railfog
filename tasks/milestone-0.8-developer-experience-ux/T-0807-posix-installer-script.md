# T-0807 — Implement POSIX Shell Universal Installer Script

Status: Not started
Milestone: 0.8 Developer Experience & UX Polish
Depends on: none
Blocks: T-0809

## Spec references

`PLAT-19`

## Scope

**In scope**:
- `scripts/install.sh` — POSIX-compatible shell script (`/bin/sh`) for 1-line installation on macOS and Linux:
  - Detects operating system (`uname -s` -> `Darwin`, `Linux`).
  - Detects architecture (`uname -m` -> `x86_64`, `arm64`, `aarch64`).
  - Downloads the compiled binary asset or bootstraps with Deno if available.
  - Installs binary to `$HOME/.railfog/bin/rail` (or `/usr/local/bin/rail` when run with `sudo`).
  - Sets executable permissions (`chmod +x`).
  - Detects current shell (`bash`, `zsh`, `fish`) and provides exact PATH update snippet if not already on `$PATH`.
- `tests/unit/installer_posix_test.ts` — Syntax and logic validation test for `scripts/install.sh`.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Windows installer (`scripts/install.ps1` — covered in `T-0808`).
- Publishing to package managers (Homebrew, APT).

## Interface to implement

Script invocation interface:
```bash
curl -fsSL https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.sh | sh
# Optional environment variables:
# RAILFOG_INSTALL_DIR=/custom/bin
# RAILFOG_VERSION=latest
```

## Acceptance criteria (Given/When/Then)

1. Given a user runs the installer on macOS (Apple Silicon or Intel) or Linux (x86_64 or aarch64), when executed, then it correctly identifies the host OS and architecture.
2. Given a target directory, when the script completes, then the `rail` binary is located at `$HOME/.railfog/bin/rail` with executable permissions (`0755`).
3. Given `$HOME/.railfog/bin` is not present in `$PATH`, then the installer prints clear instructions on how to add it to the user's shell profile (`.zshrc`, `.bashrc`, or `config.fish`).
4. Given an unsupported OS or architecture, then the script aborts with an informative error message and instructions on manual build.

## Tests required

- [ ] Unit — `tests/unit/installer_posix_test.ts`: Verify shell script syntax (`sh -n`), parameter parsing, and OS/arch resolution logic.

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly (`PLAT-19`)
- [ ] Spec-anchor comments present at each RailFog-specific decision point
- [ ] Shell script complies with strict POSIX standards (`set -e`)
- [ ] `deno check` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all required tests passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Reviewer pass complete
- [ ] Nothing outside "In scope" touched

## Assumptions made

- Shell script uses standard utilities (`curl` or `wget`, `tar` or `unzip`, `uname`, `chmod`).
