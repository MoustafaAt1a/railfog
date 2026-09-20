// spec: contracts/platform.contract.md#PLAT-1 — Control plane daemon
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & tenant scoping
// spec: contracts/platform.contract.md#PLAT-12 — Canonical error model
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0756-control-plane-login-page.md

import { assertEquals } from "@std/assert";
import { startControlServer } from "../../apps/api/control-server.ts";
import { DeploymentService } from "../../apps/api/deployment-service.ts";
import { createStateBackupService } from "../../apps/api/state-backup-service.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { PostgresKVProvider } from "../../providers/kv/postgres-provider.ts";
import { ApiKeyStore } from "../../packages/auth/store.ts";

Deno.test("T-0756: control-server serves GET /login HTML page", async () => {
  const storage = new LocalFSProvider(await Deno.makeTempDir());
  const kv = new PostgresKVProvider();
  const deploymentService = new DeploymentService(storage);
  const stateBackupService = createStateBackupService(
    deploymentService,
    kv,
    storage,
  );
  const apiKeyStore = new ApiKeyStore({ storageProvider: kv });

  const server = await startControlServer({
    port: 0,
    host: "127.0.0.1",
    deploymentService,
    stateBackupService,
    apiKeyStore,
  });

  const res = await fetch(`http://127.0.0.1:${server.port}/login`);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type")?.includes("text/html"), true);
  const html = await res.text();
  assertEquals(html.includes("RailFog Cloud"), true);
  assertEquals(html.includes("Generate API Key"), true);
  assertEquals(html.includes("Copy API Key"), true);

  await server.close();
});

Deno.test("T-0756: control-server POST /v1/auth/keys creates persistent token (PLAT-15)", async () => {
  const storage = new PostgresKVProvider();
  const tempDir = await Deno.makeTempDir();
  const objStorage = new LocalFSProvider(tempDir);
  const deploymentService = new DeploymentService(objStorage);
  const stateBackupService = createStateBackupService(
    deploymentService,
    storage,
    objStorage,
  );
  const apiKeyStore = new ApiKeyStore({ storageProvider: storage });

  const server = await startControlServer({
    port: 0,
    host: "127.0.0.1",
    deploymentService,
    stateBackupService,
    apiKeyStore,
  });

  // 1. Generate key via POST /v1/auth/keys
  const createRes = await fetch(
    `http://127.0.0.1:${server.port}/v1/auth/keys`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: "acme", name: "laptop-key" }),
    },
  );

  assertEquals(createRes.status, 200);
  const createData = await createRes.json();
  assertEquals(createData.ok, true);
  assertEquals(typeof createData.rawToken, "string");
  assertEquals(createData.rawToken.startsWith("rfk_"), true);

  // 2. Verify token via GET /v1/auth/verify with Authorization: Bearer <token>
  const verifyRes = await fetch(
    `http://127.0.0.1:${server.port}/v1/auth/verify`,
    {
      headers: { authorization: `Bearer ${createData.rawToken}` },
    },
  );
  assertEquals(verifyRes.status, 200);
  const verifyData = await verifyRes.json();
  assertEquals(verifyData.ok, true);
  assertEquals(verifyData.identity.orgId, "acme");
  assertEquals(verifyData.identity.callerId, "laptop-key");

  // 3. Verify with invalid token returns 403 PERMISSION_DENIED
  const badVerifyRes = await fetch(
    `http://127.0.0.1:${server.port}/v1/auth/verify`,
    {
      headers: { authorization: "Bearer rfk_fake_bad_12345" },
    },
  );
  assertEquals(badVerifyRes.status, 403);
  const badData = await badVerifyRes.json();
  assertEquals(badData.error.code, "PERMISSION_DENIED");

  await server.close();
});

Deno.test("T-0802: isValidCallbackUrl enforces strict loopback and unprivileged port policy", async () => {
  const { isValidCallbackUrl } = await import("../../apps/api/login-page.ts");

  // Valid loopback callbacks
  assertEquals(isValidCallbackUrl("http://127.0.0.1:49152/callback"), true);
  assertEquals(isValidCallbackUrl("http://localhost:54321/callback"), true);

  // Invalid: external host / subdomain spoof
  assertEquals(isValidCallbackUrl("https://evil.com/callback"), false);
  assertEquals(isValidCallbackUrl("http://localhost.evil.com/callback"), false);
  assertEquals(
    isValidCallbackUrl("http://127.0.0.1:pwd@evil.com/callback"),
    false,
  );
  assertEquals(isValidCallbackUrl("javascript:alert(1)"), false);

  // Invalid: sensitive internal infrastructure ports (blacklisted)
  assertEquals(isValidCallbackUrl("http://127.0.0.1:5432/callback"), false); // PostgreSQL
  assertEquals(isValidCallbackUrl("http://127.0.0.1:6379/callback"), false); // Redis
  assertEquals(isValidCallbackUrl("http://127.0.0.1:8080/callback"), false); // Runtime plane
  assertEquals(isValidCallbackUrl("http://127.0.0.1:8081/callback"), false); // Control plane

  // Invalid: privileged port (< 1024) or missing port
  assertEquals(isValidCallbackUrl("http://127.0.0.1:80/callback"), false);
  assertEquals(isValidCallbackUrl("http://127.0.0.1/callback"), false);

  // Invalid: wrong path or pre-existing query/hash
  assertEquals(isValidCallbackUrl("http://127.0.0.1:49152/other"), false);
  assertEquals(
    isValidCallbackUrl("http://127.0.0.1:49152/callback?leak=true"),
    false,
  );
  assertEquals(
    isValidCallbackUrl("http://127.0.0.1:49152/callback#fragment"),
    false,
  );
});

Deno.test("T-0802: control-server renders callback authorization UI safely (PLAT-15)", async () => {
  const storage = new PostgresKVProvider();
  const tempDir = await Deno.makeTempDir();
  const objStorage = new LocalFSProvider(tempDir);
  const deploymentService = new DeploymentService(objStorage);
  const stateBackupService = createStateBackupService(
    deploymentService,
    storage,
    objStorage,
  );
  const apiKeyStore = new ApiKeyStore({ storageProvider: storage });

  const server = await startControlServer({
    port: 0,
    host: "127.0.0.1",
    deploymentService,
    stateBackupService,
    apiKeyStore,
  });

  // 1. Valid callback renders Authorize CLI button and embeds sanitized parameters
  const validRes = await fetch(
    `http://127.0.0.1:${server.port}/login?callback=http://127.0.0.1:49152/callback&state=nonce_abc_123`,
  );
  assertEquals(validRes.status, 200);
  const validHtml = await validRes.text();
  assertEquals(validHtml.includes("Authorize CLI in Terminal"), true);
  assertEquals(validHtml.includes("nonce_abc_123"), true);
  assertEquals(validHtml.includes("http://127.0.0.1:49152/callback"), true);

  // 2. Malicious open redirect attempt is rejected and rendered in safe fallback mode
  const evilRes = await fetch(
    `http://127.0.0.1:${server.port}/login?callback=https://evil.com/steal&state=<script>alert(1)</script>`,
  );
  assertEquals(evilRes.status, 200);
  const evilHtml = await evilRes.text();
  assertEquals(evilHtml.includes("https://evil.com/steal"), false);
  assertEquals(evilHtml.includes("<script>alert(1)</script>"), false);
  assertEquals(evilHtml.includes("Authorize CLI in Terminal"), false);

  await server.close();
});
