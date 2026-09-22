# Modular Packages (`packages/`)

> [!NOTE]
> **Scope**: Foundational, Domain-Neutral Modules &nbsp;|&nbsp;
> **Workspace**: Mapped via `deno.json` import map (`@railfog/*`) &nbsp;|&nbsp;
> **Architecture Doctrine**: [CONSTITUTION.md](../docs/reference/constitution.md)

This directory contains the foundational, domain-neutral modular packages that power RailFog's applications, runtime engine, providers, and developer CLI.

---

## 1. Package Dependency Hierarchy

Packages maintain strict downward-only dependencies. Cross-boundary upward coupling is strictly prohibited:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Upper Layers: apps/ · cli/ · runtime/ · providers/ · primitives/       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (Depends on @railfog/*)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Domain Packages: @railfog/auth · @railfog/config · @railfog/policy ... │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ (Depends on foundational packages)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Foundational Packages: @railfog/core · @railfog/errors                 │
└────────────────────────────────────────────────────────────────────────┘
```

### Dependency Rules:
1. Packages may depend on `@railfog/core`, `@railfog/errors`, and `@std/*`.
2. Packages must **never** depend on `primitives/`, `providers/`, `runtime/`, `apps/`, or `cli/`.
3. Circular dependencies between packages are rejected by `deno task check`.

---

## 2. Packages Directory

All packages export standardized entrypoints via `mod.ts` and are aliased in `deno.json`:

| Package | Workspace Alias | Responsibilities | Spec Anchors |
|---|---|---|---|
| [`packages/core`](core/) | `@railfog/core` | Universal platform constants, Crockford Base32 ULID generation, lexer analyzers, base types. | [`PLAT-14`](../docs/contracts/platform.contract.md#PLAT-14) |
| [`packages/api`](api/) | `@railfog/api` | REST API request/response DTOs, endpoint routes, serialization contracts, and schema definitions. | [`PLAT-12`](../docs/contracts/platform.contract.md#PLAT-12) |
| [`packages/auth`](auth/) | `@railfog/auth` | Tenant identity context, API key verification, role-based access control, session tokens. | [`PLAT-7`](../docs/contracts/platform.contract.md#PLAT-7) |
| [`packages/config`](config/) | `@railfog/config` | Declarative manifest parsing, `railfog.toml` schema validation, route specificity scoring. | [`PLAT-2`](../docs/contracts/platform.contract.md#PLAT-2), [`PLAT-11`](../docs/contracts/platform.contract.md#PLAT-11) |
| [`packages/errors`](errors/) | `@railfog/errors` | Canonical typed `RailFogError` class hierarchy and 10 machine-readable error codes. | [`PLAT-12`](../docs/contracts/platform.contract.md#PLAT-12) |
| [`packages/logging`](logging/) | `@railfog/logging` | High-throughput structured JSON logging with automatic secret redaction. | [`PLAT-13`](../docs/contracts/platform.contract.md#PLAT-13), [`PLAT-15`](../docs/contracts/platform.contract.md#PLAT-15) |
| [`packages/metrics`](metrics/) | `@railfog/metrics` | In-memory usage metric accumulation, Prometheus text formatting, and OpenTelemetry OTLP export. | [`PLAT-13`](../docs/contracts/platform.contract.md#PLAT-13) |
| [`packages/policy`](policy/) | `@railfog/policy` | Network egress allowlisting, SSRF prevention firewall, mandatory link-local and cloud metadata blocks. | [`PLAT-5`](../docs/contracts/platform.contract.md#PLAT-5) |
| [`packages/protocol`](protocol/) | `@railfog/protocol` | Wire formats, binary framing, immutable routing snapshot serialization. | [`PLAT-8`](../docs/contracts/platform.contract.md#PLAT-8) |
| [`packages/testing`](testing/) | `@railfog/testing` | Shared test fixtures, mock providers, deterministic time harnesses, and assertions. | [`PLAT-16`](../docs/contracts/platform.contract.md#PLAT-16) |

---

## 3. Developing Packages

All packages are type-checked and linted simultaneously across the workspace:

```bash
# Type-check all packages
deno task check

# Lint package source files
deno lint packages/

# Run unit tests for packages
deno test --allow-all tests/unit/packages_*_test.ts
```
