<p align="center">
  <img src="assets/train-logo.svg" alt="RailFog Train Logo" width="300" />
</p>

# RailFog

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Specification: LTS Strict](https://img.shields.io/badge/Specification-LTS%20Strict-brightgreen.svg)](docs/contracts/platform.contract.md)
[![Runtime: Deno v2](https://img.shields.io/badge/Runtime-Deno%20v2%2B-black.svg)](https://deno.land)
[![Architecture: Modular Monolith](https://img.shields.io/badge/Architecture-Modular%20Monolith-orange.svg)](docs/architecture/overview.md)

**RailFog** is a lightweight application infrastructure platform built on
native Web Standards (`Request`, `Response`, `ReadableStream`, Web Crypto,
`URLPattern`). It reduces application architecture to four fundamental concepts:
**Compute**, **State**, **Data**, and **Signal**, mapped to four infrastructure
primitives: **Functions**, **KV**, **Objects**, and **Queues**.

$$\mathbf{Compute} \ (\text{Function}) \longleftrightarrow \mathbf{State} \ (\text{KV}) \longleftrightarrow \mathbf{Data} \ (\text{Object}) \longleftrightarrow \mathbf{Signal} \ (\text{Queue})$$

---

## Architecture Overview

RailFog is architected as a **modular monolith** with a strict **two-process
physical deployment topology**
([`PLAT-1`](docs/contracts/platform.contract.md#PLAT-1)):

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

1. **Trigger -> Function Model
   ([`PLAT-2`](docs/contracts/platform.contract.md#PLAT-2),
   [`FN-1`](docs/contracts/functions.contract.md#FN-1),
   [`FN-2`](docs/contracts/functions.contract.md#FN-2))**: All workloads (HTTP
   requests, queue messages, cron schedules, webhooks) are triggers invoking
   isolated TypeScript handlers.
2. **Fail-Static Availability
   ([`PLAT-8`](docs/contracts/platform.contract.md#PLAT-8))**: The data plane
   never calls the control plane synchronously on the request path. It routes
   traffic strictly from memory snapshots and atomic disk caches.
3. **Capability Injection
   ([`PLAT-6`](docs/contracts/platform.contract.md#PLAT-6),
   [`PLAT-15`](docs/contracts/platform.contract.md#PLAT-15),
   [`CONCEPT-6`](docs/contracts/concepts.contract.md#CONCEPT-6))**: Functions
   receive zero ambient authority (`Deno.env` is restricted). Injected capabilities
   (`ctx.state`, `ctx.data`, `ctx.signal`, `ctx.env`) are scoped at deploy time.
4. **Direct Storage Transfers
   ([`OBJ-3`](docs/contracts/objects.contract.md#OBJ-3))**: Functions generate
   SigV4 presigned URLs via `ctx.data.presign(...)`, enabling clients to
   upload and download directly to S3/R2 storage without bandwidth proxying.
5. **Local / Production Parity
   ([`PLAT-17`](docs/contracts/platform.contract.md#PLAT-17))**: Local
   development (`rail dev`) uses SQLite and filesystem adapters implementing the
   exact same provider contracts used in cloud production.

---

## Quickstart

### 1. Install the CLI (`rail`)

#### Global Deno Install (Recommended)

```bash
deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts
```

Or from a local cloned repository:

```bash
deno task install
```

#### Standalone Native Binary (Zero Prerequisites)

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

The `rail` CLI provides comprehensive local development, validation, deployment,
and operational tooling
([`PLAT-19`](docs/contracts/platform.contract.md#PLAT-19)):

### Project Scaffolding & Inspection

- **`rail init`**: Scaffolds a new project with starter function handlers,
  TypeScript configuration, and `railfog.toml`.
- **`rail status`**: Inspects deployed functions, active revisions, and
  configured route mappings.
- **`rail check`**: Statically analyzes `railfog.toml`, entrypoint files, and
  computes route specificity scores
  ([`PLAT-11`](docs/contracts/platform.contract.md#PLAT-11)).
- **`rail doctor`**: Diagnoses local environment, Deno permissions, and network
  connectivity.
- **`rail simulate`**: Dry-runs HTTP requests against route specificity
  resolution offline.
- **`rail add`**: Adds SDK bindings or storage dependencies (`sdk`, `kv`,
  `objects`, `queues`) to `deno.json`.

### Local Development

- **`rail dev`**: Boots the local development server with SQLite KV/Queues,
  local filesystem storage, and instant hot-reload
  ([`PLAT-17`](docs/contracts/platform.contract.md#PLAT-17)).

### Secrets Management

- **`rail secrets`**: Manages capability-scoped encrypted secrets resolved
  dynamically via `ctx.env`
  ([`PLAT-15`](docs/contracts/platform.contract.md#PLAT-15)).
  ```bash
  rail secrets set <KEY> [VALUE] [--file <path>]
  rail secrets list
  rail secrets delete <KEY>
  ```

### Deployment & Operations

- **`rail deploy`**: Packages TypeScript handlers, computes SHA-256 hashes,
  creates immutable deployment revisions
  ([`FN-3`](docs/contracts/functions.contract.md#FN-3)), and flips the live
  traffic pointer.
- **`rail rollback`**: Atomically flips the live traffic pointer back to a prior
  verified revision without rebuilding.
- **`rail undeploy`**: Deactivates live revision traffic and releases allocated
  runtime isolate resources.
- **`rail logs`**: Streams and filters structured JSON runtime logs in real-time
  ([`PLAT-13`](docs/contracts/platform.contract.md#PLAT-13)) with automatic
  secret redaction.

### Disaster Recovery & State Migration

- **`rail export`**: Exports project configuration, revision history, and KV
  state into an encrypted backup archive.
- **`rail import`**: Restores project configuration, revisions, and state from a
  backup archive.

### Maintenance & Telemetry

- **`rail usage`**: Displays resource consumption and itemized cost
  calculations.
- **`rail compare`**: Displays architectural comparisons against other platforms
  in the terminal.
- **`rail upgrade`**: Upgrades the CLI in-place to the latest release or
  compiles from a git ref.

---

## Architectural Comparison

| Architectural Dimension      | RailFog (v0.9.2)                                      | AWS Lambda                                               | Cloudflare Workers                      |
| ---------------------------- | ----------------------------------------------------- | -------------------------------------------------------- | --------------------------------------- |
| **Execution Sandbox**        | V8 Execution Isolates                                 | MicroVMs (Firecracker)                                   | V8 Isolates                             |
| **Security Model**           | Capability Injection (3-line TOML manifest)           | IAM Roles, ARNs & JSON Policies                          | Proprietary Resource Bindings           |
| **Local Development Parity** | Embedded SQLite & Filesystem digital-twin (`PLAT-17`) | LocalStack emulation container                           | Miniflare local emulator                |
| **Storage Architecture**     | 4 Unified Primitives (Compute, State, Data, Signal)   | Disjoint service matrix (S3, DynamoDB, SQS, ElastiCache) | Disparate services (KV, R2, Queues, D1) |
| **Routing Model**            | Deterministic Mathematical Specificity (`PLAT-11`)    | API Gateway route regex rules                            | Manual request router in customer code  |
| **SDK Runtime Dependencies** | Zero external dependencies (Native Web Standards)     | Multi-package `@aws-sdk/*` distributions                 | Custom global service bindings          |
| **Unit Testing Model**       | In-memory mock context (`createMockContext`)          | Client mocking libraries (`aws-sdk-client-mock`)         | Local runtime daemons                   |

---

## Writing Functions with `@railfog/sdk`

### 1. Minimal Compute Handler (`compute` / `handle`)

```typescript
import { compute, type HandlerContext } from "@railfog/sdk";

export default compute(async (c: HandlerContext) => {
  const count = ((await c.state.get<number>(["stats", "visitors"])) ?? 0) + 1;
  await c.state.set(["stats", "visitors"], count);

  return c.json({
    message: "Hello from RailFog!",
    visitors: count,
  });
});
```

---

### 2. Multi-Route Handler (`api`)

```typescript
import { api, type HandlerContext } from "@railfog/sdk";

export default api({
  "GET /users": async (c: HandlerContext) => {
    const users = (await c.state.get(["users"])) ?? [];
    return c.json({ users });
  },

  "POST /users": async (c: HandlerContext) => {
    const user = await c.body<{ name: string }>();
    const id = crypto.randomUUID();
    await c.state.set(["users", id], { id, name: user.name });
    // Emit asynchronous signal via Signal primitive
    await c.signal.send({ event: "user_created", id });
    return c.json({ id, name: user.name }, 201);
  },
});
```

---

### 3. Background Queue Consumer (`consumer`)

```typescript
import {
  consumer,
  type ConsumerContext,
  type QueueMessage,
  withIdempotency,
} from "@railfog/sdk";

interface JobPayload {
  orderId: string;
}

export default consumer<JobPayload>(
  async (message: QueueMessage<JobPayload>, ctx: ConsumerContext) => {
    const { orderId } = message.body;

    // Deduplicate against redeliveries using mandatory 14-day retention TTL (Q-4) via State primitive
    await withIdempotency(
      ctx.state,
      ["processed_orders", orderId],
      async () => {
        console.log(`Processing order: ${orderId}`);
        await ctx.state.set(["orders", orderId], { status: "completed" });
      },
      { ttlSeconds: 14 * 24 * 3600 },
    );
  },
);
```

---

## Documentation

Full platform documentation is organized in [`docs/`](docs/README.md):

- [**Documentation Portal**](docs/README.md)
- [**Core Concepts (Compute, State, Data, Signal)**](docs/concepts/compute.md)
- [**TypeScript SDK (`@railfog/sdk`)**](docs/sdk/overview.md)
- [**Architecture Composition**](docs/composition/overview.md)
- [**Pluggable Providers**](docs/providers/overview.md)
- [**5-Minute Quickstart**](docs/get-started/quickstart.md)
- [**Developer Guides**](docs/guides/local-development.md)
- [**CLI Reference**](docs/reference/cli.md)
- [**Configuration Reference (`railfog.toml`)**](docs/configuration-reference.md)
- [**TypeScript SDK Guide**](docs/sdk-guide.md)
- [**Error Codes Reference (`PLAT-12`)**](docs/reference/error-codes.md)
- [**Platform Glossary**](docs/glossary.md)
- [**Architectural Constitution**](docs/CONSTITUTION.md)
- [**Formal LTS Specifications**](docs/contracts/platform.contract.md)

---

## License

RailFog is open-source software licensed under the [MIT License](LICENSE).
