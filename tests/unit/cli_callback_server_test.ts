// spec: docs/contracts/platform.contract.md#PLAT-1 — Control plane vs. data plane CLI interaction
// spec: docs/contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage in errors/logs
// spec: docs/contracts/platform.contract.md#PLAT-19 — Repository structure and resource lifecycle
// spec: tasks/milestone-0.8-developer-experience-ux/T-0801-ephemeral-callback-server.md

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import {
  type CallbackServerOptions,
  type CallbackServerSession,
  startCallbackServer,
} from "../../cli/callback-server.ts";

// ============================================================================
// AC 1: Server Port Allocation & Loopback URL Format
// ============================================================================

Deno.test("T-0801: AC1 - Server binds to 127.0.0.1 ephemeral port and generates UUID state nonce", async () => {
  const session: CallbackServerSession = await startCallbackServer();
  try {
    // Port must be an unprivileged ephemeral port (1024-65535)
    assert(
      session.port > 1024 && session.port <= 65535,
      `Expected unprivileged ephemeral port (>1024), got: ${session.port}`,
    );

    // Loopback URL format must strictly be http://127.0.0.1:<port>/callback
    assertEquals(
      session.callbackUrl,
      `http://127.0.0.1:${session.port}/callback`,
      "Loopback URL must use 127.0.0.1 and /callback path",
    );

    // State nonce must be a valid cryptographically generated UUIDv4 (128-bit entropy)
    assertMatch(
      session.state,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "Generated state nonce must match UUID format from crypto.randomUUID()",
    );

    // Verify distinct instances have distinct ports and state nonces
    const session2: CallbackServerSession = await startCallbackServer();
    try {
      assertNotEquals(
        session.port,
        session2.port,
        "Separate sessions must bind to distinct ports",
      );
      assertNotEquals(
        session.state,
        session2.state,
        "Separate sessions must generate distinct state nonces",
      );
    } finally {
      await session2.close();
    }
  } finally {
    await session.close();
  }
});

Deno.test("T-0801: AC1 - Predefined custom state option is respected when provided", async () => {
  const customState = "custom-csrf-state-nonce-with-sufficient-entropy-999";
  const options: CallbackServerOptions = { state: customState };
  const session: CallbackServerSession = await startCallbackServer(options);
  try {
    assertEquals(
      session.state,
      customState,
      "Session state must use custom state when provided",
    );
  } finally {
    await session.close();
  }
});

// ============================================================================
// AC 2: Successful Token Delivery & Security Headers
// ============================================================================

Deno.test("T-0801: AC2 - Successful callback returns 200 OK HTML with Referrer-Policy: no-referrer", async () => {
  const session = await startCallbackServer({ timeoutMs: 5000 });
  try {
    const tokenPromise = session.waitForToken();

    const targetUrl = new URL(session.callbackUrl);
    targetUrl.searchParams.set("token", "rfk_test_valid_token_12345");
    targetUrl.searchParams.set("state", session.state);

    const response = await fetch(targetUrl.toString());
    assertEquals(
      response.status,
      200,
      "Matching state and valid token must return 200 OK",
    );

    // Security headers: Referrer-Policy: no-referrer and Cache-Control: no-store, private
    assertEquals(
      response.headers.get("referrer-policy"),
      "no-referrer",
      "Response must enforce Referrer-Policy: no-referrer to prevent token leakage",
    );
    const cacheControl = response.headers.get("cache-control");
    assert(
      cacheControl !== null && cacheControl.includes("no-store"),
      `Response Cache-Control must include no-store, got: ${cacheControl}`,
    );

    // Response body must be self-contained HTML with user instruction and zero external assets
    const html = await response.text();
    assertMatch(
      html,
      /close this tab|return to your terminal/i,
      "HTML response must instruct the user to close the tab and return to terminal",
    );
    assert(
      !html.includes("<script src="),
      "HTML confirmation page must not load external scripts",
    );
    assert(
      !html.includes("<link rel="),
      "HTML confirmation page must not load external stylesheets",
    );
    assert(
      !html.includes("<img src="),
      "HTML confirmation page must not load external images",
    );

    // waitForToken() fulfills with the delivered token
    const result = await tokenPromise;
    assertEquals(result.token, "rfk_test_valid_token_12345");
  } finally {
    await session.close();
  }
});

Deno.test("T-0801: AC2 - Callback accepts optional orgId and org_id query parameters", async () => {
  // Test camelCase orgId
  const session1 = await startCallbackServer({ timeoutMs: 5000 });
  try {
    const tokenPromise = session1.waitForToken();
    const url = new URL(session1.callbackUrl);
    url.searchParams.set("token", "rfk_token_with_org_1");
    url.searchParams.set("state", session1.state);
    url.searchParams.set("orgId", "org_enterprise_alpha");

    const res = await fetch(url.toString());
    assertEquals(res.status, 200);
    const result = await tokenPromise;
    assertEquals(result.token, "rfk_token_with_org_1");
    assertEquals(result.orgId, "org_enterprise_alpha");
  } finally {
    await session1.close();
  }

  // Test snake_case org_id compatibility
  const session2 = await startCallbackServer({ timeoutMs: 5000 });
  try {
    const tokenPromise = session2.waitForToken();
    const url = new URL(session2.callbackUrl);
    url.searchParams.set("token", "rfk_token_with_org_2");
    url.searchParams.set("state", session2.state);
    url.searchParams.set("org_id", "org_enterprise_beta");

    const res = await fetch(url.toString());
    assertEquals(res.status, 200);
    const result = await tokenPromise;
    assertEquals(result.token, "rfk_token_with_org_2");
    assertEquals(result.orgId, "org_enterprise_beta");
  } finally {
    await session2.close();
  }
});

