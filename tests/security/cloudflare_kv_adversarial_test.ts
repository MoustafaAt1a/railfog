// Spec references: PLAT-15 (Secret redaction), KV-4 (Key sanitization & path traversal), KV-5 (Tier enforcement)
// Task: T-0205 (Cloudflare Workers KV remote provider) adversarial security audit

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
  InternalError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

// ---------------------------------------------------------------------------
// Adversarial Attack 1: PLAT-15 Secret Leakage via JSON parsing error in list()
// ---------------------------------------------------------------------------
Deno.test("Adversarial PLAT-15: list() JSON parse error must not leak apiToken or bypass error taxonomy", async () => {
  const secretToken = "super-secret-token-xyz789";
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => {
      // Simulate upstream HTTP 200 with invalid JSON body embedding the secret token
      return new Response(`{"result": ${secretToken}}`, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  try {
    const port = server.addr.port;
    const kv = new CloudflareKVProvider({
      accountId: "acc-adv",
      namespaceId: "ns-adv",
      apiToken: secretToken,
      baseUrl: `http://localhost:${port}`,
    });

    let caughtError: unknown = null;
    try {
      await kv.list(["prefix"]);
    } catch (err) {
      caughtError = err;
    }

    assert(caughtError !== null, "list() must throw on invalid JSON");
    // Must adhere to PLAT-12 error model (InternalError)
    assert(
      caughtError instanceof InternalError,
      `Expected InternalError per PLAT-12, got: ${caughtError}`,
    );

    const errMsg = (caughtError as Error).message;
    const errStack = (caughtError as Error).stack ?? "";

    // Must satisfy PLAT-15 secret redaction
    assertFalse(
      errMsg.includes(secretToken),
      `Error message leaked apiToken: ${errMsg}`,
    );
    assertFalse(
      errStack.includes(secretToken),
      `Error stack leaked apiToken: ${errStack}`,
    );
  } finally {
    await server.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Adversarial Attack 2: PLAT-15 Secret Leakage via naive object logging/inspection
// ---------------------------------------------------------------------------
Deno.test("Adversarial PLAT-15: naive inspection via Deno.inspect/JSON.stringify must not leak apiToken", () => {
  const secretToken = "top-secret-bearer-token-123456";
  const kv = new CloudflareKVProvider({
    accountId: "acc-adv",
    namespaceId: "ns-adv",
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
});

// ---------------------------------------------------------------------------
// Adversarial Attack 3: PLAT-15 Secret Leakage via upstream 4xx/5xx responses
// ---------------------------------------------------------------------------
Deno.test("Adversarial PLAT-15: upstream 4xx/5xx echoing token in body must be redacted across all methods", async () => {
  const secretToken = "leaked-token-in-upstream-body-456";
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => {
      // Simulate remote 502 with error echoing the token
      return new Response(
        JSON.stringify({
          success: false,
          errors: [
            { code: 50201, message: `Upstream error with ${secretToken}` },
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
    const kv = new CloudflareKVProvider({
      accountId: "acc-adv",
      namespaceId: "ns-adv",
      apiToken: secretToken,
      baseUrl: `http://localhost:${port}`,
    });

    const calls = [
      () => kv.get(["test"]),
      () => kv.set(["test"], "val"),
      () => kv.delete(["test"]),
      () => kv.list(["test"]),
    ];

    for (const call of calls) {
      try {
        await call();
        assert(false, "Operation should have rejected on 502");
      } catch (err) {
        assert(err instanceof InternalError);
        const msg = (err as Error).message;
        const stack = (err as Error).stack ?? "";
        assertFalse(
          msg.includes(secretToken),
          `Error message leaked apiToken: ${msg}`,
        );
        assertFalse(
          stack.includes(secretToken),
          `Stack trace leaked apiToken: ${stack}`,
        );
      }
    }
  } finally {
    await server.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Adversarial Attack 4: PLAT-15 Secret Leakage via network failure
// ---------------------------------------------------------------------------
Deno.test("Adversarial PLAT-15: network connection failure with token in exception must be redacted", async () => {
  const secretToken = "offline-secret-token-789";
  // Port that is immediately closed/unavailable
  const kv = new CloudflareKVProvider({
    accountId: "acc-adv",
    namespaceId: "ns-adv",
    apiToken: secretToken,
    baseUrl: "http://127.0.0.1:59999",
  });

  try {
    await kv.get(["offline", "test"]);
    assert(false, "Expected network failure");
  } catch (err) {
    assert(err instanceof InternalError);
    const msg = (err as Error).message;
    const stack = (err as Error).stack ?? "";
    assertFalse(
      msg.includes(secretToken),
      `Network failure message leaked apiToken: ${msg}`,
    );
    assertFalse(
      stack.includes(secretToken),
      `Network failure stack leaked apiToken: ${stack}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Adversarial Attack 5: KV-4 Key injection & Path Traversal
// ---------------------------------------------------------------------------
Deno.test("Adversarial KV-4: Key injection, path traversal, null bytes, and malicious characters rejected", async () => {
  const kv = new CloudflareKVProvider({
    accountId: "acc-adv",
    namespaceId: "ns-adv",
    apiToken: "adv-token",
    baseUrl: "http://localhost:9999",
  });

  const attackVectors: string[][] = [
    // Directory traversal
    [".."],
    ["."],
    ["users", "..", "secrets"],
    ["users", ".", "secrets"],
    ["..", "..", "root"],
    // Slashes and backslashes
    ["foo/bar"],
    ["foo\\bar"],
    ["/"],
    ["\\"],
    ["users", "/etc/passwd"],
    ["users", "C:\\Windows\\System32"],
    // Null byte injection
    ["\0"],
    ["foo\0bar"],
    ["users", "admin\0.json"],
    // Empty segments
    [""],
    ["users", ""],
    ["", "empty"],
    // Non-string segments
    [123 as unknown as string],
    [null as unknown as string],
    [undefined as unknown as string],
    [{} as unknown as string],
  ];

  for (const attack of attackVectors) {
    await assertRejects(
      () => kv.get(attack),
      ValidationFailedError,
      undefined,
      `Expected get() to reject attack vector: ${JSON.stringify(attack)}`,
    );
    await assertRejects(
      () => kv.set(attack, "data"),
      ValidationFailedError,
      undefined,
      `Expected set() to reject attack vector: ${JSON.stringify(attack)}`,
    );
    await assertRejects(
      () => kv.delete(attack),
      ValidationFailedError,
      undefined,
      `Expected delete() to reject attack vector: ${JSON.stringify(attack)}`,
    );
    await assertRejects(
      () => kv.list(attack),
      ValidationFailedError,
      undefined,
      `Expected list() to reject attack vector: ${JSON.stringify(attack)}`,
    );
  }

  // Segment count boundary
  const thirtyThreeSegs = new Array(33).fill("seg");
  await assertRejects(
    () => kv.get(thirtyThreeSegs),
    ValidationFailedError,
  );

  // Total byte length boundary (> 512 bytes)
  const over512Bytes = ["a".repeat(513)];
  await assertRejects(
    () => kv.get(over512Bytes),
    ValidationFailedError,
  );
});

// ---------------------------------------------------------------------------
// Adversarial Attack 6: KV-4 REST URL manipulation & escaping
// ---------------------------------------------------------------------------
Deno.test("Adversarial KV-4: URL-encoded traversal, query injection, and CRLF cannot escape REST path", async () => {
  const recordedPaths: string[] = [];
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    (req) => {
      recordedPaths.push(req.url);
      return new Response("null", { status: 404 });
    },
  );

  try {
    const port = server.addr.port;
    const kv = new CloudflareKVProvider({
      accountId: "acc-adv",
      namespaceId: "ns-adv",
      apiToken: "adv-token",
      baseUrl: `http://localhost:${port}`,
    });

    // Valid string containing percent-encoded dots or slashes
    await kv.get(["users", "%2e%2e"]);
    // Valid string containing query characters
    await kv.get(["users", "search?query=admin#frag"]);
    // Valid string containing CRLF characters
    await kv.get(["users", "line1\r\nline2"]);

    for (const urlStr of recordedPaths) {
      const url = new URL(urlStr);
      // Ensure path remained inside /values/ and did not escape or inject HTTP headers
      assert(
        url.pathname.includes("/storage/kv/namespaces/ns-adv/values/"),
        `REST path escaped namespace: ${url.pathname}`,
      );
      // Ensure no raw ? or # penetrated the key segment path
      assertFalse(
        url.pathname.includes("?"),
        `URL pathname contains raw query character: ${url.pathname}`,
      );
      assertFalse(
        url.pathname.includes("#"),
        `URL pathname contains raw fragment character: ${url.pathname}`,
      );
    }
  } finally {
    await server.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Adversarial Attack 7: KV-5 Consistency Tier and CAS Rejection
// ---------------------------------------------------------------------------
Deno.test("Adversarial KV-5: Reject silent tier downgrade and reject CAS (atomic) on eventual tier", () => {
  const kv = new CloudflareKVProvider({
    accountId: "acc-adv",
    namespaceId: "ns-adv",
    apiToken: "adv-token",
  });

  // Verify provider tier is eventual
  assertEquals(kv.tier, "eventual");

  // Attempt to validate strong tier against eventual provider
  assertThrows(
    () => validateConsistencyTier("strong", "eventual"),
    ValidationFailedError,
  );
  assertThrows(
    () => validateConsistencyTier("strong", kv.tier),
    ValidationFailedError,
  );

  // Attempt CAS atomic builder
  assertThrows(
    () => kv.atomic(),
    ValidationFailedError,
  );
});
