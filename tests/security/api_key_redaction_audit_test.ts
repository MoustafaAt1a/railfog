// spec: contracts/platform.contract.md#PLAT-6 — Capability injection
// spec: contracts/platform.contract.md#PLAT-12 — Error model
// spec: contracts/platform.contract.md#PLAT-15 — Secrets management: zero raw secret leakage
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0758-milestone-0.75-verification-audit.md

import { assertEquals } from "@std/assert";
import { PostgresKVProvider } from "../../providers/kv/postgres-provider.ts";
import { RedisKVProvider } from "../../providers/kv/redis-provider.ts";
import { ApiKeyStore } from "../../packages/auth/store.ts";
import { createAuthMiddleware } from "../../packages/auth/middleware.ts";

Deno.test("Security Adversarial (PLAT-15): Raw API tokens never appear in database or cache", async () => {
  const pgKv = new PostgresKVProvider();
  await pgKv.initSchema();
  const redisKv = new RedisKVProvider();
  const store = new ApiKeyStore({
    storageProvider: pgKv,
    cacheProvider: redisKv,
  });

  const { rawToken } = await store.createKey({
    name: "super-secret-key",
    orgId: "security-corp",
  });

  // Verify to populate cache
  const id = await store.verifyRawToken(rawToken);
  assertEquals(id !== null, true);

  // 1. Scan all keys in Postgres KV
  const pgEntries = await pgKv.list(["_auth"], { limit: 1000 });
  for (const entry of pgEntries.keys) {
    const serialized = JSON.stringify(entry);
    assertEquals(
      serialized.includes(rawToken),
      false,
      "CRITICAL SECURITY VIOLATION: Raw API token found in PostgreSQL KV storage!",
    );
  }

  // 2. Scan all keys in Redis KV
  const redisEntries = await redisKv.list(["auth_cache"], { limit: 1000 });
  for (const entry of redisEntries.keys) {
    const serialized = JSON.stringify(entry);
    assertEquals(
      serialized.includes(rawToken),
      false,
      "CRITICAL SECURITY VIOLATION: Raw API token found in Redis cache storage!",
    );
  }

  await pgKv.close();
  await redisKv.close();
});

Deno.test("Security Adversarial (PLAT-15): Malformed or failing auth attempts never leak tokens in errors or logs", async () => {
  const pgKv = new PostgresKVProvider();
  const store = new ApiKeyStore({ storageProvider: pgKv });
  const middleware = createAuthMiddleware({ apiKeyStore: store });

  const leakCandidateToken = "rfk_sensitive_customer_token_777888999";

  // Request with invalid token
  const req = new Request("http://localhost:8081/v1/projects/my-app/deploy", {
    method: "POST",
    headers: { authorization: `Bearer ${leakCandidateToken}` },
  });

  const res = await middleware(req, "req_adversarial_test");
  assertEquals(res.ok, false);

  if (!res.ok) {
    const bodyText = await res.response.text();
    assertEquals(
      bodyText.includes(leakCandidateToken),
      false,
      "CRITICAL SECURITY VIOLATION: Raw API token leaked in 403 PERMISSION_DENIED response body!",
    );

    // Also verify headers
    for (const [headerKey, headerVal] of res.response.headers.entries()) {
      assertEquals(
        headerVal.includes(leakCandidateToken),
        false,
        `CRITICAL SECURITY VIOLATION: Raw API token leaked in header '${headerKey}'!`,
      );
    }
  }

  await pgKv.close();
});
