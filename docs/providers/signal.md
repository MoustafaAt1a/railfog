# Signal Providers

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Conceptual Layer**: Signal &nbsp;|&nbsp; **Specification**:
> [`Q-1`](../contracts/queues.contract.md#Q-1) to [`Q-6`](../contracts/queues.contract.md#Q-6),
> [`PLAT-16`](../contracts/platform.contract.md#PLAT-16)

Signal providers implement asynchronous message communication, buffering, and background job queues for RailFog applications.

In the infrastructure layer, Signal maps to the **Queue** primitive, managed via the `QueueProvider` SPI.

---

## 1. The QueueProvider SPI

All Signal backends implement the `QueueProvider` interface defined in `primitives/`:

```typescript
export interface QueueProvider {
  /** Dispatches a single message with optional delivery delay. */
  send<T = unknown>(
    body: T,
    options?: { delay?: number },
  ): Promise<{ id: string }>;

  /** Atomically dispatches a batch of messages. */
  sendBatch<T = unknown>(
    messages: readonly { body: T; delay?: number }[],
  ): Promise<{ ids: string[] }>;

  /** Leases messages for processing with visibility timeout. */
  receive<T = unknown>(options?: {
    batchSize?: number;
    visibilityTimeoutMs?: number;
  }): Promise<QueueMessage<T>[]>;

  /** Confirms successful processing, deleting the message from the queue. */
  ack(messageId: string): Promise<void>;

  /** Returns an in-flight message back to the queue for immediate or delayed redelivery. */
  nack(messageId: string): Promise<void>;
}
```

---

## 2. Supported Signal Backends

### 2.1 SQLite Queue (`SqliteQueueProvider`)
- **Use Case**: Default local development (`rail dev`) and single-node instances.
- **Engine**: SQLite table using indexed `visible_at`, `attempts`, and `status` columns with WAL concurrency.
- **Leasing**: Transactional atomic leases using `UPDATE ... SET visible_at = ? WHERE id = ?`.

### 2.2 Redis Streams (`RedisQueueProvider`)
- **Use Case**: Low-latency, high-throughput microservice messaging.
- **Consumer Groups**: Leverages Redis consumer groups (`XREADGROUP`, `XACK`) with dead-letter stream forwarding.

### 2.3 Cloudflare Queues (`CloudflareQueueProvider`)
- **Use Case**: Edge event routing and integration with serverless worker consumers.
- **Batch Processing**: Automatically batches pull requests to optimize consumer invocations.

### 2.4 AWS SQS (`SQSQueueProvider`)
- **Use Case**: Enterprise message workflows and managed compliance backends.
- **Features**: Native dead-letter queues (`RedrivePolicy`), message deduplication, and visibility extension.

---

## 3. Delivery Guarantees & DLQ Routing (`Q-1`, `Q-3`)

Signal providers implement standard asynchronous messaging guarantees:

- **At-Least-Once Delivery (`Q-1`)**: Messages are guaranteed to arrive at least once. Duplicate deliveries can occur during network partitions or crashes. Applications achieve exactly-once processing via `withIdempotency` or `consumer({ idempotent: true })` (`Q-4`).
- **Visibility Timeout (`Q-3`)**: When a consumer leases a message, it becomes invisible to other consumers for the configured duration (default: 30 seconds). If processing fails or times out, the message becomes visible again.
- **Dead-Letter Queue (`dlq`) (`Q-3`)**: When delivery attempts exceed `max_receives` (default: 5), the provider forwards the poison message to the declared DLQ.
