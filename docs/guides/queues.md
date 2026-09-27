# Asynchronous Queues Guide

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`Q-1` to `Q-6`](../contracts/queues.contract.md) &nbsp;|&nbsp; **Delivery
> Model**: At-Least-Once Delivery

The Queues primitive provides decoupled, asynchronous message passing with
automatic retry handling, visibility timeouts, and dead-letter queue (DLQ)
routing. It is the infrastructure implementation of the **Signal** concept (`communicate`) ([`Signal Concept`](../concepts/signal.md)),
accessible in handlers via `ctx.signal` (with `ctx.queues` supported for backwards compatibility) ([`CONCEPT-2`](../contracts/concepts.contract.md#CONCEPT-2)).

---

## 1. Declaring Queues in `railfog.toml`

Queues are declared under `[queues.<name>]`:

```toml
name = "job-system"

# Ingestion API sends messages to the queue
[functions.api]
entry = "functions/api.ts"
[functions.api.permissions]
queues = ["app:jobs"]

# Processor function consumes messages from the queue
[functions.processor]
entry = "functions/processor.ts"
[functions.processor.triggers]
queue = "app:jobs"
[functions.processor.permissions]
kv = ["app:files"]

# Primary work queue
[queues."app:jobs"]
visibility_timeout_ms = 30000
max_receives = 5
retention_days = 4
dlq = "app:jobs-dlq"

# Dead-letter queue for exhausted poison messages
[queues."app:jobs-dlq"]
visibility_timeout_ms = 30000
max_receives = 5
retention_days = 14
```

### Queue Configuration Parameters (`Q-3`)

| Parameter               | Type      | Default        | Description                                                                       |
| ----------------------- | --------- | -------------- | --------------------------------------------------------------------------------- |
| `visibility_timeout_ms` | `integer` | `30000`        | Milliseconds a message remains invisible to other consumers while being processed |
| `max_receives`          | `integer` | `5`            | Delivery attempt ceiling before routing to DLQ                                    |
| `retention_days`        | `integer` | `4` (max `14`) | Days unacknowledged messages are retained before automatic deletion               |
| `dlq`                   | `string`  | —              | Target queue name for exhausted poison messages                                   |

---

## 2. Enqueuing Messages (`send`, `sendBatch`)

From an HTTP handler or cron function:

```typescript
import { compute, type HandlerContext } from "@railfog/sdk";

export default compute(async (c: HandlerContext) => {
  const { documentId } = await c.body<{ documentId: string }>();

  // 1. Send a single message via Signal primitive (Q-2)
  const { id } = await c.signal.send({
    documentId,
    timestamp: Date.now(),
  }, { delaySeconds: 10 });

  return c.json({ enqueued: true, messageId: id });
});
```

To enqueue multiple messages in a single batch:

```typescript
await c.signal.sendBatch([
  { body: { taskId: "task_1" } },
  { body: { taskId: "task_2" }, delaySeconds: 30 },
]);
```

---

## 3. Consuming Messages (`consumer`)

Functions triggered by a queue receive `QueueMessage` objects:

```typescript
import { consumer, type QueueMessage, type RailFogContext } from "@railfog/sdk";

interface DocumentJob {
  documentId: string;
}

export default consumer<DocumentJob>(
  async (message: QueueMessage<DocumentJob>, ctx: RailFogContext) => {
    const { documentId } = message.body;

    console.log(
      `Processing document ${documentId} (attempt ${message.attempts})`,
    );

    // If an error is thrown, the message will be retried up to max_receives
    // Once max_receives is exceeded, it is routed to the configured dlq
  },
);
```

---

## 4. Idempotency & Deduplication (`Q-4`)

Because queues guarantee **at-least-once delivery**, network interruptions or
consumer timeouts can result in redeliveries.

To prevent duplicate side-effects, wrap sensitive business logic in
`withIdempotency` using an atomic KV marker with a mandatory 14-day retention
TTL matching queue retention:

```typescript
import {
  consumer,
  type ConsumerContext,
  type QueueMessage,
  withIdempotency,
} from "@railfog/sdk";

export default consumer(
  async (
    message: QueueMessage<{ orderId: string; amount: number }>,
    ctx: ConsumerContext,
  ) => {
    const { orderId, amount } = message.body;

    // Deduplication marker stored in State with mandatory 14-day TTL (Q-4)
    await withIdempotency(
      ctx.state,
      ["processed_orders", orderId],
      async () => {
        // This closure executes exactly once per orderId
        await chargeCreditCard(orderId, amount);
        await ctx.state.set(["orders", orderId], { status: "paid" });
      },
      { ttlSeconds: 14 * 24 * 3600 },
    );
  },
);
```

---

## Next Steps

- Learn about [Routing Specificity](routing.md).
- Learn about [Managing Secrets](secrets.md).
