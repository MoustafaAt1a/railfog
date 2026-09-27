# Composition Principle & Patterns

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Conceptual Layer**: Composition &nbsp;|&nbsp; **Specification**: [`CONCEPT-4`](../contracts/concepts.contract.md#CONCEPT-4), [`CONCEPT-8`](../contracts/concepts.contract.md#CONCEPT-8)

RailFog's power emerges not from complex individual primitives, but from their **composition**.

$$\text{Data} \longrightarrow \text{Compute} \longrightarrow \text{State} \longrightarrow \text{Signal} \longrightarrow \text{Compute} \longrightarrow \text{Data}$$

---

## 1. Composition Is the Architecture

Individual RailFog primitives are intentionally weak in isolation:
- Compute does not retain state across invocations.
- State does not store multi-gigabyte files.
- Data does not execute business logic.
- Signal does not query past messages.

By composing them, developers construct resilient, scalable distributed backends **without introducing a fifth primitive** (`CONCEPT-4`).

---

## 2. Canonical Compositions

| Pattern | Composition | Description |
| :--- | :--- | :--- |
| **Cache / Counter** | `Compute + State` | Fast in-memory state lookup and atomic counter mutations. |
| **Distributed Lock** | `Compute + State` | Lease acquisition via atomic CAS commits (`KV-3`). |
| **Asynchronous Job** | `Compute + Signal` | Offloading latency-sensitive compute to background workers. |
| **Work Pipeline** | `Compute + Signal + Compute` | Multi-stage decoupled worker transformations. |
| **File Processing** | `Data + Compute` | Streaming media transformation and thumbnail generation. |
| **Event-Driven Workflow**| `Signal + Compute + State` | State-machine progression driven by asynchronous signals. |
| **End-to-End Pipeline** | `Data + Compute + State + Signal` | Complete ingest $\to$ transform $\to$ record $\to$ notify lifecycle. |

---

## 3. End-to-End Composition Flow

The canonical worked example (`docs/contracts/worked-example.md`) demonstrates all four primitives in a single unified flow:

```
[Client] 
   │
   │ 1. Request Presigned URL
   ▼
[API Gateway] ──► [Compute: Uploader]
                         │
                         │ 2. Generate Presigned URL
                         ▼
                     [Data: Store]
   │
   │ 3. Direct Binary Upload (Zero-Proxy OBJ-3)
   ▼
[Data: Store]
   │
   │ 4. Notify Upload
   ▼
[Compute: Ingest]
   │
   │ 5. Emit Event
   ▼
[Signal: Channel]
   │
   │ 6. Queue Trigger (FN-2)
   ▼
[Compute: Worker] ◄───► [State: Dedupe & Metadata]
   │
   │ 7. Transformed Export
   ▼
[Data: Store]
```

---

## 4. The Primitive Addition Test (`CONCEPT-4`)

Before any new primitive or runtime capability is proposed, it must pass the four-part gate:

1. **Production Reality**: Prove the use case is real and verified by production workloads.
2. **Composition Inability**: Prove that composition of Compute, State, Data, and Signal genuinely cannot express it.
3. **Fundamentality**: Prove the missing capability is fundamental, not an ergonomic helper.
4. **Complexity Reduction**: Prove that adding the primitive reduces rather than increases total platform complexity.

If composition can express the pattern, adding a new primitive is prohibited.
