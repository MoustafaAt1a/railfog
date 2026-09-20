// spec: contracts/platform.contract.md#PLAT-1 — CLI interaction
// spec: contracts/platform.contract.md#PLAT-6 — Caller identity resolution
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage in errors/logs
// spec: contracts/platform.contract.md#PLAT-17 — Local development parity
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0757-cli-login-workflow.md

import { assertEquals } from "@std/assert";
import {
  clearCliConfig,
  loadCliConfig,
  resolveAuthHeader,
  resolveCliToken,
  saveCliConfig,
} from "../../cli/auth-config.ts";
import { runLogin, runLogout, runWhoami } from "../../cli/login.ts";

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
  const optToken = await resolveCliToken({ token: "rfk_override" }, testConfigPath);
  assertEquals(optToken, "rfk_override");

  // Default from file
  const fileToken = await resolveCliToken({}, testConfigPath);
  assertEquals(fileToken, "rfk_test_12345");

  // 5. Auth header formatting
  const headers = await resolveAuthHeader({ token: "rfk_override" }, testConfigPath);
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

  const controlUrl = `http://127.0.0.1:${(mockServer.addr as Deno.NetAddr).port}`;

  try {
    // 1. Interactive login with simulated stdin
    const loginResult = await runLogin({
      controlUrl,
      configPath: testConfigPath,
      openBrowser: mockOpenBrowser,
      stdinReader: () => Promise.resolve("   rfk_valid_key_abc   \n"), // Simulates copy-paste with spaces/newlines
    });

    assertEquals(loginResult.ok, true);
    assertEquals(loginResult.orgId, "demo-org");
    assertEquals(browserOpenedUrl, `${controlUrl}/login`);

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
