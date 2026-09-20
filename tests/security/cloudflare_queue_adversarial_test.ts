// Spec references: PLAT-15 (Secret redaction), Q-2 (Payload & delay bounds), Q-3 (Visibility timeout state)
// Task: T-0206 (Cloudflare Queues remote provider) adversarial security audit

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { delay } from "@std/async";
import { CloudflareQueueProvider } from "../../providers/queues/cloudflare-queue-provider.ts";
import {
  InternalError,
  PayloadTooLargeError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

// ===========================================================================
// ATTACK VECTOR 1: PLAT-15 (Secret leakage & redaction)
// ===========================================================================

// Attack 1.1: Upstream 4xx/5xx responses echoing apiToken across all methods
Deno.test("Adversarial PLAT-15: upstream 4xx/5xx responses echoing apiToken are thoroughly redacted from message and stack across all methods", async () => {
  const secretToken = "super-secret-cf-token-99999";

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => {
      // Simulate remote 502 with error echoing the secret token in body and details
      return new Response(
        JSON.stringify({
          success: false,
          errors: [
            {
              code: 10001,
              message:
                `Upstream failure: Bearer ${secretToken} rejected by gateway`,
            },
          ],
        }),
        {
          status: 502,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );

  try {
    const port = server.addr.port;
    const provider = new CloudflareQueueProvider({
      accountId: "acc-sec",
      queueId: "q-sec",
      apiToken: secretToken,
      baseUrl: `http://localhost:${port}`,
    });

    const operations: Array<[string, () => Promise<unknown>]> = [
      ["send", () => provider.send({ test: 1 })],
      ["sendBatch", () => provider.sendBatch([{ test: 1 }])],
      ["receive", () => provider.receive()],
      ["ack", () => provider.ack("msg_test_123")],
    ];

    for (const [name, op] of operations) {
      let caught: unknown = null;
      try {
        await op();
      } catch (err) {
        caught = err;
      }

      assert(caught !== null, `${name}() should have failed on upstream 502`);
      assert(
        caught instanceof InternalError,
        `Expected InternalError per PLAT-12, got ${caught}`,
      );

      const msg = (caught as Error).message;
      const stack = (caught as Error).stack ?? "";

      assertFalse(
        msg.includes(secretToken),
        `${name}() error message leaked apiToken: ${msg}`,
      );
      assertFalse(
        stack.includes(secretToken),
        `${name}() error stack leaked apiToken: ${stack}`,
      );
      assert(
        msg.includes("[REDACTED]"),
        `${name}() error message should contain [REDACTED], got: ${msg}`,
      );
    }
  } finally {
    await server.shutdown();
  }
});

// Attack 1.2: Upstream 200 OK with malformed JSON embedding apiToken
Deno.test("Adversarial PLAT-15: malformed JSON response embedding apiToken is scrubbed from syntax error and stack", async () => {
  const secretToken = "token-embedded-in-raw-json-88888";

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => {
      // Return 200 with invalid JSON body embedding the token (V8 SyntaxError quotes token in message)
      return new Response(`{ "result": ${secretToken} }`, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  try {
    const port = server.addr.port;
    const provider = new CloudflareQueueProvider({
      accountId: "acc-sec",
      queueId: "q-sec",
      apiToken: secretToken,
      baseUrl: `http://localhost:${port}`,
    });

    const operations: Array<[string, () => Promise<unknown>]> = [
      ["send", () => provider.send({ ok: true })],
      ["sendBatch", () => provider.sendBatch([{ ok: true }])],
      ["receive", () => provider.receive()],
      ["ack", () => provider.ack("msg_ack_1")],
    ];

    for (const [name, op] of operations) {
      let caught: unknown = null;
      try {
        await op();
      } catch (err) {
        caught = err;
      }

      assert(caught !== null, `${name}() must throw on malformed JSON`);
      assert(caught instanceof InternalError);

      const msg = (caught as Error).message;
      const stack = (caught as Error).stack ?? "";

      assertFalse(
        msg.includes(secretToken),
        `${name}() JSON parse error leaked apiToken in message: ${msg}`,
      );
      assertFalse(
        stack.includes(secretToken),
        `${name}() JSON parse error leaked apiToken in stack: ${stack}`,
      );
      assert(
        msg.includes("[REDACTED]"),
        `${name}() JSON parse error message should redact token with [REDACTED]`,
      );
    }
  } finally {
    await server.shutdown();
  }
});

// Attack 1.3: Upstream network / connection failure error scrubbing
Deno.test("Adversarial PLAT-15: network connection failure does not leak apiToken in message or stack", async () => {
  const secretToken = "network-fail-secret-token-77777";

  const provider = new CloudflareQueueProvider({
    accountId: "acc-sec",
    queueId: "q-sec",
    apiToken: secretToken,
    baseUrl: "http://127.0.0.1:58888", // dead port
  });

  const operations: Array<[string, () => Promise<unknown>]> = [
    ["send", () => provider.send({ test: 1 })],
    ["sendBatch", () => provider.sendBatch([{ test: 1 }])],
    ["receive", () => provider.receive()],
    ["ack", () => provider.ack("msg_999")],
  ];

  for (const [name, op] of operations) {
    let caught: unknown = null;
    try {
      await op();
    } catch (err) {
      caught = err;
    }

    assert(caught !== null, `${name}() should have failed on network error`);
    assert(caught instanceof InternalError);

    const msg = (caught as Error).message;
    const stack = (caught as Error).stack ?? "";

    assertFalse(
      msg.includes(secretToken),
      `${name}() network error leaked apiToken in message: ${msg}`,
    );
    assertFalse(
      stack.includes(secretToken),
      `${name}() network error leaked apiToken in stack: ${stack}`,
    );
  }
});

// Attack 1.4: Naive object inspection, reflection, serialization, and private field isolation
Deno.test("Adversarial PLAT-15: naive inspection, reflection, and JSON serialization never leak apiToken", () => {
  const secretToken = "inspect-leak-target-token-66666";
  const provider = new CloudflareQueueProvider({
    accountId: "acc-sec",
    queueId: "q-sec",
    apiToken: secretToken,
  });

  // 1. Deno.inspect default
  const defaultInspect = Deno.inspect(provider);
  assertFalse(
    defaultInspect.includes(secretToken),
    `Deno.inspect leaked apiToken: ${defaultInspect}`,
  );
  assert(
    defaultInspect.includes("[REDACTED]"),
    "Deno.inspect must redact apiToken with [REDACTED]",
  );

  // 2. Deno.inspect with showHidden: true and depth: 10
  const rawInspect = Deno.inspect(provider, {
    showHidden: true,
    depth: 10,
  });
  assertFalse(
    rawInspect.includes(secretToken),
    `Raw Deno.inspect({ customInspect: false }) leaked apiToken: ${rawInspect}`,
  );

  // 3. JSON.stringify
  const jsonStr = JSON.stringify(provider);
  assertFalse(
    jsonStr.includes(secretToken),
    `JSON.stringify leaked apiToken: ${jsonStr}`,
  );
  assert(
    jsonStr.includes("[REDACTED]"),
    "JSON.stringify must redact apiToken with [REDACTED]",
  );

  // 4. Reflection and property enumeration
  const ownProps = Object.getOwnPropertyNames(provider);
  const ownSymbols = Object.getOwnPropertySymbols(provider);
  for (const sym of ownSymbols) {
    assertFalse(
      sym.description?.includes(secretToken) ?? false,
      `Symbol description leaked apiToken: ${sym.description}`,
    );
  }
  const ownKeys = Reflect.ownKeys(provider);

  for (const key of ownKeys) {
    const val = (provider as unknown as Record<string | symbol, unknown>)[key];
    if (typeof val === "string") {
      assertFalse(
        val.includes(secretToken),
        `Reflected property ${String(key)} leaked apiToken: ${val}`,
      );
    }
  }

  // Confirm #apiToken is not in enumerable keys
  assertFalse(ownProps.includes("apiToken"));
  assertFalse(ownProps.includes("#apiToken"));
});

// Attack 1.5: Secret token containing regex metacharacters
Deno.test("Adversarial PLAT-15: tokens with regex metacharacters are safely redacted without crashing", async () => {
  const regexToken = "tok$1*special(chars)+[brackets]?^val.ok";

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => {
      return new Response(
        JSON.stringify({
          success: false,
          errors: [
            {
              code: 10002,
              message: `Gateway failure with token: ${regexToken}`,
            },
          ],
        }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );

  try {
    const port = server.addr.port;
    const provider = new CloudflareQueueProvider({
      accountId: "acc-sec",
      queueId: "q-sec",
      apiToken: regexToken,
      baseUrl: `http://localhost:${port}`,
    });

    try {
      await provider.send({ data: "test" });
      assert(false, "Expected send to fail");
    } catch (err) {
      assert(err instanceof InternalError);
      const msg = (err as Error).message;
      assertFalse(
        msg.includes(regexToken),
        `Regex token leaked in error message: ${msg}`,
      );
      assert(
        msg.includes("[REDACTED]"),
        `Error message should contain [REDACTED]: ${msg}`,
      );
    }
  } finally {
    await server.shutdown();
  }
});

// ===========================================================================
// ATTACK VECTOR 2: Q-2 (Resource exhaustion, bounds, & zero network dispatch)
// ===========================================================================

// Attack 2.1: Payloads > 128 KB and invalid delays rejected BEFORE network dispatch
Deno.test("Adversarial Q-2: payloads > 128 KB, circular payloads, and invalid delays are rejected before any network traffic", async () => {
  let networkRequestCount = 0;
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => {
      networkRequestCount++;
      return new Response(
        JSON.stringify({ success: true, result: { id: "ok" } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );

  try {
    const port = server.addr.port;
    const provider = new CloudflareQueueProvider({
      accountId: "acc-bounds",
      queueId: "q-bounds",
      apiToken: "token-bounds",
      baseUrl: `http://localhost:${port}`,
    });

    // 1. Payload > 128 KB ASCII string (131,073 bytes)
    const maxBytes = 128 * 1024;
    const oversizedString = "x".repeat(maxBytes + 1);

    await assertRejects(
      () => provider.send(oversizedString),
      PayloadTooLargeError,
      "PAYLOAD_TOO_LARGE",
    );
    assertEquals(
      networkRequestCount,
      0,
      "No network request for oversized string",
    );

    // 2. Multibyte UTF-8 characters exceeding 128 KB (65,537 2-byte chars = 131,074 bytes)
    // String length is only 65,537 <= 131,072, but UTF-8 byte length > 128 KB
    const multibyteOversized = "§".repeat(65537);
    await assertRejects(
      () => provider.send(multibyteOversized),
      PayloadTooLargeError,
      "PAYLOAD_TOO_LARGE",
    );
    assertEquals(
      networkRequestCount,
      0,
      "No network request for multibyte oversized payload",
    );

    // 3. Object exceeding 128 KB in JSON serialized form
    const oversizedObj = { data: "y".repeat(maxBytes) };
    await assertRejects(
      () => provider.send(oversizedObj),
      PayloadTooLargeError,
      "PAYLOAD_TOO_LARGE",
    );
    assertEquals(
      networkRequestCount,
      0,
      "No network request for oversized object",
    );

    // 4. Circular object payload
    const circularObj: Record<string, unknown> = { a: 1 };
    circularObj.self = circularObj;
    await assertRejects(
      () => provider.send(circularObj),
      ValidationFailedError,
      "VALIDATION_FAILED",
    );
    assertEquals(
      networkRequestCount,
      0,
      "No network request for circular payload",
    );

    // 5. Excessive delay (> 900s)
    const invalidDelays = [
      901,
      900.001,
      10000,
      -1,
      -0.001,
      NaN,
      Infinity,
      -Infinity,
      "60" as unknown as number,
      {} as unknown as number,
    ];

    for (const d of invalidDelays) {
      await assertRejects(
        () => provider.send({ ok: true }, { delay: d }),
        ValidationFailedError,
        "VALIDATION_FAILED",
      );
      assertEquals(
        networkRequestCount,
        0,
        `No network request for delay: ${d}`,
      );
    }

    // 6. sendBatch with oversized payload at start, middle, end
    const batchWithOversizedStart = [oversizedString, { ok: 1 }, { ok: 2 }];
    const batchWithOversizedMid = [{ ok: 1 }, oversizedString, { ok: 2 }];
    const batchWithOversizedEnd = [{ ok: 1 }, { ok: 2 }, oversizedString];

    for (
      const batch of [
        batchWithOversizedStart,
        batchWithOversizedMid,
        batchWithOversizedEnd,
      ]
    ) {
      await assertRejects(
        () => provider.sendBatch(batch),
        PayloadTooLargeError,
        "PAYLOAD_TOO_LARGE",
      );
      assertEquals(
        networkRequestCount,
        0,
        "No network request for batch with oversized payload",
      );
    }

    // 7. sendBatch with circular object
    await assertRejects(
      () => provider.sendBatch([{ ok: 1 }, circularObj]),
      ValidationFailedError,
      "VALIDATION_FAILED",
    );
    assertEquals(
      networkRequestCount,
      0,
      "No network request for batch with circular object",
    );

    // 8. sendBatch with non-array
    await assertRejects(
      () => provider.sendBatch("not-array" as unknown as unknown[]),
      ValidationFailedError,
      "VALIDATION_FAILED",
    );
    assertEquals(
      networkRequestCount,
      0,
      "No network request for sendBatch non-array",
    );
  } finally {
    await server.shutdown();
  }
});

// ===========================================================================
// ATTACK VECTOR 3: Q-3 (Visibility timeout state, parameters & transitions)
// ===========================================================================

// Attack 3.1: Invalid visibilityTimeoutMs rejected before network dispatch
Deno.test("Adversarial Q-3: invalid visibilityTimeoutMs and defaultVisibilityTimeoutMs are rejected before network traffic", async () => {
  let networkCalls = 0;
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => {
      networkCalls++;
      return new Response(
        JSON.stringify({ success: true, result: { messages: [] } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );

  try {
    const port = server.addr.port;
    const provider = new CloudflareQueueProvider({
      accountId: "acc-q3",
      queueId: "q-q3",
      apiToken: "token-q3",
      baseUrl: `http://localhost:${port}`,
    });

    const invalidTimeouts = [
      0,
      -1,
      -500,
      NaN,
      Infinity,
      -Infinity,
      "30000" as unknown as number,
    ];

    for (const vt of invalidTimeouts) {
      await assertRejects(
        () => provider.receive({ visibilityTimeoutMs: vt }),
        ValidationFailedError,
        "VALIDATION_FAILED",
      );
      assertEquals(
        networkCalls,
        0,
        `No network request for visibilityTimeoutMs: ${vt}`,
      );
    }

    // Constructor validation for defaultVisibilityTimeoutMs
    for (const vt of invalidTimeouts) {
      assertThrows(
        () =>
          new CloudflareQueueProvider({
            accountId: "acc-q3",
            queueId: "q-q3",
            apiToken: "token-q3",
            defaultVisibilityTimeoutMs: vt,
          }),
        ValidationFailedError,
        "VALIDATION_FAILED",
      );
    }

    // Invalid ack id validation before network
    const invalidAckIds = [
      "",
      "   ",
      null as unknown as string,
      undefined as unknown as string,
      123 as unknown as string,
    ];
    for (const id of invalidAckIds) {
      await assertRejects(
        () => provider.ack(id),
        ValidationFailedError,
        "VALIDATION_FAILED",
      );
      assertEquals(networkCalls, 0, `No network request for ack id: ${id}`);
    }
  } finally {
    await server.shutdown();
  }
});

// Attack 3.2: Complete visibility timeout lifecycle and attempt counting
Deno.test("Adversarial Q-3: state machine enforces message invisibility, redelivery with attempts counter, and ack permanence", async () => {
  interface MessageState {
    id: string;
    body: unknown;
    visibleAfter: number;
    attempts: number;
    acked: boolean;
  }

  const storedMessages: MessageState[] = [];

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req: Request) => {
      const url = new URL(req.url);
      const text = await req.text();
      const body = text ? JSON.parse(text) : {};

      if (url.pathname.endsWith("/messages") && req.method === "POST") {
        const id = `msg_${crypto.randomUUID()}`;
        storedMessages.push({
          id,
          body: body.body,
          visibleAfter: Date.now(),
          attempts: 0,
          acked: false,
        });
        return new Response(JSON.stringify({ success: true, result: { id } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname.endsWith("/messages/pull") && req.method === "POST") {
        const now = Date.now();
        const vt = body.visibility_timeout_ms ?? 30000;
        const candidate = storedMessages.find((m) =>
          !m.acked && m.visibleAfter <= now
        );

        if (!candidate) {
          return new Response(
            JSON.stringify({ success: true, result: { messages: [] } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        candidate.attempts += 1;
        candidate.visibleAfter = now + vt;

        return new Response(
          JSON.stringify({
            success: true,
            result: {
              messages: [
                {
                  id: candidate.id,
                  body: candidate.body,
                  attempts: candidate.attempts,
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.pathname.endsWith("/messages/ack") && req.method === "POST") {
        const acks = body.acks ?? [];
        for (const { id } of acks) {
          const m = storedMessages.find((msg) => msg.id === id);
          if (m) {
            m.acked = true;
          }
        }
        return new Response(
          JSON.stringify({ success: true, result: { count: acks.length } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("Not found", { status: 404 });
    },
  );

  try {
    const port = server.addr.port;
    const provider = new CloudflareQueueProvider({
      accountId: "acc-state",
      queueId: "q-state",
      apiToken: "token-state",
      baseUrl: `http://localhost:${port}`,
    });

    // 1. Send message
    const { id } = await provider.send({ task: "critical-operation" });
    assert(id);

    // 2. Receive message with short 100ms visibility timeout
    const m1 = await provider.receive({ visibilityTimeoutMs: 100 });
    assert(m1 !== null);
    assertEquals(m1.id, id);
    assertEquals(m1.attempts, 1);

    // 3. Immediately receive again: should return null because message is hidden
    const immediate = await provider.receive();
    assertEquals(
      immediate,
      null,
      "Message must be invisible during visibility window",
    );

    // 4. Wait for visibility timeout to expire
    await delay(150);

    // 5. Receive again: message must be redelivered with incremented attempts = 2
    const m2 = await provider.receive({ visibilityTimeoutMs: 100 });
    assert(
      m2 !== null,
      "Message should reappear after visibility timeout expiry",
    );
    assertEquals(m2.id, id);
    assertEquals(
      m2.attempts,
      2,
      "Attempts counter must increment on redelivery",
    );

    // 6. Acknowledge message
    await provider.ack(id);

    // 7. Wait another window
    await delay(150);

    // 8. Receive again: must return null, message permanently acknowledged
    const m3 = await provider.receive();
    assertEquals(m3, null, "Acknowledged message must never be redelivered");
  } finally {
    await server.shutdown();
  }
});
