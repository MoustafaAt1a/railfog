import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { delay } from "@std/async";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";

function setupProvider(): SQLiteQueueProvider {
  // Use in-memory SQLite for tests
  return new SQLiteQueueProvider(":memory:");
}

Deno.test("SQLiteQueueProvider - basic send/receive/ack flow", async () => {
  const provider = setupProvider();

  const { id } = await provider.send({ hello: "world" });
  assert(id);

  const msg = await provider.receive();
  assert(msg);
  assertEquals(msg.id, id);
  assertEquals(msg.body, { hello: "world" });
  assertEquals(msg.attempts, 1);

  await provider.ack(id);

  const msg2 = await provider.receive();
  assertEquals(msg2, null);
});

Deno.test("SQLiteQueueProvider - sendBatch sends multiple messages", async () => {
  const provider = setupProvider();

  const ids = await provider.sendBatch([{ a: 1 }, { b: 2 }]);
  assertEquals(ids.length, 2);

  const msg1 = await provider.receive();
  const msg2 = await provider.receive();
  const msg3 = await provider.receive();

  assert(msg1);
  assert(msg2);
  assertEquals(msg3, null);

  assert([ids[0].id, ids[1].id].includes(msg1.id));
  assert([ids[0].id, ids[1].id].includes(msg2.id));
  assertNotEquals(msg1.id, msg2.id);
});

Deno.test("SQLiteQueueProvider - delay support (Q-2)", async () => {
  const provider = setupProvider();

  await provider.send({ delayed: true }, { delay: 1 }); // 1 second delay

  const msg1 = await provider.receive();
  assertEquals(msg1, null, "Message should not be receivable yet");

  await delay(1100); // Wait for delay to pass

  const msg2 = await provider.receive();
  assert(msg2);
  assertEquals(msg2.body, { delayed: true });
});

Deno.test("SQLiteQueueProvider - validation fails for delay > 900s", async () => {
  const provider = setupProvider();

  await assertRejects(
    async () => {
      await provider.send({ too: "delayed" }, { delay: 901 });
    },
    Error,
    "VALIDATION_FAILED",
  );
});

Deno.test("SQLiteQueueProvider - validation fails for payload > 128KB", async () => {
  const provider = setupProvider();

  // 128 KB = 131072 bytes. Create payload strictly larger.
  const largePayload = "a".repeat(131073);

  await assertRejects(
    async () => {
      await provider.send({ largePayload });
    },
    Error,
    "PAYLOAD_TOO_LARGE",
  );
});

Deno.test("SQLiteQueueProvider - redelivery state machine & visibility timeout", async () => {
  const provider = setupProvider();

  const { id } = await provider.send({ redelivery: true });

  const msg1 = await provider.receive({ visibilityTimeoutMs: 300 });
  assert(msg1);
  assertEquals(msg1.id, id);
  assertEquals(msg1.attempts, 1);

  // Message should be hidden during visibility timeout
  const msgHidden = await provider.receive();
  assertEquals(msgHidden, null);

  // Wait for visibility timeout to elapse
  await delay(400);

  // Receive again, attempts should be incremented
  const msg2 = await provider.receive({ visibilityTimeoutMs: 300 });
  assert(msg2);
  assertEquals(msg2.id, id);
  assertEquals(msg2.attempts, 2);

  await provider.ack(id);
});

Deno.test("SQLiteQueueProvider - dead-letter queue routing on max_receives", async () => {
  const provider = setupProvider();

  const { id } = await provider.send({ dlq: true });

  // max_receives is default 5.
  // We need to receive it 5 times and let it timeout each time.
  for (let i = 1; i <= 5; i++) {
    const msg = await provider.receive({ visibilityTimeoutMs: 100 });
    assert(msg, `Should receive message on attempt ${i}`);
    assertEquals(msg.attempts, i);
    await delay(150); // Wait for timeout
  }

  // Next receive on main queue should be null (routed to DLQ instead of redelivered)
  const msgMain = await provider.receive();
  assertEquals(msgMain, null, "Message should no longer be on main queue");

  // Should be receivable from DLQ
  const dlqMsg = await provider.deadLetter.receive();
  assert(dlqMsg, "Message should be in the dead-letter queue");
  assertEquals(dlqMsg.id, id);
});
