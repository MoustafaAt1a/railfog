// spec: contracts/kv.contract.md#KV-1 — KV purpose
// spec: contracts/kv.contract.md#KV-2 — KV API shape (get, set, delete, list, atomic)
// spec: contracts/kv.contract.md#KV-3 — Optimistic concurrency (CAS)
// spec: contracts/kv.contract.md#KV-4 — Key model validation (32 segments, 512 bytes)
// spec: contracts/kv.contract.md#KV-5 — Consistency tiers
// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0751-redis-kv-provider.md

import { assertEquals, assertRejects } from "@std/assert";
import { RedisKVProvider } from "../../providers/kv/redis-provider.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";

Deno.test("T-0751: RedisKVProvider enforces KV-4 key limits", async () => {
  const provider = new RedisKVProvider();

  // Test segments limit (> 32 segments)
  const tooManySegments = Array.from({ length: 33 }, (_, i) => `seg${i}`);
  await assertRejects(
    async () => {
      await provider.get(tooManySegments);
    },
    ValidationFailedError,
    "exceeds 32 segments",
  );

  // Test byte size limit (> 512 bytes)
  const longSegment = "a".repeat(513);
  await assertRejects(
    async () => {
      await provider.get([longSegment]);
    },
    ValidationFailedError,
    "exceeds 512 bytes",
  );

  await provider.close();
});

Deno.test("T-0751: RedisKVProvider basic CRUD and TTL (KV-2)", async () => {
  const provider = new RedisKVProvider();

  // Non-existent key returns null
  const initial = await provider.get(["users", "101"]);
  assertEquals(initial, null);

  // Set and get
  await provider.set(["users", "101"], { name: "Alice", role: "admin" });
  const fetched = await provider.get(["users", "101"]) as {
    name: string;
    role: string;
  };
  assertEquals(fetched.name, "Alice");
  assertEquals(fetched.role, "admin");

  // Delete
  await provider.delete(["users", "101"]);
  const afterDelete = await provider.get(["users", "101"]);
  assertEquals(afterDelete, null);

  // TTL expiration in seconds
  await provider.set(["tokens", "temp1"], { token: "abc" }, { ttl: 1 });
  const validTemp = await provider.get(["tokens", "temp1"]);
  assertEquals(validTemp, { token: "abc" });

  await provider.close();
});

Deno.test("T-0751: RedisKVProvider list with prefix and pagination (KV-2)", async () => {
  const provider = new RedisKVProvider();

  await provider.set(["session", "alpha"], { id: "a" });
  await provider.set(["session", "beta"], { id: "b" });
  await provider.set(["session", "gamma"], { id: "c" });
  await provider.set(["other", "delta"], { id: "d" });

  const listRes = await provider.list(["session"], { limit: 2 });
  assertEquals(listRes.keys.length, 2);
  assertEquals(typeof listRes.cursor, "string");

  // Fetch next page
  const page2 = await provider.list(["session"], {
    limit: 2,
    cursor: listRes.cursor,
  });
  assertEquals(page2.keys.length, 1);
  assertEquals(page2.keys[0].key, ["session", "gamma"]);

  await provider.close();
});

Deno.test("T-0751: RedisKVProvider atomic optimistic concurrency CAS (KV-3)", async () => {
  const provider = new RedisKVProvider();

  // Initial key does not exist, so version is 0
  const atomic1 = provider.atomic();
  atomic1.check(["items", "counter"], 0);
  atomic1.set(["items", "counter"], { count: 1 });
  const res1 = await atomic1.commit();
  assertEquals(res1.ok, true);
  assertEquals(res1.version, 1);

  // Successful CAS from version 1 to 2
  const atomic2 = provider.atomic();
  atomic2.check(["items", "counter"], 1);
  atomic2.set(["items", "counter"], { count: 2 });
  const res2 = await atomic2.commit();
  assertEquals(res2.ok, true);
  assertEquals(res2.version, 2);

  // Conflicting CAS: expected version 1 but current is 2 -> returns ok: false
  const atomicConflict = provider.atomic();
  atomicConflict.check(["items", "counter"], 1);
  atomicConflict.set(["items", "counter"], { count: 999 });
  const conflictRes = await atomicConflict.commit();
  assertEquals(conflictRes.ok, false);

  // Value remains untouched at version 2
  const current = await provider.get(["items", "counter"]) as { count: number };
  assertEquals(current.count, 2);

  await provider.close();
});
