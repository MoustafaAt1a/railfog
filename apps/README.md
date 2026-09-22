# Applications (`apps/`)

> [!NOTE]
> **Topology**: Strict 2-Process Deployment Boundary &nbsp;|&nbsp;
> **Specification**: [PLAT-1 (Modular Monolith)](../docs/contracts/platform.contract.md#PLAT-1), [PLAT-8 (Fail-Static)](../docs/contracts/platform.contract.md#PLAT-8) &nbsp;|&nbsp;
> **Documentation Hub**: [System Architecture](../docs/architecture/overview.md)

This directory contains the deployable service entrypoints and daemon processes for RailFog.

---

## 1. Process Architecture & Topology

RailFog maintains a strict **two-process physical deployment boundary** in production (`PLAT-1`). High-throughput customer request execution is fully isolated from administrative control-plane operations.

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

---

## 2. Applications Directory

| Directory | Daemon Identity | Default Port / Socket | Responsibilities | Spec Anchors |
|---|---|---|---|---|
| [`apps/api`](api/) | `railfog-control` | `TCP 8082` | Deployment management, revision indexing (`FN-3`), manifest validation, capability compilation, snapshot publishing, usage billing aggregation. | [`PLAT-1`](../docs/contracts/platform.contract.md#PLAT-1), [`PLAT-3`](../docs/contracts/platform.contract.md#PLAT-3) |
| [`apps/runtime`](runtime/) | `railfog-runtime` | `UDS /tmp/railfog-data.sock` (or `TCP 8081`) | In-memory routing snapshot evaluation, capability context injection (`PLAT-6`), isolate sandboxing (`PLAT-4`), hard timeout enforcement (`FN-5`). | [`PLAT-1`](../docs/contracts/platform.contract.md#PLAT-1), [`PLAT-8`](../docs/contracts/platform.contract.md#PLAT-8) |
| [`apps/gateway`](gateway/) | `railfog-gateway` | `TCP 8080` | Public edge TLS termination, token bucket IP rate limiting (`PLAT-9`), perimeter header stripping (`x-forwarded-by`), request proxying to runtime. | [`PLAT-9`](../docs/contracts/platform.contract.md#PLAT-9), [`PLAT-10`](../docs/contracts/platform.contract.md#PLAT-10) |
| [`apps/worker`](worker/) | `railfog-worker` | Background Loop | Queue consumer supervisor, message lease visibility tracking (`Q-3`), exponential backoff retry coordination, dead-letter queue routing. | [`Q-3`](../docs/contracts/queues.contract.md#Q-3), [`FN-2`](../docs/contracts/functions.contract.md#FN-2) |

---

## 3. Operational Guarantees

1. **Fail-Static Availability (`PLAT-8`)**:
   `apps/runtime` **never makes synchronous calls to `apps/api` on the customer request path**. The Data Plane serves traffic strictly from in-memory snapshots and atomic disk caches (`.railfog/snapshot.json`). If `apps/api` crashes or is redeployed, `apps/runtime` continues serving traffic with zero downtime.
2. **Untrusted Code Sandboxing (`PLAT-4`)**:
   Customer code never executes directly in the runtime daemon. All functions execute inside sandboxed V8 execution threads or sub-processes managed by `LocalIsolationProvider`.
3. **Low-Allocation Transport**:
   On POSIX systems, `apps/gateway` communicates with `apps/runtime` via local Unix Domain Sockets, bypassing the kernel TCP/IP loopback stack and reducing latency.

---

## 4. Starting Daemons Locally

```bash
# Ingress Gateway (Port 8080)
deno run -A apps/gateway/server.ts

# Data Plane Runtime (Port 8081 or UDS)
deno run -A apps/runtime/server.ts

# Control Plane API (Port 8082)
deno run -A apps/api/server.ts

# Background Worker Daemon
deno run -A apps/worker/supervisor.ts
```
