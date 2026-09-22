# Queues Primitive — Overview

> [!NOTE]
> **Documentation**: [Docs Home](../../README.md) &nbsp;|&nbsp;
> **Specification**: [Q-1, Q-2, Q-3](../../contracts/queues.contract.md)
> &nbsp;|&nbsp; **Delivery Model**: At-least-once delivery

The Queues primitive (`ctx.queues` / `QueueBinding`) enables decoupled
asynchronous message passing between functions, with at-least-once delivery
guarantees and automatic dead-letter routing.

---

## 1. Producer API (`ctx.queues.send`)

Functions send single messages or batches:

```typescript
import type { QueueBinding } from "@railfog/sdk";

export async function dispatchTasks(queues: QueueBinding): Promise<void> {
  // 1. Send single message with optional delivery delay up to 15 minutes (Q-2)
  const { id } = await queues.send(
    { action: "generate_thumbnail", fileId: "file_123" },
    { delay: 30 },
  );
  console.log("Enqueued message ID:", id);

  // 2. Send batch of messages atomically
  const results = await queues.sendBatch([
    { action: "send_email", userId: "u1" },
    { action: "send_email", userId: "u2" },
  ]);
}
```

> [!NOTE]
> Queue message bodies are capped at 128 KB (`Q-2`). For larger datasets, store
> the file in Object storage and pass the object key in the message body.

---

## 2. Consumer Architecture (`QueueConsumerHandler`)

A function declares a queue trigger in `railfog.toml` to automatically receive
delivered messages:

```toml
[functions.processor]
entry = "functions/processor.ts"

[functions.processor.triggers]
queue = "app:jobs"
```

The handler exports a typed consumer function:

```typescript
import type { QueueConsumerHandler } from "@railfog/sdk";

interface JobPayload {
  action: string;
  fileId: string;
}

const consume: QueueConsumerHandler<JobPayload> = async (message, ctx) => {
  console.log("Processing message:", message.id);
  console.log("Attempt number:", message.attempts);
  console.log("Payload:", message.body);
};

export default consume;
```

---

## Next Steps

- Learn about [Dead-Letter Queues & Deduplication](dead-letter-queues.md).
- Explore the [Declarative Manifest Reference](../../configuration/manifest.md).
