# Signal Concept

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Conceptual Layer**: Signal &nbsp;|&nbsp; **Verb**: `communicate` &nbsp;|&nbsp; **Infrastructure Mapping**: Queue ([`Q-1`](../contracts/queues.contract.md#Q-1)) &nbsp;|&nbsp; **Specification**: [`CONCEPT-1`](../contracts/concepts.contract.md#CONCEPT-1), [`CONCEPT-2`](../contracts/concepts.contract.md#CONCEPT-2)

Signal represents asynchronous communication and event dispatch in RailFog.

$$\text{producer} \longrightarrow \mathbf{Signal} \longrightarrow \text{consumer}$$

---

## 1. Definition & Role

Signal is responsible for:
- **Communicating**: Connecting decoupled producer and consumer Compute units asynchronously (`communicate`).
- **Buffering**: Absorbing traffic bursts and evening out ingestion loads.
- **Decoupling**: Allowing the producer to complete without waiting for heavy processing.
- **Reliability**: Managing message visibility timeouts, retry policies, and dead-letter queues (`Q-3`).

### Typical Uses
- Background jobs and asynchronous tasks
- Event-driven notifications and webhooks
- Work pipelines and multi-stage transformations
- Log and telemetry ingestion buffering

Signal **should not become a general-purpose state system or database**. Once consumed and acknowledged, messages leave the active channel.

---

## 2. Conceptual vs. Infrastructure Mapping

| Layer | Terminology | Description |
| :--- | :--- | :--- |
| **Developer Concept** | **Signal** | The product abstraction representing asynchronous message dispatch. |
| **Infrastructure Primitive** | **Queue** | Queue engine (SQLite Queues, Redis Streams, AWS SQS, Cloudflare Queues). |
| **Fundamental Verb** | **`communicate`** | The singular action performed by Signal. |

---

## 3. Disambiguation: WHATWG `AbortSignal` vs. `c.signal`

RailFog strictly decouples request lifecycle cancellation from asynchronous messaging (`CONCEPT-2`, `FN-5`):

- **`c.req.signal` (`AbortSignal`)**: Standard Web standard signal indicating client connection abort or request deadline timeout.
- **`c.signal` (`SignalBinding`)**: Asynchronous messaging capability for dispatching queue jobs.

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ req, signal, json }) => {
  // Check client request cancellation:
  if (req.signal.aborted) {
    return json({ error: "client aborted" }, 499);
  }

  // Dispatch asynchronous message via Signal capability:
  const { id } = await signal.send({
    type: "order.processed",
    orderId: "ord_100",
  });

  return json({ queued: true, signalId: id });
});
```

---

## 4. Consumer Handlers & Idempotency (`Q-4`)

Signal consumer functions receive messages through the `consumer()` wrapper:

```typescript
import { consumer } from "@railfog/sdk";

export default consumer(
  async (message, { state }) => {
    // Process message
    await state.set(["processed_orders", message.body.orderId], {
      timestamp: message.timestamp,
    });
  },
  {
    idempotent: true, // Automatically deduplicate with mandatory TTL (Q-4)
    ttlSeconds: 86400,
  },
);
```
