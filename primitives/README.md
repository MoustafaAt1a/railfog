# Platform Primitives (`primitives/`)

> [!NOTE]
> **Philosophy**: 4 Primitives + 1 Runtime &nbsp;|&nbsp;
> **Specification**: [PLAT-20 (No Fifth Primitive)](../docs/contracts/platform.contract.md#PLAT-20) &nbsp;|&nbsp;
> **Documentation Hub**: [Primitives Guides](../docs/README.md#3-storage--compute-primitives)

This directory defines the four fundamental building blocks of RailFog—**Functions**, **KV**, **Objects**, and **Queues**—plus compute sandbox contracts.

---

## 1. The Core Mental Model

Per [`PLAT-20`](../docs/contracts/platform.contract.md#PLAT-20) and Engineering Rule 7: **Never add a fifth primitive.** All application workloads and platform services are composed entirely on top of the four primitives:

$$\text{Workload} = \text{Trigger} \longrightarrow \text{Function} \longrightarrow \{\text{KV}, \text{Objects}, \text{Queues}\}$$

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

## 2. Primitives Directory

| Primitive | Directory | Responsibilities | Spec Contract | Documentation |
|---|---|---|---|---|
| **Functions** | [`primitives/functions`](functions/) | Handler definitions (`FunctionHandler`, `QueueConsumerHandler`), lifecycle states, `RailFogContext` API. | [`functions.contract.md`](../docs/contracts/functions.contract.md) | [Functions Guide](../docs/primitives/functions/overview.md) |
| **KV** | [`primitives/kv`](kv/) | Structured state, hierarchical tuple keys, atomic CAS (`KV-3`), consistency tiers (`strong` vs `eventual`). | [`kv.contract.md`](../docs/contracts/kv.contract.md) | [KV Guide](../docs/primitives/kv/overview.md) |
| **Objects** | [`primitives/objects`](objects/) | Durable binary asset store, S3 compatibility, SigV4 presigned direct transfers (`OBJ-3`). | [`objects.contract.md`](../docs/contracts/objects.contract.md) | [Objects Guide](../docs/primitives/objects/overview.md) |
| **Queues** | [`primitives/queues`](queues/) | Decoupled message passing, at-least-once delivery, visibility timeouts, dead-letter queue routing (`Q-3`). | [`queues.contract.md`](../docs/contracts/queues.contract.md) | [Queues Guide](../docs/primitives/queues/overview.md) |
| **Compute** | [`primitives/compute`](compute/) | Sandboxed isolate execution contracts, resource limit envelopes (`FN-5`), pre-warm API. | [`platform.contract.md`](../docs/contracts/platform.contract.md#PLAT-4) | [Execution Model](../docs/architecture/execution-model.md) |

---

## 3. Architectural Invariants

1. **Contracts, Not Implementations**: `primitives/*` contains purely domain interfaces, types, and validation rules. It never contains database drivers, network clients, or vendor-specific code.
2. **Capability Injection Scoping ([`PLAT-6`](../docs/contracts/platform.contract.md#PLAT-6))**: Function handlers receive instances of bindings that are strictly pre-scoped to their declared permissions (e.g. `KVBinding` is restricted to declared namespace prefixes).
3. **Zero Bandwidth Proxying ([`OBJ-3`](../docs/contracts/objects.contract.md#OBJ-3))**: Functions never proxy multi-megabyte object bytes. Binary uploads stream directly between clients and object storage via presigned URLs.
