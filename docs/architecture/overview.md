# Architecture Overview & Process Topology

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [PLAT-1 (Modular Monolith)](../contracts/platform.contract.md#PLAT-1)
> &nbsp;|&nbsp; **Deployment Model**: 2-Process Physical Boundary

RailFog is architected as a **modular monolith** deployed across a strict
**two-process physical boundary** (`PLAT-1`). This design separates
latency-critical customer request processing from control-plane management
tasks.

---

## 1. Process Topology Diagram

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

## 2. Process Breakdown

### 2.1 Ingress Gateway (`apps/gateway`)

The public-facing edge entrypoint:

- **Port**: `TCP 8080`.
- **TLS Termination & Sanitization**: Strips internal perimeter headers
  (`x-forwarded-by`, `x-railfog-trigger`, `x-railfog-call-depth`,
  `x-railfog-invocation-id`) via zero-allocation WHATWG `Headers.delete()`.
- **Ingress Rate Limiting (`PLAT-9`)**: Token bucket per IP address, returning
  `429 RATE_LIMITED` with `Retry-After` on exhaustion.
- **Fast IPC Forwarding**: Forwards valid traffic to the Data Plane via Unix
  Domain Socket (`/tmp/railfog-data.sock`) or local TCP.

### 2.2 Data Plane Runtime (`apps/runtime`)

The request routing and execution daemon:

- **Socket / Port**: `UDS /tmp/railfog-data.sock` (POSIX) or `TCP 8081`.
- **In-Memory Snapshot Evaluation**: Routes incoming URLs against the active
  configuration snapshot in RAM using `PLAT-11` specificity scoring.
- **Capability Context Injection (`PLAT-6`)**: Generates fresh, isolated
  `RailFogContext` instances with capability-scoped bindings for each
  invocation.
- **Isolate Sandboxing (`PLAT-4`)**: Dispatches executions into sandboxed V8
  execution threads or sub-processes under hard resource limits (`FN-5`).

### 2.3 Control Plane API (`apps/api`)

The administrative management daemon:

- **Port**: `TCP 8082`.
- **Deployment Compilation (`PLAT-3`)**: Ingests `railfog.toml`, resolves
  capability matrices, encrypts secrets, and produces immutable revision records
  (`FN-3`).
- **Snapshot Distribution (`PLAT-8`)**: Distributes content-addressed snapshots
  to Data Plane nodes.
- **Telemetry & Billing Aggregation**: Aggregates CPU millisecond and storage
  byte usage records into tenant billing ledgers.

### 2.4 Worker Supervisor (`apps/worker`)

The asynchronous background task coordinator:

- **Queue Poller**: Polls storage queues, respects visibility timeouts (`Q-3`),
  and dispatches messages to consumer functions.
- **Retry Coordinator (`Q-5`)**: Applies exponential backoff with decorrelated
  jitter.
- **Dead-Letter Queue (DLQ) Router**: Relocates failing messages to the
  configured DLQ when `max_receives` is exceeded.

---

## 3. Fail-Static Snapshot Caching (`PLAT-8`)

The data plane **never makes synchronous calls to the control plane on the
customer request path**.

```
Normal Operation:
Control Plane ──(Snapshot Ingestion)──► Data Plane RAM ──► Disk (.railfog/snapshot.json)
                                               ▲
Control Plane Outage:                          │
Control Plane [DOWN / UNREACHABLE]             │
Data Plane ──(Atomic Disk Cache Fallback)──────┘ ──► 100% Traffic Served
```

If the control plane daemon restarts or experiences a network partition:

1. `railfog-runtime` detects the polling failure and logs a warning.
2. The runtime continues serving live traffic from its immutable memory
   snapshot.
3. On node cold boot during a partition, the runtime restores configuration
   state from `.railfog/snapshot.json`.

---

## Next Steps

- Learn about [Sandboxed Execution & Capability Injection](execution-model.md).
- Read about [High-Performance Data-Plane Optimizations](performance.md).
