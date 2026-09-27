# Compute Concept

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Conceptual Layer**: Compute &nbsp;|&nbsp; **Verb**: `transform` &nbsp;|&nbsp; **Infrastructure Mapping**: Function ([`FN-1`](../contracts/functions.contract.md#FN-1)) &nbsp;|&nbsp; **Specification**: [`CONCEPT-1`](../contracts/concepts.contract.md#CONCEPT-1), [`CONCEPT-2`](../contracts/concepts.contract.md#CONCEPT-2)

Compute is the fundamental execution and decision-making concept in RailFog.

$$\text{input} \longrightarrow \mathbf{Compute} \longrightarrow \text{output}$$

---

## 1. Definition & Role

Compute is responsible for:
- **Execution**: Running business logic in response to incoming events or HTTP requests.
- **Transformation**: Converting input representations into target outputs (`transform`).
- **Validation**: Enforcing schema constraints, payload integrity, and domain rules.
- **Coordination**: Directing data flows between State, Data, and Signal primitives.
- **Decision Making**: Branching control flow based on current state or input conditions.

Compute **does not implicitly own persistent state**. Persistent state must be explicitly delegated to State (`remember`) or Data (`persist`).

---

## 2. Conceptual vs. Infrastructure Mapping

| Layer | Terminology | Description |
| :--- | :--- | :--- |
| **Developer Concept** | **Compute** | The product abstraction representing execution and transformation. |
| **Infrastructure Primitive** | **Function** | The V8 isolate or process sandbox executing compiled customer code. |
| **Fundamental Verb** | **`transform`** | The singular action performed by Compute on incoming inputs. |

Underlying infrastructure mechanics (V8 isolate pools, process workers, gVisor sandboxes) are implementation details of the runtime daemon (`apps/runtime`). The developer works solely with the Compute abstraction.

---

## 3. SDK Mental Model

In the TypeScript SDK (`@railfog/sdk`), Compute is expressed through typed handler wrappers:

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ req, state, data, signal, json }) => {
  // 1. Transform / Validate input
  const payload = await req.json();

  // 2. Remember state
  await state.set(["records", payload.id], payload);

  // 3. Emit signal
  await signal.send({ event: "record.created", id: payload.id });

  return json({ ok: true, id: payload.id });
});
```

---

## 4. Capability Model

A Compute unit possesses **zero ambient authority** (`PLAT-6`, `CONCEPT-6`). It receives access only to the capabilities explicitly declared in its manifest configuration:

```toml
[functions.processor]
entry = "src/processor.ts"
route = "/process"

# Compute unit receives strictly scoped capabilities:
[functions.processor.permissions]
state = ["sessions"]
data = ["uploads"]
signal = ["jobs"]
```

Undeclared capabilities are structurally absent from the execution context (`PLAT-6`).

---

## 5. Composition

Compute is designed to compose with the other three primitives without requiring workflow engines or graph schedulers (`CONCEPT-4`, `CONCEPT-8`):

- **Compute + State**: Caching, counters, rate limits, session management, optimistic locks.
- **Compute + Signal**: Asynchronous background jobs, decoupled fan-out, event processing.
- **Compute + Data**: Media processing, report generation, streaming transformation.
- **Compute + State + Data + Signal**: Complete resilient distributed applications.
