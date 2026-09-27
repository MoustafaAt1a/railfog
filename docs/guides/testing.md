# Testing Functions Guide

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Module**:
> `@railfog/sdk/testing` &nbsp;|&nbsp; **Toolchain**: Native `deno test`

RailFog provides first-class testing utilities allowing you to test functions,
routers, and consumers in-memory without starting background daemons or mocking
global fetch.

---

## 1. The In-Memory Mock Context (`createMockContext`)

The `createMockContext` helper instantiates an in-memory implementation of
`RailFogContext` (`MockRailFogContext`). It provides full implementations of
`kv`, `objects`, `queues`, and `env`, plus an inspectable `storage` property.

```typescript
import { assertEquals } from "@std/assert";
import { createMockContext } from "@railfog/sdk/testing";

Deno.test("KV get and set in-memory", async () => {
  const ctx = createMockContext({
    env: { API_KEY: "secret_123" },
    initialKv: [
      [["users", "u1"], { name: "Alice" }],
    ],
  });

  // Verify initial data
  const user = await ctx.state.get<{ name: string }>(["users", "u1"]);
  assertEquals(user?.name, "Alice");

  // Modify data
  await ctx.state.set(["users", "u2"], { name: "Bob" });

  // Direct assertion on mock storage
  assertEquals(ctx.storage.getKv(["users", "u2"]), { name: "Bob" });
});
```

---

## 2. Unit Testing an HTTP Handler

Given a function in `functions/api.ts`:

```typescript
// functions/api.ts
import { compute, type HandlerContext } from "@railfog/sdk";

export default compute(async (c: HandlerContext) => {
  const count = ((await c.state.get<number>(["hits"])) ?? 0) + 1;
  await c.state.set(["hits"], count);
  return c.json({ count });
});
```

You can test it directly:

```typescript
// tests/api_test.ts
import { assertEquals } from "@std/assert";
import { createMockContext } from "@railfog/sdk/testing";
import handler from "../functions/api.ts";

Deno.test("API handler increments visitor hits", async () => {
  const ctx = createMockContext();
  const req = new Request("https://example.com/api/hits");

  const res = await handler(req, ctx);
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.count, 1);

  // Second invocation on the same context
  const res2 = await handler(req, ctx);
  const body2 = await res2.json();
  assertEquals(body2.count, 2);
});
```

---

## 3. Unit Testing a Queue Consumer

Given a queue consumer:

```typescript
// functions/processor.ts
import type { QueueConsumerHandler } from "@railfog/sdk";

const consume: QueueConsumerHandler<{ documentId: string }> = async (
  message,
  ctx,
) => {
  const { documentId } = message.body;
  await ctx.state.set(["processed", documentId], { done: true, at: Date.now() });
};

export default consume;
```

Write a test verifying processing and storage mutations:

```typescript
// tests/processor_test.ts
import { assertEquals, assertNotEquals } from "@std/assert";
import { createMockContext } from "@railfog/sdk/testing";
import consume from "../functions/processor.ts";

Deno.test("Processor marks document as processed", async () => {
  const ctx = createMockContext();

  const message = {
    id: "msg_123",
    body: { documentId: "doc_999" },
    attempts: 1,
    timestamp: Date.now(),
  };

  await consume(message, ctx);

  const status = ctx.storage.getKv(["processed", "doc_999"]) as {
    done: boolean;
  };
  assertEquals(status.done, true);
});
```

---

## 4. Running Tests

Run the test suite using standard Deno commands:

```bash
# Run all tests in the tests/ directory
deno test -A tests/

# Run with file watching during development
deno test -A --watch tests/
```

---

## Next Steps

- Learn how to [Deploy Projects](deployment.md).
- Learn how to [Perform Instant Rollbacks](rollback.md).
