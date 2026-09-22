# Queues — Dead-Letter Queues & Deduplication

> [!NOTE]
> **Documentation**: [Docs Home](../../README.md) &nbsp;|&nbsp;
> **Specification**:
> [Q-3 (DLQ), Q-4 (Idempotency)](../../contracts/queues.contract.md)
> &nbsp;|&nbsp; **Invariant**: Mandatory TTL on deduplication keys matching
> queue retention (14 days)

Queue processing operates under **at-least-once delivery** (`Q-1`). This
document describes how RailFog handles poison messages and prevents duplicate
side-effects.

---

## 1. Dead-Letter Queues (DLQ) (`Q-3`)

When a queue consumer throws an error or exceeds its execution timeout
(`timeout_ms`), the message remains on the queue. After `visibility_timeout_ms`
elapses, the message becomes visible to other consumers.

If a message fails repeatedly and exceeds `max_receives`, the supervisor moves
it to the configured `dlq`:

```toml
[queues."app:jobs"]
visibility_timeout_ms = 30000
max_receives = 5
retention_days = 4
dlq = "app:jobs-dlq"

[queues."app:jobs-dlq"]
visibility_timeout_ms = 30000
max_receives = 5
retention_days = 14
```

| Parameter               | Default        | Description                                                  |
| ----------------------- | -------------- | ------------------------------------------------------------ |
| `visibility_timeout_ms` | `30000`        | Milliseconds a message remains hidden while being processed. |
| `max_receives`          | `5`            | Maximum delivery attempts before moving to DLQ.              |
| `retention_days`        | `4` (max `14`) | Unacknowledged message lifespan before automatic deletion.   |
| `dlq`                   | —              | Target queue name for exhausted poison messages.             |

---

## 2. Idempotency Pattern (`Q-4`)

To protect against duplicate processing during network retries or worker
restarts, consumers use `withIdempotency` with a mandatory 14-day retention TTL:

```typescript
import { withIdempotency } from "@railfog/sdk";
import type { QueueConsumerHandler } from "@railfog/sdk";

interface OrderEvent {
  orderId: string;
  amount: number;
}

const consume: QueueConsumerHandler<OrderEvent> = async (message, ctx) => {
  const { orderId } = message.body;

  // Deduplication marker stored in KV with mandatory 14-day retention TTL (Q-4)
  await withIdempotency(
    ctx.kv,
    ["processed_orders", orderId],
    async () => {
      // Business logic executes exactly once per orderId
      await ctx.kv.set(["orders", orderId], { status: "settled" });
    },
    { ttlSeconds: 14 * 24 * 3600 },
  );
};

export default consume;
```

> [!IMPORTANT]
> Omitting the TTL on deduplication markers is strictly prohibited to prevent
> permanent database bloating (`KV-2`).

---

## Next Steps

- Explore the complete
  [Configuration Reference](../../configuration/manifest.md).
- Learn about the
  [TypeScript SDK Reliability Helpers](../../sdk/reliability.md).
