# RailFog

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Specification: LTS 1.0 Strict](https://img.shields.io/badge/Specification-LTS%201.0%20Strict-brightgreen.svg)](docs/contracts/platform.contract.md)
[![Runtime: Deno v2](https://img.shields.io/badge/Runtime-Deno%20v2%2B-black.svg)](https://deno.land)
[![Architecture: Modular Monolith](https://img.shields.io/badge/Architecture-Modular%20Monolith-orange.svg)](docs/architecture/overview.md)

**RailFog** is a lightweight, high-performance edge compute and application platform built entirely on native Web Standards (`Request`, `Response`, `ReadableStream`, Web Crypto, `URLPattern`). It provides strict capability-based isolation and four fundamental primitives: **Functions**, **KV**, **Objects**, and **Queues**.

$$\text{Workload} = \text{Trigger} \longrightarrow \text{Function} \longrightarrow \{\text{KV}, \text{Objects}, \text{Queues}\}$$

---

## Architecture Overview

RailFog is architected as a **modular monolith** with a strict **two-process physical deployment topology** ([`PLAT-1`](docs/contracts/platform.contract.md#PLAT-1)):

```
                           ┌───────────────────────────────┐
                           │        Ingress Gateway        │
                           │         (apps/gateway)        │
                           │   Token Bucket Rate Limiter   │
                           │   Perimeter Header Normalizer │
                           └───────────────┬───────────────┘
                                           │
                    ┌──────────────────────┴──────────────────────┐
                    │ (Unix Domain Socket / TCP IPC)              │ (REST / JSON)
                    ▼                                             ▼
     ┌─────────────────────────────┐               ┌─────────────────────────────┐
     │      Data Plane Daemon      │               │     Control Plane Daemon    │
     │      (railfog-runtime)      │               │      (railfog-control)      │
     │       [apps/runtime]        │               │         [apps/api]          │
     ├─────────────────────────────┤               ├─────────────────────────────┤
     │ • Fail-Static Route Router  │               │ • Deployments & Revisions   │
     │ • Memory & Disk Snapshot    │◄──────────────│ • Capability Matrix Resolver│
     │ • Pre-Warmed Sandboxes      │  Periodic     │ • Dynamic Secrets Vault     │
     │ • Per-Invocation Deadlines  │  Poll (PLAT-8)│ • Telemetry & Usage Ledger  │
     │ • Zero-Copy Frame Handling  │               │ • Admin Web Console & Auth  │
     └──────────────┬──────────────┘               └─────────────────────────────┘
                    │
                    ▼
     ┌─────────────────────────────┐
     │     Background Worker       │
     │       (apps/worker)         │
     ├─────────────────────────────┤
     │ • Queue Consumer Supervisor │
     │ • Exponential Backoff Retry │
     │ • DLQ Routing & Poison Ack  │
     └─────────────────────────────┘
```

### Key Architectural Invariants
1. **Trigger -> Function Model ([`PLAT-2`](docs/contracts/platform.contract.md#PLAT-2), [`FN-1`](docs/contracts/functions.contract.md#FN-1), [`FN-2`](docs/contracts/functions.contract.md#FN-2))**: All workloads (HTTP requests, queue messages, cron schedules, webhooks) are triggers invoking isolated TypeScript handlers.
2. **Fail-Static Availability ([`PLAT-8`](docs/contracts/platform.contract.md#PLAT-8))**: The data plane never calls the control plane synchronously on the request path. It routes traffic strictly from memory snapshots and atomic disk caches.
3. **Capability Injection ([`PLAT-6`](docs/contracts/platform.contract.md#PLAT-6), [`PLAT-15`](docs/contracts/platform.contract.md#PLAT-15))**: Functions receive zero ambient authority (`Deno.env` is restricted). Injected bindings (`ctx.kv`, `ctx.objects`, `ctx.queues`, `ctx.env`) are physically scoped at deploy time.
4. **Direct Storage Transfers ([`OBJ-3`](docs/contracts/objects.contract.md#OBJ-3))**: Functions generate SigV4 presigned URLs via `ctx.objects.presign(...)`, enabling clients to upload and download directly to S3/R2 storage without bandwidth proxying.
5. **Local / Production Parity ([`PLAT-17`](docs/contracts/platform.contract.md#PLAT-17))**: Local development (`rail dev`) uses SQLite and filesystem adapters implementing the exact same provider contracts used in cloud production.

---

## Quickstart

### 1. Install the CLI (`rail`)

#### Global Deno Install (Recommended)
```bash
deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts
```

Or clone the repository and run:
```bash
deno task install
```

#### Standalone Native Binary (Zero Prerequisites)
Compile a self-contained executable for your platform:
```bash
deno compile -A -o rail cli/main.ts
```

---

### 2. Scaffold and Run a Project

```bash
# Initialize a new project interactively
rail init my-app
cd my-app

# Start the local development server with hot reload
rail dev

# Statically validate configuration and entrypoints
rail check

# Authenticate with the RailFog control plane
rail login

# Deploy revision to production
rail deploy
```

---

## Developer Tooling & CLI Commands

The `rail` CLI provides comprehensive local development, validation, deployment, and operational tooling ([`PLAT-19`](docs/contracts/platform.contract.md#PLAT-19)):

### Project Scaffolding & Inspection
- **`rail init`**: Scaffolds a new project with starter function handlers, TypeScript configuration, and `railfog.toml`.
- **`rail add`**: Adds SDK bindings or storage dependencies (`sdk`, `kv`, `objects`, `queues`) to `deno.json`.
- **`rail status`**: Inspects deployed functions, active revisions, and configured route mappings.
- **`rail check`**: Statically analyzes `railfog.toml`, entrypoint files, and computes route specificity scores ([`PLAT-11`](docs/contracts/platform.contract.md#PLAT-11)).
- **`rail doctor`**: Diagnoses local environment, Deno permissions, and network connectivity.
- **`rail simulate`**: Dry-runs HTTP requests against route specificity resolution offline.

### Local Development
- **`rail dev`**: Boots the local development server with SQLite KV/Queues, local filesystem storage, and instant hot-reload ([`PLAT-17`](docs/contracts/platform.contract.md#PLAT-17)).

### Secrets Management
- **`rail secrets`**: Manages capability-scoped encrypted secrets resolved dynamically via `ctx.env` ([`PLAT-15`](docs/contracts/platform.contract.md#PLAT-15)).
  ```bash
  rail secrets set <KEY> [VALUE] [--file <path>]
  rail secrets list
  rail secrets delete <KEY>
  ```

### Deployment & Operations
- **`rail deploy`**: Packages TypeScript handlers, computes SHA-256 hashes, creates immutable deployment revisions ([`FN-3`](docs/contracts/functions.contract.md#FN-3)), and flips the live traffic pointer.
- **`rail rollback`**: Atomically flips the live traffic pointer back to a prior verified revision without rebuilding.
- **`rail undeploy`**: Deactivates live revision traffic and releases allocated runtime isolate resources.
- **`rail logs`**: Streams and filters structured JSON runtime logs in real-time ([`PLAT-13`](docs/contracts/platform.contract.md#PLAT-13)) with automatic secret redaction.

### Disaster Recovery & State Migration
- **`rail export`**: Exports project configuration, revision history, and KV state into an encrypted backup archive.
- **`rail import`**: Restores project configuration, revisions, and state from a backup archive.

### CLI Self-Upgrade
- **`rail --version`** / **`rail -v`**: Displays current semantic CLI version.
- **`rail update`** / **`rail upgrade`**: Upgrades the CLI in-place to the latest release, git ref, or compiles a native binary.

---

## Writing Functions with `@railfog/sdk`

### Ergonomic HTTP Handler
```typescript
import { handle } from "@railfog/sdk";

export default handle(async ({ req, kv }) => {
  const visitors = ((await kv.get<number>(["stats", "visitors"])) ?? 0) + 1;
  await kv.set(["stats", "visitors"], visitors);
  return { ok: true, visitors };
});
```

### Queue Consumer with Mandatory Deduplication
```typescript
import type { QueueConsumerHandler } from "@railfog/sdk";
import { withIdempotency } from "@railfog/sdk";

interface OrderTask {
  orderId: string;
}

const consume: QueueConsumerHandler<OrderTask> = async (message, ctx) => {
  const { orderId } = message.body;

  // Deduplication with mandatory 14-day retention TTL (Q-4)
  await withIdempotency(
    ctx.kv,
    ["processed_orders", orderId],
    async () => {
      await ctx.kv.set(["orders", orderId], { status: "processed" });
    },
    { ttlSeconds: 14 * 24 * 3600 },
  );
};

export default consume;
```

---

## Documentation Hub

Explore the full documentation suite organized in Cloudflare / AWS documentation architecture:

- [**Documentation Master Portal**](docs/README.md) — Documentation index and category overview.
- [**5-Minute Quickstart**](docs/get-started/quickstart.md) — Scaffolding, local development, and deploying your first project.
- [**System Architecture & Internals**](docs/architecture/overview.md) — Deep architectural blueprint, fail-static snapshots, pre-warmed isolates, and UDS IPC.
- [**Configuration Reference (`railfog.toml`)**](docs/configuration/manifest.md) — Full manifest specification for functions, limits, permissions, and routes.
- [**TypeScript SDK Developer Guide**](docs/sdk/overview.md) — Guide to developing with `@railfog/sdk`, storage primitives, and reliability helpers.
- [**Command-Line Interface Reference**](docs/cli/commands.md) — Complete manual for all `rail` commands and flags.
- [**Platform Constitution**](docs/reference/constitution.md) — Architectural doctrine: SOLID + OOP at boundaries vs DOD in hot paths.
- [**Canonical Glossary**](docs/reference/glossary.md) — Domain terminology and acronym definitions.
- [**Formal LTS Specifications**](docs/contracts/) — Mathematical platform specifications and invariants.
- [**Architecture Decision Records**](docs/adr/) — Historical record of platform architecture decisions.

---

## License

MIT License. Copyright (c) 2026 Moustafa Atia.
