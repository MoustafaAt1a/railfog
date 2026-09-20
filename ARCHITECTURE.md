# RailFog — Architecture & Modular Monolith Guide

This document defines the structural organization, architectural boundaries, dependency rules, and maintenance principles for RailFog's modular monolith.

---

## 1. System Topology & Process Boundaries

RailFog is architected as a **modular monolith** with a strict **two-process physical deployment topology** per [`PLAT-1`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L11).

```
                            ┌────────────────────────────────────────┐
                            │            Ingress Gateway             │
                            │           (apps/gateway)               │
                            └───────────────────┬────────────────────┘
                                                │
                     ┌──────────────────────────┴──────────────────────────┐
                     │                                                     │
                     ▼                                                     ▼
    ┌─────────────────────────────────┐                   ┌─────────────────────────────────┐
    │     Control Plane Process       │                   │      Data Plane Process         │
    │        (railfog-control)        │                   │      (railfog-runtime)          │
    │         [apps/api]              │                   │        [apps/runtime]           │
    ├─────────────────────────────────┤                   ├─────────────────────────────────┤
    │ • Project & Route Management    │                   │ • Fail-Static Request Router    │
    │ • Deployments & Revisions       │                   │ • Memory & Disk Snapshot Cache  │
    │ • Capability/Secret Resolver    │                   │ • Sandbox Process Isolation     │
    │ • Snapshot Distribution         │                   │ • Capability Context Injection  │
    │ • Usage & Billing Aggregation   │                   │ • Rate Limiting & Metrics       │
    └────────────────┬────────────────┘                   └────────────────┬────────────────┘
                     │                                                     │
                     │  Periodic Snapshot Poll / Disk Cache (PLAT-8)       │
                     └─────────────────────────────────────────────────────┘
                                                │
                                                ▼
                                  ┌───────────────────────────┐
                                  │    Background Worker      │
                                  │      (apps/worker)        │
                                  ├───────────────────────────┤
                                  │ • Queue Consumer Loop     │
                                  │ • Worker Supervisor       │
                                  │ • DLQ Routing & Retries   │
                                  └───────────────────────────┘
```

### Critical Operational Invariants

1. **Fail-Static Availability ([`PLAT-8`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L129))**: The data plane (`railfog-runtime`) **never makes synchronous calls** to the control plane on the request path. It routes live traffic strictly from an immutable memory snapshot, persisted to disk cache. If `railfog-control` crashes or is redeployed, `railfog-runtime` continues serving with zero downtime or degradation.
2. **Untrusted Code Sandboxing ([`PLAT-4`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L45))**: Customer function code never executes directly in the runtime daemon process. Execution occurs within isolated worker boundaries enforced by `ComputeProvider` and `ProcessIsolationProvider`.
3. **Capability Injection ([`PLAT-6`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L83))**: User functions never receive ambient network or storage credentials. Every resource (`kv`, `objects`, `queues`, `env`) is injected into `RailFogContext` pre-scoped to that function's declared permissions.

---

## 2. Layer Hierarchy & Dependency Direction

The codebase is organized into five distinct layers. Dependencies must flow **downward only**. Upward or cross-boundary circular dependencies are strictly forbidden.

```
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 5: Applications & CLI                                            │
│ apps/ (api, gateway, runtime, worker) · cli/                           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 4: Runtime Engine & Execution Boundary                           │
│ runtime/ (api, sandbox, loader, limits, lifecycle)                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 3: Infrastructure Adapters (SPI Implementations)                 │
│ providers/ (compute, kv, objects, queues)                              │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 2: Core Domain & Primitives                                      │
│ primitives/ (functions, kv, objects, queues)                           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 1: Foundational Utility Packages                                 │
│ packages/ (core, api, auth, config, errors, logging, metrics, ...)     │
└────────────────────────────────────────────────────────────────────────┘
```

### Dependency Rules Matrix

| Layer | May Depend On | Must NEVER Depend On |
|---|---|---|
| `packages/*` | `@railfog/errors`, `@railfog/core`, standard library | `primitives/*`, `providers/*`, `runtime/*`, `apps/*`, `cli/*` |
| `primitives/*` | `packages/*` | `providers/*`, `runtime/*`, `apps/*`, `cli/*` |
| `providers/*` | `primitives/*`, `packages/*` | `runtime/*`, `apps/*`, other sibling providers |
| `runtime/*` | `primitives/*` (interfaces), `packages/*` | Concrete `providers/*` directly (wired via DI) |
| `apps/*` | `runtime/*`, `providers/*`, `primitives/*`, `packages/*` | Other sibling apps |
| `cli/*` | `apps/*`, `runtime/*`, `providers/*`, `primitives/*`, `packages/*` | None (composition root) |

---

## 3. The Boundary Rule: OOP vs. DOD

