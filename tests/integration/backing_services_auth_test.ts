// spec: contracts/platform.contract.md#PLAT-1 — Control plane daemon
// spec: contracts/platform.contract.md#PLAT-3 — Deployment pipeline
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & tenant scoping
// spec: contracts/platform.contract.md#PLAT-8 — Fail-static snapshot distribution
// spec: contracts/platform.contract.md#PLAT-12 — Error model
// spec: contracts/platform.contract.md#PLAT-14 — Request ID propagation
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage
// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction (PostgreSQL & Redis)
// spec: contracts/platform.contract.md#PLAT-17 — Local/production parity
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0758-milestone-075-verification-audit.md

import { assertEquals, assertNotEquals } from "@std/assert";
import { startControlServer } from "../../apps/api/control-server.ts";
import { DeploymentService } from "../../apps/api/deployment-service.ts";
import { createStateBackupService } from "../../apps/api/state-backup-service.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { PostgresKVProvider } from "../../providers/kv/postgres-provider.ts";
import { RedisKVProvider } from "../../providers/kv/redis-provider.ts";
import { ApiKeyStore } from "../../packages/auth/store.ts";
import { packageFunctionArtifact } from "../../packages/core/artifact/packager.ts";
import { runLogin, runWhoami } from "../../cli/login.ts";

Deno.test("T-0758: Integration — Full Backing Services and Web-to-CLI Login Lifecycle", async () => {
  const tempDir = await Deno.makeTempDir();
  const objStorage = new LocalFSProvider(tempDir);
  const pgKv = new PostgresKVProvider();
  await pgKv.initSchema();
  const redisKv = new RedisKVProvider();
  const apiKeyStore = new ApiKeyStore({
    storageProvider: pgKv,
    cacheProvider: redisKv,
  });

  const deploymentService = new DeploymentService(objStorage);
  const stateBackupService = createStateBackupService(
    deploymentService,
    pgKv,
    objStorage,
  );

  const server = await startControlServer({
    port: 0,
    host: "127.0.0.1",
    deploymentService,
    stateBackupService,
    apiKeyStore,
  });

  const controlUrl = `http://127.0.0.1:${server.port}`;
  const cliConfigPath = `${tempDir}/cli-config.json`;

  try {
    // 1. Step 1: Web Page access (GET /login)
    const loginPageRes = await fetch(`${controlUrl}/login`);
    assertEquals(loginPageRes.status, 200);
    const loginHtml = await loginPageRes.text();
    assertEquals(loginHtml.includes("Generate API Key"), true);

    // 2. Step 2: Key Generation from Web UI (POST /v1/auth/keys)
    const keyGenRes = await fetch(`${controlUrl}/v1/auth/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: "acme-corp", name: "developer-macbook" }),
    });
    assertEquals(keyGenRes.status, 200);
    const keyGenData = await keyGenRes.json();
    const issuedRawToken: string = keyGenData.rawToken;
    assertEquals(issuedRawToken.startsWith("rfk_"), true);

    // 3. Step 3: CLI interactive login simulation (paste key at prompt)
    const loginResult = await runLogin({
      controlUrl,
      manual: true,
      configPath: cliConfigPath,
      openBrowser: () => Promise.resolve(true), // Mock browser open
      stdinReader: () => Promise.resolve(`  ${issuedRawToken}  `), // User pastes key
    });
    assertEquals(loginResult.ok, true);
    assertEquals(loginResult.orgId, "acme-corp");

    // 4. Step 4: Verify whoami
    const whoami = await runWhoami({
      controlUrl,
      configPath: cliConfigPath,
    });
    assertEquals(whoami.authenticated, true);
    assertEquals(whoami.orgId, "acme-corp");

    const pkg = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode('export default () => new Response("hello");'),
    );
    const validArtifact = {
      id: pkg.id,
      integrity: pkg.integrity,
      manifest: pkg.manifest,
      bytes: Array.from(pkg.bytes),
    };

    // 5. Step 5: Unauthenticated deployment attempt (without token) must fail with 403
    const unauthDeployRes = await fetch(`${controlUrl}/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "my-app",
        functionName: "api",
        artifact: validArtifact,
      }),
    });
    assertEquals(unauthDeployRes.status, 403);
    const unauthBody = await unauthDeployRes.json();
    assertEquals(unauthBody.error.code, "PERMISSION_DENIED");

    // 6. Step 6: Authenticated deployment using issued token succeeds
    const authDeployRes = await fetch(`${controlUrl}/deploy`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${issuedRawToken}`,
      },
      body: JSON.stringify({
        project: "my-app",
        functionName: "api",
        artifact: validArtifact,
      }),
    });
    assertEquals(authDeployRes.status, 200);
    const deployData = await authDeployRes.json();
    assertEquals(deployData.state, "Deployed");
    assertNotEquals(deployData.revisionId, "");
  } finally {
    await server.close();
    await pgKv.close();
    await redisKv.close();
  }
});
