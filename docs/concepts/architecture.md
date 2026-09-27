# Conceptual Architecture

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-1 (Modular Monolith)`](../contracts/platform.contract.md#PLAT-1)
> &nbsp;|&nbsp; **Architecture Doctrine**:
> [`CONSTITUTION.md`](../CONSTITUTION.md)

RailFog is architected as a **modular monolith** physically deployed across a
strict **two-process physical boundary** (`PLAT-1`). This design separates the
high-throughput, low-latency request processing path from control-plane
administrative and state management tasks.

---

## 1. The Modular Monolith Principle

Rather than introducing distributed microservices with network serialization
boundaries, service meshes, and operational complexity, RailFog maintains a
single codebase composed of clean, decoupled modules with strict downward
dependency rules:

- **`primitives/*`**: Core abstractions for Functions, KV, Objects, and Queues.
- **`packages/*`**: Shared domain libraries (auth, config, errors, logging,
  metrics, policy).
- **`providers/*`**: Pluggable infrastructure adapters implementing pure
  TypeScript interfaces (SPI).
- **`runtime/*`**: The request execution kernel and sandbox dispatcher.
- **`apps/*`**: The four runnable process entrypoints.

---

## 2. The Two-Process Physical Boundary (`PLAT-1`)

At deployment time, RailFog decomposes physically into two independent server
processes:

```
                      ┌───────────────────────────────┐
                      │        Ingress Gateway        │
                      │         (apps/gateway)        │
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

### 1. The Data Plane (`apps/runtime`)

- **Responsibility**: Serves 100% of live customer requests.
- **Independence (`PLAT-8`)**: Operates fail-static from frozen in-memory
  snapshots and atomic disk caches. It never blocks on synchronous calls to the
  control plane.
- **Execution**: Dispatches invocations into sandboxed V8 execution threads with
  pre-warmed code and hard resource ceilings (`FN-5`).

### 2. The Control Plane (`apps/api`)

- **Responsibility**: Manages project configuration, compiles deployment
  manifests, signs immutable revision artifacts, encrypts secrets, and tracks
  usage billing.
- **Security**: Never executes untrusted customer code.

---

## 3. Supporting Subsystems

### Ingress Gateway (`apps/gateway`)

The public-facing edge boundary terminating external TLS, stripping internal
perimeter headers (`x-forwarded-by`, `x-railfog-trigger`), enforcing
token-bucket rate limits (`PLAT-9`), and proxying traffic over Unix Domain
Sockets (`/tmp/railfog-data.sock`).

### Worker Supervisor (`apps/worker`)

The asynchronous background task coordinator polling queue storage, managing
message visibility timeouts (`Q-3`), executing consumer functions, and routing
exhausted messages to dead-letter queues.

---

## Next Steps

- Understand the [Execution Model & Sandboxing](execution-model.md).
- Learn about [Capability Injection](capabilities.md).
- Review [Provider Abstractions](providers.md).
