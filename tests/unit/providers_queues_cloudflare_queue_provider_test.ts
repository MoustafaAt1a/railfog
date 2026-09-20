// Spec references: Q-1, Q-2, Q-3, PLAT-12, PLAT-15, PLAT-16, PLAT-17
// Task: T-0206 (Cloudflare Queues remote provider)

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { delay } from "@std/async";
import {
  InternalError,
  PayloadTooLargeError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import type { QueueMessage } from "../../primitives/queues/queue-provider.ts";
import {
  CloudflareQueueProvider,
  type CloudflareQueueProviderOptions,
} from "../../providers/queues/cloudflare-queue-provider.ts";

// ---------------------------------------------------------------------------
// In-process mock HTTP server simulating Cloudflare Queues REST API
// Spec reference: PLAT-17 (Local/production parity, zero external credentials)
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  pathname: string;
  headers: Headers;
  bodyText: string;
  // deno-lint-ignore no-explicit-any
  parsedBody: any;
}

interface StoredMessage {
  id: string;
  body: unknown;
  visibleAfter: number;
  attempts: number;
  acked: boolean;
}

interface MockServerOptions {
  expectedToken?: string;
  simulateError?: { status: number; message: string };
}

async function withMockServer(
  fn: (context: {
    baseUrl: string;
    recordedRequests: RecordedRequest[];
    queueMessages: StoredMessage[];
    setSimulateError: (
      err: { status: number; message: string } | null,
    ) => void;
  }) => Promise<void>,
  serverOpts?: MockServerOptions,
): Promise<void> {
  const recordedRequests: RecordedRequest[] = [];
  const queueMessages: StoredMessage[] = [];
  let simulateError = serverOpts?.simulateError ?? null;
  const expectedToken = serverOpts?.expectedToken ?? "mock-api-token-12345";

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req: Request) => {
      const url = new URL(req.url);
      const authHeader = req.headers.get("authorization");
      const bodyText = await req.text();

      let parsedBody: unknown = undefined;
      if (bodyText) {
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          parsedBody = bodyText;
        }
      }

      recordedRequests.push({
        method: req.method,
        url: req.url,
        pathname: url.pathname,
        headers: req.headers,
        bodyText,
        parsedBody,
      });

      if (simulateError) {
        return new Response(
          JSON.stringify({
            success: false,
            errors: [
              { code: simulateError.status, message: simulateError.message },
            ],
            messages: [],
            result: null,
          }),
          {
            status: simulateError.status,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Check Bearer authorization header per Cloudflare Queues REST API
      if (authHeader !== `Bearer ${expectedToken}`) {
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
            messages: [],
            result: null,
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Route pattern for Cloudflare Queues API:
      // (?:/client/v4)?/accounts/:accountId/queues/:queueId/messages(?:\/(batch|pull|ack))?
      const match = url.pathname.match(
        /(?:\/client\/v4)?\/accounts\/([^/]+)\/queues\/([^/]+)\/messages(?:\/(batch|pull|ack))?$/,
      );

      if (!match) {
        return new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 7000, message: "No route matched" }],
            messages: [],
            result: null,
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      const [, , , action] = match;

      // 1. Send single message: POST /accounts/:accountId/queues/:queueId/messages
      if (!action && req.method === "POST") {
        const bodyObj = parsedBody as {
          body?: unknown;
          delay_seconds?: number;
        };
        const msgBody = bodyObj?.body;
        const delaySeconds = bodyObj?.delay_seconds ?? 0;
        const id = `msg_${crypto.randomUUID()}`;
        const visibleAfter = Date.now() + delaySeconds * 1000;

        queueMessages.push({
          id,
          body: msgBody,
          visibleAfter,
          attempts: 0,
          acked: false,
        });

        return new Response(
          JSON.stringify({
            success: true,
            result: { id },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // 2. Send batch: POST /accounts/:accountId/queues/:queueId/messages/batch
      if (action === "batch" && req.method === "POST") {
        const batchObj = parsedBody as {
          messages?: Array<{ body: unknown; delay_seconds?: number }>;
        };
        const rawMessages = batchObj?.messages ?? [];
        const result: Array<{ id: string }> = [];

        for (const item of rawMessages) {
          const id = `msg_${crypto.randomUUID()}`;
          const delaySeconds = item.delay_seconds ?? 0;
          const visibleAfter = Date.now() + delaySeconds * 1000;

          queueMessages.push({
            id,
            body: item.body,
            visibleAfter,
            attempts: 0,
            acked: false,
          });

          result.push({ id });
        }

        return new Response(
          JSON.stringify({
            success: true,
            result,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // 3. Pull/Receive: POST /accounts/:accountId/queues/:queueId/messages/pull
      if (action === "pull" && req.method === "POST") {
        const pullObj = parsedBody as {
          visibility_timeout_ms?: number;
          batch_size?: number;
        };
        const visibilityTimeoutMs = pullObj?.visibility_timeout_ms ?? 30000;
        const batchSize = pullObj?.batch_size ?? 1;
        const now = Date.now();

        const available = queueMessages.filter(
          (m) => !m.acked && m.visibleAfter <= now,
        );
        const selected = available.slice(0, batchSize);

        const resultMessages: Array<{
          id: string;
          body: unknown;
          attempts: number;
        }> = [];
        for (const m of selected) {
          m.attempts += 1;
          m.visibleAfter = now + visibilityTimeoutMs;
          resultMessages.push({
            id: m.id,
            body: m.body,
            attempts: m.attempts,
          });
        }

        return new Response(
          JSON.stringify({
            success: true,
            result: { messages: resultMessages },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // 4. Ack: POST /accounts/:accountId/queues/:queueId/messages/ack
      if (action === "ack" && req.method === "POST") {
        const ackObj = parsedBody as { acks?: Array<{ id: string }> };
        const acks = ackObj?.acks ?? [];
        let ackCount = 0;

        for (const { id } of acks) {
          const found = queueMessages.find((m) => m.id === id);
          if (found) {
            found.acked = true;
            ackCount += 1;
          }
        }

        return new Response(
          JSON.stringify({
            success: true,
            result: { count: ackCount },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("Method not allowed", { status: 405 });
    },
  );

  try {
    const port = server.addr.port;
    const baseUrl = `http://localhost:${port}`;
    await fn({
      baseUrl,
      recordedRequests,
      queueMessages,
      setSimulateError: (err) => {
        simulateError = err;
      },
    });
  } finally {
    await server.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Unit tests: Options defaults, delay bounds check (900s), payload size (128 KB)
// Spec references: Q-2, Q-3, PLAT-12, PLAT-16
// ---------------------------------------------------------------------------

// AC3: Given delay greater than 900 seconds, delay < 0, or NaN, when send is called,
// then it throws VALIDATION_FAILED pointing to Q-2.
Deno.test("CloudflareQueueProvider - unit: delay bounds validation rejects > 900s, < 0, and NaN (Q-2, AC3)", async () => {
  const provider = new CloudflareQueueProvider({
    accountId: "test-acc",
    queueId: "test-queue",
    apiToken: "test-token",
    baseUrl: "http://localhost:9999",
  });

  // delay > 900 must throw ValidationFailedError
  await assertRejects(
    () => provider.send({ msg: 1 }, { delay: 901 }),
    ValidationFailedError,
  );

  await assertRejects(
    () => provider.send({ msg: 1 }, { delay: 900.1 }),
    ValidationFailedError,
  );

  // delay < 0 must throw ValidationFailedError
  await assertRejects(
    () => provider.send({ msg: 1 }, { delay: -1 }),
    ValidationFailedError,
  );

  await assertRejects(
    () => provider.send({ msg: 1 }, { delay: -0.5 }),
    ValidationFailedError,
  );

  // delay NaN must throw ValidationFailedError
  await assertRejects(
    () => provider.send({ msg: 1 }, { delay: NaN }),
    ValidationFailedError,
  );

  // delay Infinity must throw ValidationFailedError
  await assertRejects(
    () => provider.send({ msg: 1 }, { delay: Infinity }),
    ValidationFailedError,
  );

  // Error code must strictly be VALIDATION_FAILED per PLAT-12 and Q-2
  try {
    await provider.send({ msg: 1 }, { delay: 1000 });
    assert(false, "Must have thrown for delay > 900");
  } catch (err) {
    assert(err instanceof ValidationFailedError);
    assertEquals((err as ValidationFailedError).code, "VALIDATION_FAILED");
    const msg = (err as Error).message;
    assert(
      msg.includes("900") || msg.includes("Q-2") ||
        msg.includes("VALIDATION_FAILED"),
      `Expected message citing 900s delay cap per Q-2, got: ${msg}`,
    );
  }
});

// AC2: Given a payload exceeding 128 KB (131,072 bytes), when send is called,
// then it throws PAYLOAD_TOO_LARGE (Q-2, PLAT-12).
Deno.test("CloudflareQueueProvider - unit: payload size validation rejects > 128 KB (Q-2, PLAT-12, AC2)", async () => {
  const provider = new CloudflareQueueProvider({
    accountId: "test-acc",
    queueId: "test-queue",
    apiToken: "test-token",
    baseUrl: "http://localhost:9999",
  });

  const maxBytes = 128 * 1024; // 131,072 bytes per Q-2

  // 131,073 bytes payload string exceeds 128 KB limit
  const oversizedString = "a".repeat(maxBytes + 1);

  await assertRejects(
    () => provider.send(oversizedString),
    PayloadTooLargeError,
  );

  // Verify error code strictly matches PAYLOAD_TOO_LARGE
  try {
    await provider.send(oversizedString);
    assert(false, "Must have thrown for payload > 128 KB");
  } catch (err) {
    assert(err instanceof PayloadTooLargeError);
    assertEquals((err as PayloadTooLargeError).code, "PAYLOAD_TOO_LARGE");
    const msg = (err as Error).message;
    assert(
      msg.includes("128") || msg.includes("PAYLOAD_TOO_LARGE") ||
        msg.includes("Q-2"),
      `Expected error message referencing payload size limit, got: ${msg}`,
    );
  }

  // Oversized object whose JSON string exceeds 128 KB
  const oversizedObj = { data: "x".repeat(maxBytes) };
  await assertRejects(
    () => provider.send(oversizedObj),
    PayloadTooLargeError,
  );

  // sendBatch must also enforce 128 KB limit per item
  await assertRejects(
    () => provider.sendBatch([{ ok: true }, oversizedString]),
    PayloadTooLargeError,
  );
});

// Spec reference: Q-3, Scope (Options defaults and constructor validation)
Deno.test("CloudflareQueueProvider - unit: options defaults and required parameters validation", () => {
  // Missing required parameters in constructor should throw ValidationFailedError
  assertThrows(
    () =>
      new CloudflareQueueProvider({
        accountId: "",
        queueId: "test-queue",
        apiToken: "test-token",
      }),
    ValidationFailedError,
  );

  assertThrows(
    () =>
      new CloudflareQueueProvider({
        accountId: "test-acc",
        queueId: "",
        apiToken: "test-token",
      }),
    ValidationFailedError,
  );

  assertThrows(
    () =>
      new CloudflareQueueProvider({
        accountId: "test-acc",
        queueId: "test-queue",
        apiToken: "",
      }),
    ValidationFailedError,
  );

  // Valid instantiation satisfying CloudflareQueueProviderOptions
  const validOptions: CloudflareQueueProviderOptions = {
    accountId: "test-acc",
    queueId: "test-queue",
    apiToken: "test-token",
  };
  const provider = new CloudflareQueueProvider(validOptions);
  assert(provider);
});

// ---------------------------------------------------------------------------
// Integration tests: send, sendBatch, receive with visibility timeout, ack
// Spec references: Q-1, Q-2, Q-3, PLAT-16, PLAT-17
// ---------------------------------------------------------------------------

// AC1: Given a configured CloudflareQueueProvider, when send is called with valid payload,
// then it transmits POST to queue messages endpoint with headers Authorization: Bearer <token>
// and Content-Type: application/json, returning { id } (Q-2).
Deno.test("CloudflareQueueProvider - integration: send transmits POST to queue messages endpoint with headers and returns { id } (Q-2, AC1)", async () => {
  await withMockServer(async ({ baseUrl, recordedRequests }) => {
    const provider = new CloudflareQueueProvider({
      accountId: "my-account-123",
      queueId: "my-queue-456",
      apiToken: "mock-api-token-12345",
      baseUrl,
    });

    // 1. send without delay
    const payload = { event: "user.created", userId: "u_99" };
    const res = await provider.send(payload);

    assert(res && typeof res.id === "string" && res.id.length > 0);

    const sendReq = recordedRequests.find(
      (r) =>
        r.method === "POST" &&
        r.pathname.includes(
          "/accounts/my-account-123/queues/my-queue-456/messages",
        ) &&
        !r.pathname.endsWith("/batch") &&
        !r.pathname.endsWith("/pull") &&
        !r.pathname.endsWith("/ack"),
    );
    assert(
      sendReq !== undefined,
      "POST request to messages endpoint must be dispatched",
    );
    assertEquals(
      sendReq.headers.get("authorization"),
      "Bearer mock-api-token-12345",
      "Authorization header must be Bearer <token>",
    );
    assert(
      (sendReq.headers.get("content-type") ?? "").includes("application/json"),
      "Content-Type header must be application/json",
    );
    assertEquals(sendReq.parsedBody?.body, payload);

    // 2. send with valid delay (e.g. 60s)
    recordedRequests.length = 0;
    const delayedPayload = { event: "reminder", after: 60 };
    const delayedRes = await provider.send(delayedPayload, { delay: 60 });

    assert(delayedRes && typeof delayedRes.id === "string");
    const delayReq = recordedRequests[0];
    assert(delayReq !== undefined);
    assertEquals(delayReq.parsedBody?.body, delayedPayload);
    assertEquals(delayReq.parsedBody?.delay_seconds, 60);

    // 3. Exact 128 KB boundary payload (131,072 bytes UTF-8)
    const exact128KBString = "b".repeat(128 * 1024);
    const boundaryRes = await provider.send(exact128KBString);
    assert(boundaryRes && typeof boundaryRes.id === "string");
  });
});

// AC4: Given a batch of messages, when sendBatch is called,
// then it transmits them and returns an array of generated { id } items (Q-2, AC4).
Deno.test("CloudflareQueueProvider - integration: sendBatch transmits batch to /messages/batch and returns { id }[] (Q-2, AC4)", async () => {
  await withMockServer(async ({ baseUrl, recordedRequests }) => {
    const provider = new CloudflareQueueProvider({
      accountId: "my-account-123",
      queueId: "my-queue-456",
      apiToken: "mock-api-token-12345",
      baseUrl,
    });

    const messages = [
      { action: "sync", target: 1 },
      { action: "sync", target: 2 },
      { action: "sync", target: 3 },
    ];

    const results = await provider.sendBatch(messages);

    assertEquals(results.length, 3);
    for (const item of results) {
      assert(typeof item.id === "string" && item.id.length > 0);
    }

    const batchReq = recordedRequests.find(
      (r) =>
        r.method === "POST" &&
        r.pathname.includes(
          "/accounts/my-account-123/queues/my-queue-456/messages/batch",
        ),
    );
    assert(
      batchReq !== undefined,
      "POST request to /messages/batch must be dispatched",
    );
    assertEquals(
      batchReq.headers.get("authorization"),
      "Bearer mock-api-token-12345",
    );
    assert(
      (batchReq.headers.get("content-type") ?? "").includes("application/json"),
    );

    const reqMessages = batchReq.parsedBody?.messages;
    assert(Array.isArray(reqMessages));
    assertEquals(reqMessages.length, 3);
    assertEquals(reqMessages[0].body, messages[0]);
    assertEquals(reqMessages[1].body, messages[1]);
    assertEquals(reqMessages[2].body, messages[2]);

    // Empty batch returns empty array
    const emptyResult = await provider.sendBatch([]);
    assertEquals(emptyResult, []);
  });
});

// AC5: Given a message received, when ack is called on its id,
// then the message is marked acknowledged and never re-received (Q-3, AC5).
Deno.test("CloudflareQueueProvider - integration: receive returns message or null, and ack acknowledges message (Q-3, AC5)", async () => {
  await withMockServer(async ({ baseUrl, recordedRequests }) => {
    const provider = new CloudflareQueueProvider({
      accountId: "my-account-123",
      queueId: "my-queue-456",
      apiToken: "mock-api-token-12345",
      baseUrl,
    });

    // 1. Receive from empty queue returns null
    const emptyMsg = await provider.receive();
    assertEquals(emptyMsg, null);

    // 2. Send message
    const { id } = await provider.send({ job: "process-invoice", amount: 150 });
    assert(id);

    // 3. Receive message
    recordedRequests.length = 0;
    const msg: QueueMessage | null = await provider.receive();
    assert(msg !== null, "Message should be received");
    assertEquals(msg.id, id);
    assertEquals(msg.body, { job: "process-invoice", amount: 150 });
    assertEquals(msg.attempts, 1);

    const pullReq = recordedRequests.find(
      (r) =>
        r.method === "POST" &&
        r.pathname.includes(
          "/accounts/my-account-123/queues/my-queue-456/messages/pull",
        ),
    );
    assert(
      pullReq !== undefined,
      "POST request to /messages/pull must be dispatched",
    );
    assertEquals(
      pullReq.headers.get("authorization"),
      "Bearer mock-api-token-12345",
    );

    // 4. Ack message
    recordedRequests.length = 0;
    await provider.ack(id);

    const ackReq = recordedRequests.find(
      (r) =>
        r.method === "POST" &&
        r.pathname.includes(
          "/accounts/my-account-123/queues/my-queue-456/messages/ack",
        ),
    );
    assert(
      ackReq !== undefined,
      "POST request to /messages/ack must be dispatched",
    );
    assertEquals(
      ackReq.headers.get("authorization"),
      "Bearer mock-api-token-12345",
    );
    assertEquals(ackReq.parsedBody?.acks, [{ id }]);

    // 5. Subsequent receive returns null (acknowledged message never re-received)
    const afterAck = await provider.receive();
    assertEquals(afterAck, null);
  });
});

// AC6: Given an unacknowledged message exceeding its visibility timeout,
// when receive is invoked again, then the message is redelivered with incremented attempts (Q-3).
// Default visibility timeout is 30,000 ms.
Deno.test("CloudflareQueueProvider - integration: visibility timeout and redelivery with incremented attempts counter (Q-3, AC6)", async () => {
  await withMockServer(async ({ baseUrl, recordedRequests }) => {
    const provider = new CloudflareQueueProvider({
      accountId: "my-account-123",
      queueId: "my-queue-456",
      apiToken: "mock-api-token-12345",
      baseUrl,
    });

    const { id } = await provider.send({
      job: "transcode-video",
      file: "sample.mp4",
    });

    // Receive message with short visibility timeout (150ms)
    // ANTIHALLUCINATION Rule 5: real elapsed time, no mocked clocks
    recordedRequests.length = 0;
    const msg1 = await provider.receive({ visibilityTimeoutMs: 150 });
    assert(msg1 !== null);
    assertEquals(msg1.id, id);
    assertEquals(msg1.attempts, 1);

    const pullReq1 = recordedRequests.find(
      (r) => r.method === "POST" && r.pathname.endsWith("/messages/pull"),
    );
    assert(pullReq1 !== undefined);
    assertEquals(pullReq1.parsedBody?.visibility_timeout_ms, 150);

    // Immediately receive again -> message is invisible, should return null
    const hiddenMsg = await provider.receive();
    assertEquals(
      hiddenMsg,
      null,
      "Message must be invisible during visibility timeout window",
    );

    // Wait for visibility timeout to elapse in real time
    await delay(200);

    // Receive again: message is redelivered with incremented attempts (attempts = 2)
    const msg2 = await provider.receive({ visibilityTimeoutMs: 150 });
    assert(
      msg2 !== null,
      "Message should be redelivered after visibility timeout expires",
    );
    assertEquals(msg2.id, id);
    assertEquals(
      msg2.attempts,
      2,
      "Attempts counter must be incremented on redelivery",
    );

    // Acknowledge the message
    await provider.ack(id);

    // Wait past another window, verify message is deleted/permanently gone
    await delay(200);
    const msg3 = await provider.receive();
    assertEquals(msg3, null);
  });
});

// Spec reference: Q-3, Scope (Default visibility timeout 30,000 ms per Q-3)
Deno.test("CloudflareQueueProvider - integration: default visibility timeout 30,000 ms propagated in pull request (Q-3, AC6)", async () => {
  await withMockServer(async ({ baseUrl, recordedRequests }) => {
    // 1. Without constructor option defaultVisibilityTimeoutMs, defaults to 30,000 ms
    const providerDefault = new CloudflareQueueProvider({
      accountId: "acc-def",
      queueId: "queue-def",
      apiToken: "mock-api-token-12345",
      baseUrl,
    });

    await providerDefault.receive();
    const pullReqDef = recordedRequests[recordedRequests.length - 1];
    assertEquals(
      pullReqDef.parsedBody?.visibility_timeout_ms,
      30000,
      "Default visibility timeout must be 30,000 ms per Q-3",
    );

    // 2. With constructor option defaultVisibilityTimeoutMs = 45,000 ms
    const providerCustom = new CloudflareQueueProvider({
      accountId: "acc-cust",
      queueId: "queue-cust",
      apiToken: "mock-api-token-12345",
      baseUrl,
      defaultVisibilityTimeoutMs: 45000,
    });

    await providerCustom.receive();
    const pullReqCust = recordedRequests[recordedRequests.length - 1];
    assertEquals(
      pullReqCust.parsedBody?.visibility_timeout_ms,
      45000,
      "Configured defaultVisibilityTimeoutMs must be used when opts.visibilityTimeoutMs omitted",
    );
  });
});

// ---------------------------------------------------------------------------
// Security tests: Token redaction (PLAT-15) and naive inspection (PLAT-15)
// ---------------------------------------------------------------------------

// Security: Verify authorization header containing apiToken is redacted from error strings and traces (PLAT-15)
Deno.test("CloudflareQueueProvider - security: apiToken is scrubbed from error messages and stack traces (PLAT-15)", async () => {
  const secretToken = "super-secret-cloudflare-queue-token-77777";

  // 1. HTTP error from remote server
  await withMockServer(
    async ({ baseUrl, setSimulateError }) => {
      const provider = new CloudflareQueueProvider({
        accountId: "test-acc",
        queueId: "test-queue",
        apiToken: secretToken,
        baseUrl,
      });

      setSimulateError({
        status: 500,
        message: "Internal Cloudflare Error with auth details",
      });

      const methods: (() => Promise<unknown>)[] = [
        () => provider.send({ test: 1 }),
        () => provider.sendBatch([{ test: 1 }]),
        () => provider.receive(),
        () => provider.ack("msg_123"),
      ];

      for (const method of methods) {
        try {
          await method();
          assert(false, "Expected method to reject on remote error");
        } catch (err) {
          const errStr = String(err);
          const stackStr = (err as Error).stack ?? "";
          assertFalse(
            errStr.includes(secretToken),
            `Error message must not leak apiToken: ${errStr}`,
          );
          assertFalse(
            stackStr.includes(secretToken),
            `Error stack trace must not leak apiToken: ${stackStr}`,
          );
        }
      }
    },
    { expectedToken: secretToken },
  );

  // 2. Network / connection failure error
  const invalidProvider = new CloudflareQueueProvider({
    accountId: "test-acc",
    queueId: "test-queue",
    apiToken: secretToken,
    baseUrl: "http://127.0.0.1:1", // unreachable port
  });

  const networkMethods: (() => Promise<unknown>)[] = [
    () => invalidProvider.send({ test: 1 }),
    () => invalidProvider.sendBatch([{ test: 1 }]),
    () => invalidProvider.receive(),
    () => invalidProvider.ack("msg_123"),
  ];

  for (const method of networkMethods) {
    try {
      await method();
      assert(false, "Expected method to reject on network failure");
    } catch (err) {
      const errStr = String(err);
      const stackStr = (err as Error).stack ?? "";
      assertFalse(
        errStr.includes(secretToken),
        `Network error string must not leak apiToken: ${errStr}`,
      );
      assertFalse(
        stackStr.includes(secretToken),
        `Network error stack trace must not leak apiToken: ${stackStr}`,
      );
    }
  }
});

// Security: Verify naive object inspection via Deno.inspect/JSON.stringify redacts apiToken (PLAT-15)
Deno.test("CloudflareQueueProvider - security: naive object inspection via Deno.inspect/JSON.stringify redacts apiToken (PLAT-15)", () => {
  const secretToken = "super-secret-queue-inspect-token-88888";
  const provider = new CloudflareQueueProvider({
    accountId: "test-acc",
    queueId: "test-queue",
    apiToken: secretToken,
  });

  const inspected = Deno.inspect(provider);
  const jsonStr = JSON.stringify(provider);

  assertFalse(
    inspected.includes(secretToken),
    `Deno.inspect(provider) leaked apiToken: ${inspected}`,
  );
  assertFalse(
    jsonStr.includes(secretToken),
    `JSON.stringify(provider) leaked apiToken: ${jsonStr}`,
  );
  assert(
    inspected.includes("[REDACTED]"),
    "Deno.inspect must redact apiToken with [REDACTED]",
  );
  assert(
    jsonStr.includes("[REDACTED]"),
    "JSON.stringify must redact apiToken with [REDACTED]",
  );
});

// Security: Upstream malformed JSON responses are redacted and mapped to InternalError (PLAT-15, PLAT-12)
Deno.test("CloudflareQueueProvider - security: malformed JSON response is redacted and mapped to InternalError (PLAT-15, PLAT-12)", async () => {
  const secretToken = "secret-token-in-queue-json-err";
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => {
      // Simulate upstream 200 with invalid JSON containing the secret token
      return new Response(`{"result": ${secretToken}}`, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  try {
    const port = server.addr.port;
    const provider = new CloudflareQueueProvider({
      accountId: "acc-1",
      queueId: "queue-1",
      apiToken: secretToken,
      baseUrl: `http://localhost:${port}`,
    });

    let caught: unknown = null;
    try {
      await provider.receive();
    } catch (err) {
      caught = err;
    }

    assert(caught !== null, "receive() must throw on malformed JSON");
    assert(
      (caught as Error).name === "InternalError" ||
        caught instanceof InternalError,
      `Expected InternalError, got: ${caught}`,
    );

    const msg = (caught as Error).message;
    const stack = (caught as Error).stack ?? "";
    assertFalse(
      msg.includes(secretToken),
      `receive() JSON error leaked apiToken: ${msg}`,
    );
    assertFalse(
      stack.includes(secretToken),
      `receive() JSON stack leaked apiToken: ${stack}`,
    );
  } finally {
    await server.shutdown();
  }
});
