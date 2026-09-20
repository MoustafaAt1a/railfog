# `@railfog/*` Packages

Foundational, domain-neutral modules used across RailFog's applications, runtime, and CLI.

## Packages Overview

All packages are mapped into the workspace import map in [`deno.json`](file:///C:/FM/railfog/deno.json) and exported via standardized entry points (`mod.ts`).

| Package | Workspace Alias | Description | Clause References |
|---|---|---|---|
| [`core`](file:///C:/FM/railfog/packages/core/mod.ts) | `@railfog/core` | Universal platform constants, Crockford Base32 ULID generation, and core data structures | [`PLAT-14`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L248) |
| [`api`](file:///C:/FM/railfog/packages/api/mod.ts) | `@railfog/api` | REST API request/response DTOs, endpoint routes, and serialization contracts | [`PLAT-12`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L210) |
| [`auth`](file:///C:/FM/railfog/packages/auth/mod.ts) | `@railfog/auth` | Tenant context extraction, API key verification, role-based authorization | [`PLAT-7`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L104) |
| [`config`](file:///C:/FM/railfog/packages/config/mod.ts) | `@railfog/config` | Manifest parsing, `railfog.toml` validation, environment override resolution | [`PLAT-2`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L25) |
| [`errors`](file:///C:/FM/railfog/packages/errors/mod.ts) | `@railfog/errors` | Canonical typed `RailFogError` hierarchy (10 standard error codes) | [`PLAT-12`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L210) |
| [`logging`](file:///C:/FM/railfog/packages/logging/mod.ts) | `@railfog/logging` | Structured JSON logging with automatic secret value redaction | [`PLAT-15`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L258) |
| [`metrics`](file:///C:/FM/railfog/packages/metrics/mod.ts) | `@railfog/metrics` | In-memory metric accumulation, Prometheus text formatting, OTLP payload generation | [`PLAT-13`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L236) |
| [`policy`](file:///C:/FM/railfog/packages/policy/mod.ts) | `@railfog/policy` | Network egress allowlisting, SSRF prevention, mandatory IP-range blocks | [`PLAT-5`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L62) |
| [`protocol`](file:///C:/FM/railfog/packages/protocol/mod.ts) | `@railfog/protocol` | Wire formats, binary framing, snapshot serialization | [`PLAT-8`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L129) |
| [`testing`](file:///C:/FM/railfog/packages/testing/mod.ts) | `@railfog/testing` | Shared test harness, mock providers, deterministic fixtures | [`PLAT-16`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L268) |

## Dependency Rules

1. Packages may depend on `@railfog/core` and `@railfog/errors`.
2. Packages must **never** depend on `primitives/`, `providers/`, `runtime/`, or `apps/`.
3. Circular dependencies between packages are forbidden.
