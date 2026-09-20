// spec: contracts/platform.contract.md#PLAT-1 — Ephemeral loopback callback server for CLI interaction
// spec: contracts/platform.contract.md#PLAT-6 — Caller identity resolution
// spec: contracts/platform.contract.md#PLAT-12 — Error taxonomy
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage in errors/logs
// spec: contracts/platform.contract.md#PLAT-17 — Local development parity
// spec: contracts/platform.contract.md#PLAT-19 — Resource lifecycle and deterministic teardown
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0757-cli-login-workflow.md
// spec: tasks/milestone-0.8-developer-experience-ux/T-0803-zero-copy-cli-login.md

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  clearCliConfig,
  loadCliConfig,
  resolveAuthHeader,
  resolveCliToken,
  saveCliConfig,
} from "../../cli/auth-config.ts";
import {
  type LoginOptions,
  type LoginResult,
  runLogin,
  runLogout,
  runWhoami,
} from "../../cli/login.ts";

/**
 * T-0803 extended login options matching tasks/milestone-0.8-developer-experience-ux/T-0803-zero-copy-cli-login.md
 */
export interface T0803LoginOptions extends LoginOptions {
  manual?: boolean;
  callbackTimeoutMs?: number;
}

const invokeLogin = runLogin as (
  options?: T0803LoginOptions,
) => Promise<LoginResult>;

// ============================================================================
// T-0757: Baseline Auth-Config & Manual Workflow Tests
// ============================================================================

Deno.test("T-0757: auth-config saves, loads, and clears CLI config", async () => {
  const tempDir = await Deno.makeTempDir();
  const testConfigPath = `${tempDir}/config.json`;

  // 1. Initial load should be null
  const initial = await loadCliConfig(testConfigPath);
  assertEquals(initial, null);

  // 2. Save config
  await saveCliConfig(
    {
      token: "rfk_test_12345",
      controlUrl: "https://control.example.com",
      orgId: "acme-corp",
    },
    testConfigPath,
  );

  // 3. Load config
  const loaded = await loadCliConfig(testConfigPath);
  assertEquals(loaded?.token, "rfk_test_12345");
  assertEquals(loaded?.controlUrl, "https://control.example.com");
  assertEquals(loaded?.orgId, "acme-corp");

  // 4. Resolve token precedence
  // Explicit option takes precedence
  const optToken = await resolveCliToken(
    { token: "rfk_override" },
    testConfigPath,
  );
  assertEquals(optToken, "rfk_override");

  // Default from file
  const fileToken = await resolveCliToken({}, testConfigPath);
  assertEquals(fileToken, "rfk_test_12345");

  // 5. Auth header formatting
  const headers = await resolveAuthHeader(
    { token: "rfk_override" },
    testConfigPath,
  );
  assertEquals(headers["authorization"], "Bearer rfk_override");

  // 6. Clear config
  await clearCliConfig(testConfigPath);
  const afterClear = await loadCliConfig(testConfigPath);
  assertEquals(afterClear, null);
});