Deno.test("T-0801: AC2 - Single-use listener shuts down immediately after first valid callback", async () => {
  const session = await startCallbackServer({ timeoutMs: 5000 });
  try {
    const tokenPromise = session.waitForToken();
    const url = new URL(session.callbackUrl);
    url.searchParams.set("token", "rfk_single_use_token_1");
    url.searchParams.set("state", session.state);

    const firstRes = await fetch(url.toString());
    assertEquals(firstRes.status, 200);
    await tokenPromise;

    // Single-use listener must terminate immediately. Subsequent requests must fail.
    await assertRejects(
      async () => {
        await fetch(url.toString());
      },
      TypeError,
      undefined,
      "Second request to single-use server must fail with connection error",
    );
  } finally {
    await session.close();
  }
});

// ============================================================================
// AC 3: Probe Resilience & Mismatched State Rejection
// ============================================================================

Deno.test("T-0801: AC3 - Invalid or mismatched state returns 400 Bad Request", async () => {
  const session = await startCallbackServer({ timeoutMs: 5000 });
  try {
    const url = new URL(session.callbackUrl);
    url.searchParams.set("token", "rfk_probe_token_123");
    url.searchParams.set("state", "invalid-mismatched-nonce-999");

    const res = await fetch(url.toString());
    assertEquals(
      res.status,
      400,
      "Mismatched state must yield 400 Bad Request",
    );

    const body = await res.text();
    // PLAT-15: Never echo state or secrets in error response
    assert(
      !body.includes(session.state),
      "Error response must not leak the expected state nonce",
    );
  } finally {
    await session.close();
  }
});

Deno.test("T-0801: AC3 - Missing token or missing state returns 400 Bad Request", async () => {
  const session = await startCallbackServer({ timeoutMs: 5000 });
  try {
    // 1. Missing state
    const urlMissingState = new URL(session.callbackUrl);
    urlMissingState.searchParams.set("token", "rfk_probe_token_abc");
    const res1 = await fetch(urlMissingState.toString());
    assertEquals(
      res1.status,
      400,
      "Missing state parameter must yield 400 Bad Request",
    );

    // 2. Missing token
    const urlMissingToken = new URL(session.callbackUrl);
    urlMissingToken.searchParams.set("state", session.state);
    const res2 = await fetch(urlMissingToken.toString());
    assertEquals(
      res2.status,
      400,
      "Missing token parameter must yield 400 Bad Request",
    );
  } finally {
    await session.close();
  }
});

Deno.test("T-0801: AC3 - Probe resilience keeps listener active for legitimate callback after invalid attempts", async () => {
  const session = await startCallbackServer({ timeoutMs: 5000 });
  try {
    const tokenPromise = session.waitForToken();

    // 1. Attempt probe with wrong state
    const probe1 = new URL(session.callbackUrl);
    probe1.searchParams.set("token", "rfk_probe_bad_state");
    probe1.searchParams.set("state", "definitely-wrong-nonce");
    const probeRes1 = await fetch(probe1.toString());
    assertEquals(probeRes1.status, 400);

    // 2. Attempt probe to unhandled path
    const probeRes2 = await fetch(
      `http://127.0.0.1:${session.port}/unhandled-path`,
    );
    assert(
      probeRes2.status === 404 || probeRes2.status === 400,
      "Unhandled path must return 404 or 400",
    );

    // 3. Attempt probe with wrong HTTP method
    const probeRes3 = await fetch(session.callbackUrl, { method: "POST" });
    assert(
      probeRes3.status === 405 || probeRes3.status === 400 ||
        probeRes3.status === 404,
      "POST to callback must return 405, 400, or 404",
    );

    // 4. Now send legitimate request with valid matching state
    const legitUrl = new URL(session.callbackUrl);
    legitUrl.searchParams.set("token", "rfk_legitimate_token_success");
    legitUrl.searchParams.set("state", session.state);

    const legitRes = await fetch(legitUrl.toString());
    assertEquals(
      legitRes.status,
      200,
      "Legitimate request must succeed after failed probes",
    );

    const result = await tokenPromise;
    assertEquals(
      result.token,
      "rfk_legitimate_token_success",
      "waitForToken must successfully resolve legitimate token after probes",
    );
  } finally {
    await session.close();
  }
});

// ============================================================================
// AC 4: Timeout Handling & Automatic Cleanup
// ============================================================================

