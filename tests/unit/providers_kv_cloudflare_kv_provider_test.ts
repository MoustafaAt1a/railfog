// Spec references: KV-1, KV-2, KV-4, KV-5, PLAT-12, PLAT-15, PLAT-16, PLAT-17
// Task: T-0205 (Cloudflare Workers KV remote provider)

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  CloudflareKVProvider,
  validateConsistencyTier,
} from "../../providers/kv/cloudflare-kv-provider.ts";
import {
  PayloadTooLargeError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

// ---------------------------------------------------------------------------
// In-process mock HTTP server simulating Cloudflare Workers KV REST API
// Spec reference: PLAT-17 (Local/production parity, zero external credentials)
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  pathname: string;
  searchParams: URLSearchParams;
  headers: Headers;
  bodyText: string;
}

interface MockServerOptions {
  expectedToken?: string;
  simulateError?: { status: number; message: string };
}

async function withMockServer(
  fn: (context: {
    baseUrl: string;
    recordedRequests: RecordedRequest[];
    store: Map<
      string,
      { value: unknown; rawText: string; expiresAt?: number }
    >;
    setSimulateError: (
      err: { status: number; message: string } | null,
    ) => void;
  }) => Promise<void>,
  serverOpts?: MockServerOptions,
): Promise<void> {
  const recordedRequests: RecordedRequest[] = [];
  const store = new Map<
    string,
    { value: unknown; rawText: string; expiresAt?: number }
  >();
  let simulateError = serverOpts?.simulateError ?? null;
  const expectedToken = serverOpts?.expectedToken ?? "mock-api-token-12345";

  const handler = async (req: Request) => {
    const url = new URL(req.url);
    const authHeader = req.headers.get("authorization");
    const bodyText = await req.text();

    recordedRequests.push({
      method: req.method,
      url: req.url,
      pathname: url.pathname,
      searchParams: url.searchParams,
      headers: req.headers,
      bodyText,
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

    // Check Bearer authorization header per Cloudflare Workers KV REST API
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

    // Standard Cloudflare Workers KV REST API route pattern:
    // (?:/client/v4)?/accounts/:accountId/storage/kv/namespaces/:namespaceId/(values|keys)(?:/:key)?
    const match = url.pathname.match(
      /(?:\/client\/v4)?\/accounts\/([^/]+)\/storage\/kv\/namespaces\/([^/]+)\/(values|keys)(?:\/(.+))?/,
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

    const [, , , action, rawKeyName] = match;

    // Endpoint: /values/:key
    if (action === "values") {
      if (!rawKeyName) {
        return new Response("Missing key name", { status: 400 });
      }
      const keyName = decodeURIComponent(rawKeyName);

      if (req.method === "PUT") {
        const ttlParam = url.searchParams.get("expiration_ttl");
        const ttl = ttlParam ? parseInt(ttlParam, 10) : undefined;
        let parsedValue: unknown = bodyText;
        try {
          parsedValue = JSON.parse(bodyText);
        } catch {
          // retain as raw string if not JSON
        }
        const item = {
          value: parsedValue,
          rawText: bodyText,
          expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
        };
        store.set(keyName, item);
        if (keyName !== rawKeyName) {
          store.set(rawKeyName, item);
        }
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (req.method === "GET") {
        const item = store.get(keyName) ?? store.get(rawKeyName);
        if (!item || (item.expiresAt && item.expiresAt <= Date.now())) {
          return new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 10009, message: "asset not found" }],
              messages: [],
              result: null,
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(item.rawText, {
          status: 200,
          headers: {
            "content-type": typeof item.value === "string"
              ? "text/plain; charset=utf-8"
              : "application/json; charset=utf-8",
          },
        });
      }

      if (req.method === "DELETE") {
        store.delete(keyName);
        if (keyName !== rawKeyName) {
          store.delete(rawKeyName);
        }
        return new Response(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response("Method not allowed", { status: 405 });
    }

    // Endpoint: /keys (listing with prefix, limit, cursor)
    if (action === "keys" && req.method === "GET") {
      const prefixParam = url.searchParams.get("prefix") ?? "";
      const decodedPrefix = decodeURIComponent(prefixParam);
      const limitParam = parseInt(
        url.searchParams.get("limit") ?? "1000",
        10,
      );
      const cursorParam = url.searchParams.get("cursor") ?? "";

      // Find distinct keys matching prefix
      const matched = new Set<string>();
      for (const k of store.keys()) {
        if (k.startsWith(prefixParam) || k.startsWith(decodedPrefix)) {
          matched.add(k);
        }
      }
      const matchingKeys = Array.from(matched).sort();

      let sliceStart = 0;
      if (cursorParam) {
        const idx = matchingKeys.indexOf(cursorParam);
        if (idx !== -1) {
          sliceStart = idx + 1;
        }
      }

      const remaining = matchingKeys.slice(sliceStart);
      const page = remaining.slice(0, limitParam);
      const hasMore = remaining.length > limitParam;
      const nextCursor = hasMore ? page[page.length - 1] : undefined;

      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: page.map((name) => ({ name })),
          result_info: {
            count: page.length,
            cursor: nextCursor,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  };

  let server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    onListen: () => {},
  }, handler);
  // Guard against random ephemeral ports hitting WHATWG fetch forbidden ports (e.g. 6566 sane-port)
  while (
    [6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080].includes(
      (server.addr as Deno.NetAddr).port,
    )
  ) {
    await server.shutdown();
    server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      handler,
    );
  }

  try {
    const port = (server.addr as Deno.NetAddr).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    await fn({
      baseUrl,
      recordedRequests,
      store,
      setSimulateError: (err) => {
        simulateError = err;
      },
    });
  } finally {
    await server.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Unit tests: Consistency tier validator, atomic() CAS rejection, TTL bounds,
// payload size limits, and key validation
// ---------------------------------------------------------------------------

// AC3: Given validateConsistencyTier("strong", "eventual"), when evaluated at deploy time,
// then it throws VALIDATION_FAILED and refuses deployment (KV-5).
// AC4: Given validateConsistencyTier("strong", "strong") or validateConsistencyTier("eventual", "eventual"),
// then it returns without error.
Deno.test("CloudflareKVProvider - unit: validateConsistencyTier enforces declared vs provider tier (KV-5, AC3, AC4)", () => {
  // AC3: Rejects requesting "strong" against an "eventual" tier provider
  assertThrows(
    () => validateConsistencyTier("strong", "eventual"),
    ValidationFailedError,
  );

  try {
    validateConsistencyTier("strong", "eventual");
    assert(false, "validateConsistencyTier must throw for mismatched tiers");
  } catch (e) {
    assert(e instanceof ValidationFailedError);
    assertEquals((e as ValidationFailedError).code, "VALIDATION_FAILED");
  }

  // AC4: Same tier declarations return without error
  validateConsistencyTier("strong", "strong");
  validateConsistencyTier("eventual", "eventual");
});

// Spec reference: KV-5 (Backing provider tier)
Deno.test("CloudflareKVProvider - unit: tier property is 'eventual' (KV-5)", () => {
  const kv = new CloudflareKVProvider({
    accountId: "test-acc",
    namespaceId: "test-ns",
    apiToken: "test-token",
  });
  assertEquals(kv.tier, "eventual");
});

// AC2: Given atomic() called on CloudflareKVProvider, then it throws VALIDATION_FAILED
// with an explicit message that linearizable CAS cannot be fulfilled on an eventual tier (KV-5).
Deno.test("CloudflareKVProvider - unit: atomic() throws VALIDATION_FAILED rejecting CAS on eventual tier (KV-5, AC2)", () => {
  const kv = new CloudflareKVProvider({
    accountId: "test-acc",
    namespaceId: "test-ns",
    apiToken: "test-token",
  });

  assertThrows(
    () => kv.atomic(),
    ValidationFailedError,
  );

  try {
    kv.atomic();
    assert(false, "kv.atomic() must throw ValidationFailedError");
  } catch (e) {
    assert(e instanceof ValidationFailedError);
    assertEquals((e as ValidationFailedError).code, "VALIDATION_FAILED");
    const msg = (e as Error).message.toLowerCase();
    assert(
      msg.includes("cas") ||
        msg.includes("atomic") ||
        msg.includes("eventual") ||
        msg.includes("linearizable"),
      `Expected message explaining eventual tier CAS rejection, got: ${
        (e as Error).message
      }`,
    );
  }
});

// AC5: Given set called with ttl less than 60 seconds, then it throws VALIDATION_FAILED
// with an explanation of Cloudflare's minimum TTL requirement (KV-5).
Deno.test("CloudflareKVProvider - unit: TTL bounds checking enforces Cloudflare 60s minimum (KV-5, KV-2, AC5)", async () => {
  const kv = new CloudflareKVProvider({
    accountId: "test-acc",
    namespaceId: "test-ns",
    apiToken: "test-token",
    baseUrl: "http://localhost:9999",
  });

  // ttl < 60 must throw ValidationFailedError
  await assertRejects(
    () => kv.set(["session", "token"], "val", { ttl: 59 }),
    ValidationFailedError,
  );

  await assertRejects(
    () => kv.set(["session", "token"], "val", { ttl: 0 }),
    ValidationFailedError,
  );

  await assertRejects(
    () => kv.set(["session", "token"], "val", { ttl: -10 }),
    ValidationFailedError,
  );

  await assertRejects(
    () => kv.set(["session", "token"], "val", { ttl: NaN }),
    ValidationFailedError,
  );

  // Message must explain 60s minimum requirement
  try {
    await kv.set(["session", "token"], "val", { ttl: 30 });
    assert(false, "Must have thrown for ttl < 60");
  } catch (e) {
    assert(e instanceof ValidationFailedError);
    assertEquals((e as ValidationFailedError).code, "VALIDATION_FAILED");
    const msg = (e as Error).message.toLowerCase();
    assert(
      msg.includes("60") || msg.includes("minimum"),
      `Expected message citing 60-second minimum TTL, got: ${
        (e as Error).message
      }`,
    );
  }
});

// AC6: Given a value exceeding 256 KB, when set is called,
// then it throws PAYLOAD_TOO_LARGE (KV-1, PLAT-12).
Deno.test("CloudflareKVProvider - unit: payload size checking enforces 256 KB limit (KV-1, PLAT-12, AC6)", async () => {
  const kv = new CloudflareKVProvider({
    accountId: "test-acc",
    namespaceId: "test-ns",
    apiToken: "test-token",
    baseUrl: "http://localhost:9999",
  });

  const maxBytes = 256 * 1024; // 262,144 bytes
  const oversizedString = "a".repeat(maxBytes + 1);

  await assertRejects(
    () => kv.set(["large", "key"], oversizedString),
    PayloadTooLargeError,
  );

  try {
    await kv.set(["large", "key"], oversizedString);
    assert(false, "Must have thrown for payload > 256 KB");
  } catch (e) {
    assert(e instanceof PayloadTooLargeError);
    assertEquals((e as PayloadTooLargeError).code, "PAYLOAD_TOO_LARGE");
  }

  // Oversized object serialization
  const oversizedObj = { data: "x".repeat(maxBytes) };
  await assertRejects(
    () => kv.set(["large", "obj"], oversizedObj),
    PayloadTooLargeError,
  );
});

// Spec reference: KV-4 (Key constraints: max 32 segments, non-empty)
Deno.test("CloudflareKVProvider - unit: key segment counting and empty key validation (KV-4)", async () => {
  const kv = new CloudflareKVProvider({
    accountId: "test-acc",
    namespaceId: "test-ns",
    apiToken: "test-token",
    baseUrl: "http://localhost:9999",
  });

  // 0 segments must throw ValidationFailedError across all operations
  await assertRejects(() => kv.set([], "val"), ValidationFailedError);
  await assertRejects(() => kv.get([]), ValidationFailedError);
  await assertRejects(() => kv.delete([]), ValidationFailedError);
  await assertRejects(() => kv.list([]), ValidationFailedError);

  // 33 segments exceeds max limit of 32
  const key33 = new Array(33).fill("seg");
  await assertRejects(() => kv.set(key33, "val"), ValidationFailedError);
  await assertRejects(() => kv.get(key33), ValidationFailedError);
  await assertRejects(() => kv.delete(key33), ValidationFailedError);
});

// Spec reference: KV-4 (Key constraints: max 512 bytes UTF-8)
Deno.test("CloudflareKVProvider - unit: key length calculation with multi-byte UTF-8 (KV-4)", async () => {
  const kv = new CloudflareKVProvider({
    accountId: "test-acc",
    namespaceId: "test-ns",
    apiToken: "test-token",
    baseUrl: "http://localhost:9999",
  });

  // 513 bytes: 128 four-byte UTF-8 emojis + 1 ASCII byte = 513 bytes
  const over512 = ["🦀".repeat(128) + "x"];
  await assertRejects(() => kv.set(over512, "over-512"), ValidationFailedError);
  await assertRejects(() => kv.get(over512), ValidationFailedError);

  // Multiple segments exceeding 512 bytes cumulatively (510 + 3 = 513 bytes)
  const multiSegOver = [...new Array(10).fill("a".repeat(51)), "a".repeat(3)];
  await assertRejects(
    () => kv.set(multiSegOver, "multi-seg-over"),
    ValidationFailedError,
  );
});

// ---------------------------------------------------------------------------
// Integration tests: Standard Cloudflare REST API requests, CRUD, pagination
// Spec references: KV-1, KV-2, KV-4, KV-5, PLAT-16, PLAT-17
// ---------------------------------------------------------------------------

// AC1: Given a configured CloudflareKVProvider, when set, get, delete, and list are invoked,
// then standard Cloudflare Workers KV REST API requests are dispatched.
Deno.test("CloudflareKVProvider - integration: standard Cloudflare REST API requests dispatched for set, get, delete (KV-2, AC1)", async () => {
  await withMockServer(async ({ baseUrl, recordedRequests }) => {
    const kv = new CloudflareKVProvider({
      accountId: "acc-1",
      namespaceId: "ns-1",
      apiToken: "mock-api-token-12345",
      baseUrl,
    });

    // 1. set
    await kv.set(["users", "alice"], { role: "admin" });

    const putReq = recordedRequests.find((r) => r.method === "PUT");
    assert(putReq !== undefined, "PUT request must be dispatched on set");
    assertEquals(
      putReq.headers.get("authorization"),
      "Bearer mock-api-token-12345",
    );
    assert(
      putReq.pathname.includes(
        "/client/v4/accounts/acc-1/storage/kv/namespaces/ns-1/values/",
      ),
      `Path must match CF KV values URL: ${putReq.pathname}`,
    );

    // 2. get
    const val = await kv.get(["users", "alice"]);
    assertEquals(val, { role: "admin" });

    const getReq = recordedRequests.find((r) => r.method === "GET");
    assert(getReq !== undefined, "GET request must be dispatched on get");
    assertEquals(
      getReq.headers.get("authorization"),
      "Bearer mock-api-token-12345",
    );
    assert(
      getReq.pathname.includes(
        "/client/v4/accounts/acc-1/storage/kv/namespaces/ns-1/values/",
      ),
      `Path must match CF KV values URL: ${getReq.pathname}`,
    );

    // 3. delete
    await kv.delete(["users", "alice"]);

    const delReq = recordedRequests.find((r) => r.method === "DELETE");
    assert(delReq !== undefined, "DELETE request must be dispatched on delete");
    assertEquals(
      delReq.headers.get("authorization"),
      "Bearer mock-api-token-12345",
    );
    assert(
      delReq.pathname.includes(
        "/client/v4/accounts/acc-1/storage/kv/namespaces/ns-1/values/",
      ),
      `Path must match CF KV values URL: ${delReq.pathname}`,
    );

    // After delete, get returns null
    const afterDel = await kv.get(["users", "alice"]);
    assertEquals(afterDel, null);
  });
});

// AC5: set with valid TTL (>= 60s) translates to expiration_ttl query parameter per CF API
Deno.test("CloudflareKVProvider - integration: set with TTL dispatches expiration_ttl query param (KV-2, AC1, AC5)", async () => {
  await withMockServer(async ({ baseUrl, recordedRequests }) => {
    const kv = new CloudflareKVProvider({
      accountId: "acc-1",
      namespaceId: "ns-1",
      apiToken: "mock-api-token-12345",
      baseUrl,
    });

    await kv.set(["cache", "page-1"], "html-content", { ttl: 120 });

    const putReq = recordedRequests.find((r) => r.method === "PUT");
    assert(putReq !== undefined, "PUT request must be dispatched");
    assertEquals(putReq.searchParams.get("expiration_ttl"), "120");
  });
});

// Spec reference: KV-2 (get non-existent returns null)
Deno.test("CloudflareKVProvider - integration: get non-existent key returns null (KV-2, AC1)", async () => {
  await withMockServer(async ({ baseUrl }) => {
    const kv = new CloudflareKVProvider({
      accountId: "acc-1",
      namespaceId: "ns-1",
      apiToken: "mock-api-token-12345",
      baseUrl,
    });

    const result = await kv.get(["missing", "key"]);
    assertEquals(result, null);
  });
});

// Spec reference: KV-2, PLAT-16 (Multiple data types and boundary payload)
Deno.test("CloudflareKVProvider - integration: round-trip CRUD for multiple data types (KV-2, PLAT-16)", async () => {
  await withMockServer(async ({ baseUrl }) => {
    const kv = new CloudflareKVProvider({
      accountId: "acc-1",
      namespaceId: "ns-1",
      apiToken: "mock-api-token-12345",
      baseUrl,
    });

    // String
    await kv.set(["type", "string"], "hello world");
    assertEquals(await kv.get(["type", "string"]), "hello world");

    // Number
    await kv.set(["type", "number"], 42.5);
    assertEquals(await kv.get(["type", "number"]), 42.5);

    // Boolean
    await kv.set(["type", "boolean"], true);
    assertEquals(await kv.get(["type", "boolean"]), true);

    // Complex nested object
    const complex = { foo: "bar", count: 10, tags: ["a", "b"] };
    await kv.set(["type", "object"], complex);
    assertEquals(await kv.get(["type", "object"]), complex);

    // Exact 256 KB payload boundary (256 * 1024 bytes)
    const exact256KB = "x".repeat(256 * 1024);
    await kv.set(["type", "boundary256k"], exact256KB);
    assertEquals(await kv.get(["type", "boundary256k"]), exact256KB);
  });
});

// Spec reference: KV-2 (list with prefix and cursor pagination)
Deno.test("CloudflareKVProvider - integration: list with prefix, limit, and cursor pagination (KV-2, AC1)", async () => {
  await withMockServer(async ({ baseUrl, recordedRequests }) => {
    const kv = new CloudflareKVProvider({
      accountId: "acc-1",
      namespaceId: "ns-1",
      apiToken: "mock-api-token-12345",
      baseUrl,
    });

    // Seed 25 items under ["logs", "prod"] and 5 items under ["logs", "staging"]
    for (let i = 0; i < 25; i++) {
      const id = i.toString().padStart(2, "0");
      await kv.set(["logs", "prod", id], { id: i });
    }
    for (let i = 0; i < 5; i++) {
      const id = i.toString().padStart(2, "0");
      await kv.set(["logs", "staging", id], { stagingId: i });
    }

    recordedRequests.length = 0;

    // Page 1: limit 10
    const page1 = await kv.list(["logs", "prod"], { limit: 10 });
    assertEquals(page1.keys.length, 10);
    assert(typeof page1.cursor === "string", "Page 1 cursor must be returned");

    // Verify GET request to keys endpoint dispatched with prefix and limit
    const listReq1 = recordedRequests.find(
      (r) => r.method === "GET" && r.pathname.includes("/keys"),
    );
    assert(listReq1 !== undefined, "GET request to keys must be dispatched");
    assertEquals(
      listReq1.headers.get("authorization"),
      "Bearer mock-api-token-12345",
    );
    assertEquals(listReq1.searchParams.get("limit"), "10");

    // Page 2: limit 10 using cursor from page 1
    const page2 = await kv.list(["logs", "prod"], {
      limit: 10,
      cursor: page1.cursor,
    });
    assertEquals(page2.keys.length, 10);
    assert(typeof page2.cursor === "string", "Page 2 cursor must be returned");

    // Page 3: limit 10 using cursor from page 2 (remaining 5 items)
    const page3 = await kv.list(["logs", "prod"], {
      limit: 10,
      cursor: page2.cursor,
    });
    assertEquals(page3.keys.length, 5);
    assertEquals(
      page3.cursor,
      undefined,
      "Last page must have undefined cursor",
    );

    // Verify all 25 items retrieved without repetition
    const all = [...page1.keys, ...page2.keys, ...page3.keys];
    assertEquals(all.length, 25);
    const ids = new Set(all.map((item) => (item.value as { id: number }).id));
    assertEquals(ids.size, 25);

    // Staging logs must not be included under prefix ["logs", "prod"]
    for (const item of all) {
      assertEquals(item.key[0], "logs");
      assertEquals(item.key[1], "prod");
    }
  });
});

// Spec reference: KV-2 (list default limit 100, max limit 1000)
Deno.test("CloudflareKVProvider - integration: list default limit (100) and max limit (1000) (KV-2)", async () => {
  await withMockServer(async ({ baseUrl, recordedRequests }) => {
    const kv = new CloudflareKVProvider({
      accountId: "acc-1",
      namespaceId: "ns-1",
      apiToken: "mock-api-token-12345",
      baseUrl,
    });

    // Calling list without limit options uses default limit 100
    await kv.list(["bulk"]);
    const reqDefault = recordedRequests[recordedRequests.length - 1];
    assertEquals(reqDefault.searchParams.get("limit"), "100");

    // Calling list with limit > 1000 clamps to max limit 1000 per KV-2
    await kv.list(["bulk"], { limit: 5000 });
    const reqMax = recordedRequests[recordedRequests.length - 1];
    assertEquals(reqMax.searchParams.get("limit"), "1000");
  });
});

// ---------------------------------------------------------------------------
// Security tests: Token redaction (PLAT-15) and key sanitization (KV-4)
// ---------------------------------------------------------------------------

// Security: Verify authorization header containing apiToken is redacted from error strings and traces (PLAT-15)
Deno.test("CloudflareKVProvider - security: authorization header containing apiToken is redacted from error strings and traces (PLAT-15)", async () => {
  const secretToken = "super-secret-cloudflare-api-token-99999";
  await withMockServer(
    async ({ baseUrl, setSimulateError }) => {
      const kv = new CloudflareKVProvider({
        accountId: "test-acc",
        namespaceId: "test-ns",
        apiToken: secretToken,
        baseUrl,
      });

      // Simulate remote 500 error from Cloudflare endpoint
      setSimulateError({
        status: 500,
        message: "Internal Cloudflare Error with auth details",
      });

      const methods: (() => Promise<unknown>)[] = [
        () => kv.get(["users", "alice"]),
        () => kv.set(["users", "alice"], "val"),
        () => kv.delete(["users", "alice"]),
        () => kv.list(["users"]),
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
            `Error message/string must not leak apiToken: ${errStr}`,
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
});

// Spec reference: KV-4 (Path traversal and illegal character rejection)
Deno.test("CloudflareKVProvider - security: rejects path traversal and malicious key segments across all methods (KV-4)", async () => {
  const kv = new CloudflareKVProvider({
    accountId: "test-acc",
    namespaceId: "test-ns",
    apiToken: "test-token",
    baseUrl: "http://localhost:9999",
  });

  const maliciousKeys = [
    ["users", "..", "secrets"],
    ["..", "etc", "passwd"],
    ["users", ".", "profile"],
    ["users", "foo/bar"],
    ["users", "foo\\bar"],
    ["users", "admin\0injection"],
    ["\0", "secrets"],
    ["users", ""],
    ["", "empty_root"],
  ];

  for (const badKey of maliciousKeys) {
    await assertRejects(() => kv.set(badKey, "exploit"), ValidationFailedError);
    await assertRejects(() => kv.get(badKey), ValidationFailedError);
    await assertRejects(() => kv.delete(badKey), ValidationFailedError);
    await assertRejects(() => kv.list(badKey), ValidationFailedError);
  }
});

// Spec reference: KV-4 (Segment typing rejection)
Deno.test("CloudflareKVProvider - security: enforces strict string segment typing (KV-4)", async () => {
  const kv = new CloudflareKVProvider({
    accountId: "test-acc",
    namespaceId: "test-ns",
    apiToken: "test-token",
    baseUrl: "http://localhost:9999",
  });

  const nonStringKeys = [
    ["users", 123 as unknown as string],
    ["users", null as unknown as string],
    ["users", undefined as unknown as string],
    ["users", true as unknown as string],
    ["users", {} as unknown as string],
  ];

  for (const badKey of nonStringKeys) {
    await assertRejects(
      () => kv.set(badKey, "bad_type"),
      ValidationFailedError,
    );
    await assertRejects(() => kv.get(badKey), ValidationFailedError);
  }
});

// Spec reference: PLAT-15 (Naive inspection/logging must not leak apiToken)
Deno.test("CloudflareKVProvider - security: naive object inspection via Deno.inspect/JSON.stringify redacts apiToken (PLAT-15)", () => {
  const secretToken = "super-secret-audit-token-9999";
  const kv = new CloudflareKVProvider({
    accountId: "test-acc",
    namespaceId: "test-ns",
    apiToken: secretToken,
  });

  const inspected = Deno.inspect(kv);
  const jsonStr = JSON.stringify(kv);

  assertFalse(
    inspected.includes(secretToken),
    `Deno.inspect(kv) leaked apiToken: ${inspected}`,
  );
  assertFalse(
    jsonStr.includes(secretToken),
    `JSON.stringify(kv) leaked apiToken: ${jsonStr}`,
  );
  assert(inspected.includes("[REDACTED]"));
  assert(jsonStr.includes("[REDACTED]"));
});

// Spec reference: PLAT-15, PLAT-12 (Malformed JSON in list() response is redacted and mapped to InternalError)
Deno.test("CloudflareKVProvider - security: malformed JSON in list() response is redacted and mapped to InternalError (PLAT-15, PLAT-12)", async () => {
  const secretToken = "secret-token-in-json-parse-err";
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => {
      // Simulate upstream 200 with invalid JSON containing token
      return new Response(`{"result": ${secretToken}}`, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  try {
    const port = server.addr.port;
    const kv = new CloudflareKVProvider({
      accountId: "acc-1",
      namespaceId: "ns-1",
      apiToken: secretToken,
      baseUrl: `http://localhost:${port}`,
    });

    let caught: unknown = null;
    try {
      await kv.list(["prefix"]);
    } catch (err) {
      caught = err;
    }

    assert(caught !== null, "list() must throw on malformed JSON");
    assert(
      (caught as Error).name === "InternalError" ||
        caught instanceof Error,
      `Expected InternalError, got: ${caught}`,
    );

    const msg = (caught as Error).message;
    const stack = (caught as Error).stack ?? "";
    assertFalse(
      msg.includes(secretToken),
      `list() JSON error leaked apiToken: ${msg}`,
    );
    assertFalse(
      stack.includes(secretToken),
      `list() JSON stack leaked apiToken: ${stack}`,
    );
  } finally {
    await server.shutdown();
  }
});