Deno.test("T-0757: runLogin interactive simulator and verification", async () => {
  const tempDir = await Deno.makeTempDir();
  const testConfigPath = `${tempDir}/config.json`;

  let browserOpenedUrl = "";
  const mockOpenBrowser = (url: string) => {
    browserOpenedUrl = url;
    return Promise.resolve(true);
  };

  // Mock server responding to /v1/auth/verify
  const mockServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/auth/verify") {
      const auth = req.headers.get("authorization");
      if (auth === "Bearer rfk_valid_key_abc") {
        return new Response(
          JSON.stringify({
            ok: true,
            identity: { orgId: "demo-org", callerId: "dev-laptop" },
            request_id: "req_test",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          error: { code: "PERMISSION_DENIED", message: "Invalid key" },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const controlUrl = `http://127.0.0.1:${
    (mockServer.addr as Deno.NetAddr).port
  }`;

  try {
    // 1. Interactive login with simulated stdin
    const loginResult = await runLogin({
      controlUrl,
      configPath: testConfigPath,
      manual: true,
      openBrowser: mockOpenBrowser,
      stdinReader: () => Promise.resolve("   rfk_valid_key_abc   \n"), // Simulates copy-paste with spaces/newlines
    });

    assertEquals(loginResult.ok, true);
    assertEquals(loginResult.orgId, "demo-org");
    assert(browserOpenedUrl.startsWith(`${controlUrl}/login`));

    // Verify persisted
    const saved = await loadCliConfig(testConfigPath);
    assertEquals(saved?.token, "rfk_valid_key_abc");
    assertEquals(saved?.orgId, "demo-org");

    // 2. Whoami test
    const whoami = await runWhoami({
      controlUrl,
      configPath: testConfigPath,
    });
    assertEquals(whoami.authenticated, true);
    assertEquals(whoami.orgId, "demo-org");

    // 3. Logout test
    await runLogout({ configPath: testConfigPath });
    const afterLogout = await loadCliConfig(testConfigPath);
    assertEquals(afterLogout, null);
  } finally {
    await mockServer.shutdown();
  }
});

// ============================================================================
// T-0803 AC1 & AC2: Zero-Copy Interactive Login Flow
// ============================================================================

Deno.test("T-0803: AC1 & AC2 - Zero-copy login starts callback server, opens browser with callback & state, receives token, saves config mode 0600, and exits without manual input", async () => {
  const tempDir = await Deno.makeTempDir();
  const testConfigPath = `${tempDir}/config.json`;

  const deliveredToken = "rfk_zerocopy_valid_token_123";
  const expectedOrgId = "acme-cloud-org";

  // Control plane mock: validates token at /v1/auth/verify
  const mockServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/auth/verify") {
      const auth = req.headers.get("authorization");
      if (auth === `Bearer ${deliveredToken}`) {
        return new Response(
          JSON.stringify({
            ok: true,
            identity: { orgId: expectedOrgId, callerId: "acme-laptop" },
            request_id: "req_zc_auth",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          error: { code: "PERMISSION_DENIED", message: "Invalid key" },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const controlUrl = `http://127.0.0.1:${
    (mockServer.addr as Deno.NetAddr).port
  }`;
  let capturedBrowserUrl = "";
  let capturedCallbackUrl = "";

  try {
    // Mock browser: receives ${controlUrl}/login?callback=...&state=... and simulates callback redirect
    const mockOpenBrowser = async (url: string): Promise<boolean> => {
      capturedBrowserUrl = url;
      const parsed = new URL(url);

      // Verify endpoint and query parameters
      assertEquals(
        parsed.pathname,
        "/login",
        "Browser must open /login endpoint",
      );
      const callbackParam = parsed.searchParams.get("callback");
      const stateParam = parsed.searchParams.get("state");

      assert(
        callbackParam !== null,
        "Browser authorization URL must include 'callback' query parameter",
      );
      assert(
        stateParam !== null,
        "Browser authorization URL must include 'state' query parameter",
      );

      // Verify callback URL points to 127.0.0.1 loopback with /callback path
      const callbackObj = new URL(callbackParam);
      assertEquals(
        callbackObj.hostname,
        "127.0.0.1",
        "Callback URL host must be 127.0.0.1",
      );
      assertEquals(
        callbackObj.pathname,
        "/callback",
        "Callback URL path must be /callback",
      );
      const cbPort = parseInt(callbackObj.port, 10);
      assert(
        cbPort > 1024 && cbPort <= 65535,
        "Callback port must be ephemeral unprivileged",
      );

      // Verify state nonce is a valid UUID with sufficient entropy
      assertMatch(
        stateParam,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        "State nonce must be a valid UUIDv4",
      );

      capturedCallbackUrl = callbackParam;

      // Simulate browser authorization: HTTP GET redirect to loopback callback server
      const redirectTarget = new URL(callbackParam);
      redirectTarget.searchParams.set("token", deliveredToken);
      redirectTarget.searchParams.set("state", stateParam);
      redirectTarget.searchParams.set("orgId", expectedOrgId);
      redirectTarget.searchParams.set("keyName", "acme-laptop");

      const callbackRes = await fetch(redirectTarget.toString());
      assertEquals(
        callbackRes.status,
        200,
        "Callback server must respond 200 OK",
      );
      assertEquals(
        callbackRes.headers.get("referrer-policy"),
        "no-referrer",
        "Callback server must enforce Referrer-Policy: no-referrer",
      );

      return true;
    };

    // Stdin reader MUST NOT be called in zero-copy flow
    const failingStdinReader = (): Promise<string> => {
      throw new Error(
        "Zero-copy flow failure: stdinReader should not be invoked when browser callback succeeds!",
      );
    };

    const loginResult = await invokeLogin({
      controlUrl,
      configPath: testConfigPath,
      openBrowser: mockOpenBrowser,
      stdinReader: failingStdinReader,
    });

    // 1. Result verification
    assertEquals(loginResult.ok, true, "runLogin must return ok: true");
    assertEquals(
      loginResult.orgId,
      expectedOrgId,
      "runLogin must resolve correct orgId",
    );
    assert(
      capturedBrowserUrl.startsWith(`${controlUrl}/login`),
      "Browser must open target control plane login page",
    );

    // 2. Persisted credentials verification
    const saved = await loadCliConfig(testConfigPath);
    assertEquals(
      saved?.token,
      deliveredToken,
      "Persisted token must match callback token",
    );
    assertEquals(
      saved?.orgId,
      expectedOrgId,
      "Persisted orgId must match callback identity",
    );
    assertEquals(
      saved?.controlUrl,
      controlUrl,
      "Persisted controlUrl must match target",
    );
    assertEquals(
      saved?.keyName,
      "acme-laptop",
      "Persisted keyName must match callerId",
    );

    // 3. Mode 0600 verification on POSIX systems (PLAT-15)
    if (Deno.build.os !== "windows") {
      const stat = await Deno.stat(testConfigPath);
      const mode = stat.mode! & 0o777;
      assertEquals(
        mode,
        0o600,
        `Expected ~/.railfog/config.json to have mode 0600 on POSIX, got 0${
          mode.toString(8)
        }`,
      );
    }

    // 4. Callback server single-use teardown verification (PLAT-19)
    // The ephemeral listener must be closed after successful callback resolution
    await assertRejects(
      async () => {
        await fetch(capturedCallbackUrl);
      },
      TypeError,
      undefined,
      "Callback server must be closed after authentication completes",
    );
  } finally {
    await mockServer.shutdown();
  }
});

// ============================================================================
// T-0803 AC3: Manual Override (--manual) & Browser Failure Fallback
// ============================================================================

Deno.test("T-0803: AC3 - --manual flag bypasses callback server, opens login URL without callback/state, and prompts on stdin", async () => {
  const tempDir = await Deno.makeTempDir();
  const testConfigPath = `${tempDir}/config.json`;
  const manualToken = "rfk_manual_override_token_999";
  const expectedOrgId = "manual-org";

  const mockServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/auth/verify") {
      const auth = req.headers.get("authorization");
      if (auth === `Bearer ${manualToken}`) {
        return new Response(
          JSON.stringify({
            ok: true,
            identity: { orgId: expectedOrgId, callerId: "manual-user" },
            request_id: "req_manual_auth",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: { code: "PERMISSION_DENIED" } }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const controlUrl = `http://127.0.0.1:${
    (mockServer.addr as Deno.NetAddr).port
  }`;
  let browserOpenedUrl = "";
  let stdinCalled = false;

  try {
    const loginResult = await invokeLogin({
      controlUrl,
      configPath: testConfigPath,
      manual: true, // Force manual copy-paste flow
      openBrowser: (url: string) => {
        browserOpenedUrl = url;
        return Promise.resolve(true);
      },
      stdinReader: () => {
        stdinCalled = true;
        return Promise.resolve(`   ${manualToken}   \n`);
      },
    });

    // 1. Stdin prompt must be invoked
    assertEquals(
      stdinCalled,
      true,
      "stdinReader must be invoked when manual: true is set",
    );

    // 2. Opened browser URL must NOT have callback or state parameters
    const openedUrl = new URL(browserOpenedUrl);
    assertEquals(
      openedUrl.searchParams.has("callback"),
      false,
      "Manual flow must not include 'callback' query parameter",
    );
    assertEquals(
      openedUrl.searchParams.has("state"),
      false,
      "Manual flow must not include 'state' query parameter",
    );
    assertEquals(
      openedUrl.pathname,
      "/login",
      "Manual flow opens bare /login page",
    );

    // 3. Login verification
    assertEquals(loginResult.ok, true);
    assertEquals(loginResult.orgId, expectedOrgId);

    const saved = await loadCliConfig(testConfigPath);
    assertEquals(saved?.token, manualToken);
    assertEquals(saved?.orgId, expectedOrgId);
  } finally {
    await mockServer.shutdown();
  }
});

Deno.test("T-0803: AC3 - Fallback to stdin prompt when openBrowser fails (headless environment)", async () => {
  const tempDir = await Deno.makeTempDir();
  const testConfigPath = `${tempDir}/config.json`;
  const headlessToken = "rfk_headless_terminal_token_555";
  const expectedOrgId = "headless-org";

  const mockServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/auth/verify") {
      const auth = req.headers.get("authorization");
      if (auth === `Bearer ${headlessToken}`) {
        return new Response(
          JSON.stringify({
            ok: true,
            identity: { orgId: expectedOrgId, callerId: "headless-shell" },
            request_id: "req_headless_auth",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: { code: "PERMISSION_DENIED" } }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const controlUrl = `http://127.0.0.1:${
    (mockServer.addr as Deno.NetAddr).port
  }`;
  let stdinCalled = false;

  try {
    const loginResult = await invokeLogin({
      controlUrl,
      configPath: testConfigPath,
      // Simulate system where desktop browser cannot be opened (e.g. headless Linux or SSH session)
      openBrowser: () => Promise.resolve(false),
      stdinReader: () => {
        stdinCalled = true;
        return Promise.resolve(`   ${headlessToken}   \n`);
      },
    });

    assertEquals(
      stdinCalled,
      true,
      "stdinReader must be invoked when browser opening returns false",
    );
    assertEquals(loginResult.ok, true);
    assertEquals(loginResult.orgId, expectedOrgId);

    const saved = await loadCliConfig(testConfigPath);
    assertEquals(saved?.token, headlessToken);
  } finally {
    await mockServer.shutdown();
  }
});

// ============================================================================
// T-0803 AC4: Timeout Fallback to Interactive Stdin Prompt
// ============================================================================

Deno.test("T-0803: AC4 - Timeout fallback shuts down callback listener and falls back to stdin prompt rather than aborting", async () => {
  const tempDir = await Deno.makeTempDir();
  const testConfigPath = `${tempDir}/config.json`;
  const fallbackToken = "rfk_timeout_recovery_token_777";
  const expectedOrgId = "timeout-recovered-org";

  const mockServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/auth/verify") {
      const auth = req.headers.get("authorization");
      if (auth === `Bearer ${fallbackToken}`) {
        return new Response(
          JSON.stringify({
            ok: true,
            identity: { orgId: expectedOrgId, callerId: "timeout-user" },
            request_id: "req_timeout_auth",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: { code: "PERMISSION_DENIED" } }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const controlUrl = `http://127.0.0.1:${
    (mockServer.addr as Deno.NetAddr).port
  }`;
  let browserOpenedUrl = "";
  let stdinCalled = false;
  const startTime = Date.now();

  try {
    const loginResult = await invokeLogin({
      controlUrl,
      configPath: testConfigPath,
      callbackTimeoutMs: 100, // Short real timeout (100ms) - ANTIHALLUCINATION Rule 5
      openBrowser: (url: string) => {
        browserOpenedUrl = url;
        // Simulate user delayed / abandoned browser tab: do NOT send callback request
        return Promise.resolve(true);
      },
      stdinReader: () => {
        stdinCalled = true;
        return Promise.resolve(`   ${fallbackToken}   \n`);
      },
    });

    const elapsedMs = Date.now() - startTime;

    // 1. Initial attempt must have set up callback server and opened browser with callback and state
    const openedUrl = new URL(browserOpenedUrl);
    assert(
      openedUrl.searchParams.has("callback"),
      "Browser authorization URL must contain 'callback' query parameter for zero-copy attempt",
    );
    assert(
      openedUrl.searchParams.has("state"),
      "Browser authorization URL must contain 'state' query parameter for zero-copy attempt",
    );

    // 2. Must have waited for the timeout before falling back to stdin
    assert(
      elapsedMs >= 75,
      `Expected elapsed time to reflect timeout wait (>=75ms), got: ${elapsedMs}ms`,
    );

    // 3. Stdin prompt must have been called as fallback
    assertEquals(
      stdinCalled,
      true,
      "stdinReader must be called upon callback timeout",
    );

    // 4. Callback server listener must be closed following the timeout
    const callbackUrl = openedUrl.searchParams.get("callback")!;
    await assertRejects(
      async () => {
        await fetch(callbackUrl);
      },
      TypeError,
      undefined,
      "Callback server must be closed after timeout fallback occurs",
    );

    // 5. Login must succeed using the fallback stdin token
    assertEquals(loginResult.ok, true, "runLogin must succeed after fallback");
    assertEquals(
      loginResult.orgId,
      expectedOrgId,
      "runLogin must resolve correct orgId",
    );

    const saved = await loadCliConfig(testConfigPath);
    assertEquals(
      saved?.token,
      fallbackToken,
      "Persisted token must match fallback token",
    );
  } finally {
    await mockServer.shutdown();
  }
});

// ============================================================================
// T-0803 AC5 & PLAT-15: Zero Raw Secret Leakage Security Tests
// ============================================================================

Deno.test("T-0803: PLAT-15 - Raw token is never printed to stdout, stderr, or console logs during zero-copy login", async () => {
  const canaryToken = "rfk_canary_super_secret_login_never_print_123456789";
  const tempDir = await Deno.makeTempDir();
  const testConfigPath = `${tempDir}/config.json`;

  const mockServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/auth/verify") {
      return new Response(
        JSON.stringify({
          ok: true,
          identity: { orgId: "plat15-org", callerId: "audit-session" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("Not found", { status: 404 });
  });

  const controlUrl = `http://127.0.0.1:${
    (mockServer.addr as Deno.NetAddr).port
  }`;

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

    const loginResult = await invokeLogin({
      controlUrl,
      configPath: testConfigPath,
      openBrowser: async (url: string) => {
        const parsed = new URL(url);
        const callbackUrl = parsed.searchParams.get("callback");
        const state = parsed.searchParams.get("state");
        if (callbackUrl && state) {
          const target = new URL(callbackUrl);
          target.searchParams.set("token", canaryToken);
          target.searchParams.set("state", state);
          await fetch(target.toString());
        }
        return true;
      },
      stdinReader: () => {
        throw new Error("stdinReader should not be invoked in zero-copy flow");
      },
    });

    assertEquals(loginResult.ok, true);

    // Inspect every captured log line: PLAT-15 prohibits logging raw secrets
    for (const logLine of interceptedLogs) {
      assert(
        !logLine.includes(canaryToken),
        `PLAT-15 violation: raw token leaked in terminal log: ${logLine}`,
      );
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    console.info = origInfo;
    await mockServer.shutdown();
  }
});

Deno.test("T-0803: PLAT-15 - Raw token is never leaked in error messages when control plane rejects authentication", async () => {
  const canaryRejectedToken = "rfk_canary_rejected_token_do_not_leak_987654321";
  const tempDir = await Deno.makeTempDir();
  const testConfigPath = `${tempDir}/config.json`;

  const mockServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, () => {
    return new Response(
      JSON.stringify({
        error: {
          code: "PERMISSION_DENIED",
          message: "API key revoked or expired",
        },
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  });

  const controlUrl = `http://127.0.0.1:${
    (mockServer.addr as Deno.NetAddr).port
  }`;

  const interceptedLogs: string[] = [];
  const origError = console.error;
  const origLog = console.log;

  const captureLog = (...args: unknown[]) => {
    interceptedLogs.push(
      args
        .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
        .join(" "),
    );
  };

  try {
    console.error = captureLog;
    console.log = captureLog;

    const loginResult = await invokeLogin({
      controlUrl,
      configPath: testConfigPath,
      openBrowser: async (url: string) => {
        const parsed = new URL(url);
        const callbackUrl = parsed.searchParams.get("callback");
        const state = parsed.searchParams.get("state");
        if (callbackUrl && state) {
          const target = new URL(callbackUrl);
          target.searchParams.set("token", canaryRejectedToken);
          target.searchParams.set("state", state);
          await fetch(target.toString());
        }
        return true;
      },
      stdinReader: () => {
        throw new Error("stdinReader should not be invoked in zero-copy flow");
      },
    });

    assertEquals(loginResult.ok, false);

    // PLAT-15: Verify canary rejected token never appears in error output
    for (const logLine of interceptedLogs) {
      assert(
        !logLine.includes(canaryRejectedToken),
        `PLAT-15 violation: rejected token leaked in error output: ${logLine}`,
      );
    }
  } finally {
    console.error = origError;
    console.log = origLog;
    await mockServer.shutdown();
  }
});

Deno.test("T-0803: PLAT-15 - Raw token is never leaked on network connection error", async () => {
  const canaryNetworkToken = "rfk_canary_network_fail_token_555666777";
  const tempDir = await Deno.makeTempDir();
  const testConfigPath = `${tempDir}/config.json`;

  // Use RFC 6761 .invalid domain to guarantee deterministic and immediate network failure
  const unreachableControlUrl = "http://railfog.invalid:8080";

  const interceptedLogs: string[] = [];
  const origError = console.error;
  const origLog = console.log;

  const captureLog = (...args: unknown[]) => {
    interceptedLogs.push(
      args
        .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
        .join(" "),
    );
  };

  try {
    console.error = captureLog;
    console.log = captureLog;

    // Use non-interactive token to trigger direct verification failure
    const loginResult = await invokeLogin({
      controlUrl: unreachableControlUrl,
      token: canaryNetworkToken,
      configPath: testConfigPath,
    });

    assertEquals(loginResult.ok, false);

    for (const logLine of interceptedLogs) {
      assert(
        !logLine.includes(canaryNetworkToken),
        `PLAT-15 violation: raw token leaked in network error message: ${logLine}`,
      );
    }
  } finally {
    console.error = origError;
    console.log = origLog;
  }
});

// ============================================================================
// T-0803 PLAT-19: Listener Teardown on Verification Failure
// ============================================================================

Deno.test("T-0803: PLAT-19 - Ephemeral listener is guaranteed to close when verification fails", async () => {
  const tempDir = await Deno.makeTempDir();
  const testConfigPath = `${tempDir}/config.json`;
  let capturedCallbackUrl = "";

  const mockServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, () => {
    return new Response(
      JSON.stringify({
        error: { code: "PERMISSION_DENIED", message: "Key revoked" },
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  });

  const controlUrl = `http://127.0.0.1:${
    (mockServer.addr as Deno.NetAddr).port
  }`;

  try {
    const loginResult = await invokeLogin({
      controlUrl,
      configPath: testConfigPath,
      openBrowser: async (url: string) => {
        const parsed = new URL(url);
        const callbackUrl = parsed.searchParams.get("callback");
        const state = parsed.searchParams.get("state");
        if (callbackUrl && state) {
          capturedCallbackUrl = callbackUrl;
          const target = new URL(callbackUrl);
          target.searchParams.set("token", "rfk_revoked_key_test");
          target.searchParams.set("state", state);
          await fetch(target.toString());
        }
        return true;
      },
      stdinReader: () => {
        throw new Error("stdinReader should not be invoked in zero-copy flow");
      },
    });

    assertEquals(loginResult.ok, false);
    assert(
      capturedCallbackUrl.length > 0,
      "Callback URL must have been captured",
    );

    // PLAT-19: Callback listener must be closed even after authentication failure
    await assertRejects(
      async () => {
        await fetch(capturedCallbackUrl);
      },
      TypeError,
      undefined,
      "Callback listener must be closed when authentication fails",
    );
  } finally {
    await mockServer.shutdown();
  }
});

// ============================================================================
// T-0803 Mode 0600 File Permissions Test
// ============================================================================

Deno.test("T-0803: PLAT-15 - Saved credentials file enforces mode 0600 on POSIX", async () => {
  const tempDir = await Deno.makeTempDir();
  const testConfigPath = `${tempDir}/config.json`;

  const mockServer = Deno.serve({ port: 0, hostname: "127.0.0.1" }, () => {
    return new Response(
      JSON.stringify({
        ok: true,
        identity: { orgId: "secure-creds-org", callerId: "secure-laptop" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  const controlUrl = `http://127.0.0.1:${
    (mockServer.addr as Deno.NetAddr).port
  }`;

  try {
    const loginResult = await invokeLogin({
      controlUrl,
      configPath: testConfigPath,
      token: "rfk_secure_mode_test_token_001",
    });

    assertEquals(loginResult.ok, true);

    const stat = await Deno.stat(testConfigPath);
    if (Deno.build.os !== "windows") {
      const mode = stat.mode! & 0o777;
      assertEquals(
        mode,
        0o600,
        `Expected ~/.railfog/config.json to have mode 0600 on POSIX, got 0${
          mode.toString(8)
        }`,
      );
    } else {
      assert(stat.isFile, "Config file must be a regular file");
      assert(stat.size > 0, "Config file must not be empty");
    }

    const config = await loadCliConfig(testConfigPath);
    assertEquals(config?.token, "rfk_secure_mode_test_token_001");
    assertEquals(config?.orgId, "secure-creds-org");
  } finally {
    await mockServer.shutdown();
  }
});