Deno.test("T-0801: AC4 - Server times out after timeoutMs, rejects waitForToken with TIMEOUT, and closes", async () => {
  // Use a short real timeout (80ms) to exercise actual elapsed time without mocking clocks
  const session = await startCallbackServer({ timeoutMs: 80 });
  try {
    const error = await assertRejects(
      async () => {
        await session.waitForToken();
      },
      Error,
    );

    // Verify error message or code reflects TIMEOUT per PLAT-12
    const isTimeout = error.message.toUpperCase().includes("TIMEOUT") ||
      (error as { code?: string }).code === "TIMEOUT";
    assert(
      isTimeout,
      `Expected error to indicate TIMEOUT, got: ${error.message}`,
    );

    // Verify the server listener was automatically closed upon timeout
    await assertRejects(
      async () => {
        await fetch(session.callbackUrl);
      },
      TypeError,
      undefined,
      "Server should be closed after timeout; fetch must fail",
    );
  } finally {
    await session.close();
  }
});

// ============================================================================
// AC 5: Explicit Idempotent close() Cleanup (PLAT-19)
// ============================================================================

Deno.test("T-0801: AC5 - Explicit close() is idempotent and frees port without resource leaks", async () => {
  const session = await startCallbackServer({ timeoutMs: 10_000 });
  const pendingToken = session.waitForToken();

  // First close
  await session.close();

  // Subsequent close calls must be safe and idempotent
  await session.close();
  await session.close();

  // waitForToken must reject cleanly rather than hanging the event loop
  await assertRejects(
    async () => {
      await pendingToken;
    },
    Error,
  );

  // Verifying server port is freed
  await assertRejects(
    async () => {
      await fetch(session.callbackUrl);
    },
    TypeError,
  );
});

// ============================================================================
// Security Test (PLAT-15): Zero Raw Token Leakage & Query Sanitization
// ============================================================================

Deno.test("T-0801: PLAT-15 - Zero raw token leakage in server logs, error responses, and headers", async () => {
  const canaryValidToken = "rfk_canary_super_secret_audit_token_987654321";
  const canaryProbeToken = "rfk_canary_attacker_injected_secret_probe_123456";

  const interceptedLogs: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const origInfo = console.info;

  const captureLog = (...args: unknown[]) => {
    interceptedLogs.push(
      args
        .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
        .join(" "),
    );
  };

  try {
    console.log = captureLog;
    console.error = captureLog;
    console.warn = captureLog;
    console.info = captureLog;

    const session = await startCallbackServer({ timeoutMs: 5000 });
    try {
      const tokenPromise = session.waitForToken();

      // 1. Send invalid probe containing canaryProbeToken
      const probeUrl = new URL(session.callbackUrl);
      probeUrl.searchParams.set("token", canaryProbeToken);
      probeUrl.searchParams.set("state", "mismatched_state_value");

      const badRes = await fetch(probeUrl.toString());
      assertEquals(badRes.status, 400);

      const badBody = await badRes.text();
      assert(
        !badBody.includes(canaryProbeToken),
        "400 Bad Request body must never contain raw probe token",
      );

      // Verify response headers do not echo tokens
      for (const [key, val] of badRes.headers.entries()) {
        assert(
          !val.includes(canaryProbeToken),
          `Header ${key} leaked probe token: ${val}`,
        );
      }

      // 2. Send valid request with canaryValidToken
      const validUrl = new URL(session.callbackUrl);
      validUrl.searchParams.set("token", canaryValidToken);
      validUrl.searchParams.set("state", session.state);

      const goodRes = await fetch(validUrl.toString());
      assertEquals(goodRes.status, 200);

      const goodBody = await goodRes.text();
      assert(
        !goodBody.includes(canaryValidToken),
        "200 OK confirmation body must never contain raw token",
      );

      for (const [key, val] of goodRes.headers.entries()) {
        assert(
          !val.includes(canaryValidToken),
          `Header ${key} leaked valid token: ${val}`,
        );
      }

      await tokenPromise;

      // 3. Inspect all intercepted server logs to assert zero leakage
      for (const logLine of interceptedLogs) {
        assert(
          !logLine.includes(canaryValidToken),
          `Server log leaked valid token: ${logLine}`,
        );
        assert(
          !logLine.includes(canaryProbeToken),
          `Server log leaked probe token: ${logLine}`,
        );
      }
    } finally {
      await session.close();
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    console.info = origInfo;
  }
});

Deno.test("T-0801: Security - XSS and parameter injection payloads are rejected and not reflected", async () => {
  const session = await startCallbackServer({ timeoutMs: 5000 });
  try {
    const xssPayload =
      `<script>alert('xss')</script><img src=x onerror=alert(1)>`;
    const url = new URL(session.callbackUrl);
    url.searchParams.set("token", xssPayload);
    url.searchParams.set("state", "wrong_state");

    const res = await fetch(url.toString());
    assertEquals(res.status, 400);

    const body = await res.text();
    assert(
      !body.includes("<script>alert('xss')</script>"),
      "Response body must never reflect raw XSS scripts",
    );
    assert(
      !body.includes("<img src=x onerror=alert(1)>"),
      "Response body must never reflect raw image onerror scripts",
    );
  } finally {
    await session.close();
  }
});
