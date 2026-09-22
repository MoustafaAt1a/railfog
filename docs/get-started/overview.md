# Platform Overview

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [LTS 1.0 (PLAT-2, FN-1, FN-2)](../contracts/platform.contract.md)
> &nbsp;|&nbsp; **Runtime**: Deno v2.0+ Native Web Standards

RailFog is a minimalist, high-performance edge compute platform designed around
four fundamental primitives—**Functions**, **KV**, **Objects**, and
**Queues**—and one unified execution runtime.

---

## 1. The Core Philosophy

Traditional cloud architectures require orchestrating dozens of disparate
services: API gateways, serverless runtimes, queue consumers, cron daemons,
distributed caches, and blob stores.

RailFog reduces this complexity to its simplest mathematical minimum:

$$\text{Workload} = \text{Trigger} \longrightarrow \text{Function} \longrightarrow \{\text{KV}, \text{Objects}, \text{Queues}\}$$

There are no separate worker daemons, background schedulers, or cron
microservices. Every workload in RailFog—whether an incoming HTTP request, a
webhook, an asynchronous queue message, or a scheduled cron tick—is modeled as a
**Trigger** targeting an isolated **Function** (`PLAT-2`, `FN-1`, `FN-2`).

```
┌──────────────────────────────────────────────┐
│               TRIGGERS (FN-2)                │
│   HTTP Request · Queue Message · Cron · Hook │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│               FUNCTION (FN-1)                │
│   Isolated TypeScript Handler in Sandbox     │
│   Scoped RailFogContext (FN-4) Injected      │
└──────┬───────────────┼───────────────┬───────┘
       │               │               │
       ▼               ▼               ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│     KV      │ │   OBJECTS   │ │   QUEUES    │
│ (KV-1..5)   │ │ (OBJ-1..4)  │ │  (Q-1..5)   │
└─────────────┘ └─────────────┘ └─────────────┘
```

---

## 2. The Four Primitives

### 1. Functions (`FN-1` to `FN-7`)

Stateless TypeScript execution units running in isolated V8 sandboxes. Functions
export standard Web API handlers
(`(req: Request, ctx: RailFogContext) => Promise<Response>`), receive
capability-scoped bindings, and execute under hard resource ceilings.

### 2. Key-Value Storage (`KV-1` to `KV-5`)

Low-latency structured storage supporting hierarchical string tuple keys (e.g.
`["users", "123", "profile"]`), atomic Check-And-Set (`CAS`) transactions, and
explicit consistency tiers (`strong` vs `eventual`).

### 3. Object Storage (`OBJ-1` to `OBJ-4`)

Durable, S3-compatible binary storage for files, media, and datasets. Functions
generate SigV4 presigned URLs, allowing clients to transfer bytes directly to
storage without proxying through compute isolates.

### 4. Asynchronous Queues (`Q-1` to `Q-6`)

Decoupled message pipelines providing at-least-once delivery, configurable
visibility timeouts, automatic dead-letter queue (DLQ) routing, and exponential
backoff with decorrelated jitter.

---

## 3. Key Design Tenets

1. **Native Web Standards**: Functions interact exclusively with standard Web
   APIs (`Request`, `Response`, `Headers`, `ReadableStream`, `fetch`,
   `crypto.subtle`). There are no proprietary runtime SDK abstractions.
2. **Capability Injection (`PLAT-6`)**: Functions possess zero ambient
   authority. All external access (`ctx.kv`, `ctx.objects`, `ctx.queues`,
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
