# Architectural Composition

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Architecture**: Composition &nbsp;|&nbsp; **Specification**: [`CONCEPT-4`](../contracts/concepts.contract.md#CONCEPT-4), [`CONCEPT-8`](../contracts/concepts.contract.md#CONCEPT-8)

RailFog adheres to the fundamental principle: **Complexity emerges from composition of four simple primitives.**

$$\mathbf{RailFog} = \mathbf{Compute} \times \mathbf{State} \times \mathbf{Data} \times \mathbf{Signal}$$

---

## 1. The Composition Rule

Instead of creating dedicated services or bespoke infrastructure primitives for every application pattern (caching engines, job queues, workflow coordinators, schedulers, object storage), RailFog provides four minimal, robust building blocks:

- **Compute**: Stateless transformation and decision making.
- **State**: Small, addressable, mutable state.
- **Data**: Durable, bulk binary data.
- **Signal**: Asynchronous communication.

Every high-level backend architecture is constructed by connecting these four primitives.

---

## 2. The Four Primitives Dependency Direction

Per `CONSTITUTION.md` and `CONCEPT-2`, customer code interacts strictly through conceptual capabilities:

```
┌────────────────────────────────────────────────────────┐
│                   Customer Application                 │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│              SDK Conceptual Layer (@railfog/sdk)        │
│          Compute  •  State  •  Data  •  Signal         │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│             Infrastructure Primitive Interfaces         │
│          Function  •  KV  •  Object  •  Queue          │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│                   Pluggable Providers                  │
│       Deno V8 • SQLite • Filesystem • Cloudflare • S3  │
└────────────────────────────────────────────────────────┘
```

---

## 3. Composing Real-World Architectures

See [Composition Patterns](patterns.md) for complete implementations of:
- **Cache & Rate Limiting**: `Compute + State`
- **Background Jobs & Event Fanout**: `Compute + Signal`
- **Streaming Media Processing**: `Data + Compute`
- **Event-Driven Workflows**: `Signal + Compute + State`
- **End-to-End Ingest & Export Pipeline**: `Data + Compute + State + Signal`
