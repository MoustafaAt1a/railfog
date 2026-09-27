# Contributor Development Guide

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Audience**:
> Platform Contributors & Maintainers &nbsp;|&nbsp; **Toolchain**: Deno v2.0+

This guide covers local environment setup, toolchain requirements, and common
developer tasks for contributing to RailFog.

---

## 1. Prerequisites

- **Deno**: Version 2.0.0 or higher.
- **Git**: Modern git client.
- Optional: C compiler (only if compiling native binaries).

Verify your environment:

```bash
deno --version
git --version
```

---

## 2. Setting Up the Workspace

Clone the repository and install the development CLI:

```bash
git clone https://github.com/MoustafaAt1a/railfog.git
cd railfog

# Install local rail CLI binary linked to the repo
deno task install
```

---

## 3. Standard Workspace Tasks

All everyday engineering tasks are defined in `deno.json`:

```bash
# Start local development runtime
deno task dev

# Run workspace type-check across all TypeScript files
deno task check

# Run workspace linter
deno task lint

# Format codebase
deno task fmt

# Check formatting without modifying files
deno task fmt:check

# Run complete local verification suite
deno task verify

# Run release certification gate
deno task release:gate
```

---

## 4. Code Standards & Boundary Rule

Before submitting code, review [`docs/CONSTITUTION.md`](../CONSTITUTION.md):

- Use OOP and pure interfaces at module boundaries (`providers/*`).
- Use Data-Oriented Design (DOD) inside request hot paths (`runtime/`).
- Never introduce mock branches in production code.
- Follow anti-slop guidelines in `.agents/docs/ANTI-SLOP.md`.
