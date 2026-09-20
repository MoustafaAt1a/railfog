// spec: contracts/platform.contract.md#PLAT-6 — Capability injection
// spec: contracts/platform.contract.md#PLAT-9 — Rate limiting & identity
// spec: contracts/platform.contract.md#PLAT-14 — Monotonic ULID identifiers
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage
// spec: contracts/kv.contract.md#KV-2 — KV API usage
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0753-persistent-api-key-store.md

import { assertEquals, assertNotEquals } from "@std/assert";
import { ApiKeyStore } from "../../packages/auth/store.ts";
import { RedisKVProvider } from "../../providers/kv/redis-provider.ts";
import { PostgresKVProvider } from "../../providers/kv/postgres-provider.ts";

Deno.test("T-0753: ApiKeyStore creates and verifies raw API keys with hashing (PLAT-15)", async () => {
  const storage = new PostgresKVProvider();
  const cache = new RedisKVProvider();
  const store = new ApiKeyStore({
    storageProvider: storage,
    cacheProvider: cache,
  });

  // 1. Create a key
  const res = await store.createKey({
    name: "deploy-runner",
    orgId: "acme-corp",
    projectId: "backend-api",
  });

  assertEquals(typeof res.rawToken, "string");
  assertEquals(res.rawToken.startsWith("rfk_"), true);
  assertEquals(res.record.name, "deploy-runner");
  assertEquals(res.record.orgId, "acme-corp");
  assertEquals(res.record.projectId, "backend-api");
  assertNotEquals(res.record.tokenHash, res.rawToken); // Hash must not equal raw token

  // 2. Raw token must NEVER exist in primary storage or cache
  const storedByRaw = await storage.get(["_auth", "tokens", res.rawToken]);
  assertEquals(storedByRaw, null);

  // 3. Verify valid raw token
  const identity = await store.verifyRawToken(res.rawToken);
  assertEquals(identity !== null, true);
  assertEquals(identity?.callerId, "deploy-runner");
  assertEquals(identity?.orgId, "acme-corp");
  assertEquals(identity?.projectId, "backend-api");
  assertEquals(identity?.callerType, "token");

  // 4. Second verification should be served from cache
  const cachedIdentity = await store.verifyRawToken(res.rawToken);
  assertEquals(cachedIdentity?.orgId, "acme-corp");

  // 5. Invalid token returns null
  const invalid = await store.verifyRawToken("rfk_invalid_token_12345");
  assertEquals(invalid, null);

  await storage.close();
  await cache.close();
});

Deno.test("T-0753: ApiKeyStore revokes keys and purges cache immediately (PLAT-6, PLAT-15)", async () => {
  const storage = new PostgresKVProvider();
  const cache = new RedisKVProvider();
  const store = new ApiKeyStore({
    storageProvider: storage,
    cacheProvider: cache,
  });

  const { rawToken, record } = await store.createKey({
    name: "test-revoke",
    orgId: "cyber-sec",
  });

  // Warm cache
  const activeIdentity = await store.verifyRawToken(rawToken);
  assertEquals(activeIdentity !== null, true);

  // Revoke key
  const revoked = await store.revokeKey(record.id);
  assertEquals(revoked, true);

  // Verification after revocation must fail immediately
  const revokedIdentity = await store.verifyRawToken(rawToken);
  assertEquals(revokedIdentity, null);

  await storage.close();
  await cache.close();
});

Deno.test("T-0753: ApiKeyStore lists keys by organization", async () => {
  const storage = new PostgresKVProvider();
  const store = new ApiKeyStore({ storageProvider: storage });

  await store.createKey({ name: "key-1", orgId: "org-alpha" });
  await store.createKey({ name: "key-2", orgId: "org-alpha" });
  await store.createKey({ name: "key-3", orgId: "org-beta" });

  const alphaKeys = await store.listKeys("org-alpha");
  assertEquals(alphaKeys.length, 2);
  assertEquals(alphaKeys.map((k) => k.name).sort(), ["key-1", "key-2"]);

  const betaKeys = await store.listKeys("org-beta");
  assertEquals(betaKeys.length, 1);
  assertEquals(betaKeys[0].name, "key-3");

  await storage.close();
});

Deno.test("T-0753: ApiKeyStore handles stringified storage values and recovers from incomplete cache", async () => {
  const memory = new Map<string, string>();
  const stringifiedStorage = {
    get(key: string[]) {
      const val = memory.get(key.join("/"));
      return Promise.resolve(val ?? null);
    },
    set(key: string[], value: unknown) {
      memory.set(key.join("/"), JSON.stringify(value));
      return Promise.resolve();
    },
    delete(key: string[]) {
      memory.delete(key.join("/"));
      return Promise.resolve();
    },
    list() {
      return Promise.resolve({ keys: [] });
    },
    atomic() {
      throw new Error("unsupported");
    },
  };

  const cacheMemory = new Map<string, unknown>();
  const cacheMock = {
    get(key: string[]) {
      return Promise.resolve(cacheMemory.get(key.join("/")) ?? null);
    },
    set(key: string[], value: unknown) {
      cacheMemory.set(key.join("/"), value);
      return Promise.resolve();
    },
    delete(key: string[]) {
      cacheMemory.delete(key.join("/"));
      return Promise.resolve();
    },
    list() {
      return Promise.resolve({ keys: [] });
    },
    atomic() {
      throw new Error("unsupported");
    },
  };

  const store = new ApiKeyStore({
    storageProvider: stringifiedStorage,
    cacheProvider: cacheMock,
  });

  const { rawToken } = await store.createKey({
    name: "production-laptop",
    orgId: "custom-tenant-org",
  });

  // Verify that stringified storage is successfully parsed into identity with callerId and orgId
  const identity = await store.verifyRawToken(rawToken);
  assertEquals(identity !== null, true);
  assertEquals(identity?.callerId, "production-laptop");
  assertEquals(identity?.orgId, "custom-tenant-org");

  // Corrupt the cache entry by removing callerId and orgId (simulating previous bug)
  const tokenHash = identity!.tokenHash!;
  cacheMemory.set(`auth_cache/${tokenHash}`, {
    tokenHash,
    callerType: "token",
  });

  // Verify that verifyRawToken ignores the corrupted cache entry and re-fetches callerId & orgId from storage
  const recoveredIdentity = await store.verifyRawToken(rawToken);
  assertEquals(recoveredIdentity !== null, true);
  assertEquals(recoveredIdentity?.callerId, "production-laptop");
  assertEquals(recoveredIdentity?.orgId, "custom-tenant-org");
});
