# Installation & Setup

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Supported
> Platforms**: Linux (x86_64, aarch64), macOS (Apple Silicon, Intel), Windows
> (x86_64) &nbsp;|&nbsp; **Specification**:
> [`PLAT-19`](../contracts/platform.contract.md#PLAT-19)

The RailFog command-line interface (`rail`) can be installed using Deno,
pre-compiled platform scripts, or as a self-contained standalone binary with
zero external runtime dependencies.

---

## 1. Installation Methods

### Method A: Global Deno Install (Recommended)

If you already have Deno (v2.0 or later) installed:

```bash
deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts
```

Or from within a cloned RailFog repository:

```bash
deno task install
```

This installs the `rail` executable into your Deno bin directory (`~/.deno/bin`
on POSIX, `%USERPROFILE%\.deno\bin` on Windows). Ensure this directory is in
your system `PATH`.

---

### Method B: POSIX Shell Installer (macOS & Linux)

Install directly in any bash or zsh terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.sh | sh
```

---

### Method C: Windows PowerShell Installer

Run in Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ps1 | iex
```

---

### Method D: Standalone Native Binary (Zero Prerequisites)

Compile a self-contained single-file executable that embeds Deno and the
complete CLI:

```bash
deno compile -A -o rail cli/main.ts
```

Move the compiled `rail` (or `rail.exe` on Windows) to any directory on your
system `PATH`.

---

## 2. Verifying Installation

Verify that the CLI is accessible and inspect system dependencies:

```bash
# Check version
rail --version

# Run diagnostic health check
rail doctor
```

`rail doctor` checks your local Deno runtime version, disk permissions, network
reachability, and V8 isolate startup performance.

---

## 3. Shell Auto-Completions

Generate completion scripts for your shell using `rail completions`:

### PowerShell

```powershell
rail completions pwsh >> $PROFILE
```

### Bash

```bash
rail completions bash > /etc/bash_completion.d/rail
# Or for user profile:
rail completions bash >> ~/.bashrc
```

### Zsh

```zsh
rail completions zsh > "${fpath[1]}/_rail"
```

### Fish

```fish
rail completions fish > ~/.config/fish/completions/rail.fish
```

---

## 4. Upgrading the CLI

To upgrade `rail` in-place to the latest release:

```bash
rail upgrade
```

To compile and link directly against the latest git commit on `main`:

```bash
rail upgrade --compile
```

---

## Next Steps

- Follow the [5-Minute Quickstart](quickstart.md).
- Understand the [Standard Project Structure](project-structure.md).
