# RailFog Documentation Portal

> [!NOTE]
> **Runtime**: Deno v2.0+ Native Web Standards &nbsp;|&nbsp; **Specification**:
> [LTS 1.0 Formal Contracts](contracts/platform.contract.md) &nbsp;|&nbsp;
> **Architecture**: Modular Monolith & Shared-Nothing Isolates &nbsp;|&nbsp;
> **Security**: Capability-Based (Zero Ambient Authority)

Welcome to the **RailFog Developer Documentation**. RailFog is a minimalist edge
application platform reducing cloud infrastructure to its simplest mathematical
minimum:

$$\text{Workload} = \text{Trigger} \longrightarrow \text{Function} \longrightarrow \{\text{KV}, \text{Objects}, \text{Queues}\}$$

---

## Documentation Navigation

```
docs/
├── get-started/        # Fast-track onboarding and first steps
├── architecture/       # Process topology, sandboxing, and hot-path performance
├── primitives/         # The four fundamental platform building blocks
│   ├── functions/      # Isolated execution units and resource ceilings
│   ├── kv/             # Low-latency structured state and atomic CAS
│   ├── objects/        # Durable binary storage and direct presigning
│   └── queues/         # Decoupled messaging and dead-letter handling
├── configuration/      # Declarative manifest (railfog.toml) and route matching
├── sdk/                # @railfog/sdk TypeScript API, context, and reliability
├── cli/                # Command-line interface reference and operations
└── reference/          # Constitution, domain glossary, and error codes
```

---

## 1. Getting Started

Fast-path guides to installing RailFog, creating projects, and mastering the
development loop:

- [**Platform Overview**](get-started/overview.md): The core mental model,
  primitives breakdown, and architectural tenets.
- [**5-Minute Quickstart**](get-started/quickstart.md): Install the `rail` CLI,
  scaffold a project, run the local dev server, and deploy.
- [**Project Structure**](get-started/project-structure.md): Standard file
  layout, `railfog.toml` role, and entrypoint conventions.

---

## 2. System Architecture & Internals

Engineering blueprints for understanding RailFog's runtime, security, and data
flow:

- [**System Design & Process Topology**](architecture/overview.md): The
  two-process physical deployment boundary (`PLAT-1`), Gateway, Data Plane,
  Control Plane, and fail-static snapshot caching (`PLAT-8`).
- [**Execution Model & Sandboxing**](architecture/execution-model.md): V8
  isolate sandboxes, zero ambient authority (`PLAT-6`), hard resource limits
  (`FN-5`), and SSRF egress firewalls (`PLAT-5`).
- [**Hot-Path Performance**](architecture/performance.md): Low-allocation DOD
  hot paths, zero-copy header frames (`Object.create(null)`), pre-warmed
  isolates, and Unix Domain Socket (UDS) IPC.

---

## 3. Storage & Compute Primitives

Detailed guides for RailFog's four core primitives:

### Functions

- [**Functions Overview**](primitives/functions/overview.md): The Trigger ->
  Function model, handler entrypoint signatures, and invocation triggers.
- [**Resource Limits & Quotas**](primitives/functions/limits.md): CPU
  millisecond ceilings (`cpu_ms: 200`), wall-clock timeouts, memory limits, and
  concurrency token buckets.

### Key-Value Storage (KV)

- [**KV Storage Overview**](primitives/kv/overview.md): Low-latency state,
  hierarchical tuple keys, and 256 KB size ceilings.
- [**Consistency Tiers & Atomic CAS**](primitives/kv/consistency.md): `strong`
  vs `eventual` tiers (`KV-5`), and atomic Check-And-Set optimistic concurrency
  (`KV-3`).

### Object Storage

- [**Objects Storage Overview**](primitives/objects/overview.md): Durable binary
  storage, S3 compatibility, and metadata operations.
- [**Direct Client Transfers**](primitives/objects/direct-transfers.md): The
  Zero-Bandwidth-Proxy Principle (`OBJ-3`) and SigV4 presigned upload URLs.

### Asynchronous Queues

- [**Queues Overview**](primitives/queues/overview.md): Decoupled asynchronous
  message passing with at-least-once delivery.
- [**Dead-Letter Queues & Deduplication**](primitives/queues/dead-letter-queues.md):
  Visibility timeout, poison message handling (`dlq`), and idempotency with
  mandatory 14-day TTL.

---

## 4. Configuration Reference

Authoritative guides to configuring RailFog applications:

- [**Configuration Overview**](configuration/overview.md): Declarative TOML
  manifest structure and JSON schema setup.
- [**Manifest Reference**](configuration/manifest.md): Exhaustive reference for
  every key, limit, trigger, and permission in `railfog.toml`.
- [**Route Matching & Specificity**](configuration/routes.md): The deterministic
  `PLAT-11` scoring formula
  ($2 \times \text{literal} + 1 \times \text{wildcard}$).

---

## 5. TypeScript SDK (`@railfog/sdk`)

Writing functions, consumers, and services:

- [**SDK Overview**](sdk/overview.md): Package installation, zero-dependency
  design, and ergonomic handlers (`handle`, `api`).
- [**Context & Capability Bindings**](sdk/context.md): `RailFogContext`,
  execution budget tracking (`timeRemaining()`), and scoped bindings.
- [**Reliability Helpers**](sdk/reliability.md): Exactly-once processing with
  `withIdempotency` and backoff with `withRetry`.
- [**Error Handling & Taxonomy**](sdk/errors.md): Catching and normalizing
  errors across the 10 machine-readable `PLAT-12` codes.

---

## 6. Command-Line Interface (`rail`)

Operating and managing RailFog projects:

- [**CLI Overview**](cli/overview.md): Installation, diagnostics with
  `rail doctor`, and self-upgrades with `rail upgrade`.
- [**Command Reference**](cli/commands.md): Complete alphabetical reference for
  all CLI commands (`init`, `dev`, `check`, `deploy`, `rollback`, `logs`,
  `secrets`, etc.).

---

## 7. Platform Reference & Standards

- [**Architectural Constitution**](reference/constitution.md): The Boundary
  Rule—SOLID + OOP at boundaries, Data-Oriented Design in the hot path.
- [**Platform Glossary**](reference/glossary.md): Canonical terms, definitions,
  and domain vocabulary.
- [**Error Codes Reference**](reference/error-codes.md): Complete catalog of
  `PLAT-12` error codes and HTTP mappings.
- [**Formal LTS Specifications**](contracts/): The authoritative specification
  contracts (`PLAT`, `FN`, `KV`, `OBJ`, `Q`).
- [**Architecture Decision Records**](adr/): Historical index of architectural
  decisions and trade-offs.