RailFog enforces the **Boundary Rule** defined in [`docs/CONSTITUTION.md`](file:///C:/FM/railfog/docs/CONSTITUTION.md):

> **If it crosses a module boundary or is swappable, model it as an interface (OOP + SOLID).**
> **If it lives inside the per-request execution hot path and is never swapped independently, model it as plain data plus free functions (Data-Oriented Design).**

### OOP + SOLID Zones
- **`providers/*`**: All infrastructure adapters implement standard Provider SPIs (`ComputeProvider`, `KVProvider`, `ObjectProvider`, `QueueProvider`). Implementations are 100% swappable between local dev (SQLite, LocalFS) and cloud production (Deno KV, Cloudflare R2, Cloudflare Queues).
- **`primitives/*`**: Public resource interfaces exposed to customer handlers (`KVBinding`, `ObjectBinding`, `QueueBinding`, `RailFogContext`).
- **`packages/policy` & `packages/auth`**: Low-volume, configuration-driven security verification.

### DOD (Data-Oriented Design) Zones
- **`runtime/loader` & `runtime/limits`**: Invocation record structures, flat resource limits records.
- **Route Matching Loop**: Array indexing, numeric specificity score comparisons (`PLAT-11`).
- **`packages/metrics` & Logging**: Pre-allocated circular buffers, flat usage event records flushed in batches. Zero per-request object allocations or heap pressure.

---

## 4. Directory Layout ([`PLAT-19`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L311))

```
railfog/
├── apps/               # Service processes and daemons
│   ├── api/            # Control plane server (railfog-control)
│   ├── gateway/        # Reverse proxy and ingress rate limiter
│   ├── runtime/        # Data plane server (railfog-runtime)
│   └── worker/         # Background queue consumer daemon
├── cli/                # Developer command-line interface ('rail')
├── docs/               # Audited specs, contracts, and ADRs
│   └── contracts/      # PLAT, FN, KV, OBJ, Q spec-locks
├── infra/              # Container specifications & orchestration
├── packages/           # Foundational modular packages (@railfog/*)
│   ├── api/            # DTOs, schemas, and REST request/response types
│   ├── auth/           # Identity context, token verification, and RBAC
│   ├── config/         # railfog.toml parser and schema validator
│   ├── core/           # Universal constants, types, and utilities
│   ├── errors/         # Canonical typed RailFogError hierarchy (PLAT-12)
│   ├── logging/        # Structured JSON logger with secret redaction (PLAT-15)
│   ├── metrics/        # Usage metrics collection, Prometheus & OTLP export
│   ├── policy/         # Capability permissions and network egress validator
│   ├── protocol/       # Internal wire protocols and serialization
│   └── testing/        # Test harness, mock providers, and fixtures
├── primitives/         # Core platform primitives
│   ├── compute/        # Artifact execution context & process contracts
│   ├── functions/      # Function handlers, context, and lifecycle types
│   ├── kv/             # Key-Value storage interfaces and atomic CAS
│   ├── objects/        # Object storage interfaces and presigned URLs
│   └── queues/         # Queue producer, consumer, and DLQ contracts
├── providers/          # Swappable infrastructure adapters
│   ├── compute/        # Deno isolate and process compute adapters
│   ├── kv/             # SQLite (local) & Deno Deploy KV (cloud)
│   ├── objects/        # LocalFS (dev) & Cloudflare R2 (cloud)
│   └── queues/         # SQLite (local) & Cloudflare Queues (cloud)
├── runtime/            # Per-request execution engine
│   ├── api/            # Runtime dispatch execution boundary
│   ├── lifecycle/      # Graceful shutdown & in-flight draining
│   ├── limits/         # Concurrency, timeout, and memory enforcers
│   ├── loader/         # Dynamic module loader & cache
│   └── sandbox/        # Worker process supervisor & isolation
├── sdk/                # Customer-facing libraries
│   └── typescript/     # Official TypeScript client & bindings
└── tests/              # Centralized test pyramid
    ├── unit/           # High-speed unit tests (isolated modules)
    ├── contract/       # Parity & structural verification tests
    ├── security/       # Adversarial exploit and isolation suites
    ├── integration/    # Multi-component collaboration tests
    ├── load/           # High-concurrency throughput & burst tests
    └── e2e/            # End-to-end full workflow soak tests
```

---

## 5. Development & Verification Workflows

All workflows are orchestrated via standard `deno task` commands defined in [`deno.json`](file:///C:/FM/railfog/deno.json):

```bash
# Code Quality Gates
deno task check          # Type check all .ts files across the workspace
deno task lint           # Run Deno linter with zero warnings
deno task fmt:check      # Check formatting compliance

# Test Suites
deno task test:unit         # Unit tests (~1,000+ tests, microsecond speed)
deno task test:contract     # Contract parity and structural tests
deno task test:security     # Adversarial penetration & secret redaction tests
deno task test:integration  # Fail-static and recovery integration tests
deno task test:load         # Burst rate limiting & concurrency tests
deno task test:e2e          # Full lifecycle end-to-end soak tests

# Comprehensive Workspace Gate
deno task verify            # Runs typecheck, lint, fmt check, unit, contract, and security
```

---

## 6. Prohibited Scopes & Anti-Patterns ([`PLAT-20`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L330))

To protect the codebase from architecture decay and speculative bloat:
1. **No Out-of-Scope Infrastructure**: Do not introduce Kubernetes, service meshes (Istio/Envoy), custom database engines, distributed consensus algorithms (Raft/Paxos), or external OAuth brokers.
2. **No Fifth Primitive**: RailFog provides exactly four primitives: Functions, KV, Objects, and Queues. Any new feature must be composed on top of these four.
3. **No Ambient Secrets**: Secrets must never be committed to disk, environment files, or logs. Secrets are resolved at invocation time and redacted automatically by `@railfog/logging`.
4. **No Synchronous Control-Plane Calls**: Never introduce a synchronous HTTP call from `railfog-runtime` to `railfog-control` on the request path.
