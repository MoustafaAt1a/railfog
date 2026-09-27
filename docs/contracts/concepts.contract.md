# Contract — Concepts

Source: RailFog v0.9.1 Unified Four-Primitives & SDK Specification. Spec-anchor:
`docs/contracts/platform.contract.md` PLAT-2, PLAT-6.

## CONCEPT-1 — Four Fundamental Concepts

RailFog is architected from four fundamental concepts that constitute the
primary developer-facing mental model:

1. **Compute** — Execution, transformation, decision making, validation.
2. **State** — Small, addressable, mutable application state.
3. **Data** — Durable or bulk application data.
4. **Signal** — Asynchronous communication and event dispatch.

All application complexity emerges from the composition of these four concepts.
The underlying infrastructure primitives (`Function`, `KV`, `Object`, `Queue`)
are implementation mechanisms, not the conceptual product model.

## CONCEPT-2 — Two-Layer Taxonomy

RailFog maintains a strict two-layer terminology model separating developer
abstractions from underlying infrastructure primitives:

| Developer Concept | Infrastructure Primitive | Fundamental Role               | Contract Anchor              |
| :---------------- | :----------------------- | :----------------------------- | :--------------------------- |
| **Compute**       | Function                 | Execute / Transform            | `functions.contract.md` FN-1 |
| **State**         | KV                       | Remember (mutable small state) | `kv.contract.md` KV-1        |
| **Data**          | Object                   | Persist (durable bulk data)    | `objects.contract.md` OBJ-1  |
| **Signal**        | Queue                    | Communicate (async dispatch)   | `queues.contract.md` Q-1     |

The SDK and developer tools expose the Developer Layer. The runtime daemon,
isolation provider, and driver adapters operate at the Infrastructure Layer.

## CONCEPT-3 — Four Fundamental Verbs

Each concept reduces to a single, fundamental action:

- **Compute** $\rightarrow$ `transform`
- **State** $\rightarrow$ `remember`
- **Data** $\rightarrow$ `persist`
- **Signal** $\rightarrow$ `communicate`

```
Compute   ───► transform
State     ───► remember
Data      ───► persist
Signal    ───► communicate
```

## CONCEPT-4 — Composition-First Principle & Primitive Addition Test

Individual primitives are intentionally minimal and weak in isolation. Their
utility arises through composition. No fifth primitive is permitted when
composition of the existing four satisfies the application pattern.

### Canonical Compositions

- **Cache / Counter / Lock**: `Compute + State`
- **Job / Background Task**: `Compute + Signal`
- **File / Media Processing**: `Data + Compute`
- **Event-Driven Workflow**: `Signal + Compute + State + Data`

### Primitive Addition Test

Before introducing any new core primitive or runtime capability, all four
criteria must be satisfied:

1. Prove that the use case is real and verified by production workloads.
2. Prove that composition of Compute, State, Data, and Signal cannot express it.
3. Prove that the missing capability is fundamental, not a composite helper.
4. Prove that adding the primitive reduces rather than increases total platform
   complexity.

If composition can express the pattern, adding a new primitive is prohibited.

## CONCEPT-5 — Semantic Honesty & Provider Independence

RailFog abstractions simplify infrastructure operations without falsifying
underlying provider guarantees:

- If **State** does not guarantee linearizability on an eventual provider, the
  abstraction must not simulate or imply it (`kv.contract.md` KV-5).
- If **Signal** provides at-least-once delivery, the abstraction must not
  promise exactly-once delivery (`queues.contract.md` Q-1).
- If **Data** storage has eventual visibility, the SDK must not conceal it.

The platform normalizes error codes (`PLAT-12`) and connection semantics, but
never obscures guarantees required for crash safety or recovery.

## CONCEPT-6 — Conceptual Capability Scoping

Security capabilities are declared and injected at the conceptual boundary:

- A Compute unit declares access to named State, Data, and Signal resources
  (`PLAT-6`).
- Undeclared capabilities are structurally inaccessible (zero ambient
  authority).
- **Strict Mutual Exclusivity**: A function configuration must declare either
  the conceptual name (`state`, `data`, `signal`) or the infrastructure name
  (`kv`, `objects`, `queues`), never both simultaneously. Declaring dual aliases
  for the same resource kind is a deploy-time validation error (`PLAT-6`).
- **Single Namespace Principle**: A function may bind to at most one State
  namespace, at most one Data bucket, and at most one Signal target (`PLAT-6`).

## CONCEPT-7 — Data by Reference & Zero-Copy Flow

Large payloads must move by reference rather than through in-memory proxying:

- Handlers operating on **Data** must preserve streaming semantics
  (`ReadableStream`, Web Streams API).
- The SDK must never automatically buffer bulk data into memory before handing
  it to `Compute`.
- Direct uploads and downloads use presigned references (`OBJ-2`), bypassing
  compute bottlenecks whenever possible.

## CONCEPT-8 — Anti-Framework Boundary

Milestone 0.9.1 establishes the conceptual model without turning the platform or
SDK into a framework:

- Prohibited in core: Custom workflow orchestrators, saga coordinators,
  distributed graph execution engines, actor frameworks, or object-relational
  mappers (ORMs).
- Higher-level patterns remain user-composed functions connected via Signal,
  State, and Data.

---

## Banned patterns

- **Banned**: Adding a fifth primitive (e.g. "Workflows", "Tables", "Jobs",
  "Cache").
- **Banned**: Ambient provider access (`cloudflare.kv`, `aws.s3`) bypassing
  capability injection.
- **Banned**: Declaring both `state` and `kv` (or `data` and `objects`, or
  `signal` and `queues`) in the same function configuration.
- **Banned**: In-memory proxying of bulk Data objects through Compute when
  presigned references or streaming applies.
- **Banned**: Promising transactional or consensus guarantees not backed by the
  provider tier.
