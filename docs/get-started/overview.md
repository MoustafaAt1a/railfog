# Platform Overview

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [LTS 1.0 (PLAT-2, FN-1, FN-2)](../contracts/platform.contract.md)
> &nbsp;|&nbsp; **Runtime**: Deno v2.0+ Native Web Standards

RailFog is a minimalist, high-performance application infrastructure platform designed around
four fundamental concepts—**Compute**, **State**, **Data**, and **Signal**—mapped to four
underlying infrastructure primitives—**Functions**, **KV**, **Objects**, and **Queues**—and one unified execution runtime.

$$\mathbf{RailFog} = \{\mathbf{Compute},\, \mathbf{State},\, \mathbf{Data},\, \mathbf{Signal}\}$$

---

## 1. The Core Philosophy

Traditional cloud architectures require orchestrating dozens of disparate
services: API gateways, serverless runtimes, queue consumers, cron daemons,
distributed caches, and blob stores.

RailFog reduces this complexity to its simplest mathematical minimum:

$$\text{Workload} = \text{Trigger} \longrightarrow \mathbf{Compute} \longrightarrow \{\mathbf{State}, \mathbf{Data}, \mathbf{Signal}\}$$

$$\begin{aligned}
\mathbf{Compute} &\longrightarrow \text{Function} && (\text{Execute / } \textit{transform}) \\
\mathbf{State} &\longrightarrow \text{KV} && (\text{Remember / } \textit{remember}) \\
\mathbf{Data} &\longrightarrow \text{Object} && (\text{Persist / } \textit{persist}) \\
\mathbf{Signal} &\longrightarrow \text{Queue} && (\text{Communicate / } \textit{communicate})
\end{aligned}$$

There are no separate worker daemons, background schedulers, or cron
microservices. Every workload in RailFog—whether an incoming HTTP request, a
webhook, an asynchronous queue message, or a scheduled cron tick—is modeled as a
**Trigger** targeting an isolated **Compute** unit (`PLAT-2`, `FN-1`, `FN-2`, [`CONCEPT-1`](../contracts/concepts.contract.md#CONCEPT-1)).

```
┌──────────────────────────────────────────────┐
│               TRIGGERS (FN-2)                │
│   HTTP Request · Queue Message · Cron · Hook │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│          COMPUTE / FUNCTION (FN-1)           │
│   Isolated TypeScript Handler in Sandbox     │
│   Scoped RailFogContext (FN-4) Injected      │
└──────┬───────────────┼───────────────┬───────┘
       │               │               │
       ▼               ▼               ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ STATE / KV  │ │ DATA/OBJECT │ │SIGNAL/QUEUE │
│ (KV-1..5)   │ │ (OBJ-1..4)  │ │  (Q-1..5)   │
└─────────────┘ └─────────────┘ └─────────────┘
```

---

## 2. The Four Concepts & Infrastructure Primitives

### 1. Compute & Functions ([`Compute Concept`](../concepts/compute.md), [`FN-1` to `FN-7`](../contracts/functions.contract.md))

Stateless execution units (`transform`) running in isolated sandboxes. Compute units
export standard Web API handlers or SDK wrappers (`compute()`, `handle()`), receive
capability-scoped bindings, and execute under hard resource ceilings.

### 2. State & Key-Value Storage ([`State Concept`](../concepts/state.md), [`KV-1` to `KV-5`](../contracts/kv.contract.md))

Low-latency structured mutable state (`remember`) supporting hierarchical string tuple keys (e.g.
`["users", "123", "profile"]`), atomic Check-And-Set (`CAS`) transactions, and
explicit consistency tiers (`strong` vs `eventual`).

### 3. Data & Object Storage ([`Data Concept`](../concepts/data.md), [`OBJ-1` to `OBJ-4`](../contracts/objects.contract.md))

Durable binary bulk storage (`persist`) for files, media, and datasets. Functions
generate SigV4 presigned URLs, allowing clients to transfer bytes directly to
storage without proxying through compute isolates (`OBJ-3`).

### 4. Signal & Asynchronous Queues ([`Signal Concept`](../concepts/signal.md), [`Q-1` to `Q-6`](../contracts/queues.contract.md))

Decoupled asynchronous message pipelines (`communicate`) providing at-least-once delivery, configurable
visibility timeouts, automatic dead-letter queue (DLQ) routing, and exponential
backoff with decorrelated jitter.

---

## 3. Key Design Tenets

1. **Native Web Standards**: Functions interact exclusively with standard Web
   APIs (`Request`, `Response`, `Headers`, `ReadableStream`, `fetch`,
   `crypto.subtle`). There are no proprietary runtime SDK abstractions.
2. **Capability Injection (`PLAT-6`)**: Functions possess zero ambient
   authority. All external access (`ctx.state`, `ctx.data`, `ctx.signal`,
   `ctx.env`) is explicitly declared in `railfog.toml` and injected at deploy
   time.
3. **Fail-Static Architecture (`PLAT-8`)**: Data plane runtime nodes operate
   independently from cached, versioned configuration snapshots. If the control
   plane is unreachable, the data plane serves 100% of live traffic without
   degradation.
4. **Zero-Bandwidth-Proxy Principle (`OBJ-3`)**: File payloads are never
   streamed through compute functions. Uploads and downloads execute directly
   between the client and durable object storage via presigned URLs.
5. **Local-to-Cloud Parity (`PLAT-17`)**: The local development loop
   (`rail dev`) uses SQLite and filesystem adapters that implement the exact
   same provider interfaces used in cloud production.

---

## 4. Next Steps

- Follow the [5-Minute Quickstart](quickstart.md) to install `rail` and deploy
  your first application.
- Learn about the [Standard Project Structure](project-structure.md).
- Dive into the [System Architecture & Internals](../architecture/overview.md).
