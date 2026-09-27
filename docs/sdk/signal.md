# SDK: Signal

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Package**: `@railfog/sdk` &nbsp;|&nbsp; **Conceptual Layer**: Signal &nbsp;|&nbsp; **Specification**: [`CONCEPT-2`](../contracts/concepts.contract.md#CONCEPT-2), [`Q-1`](../contracts/queues.contract.md#Q-1), [`Q-2`](../contracts/queues.contract.md#Q-2)

Signal represents asynchronous communication and event dispatch accessed via `c.signal` (or `c.queues`).

---

## 1. `SignalBinding` Methods

```typescript
export interface SignalBinding {
  send<T = unknown>(
    message: T,
    options?: { delay?: number },
  ): Promise<{ id: string }>;
  sendBatch<T = unknown>(messages: T[]): Promise<Array<{ id: string }>>;
}
```

---

## 2. Dispatching Signals

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ signal, json }) => {
  // Send single message
  const result = await signal.send({
    event: "user.signup",
    userId: "usr_100",
  });

  // Send batch with delay
  await signal.sendBatch([
    { event: "email.welcome", userId: "usr_100" },
    { event: "crm.sync", userId: "usr_100" },
  ]);

  return json({ messageId: result.id });
});
```

---

## 3. Consuming Signals (`consumer()`)

Queue-triggered functions consume messages via the `consumer()` wrapper:

```typescript
import { consumer, type QueueMessage } from "@railfog/sdk";

interface OrderEvent {
  orderId: string;
  amount: number;
}

export default consumer<OrderEvent>(
  async (message: QueueMessage<OrderEvent>, { state }) => {
    // Signal triggers Compute to mutate State
    await state.set(["processed_orders", message.body.orderId], {
      status: "COMPLETED",
      timestamp: message.timestamp,
    });
  },
  {
    idempotent: true, // Q-4 automatic deduplication
    ttlSeconds: 86400,
  },
);
```
