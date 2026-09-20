// spec: contracts/kv.contract.md#KV-1 — KV purpose
// spec: contracts/kv.contract.md#KV-2 — KV API shape (get, set, delete, list, atomic)
// spec: contracts/kv.contract.md#KV-3 — Optimistic concurrency (CAS)
// spec: contracts/kv.contract.md#KV-4 — Key model validation (32 segments, 512 bytes)
// spec: contracts/kv.contract.md#KV-5 — Consistency tiers (strong linearizable CAS)
// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0752-postgres-kv-provider.md

import { assertEquals, assertRejects } from "@std/assert";
import { PostgresKVProvider } from "../../providers/kv/postgres-provider.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";

Deno.test("T-0752: PostgresKVProvider enforces KV-4 key validation", async () => {
  const provider = new PostgresKVProvider();

  // Test > 32 segments
  const tooManySegments = Array.from({ length: 33 }, (_, i) => `segment_${i}`);
  await assertRejects(
    async () => {
      await provider.get(tooManySegments);
    },
    ValidationFailedError,
    "exceeds 32 segments",
  );

  // Test > 512 bytes
  const largeSegment = "x".repeat(513);
  await assertRejects(
    async () => {
      await provider.set([largeSegment], { val: 1 });
    },
    ValidationFailedError,
    "exceeds 512 bytes",
  );

  await provider.close();
});

Deno.test("T-0752: PostgresKVProvider basic CRUD, TTL, and Schema (KV-2)", async () => {
  const provider = new PostgresKVProvider();
  await provider.initSchema();

  // Initial read is null
  const initial = await provider.get(["app", "config", "theme"]);
  assertEquals(initial, null);

  // Set and get
  await provider.set(["app", "config", "theme"], {
    dark: true,
    primaryColor: "#0070f3",
  });
  const theme = await provider.get(["app", "config", "theme"]) as {
    dark: boolean;
    primaryColor: string;
  };
  assertEquals(theme.dark, true);
  assertEquals(theme.primaryColor, "#0070f3");

  // Delete
  await provider.delete(["app", "config", "theme"]);
  const afterDelete = await provider.get(["app", "config", "theme"]);
  assertEquals(afterDelete, null);

  // TTL expiration in seconds
  await provider.set(["cache", "weather"], { temp: 22 }, { ttl: 1 });
  const tempValid = await provider.get(["cache", "weather"]);
  assertEquals(tempValid, { temp: 22 });

  await provider.close();
});

Deno.test("T-0752: PostgresKVProvider list with prefix and pagination (KV-2)", async () => {
  const provider = new PostgresKVProvider();
  await provider.initSchema();

  await provider.set(["projects", "p1"], { name: "Project 1" });
  await provider.set(["projects", "p2"], { name: "Project 2" });
  await provider.set(["projects", "p3"], { name: "Project 3" });
  await provider.set(["users", "u1"], { name: "User 1" });

  const page1 = await provider.list(["projects"], { limit: 2 });
  assertEquals(page1.keys.length, 2);
  assertEquals(typeof page1.cursor, "string");

  const page2 = await provider.list(["projects"], {
    limit: 2,
    cursor: page1.cursor,
  });
  assertEquals(page2.keys.length, 1);
  assertEquals(page2.keys[0].key, ["projects", "p3"]);

  await provider.close();
});

Deno.test("T-0752: PostgresKVProvider atomic transactional CAS (KV-3, KV-5)", async () => {
  const provider = new PostgresKVProvider();
  await provider.initSchema();

  // Version starts at 0 for non-existent key
  const atomic1 = provider.atomic();
  atomic1.check(["inventory", "stock"], 0);
  atomic1.set(["inventory", "stock"], { items: 100 });
  const res1 = await atomic1.commit();
  assertEquals(res1.ok, true);
  assertEquals(res1.version, 1);

  // Successful CAS check: version 1 -> 2
  const atomic2 = provider.atomic();
  atomic2.check(["inventory", "stock"], 1);
  atomic2.set(["inventory", "stock"], { items: 95 });
  const res2 = await atomic2.commit();
  assertEquals(res2.ok, true);
  assertEquals(res2.version, 2);

  // Conflicting CAS check: expects version 1 but current is 2 -> rollback
  const atomicFail = provider.atomic();
  atomicFail.check(["inventory", "stock"], 1);
  atomicFail.set(["inventory", "stock"], { items: 50 });
  const failRes = await atomicFail.commit();
  assertEquals(failRes.ok, false);

  // Stock remains untouched at 95
  const current = await provider.get(["inventory", "stock"]) as {
    items: number;
  };
  assertEquals(current.items, 95);

  await provider.close();
});
