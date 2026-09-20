import { assert, assertEquals, assertRejects } from "@std/assert";
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";

function getProvider(): KVProvider {
  return new SQLiteKVProvider(":memory:");
}

Deno.test("KVProvider - basic CRUD", async () => {
  const kv = getProvider();

  await kv.set(["users", "123"], { name: "Alice" });
  let val = await kv.get(["users", "123"]);
  assertEquals(val, { name: "Alice" });

  await kv.delete(["users", "123"]);
  val = await kv.get(["users", "123"]);
  assertEquals(val, null);
});

Deno.test("KVProvider - TTL expiry (KV-2)", async () => {
  const kv = getProvider();

  // Given a key set with ttl: 1
  await kv.set(["session", "abc"], { user: "bob" }, { ttl: 1 });

  let val = await kv.get(["session", "abc"]);
  assertEquals(val, { user: "bob" });

  // when read again after 1.5s
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // then get returns null
  val = await kv.get(["session", "abc"]);
  assertEquals(val, null);
});

Deno.test("KVProvider - CAS atomic operations (KV-3)", async () => {
  const kv = getProvider();

  // Set initial value via atomic to get a version
  const initRes = await kv.atomic()
    .set(["my_key"], "val1")
    .commit();

  assertEquals(initRes.ok, true);
  const version = initRes.version as number;
  assert(version !== undefined);

  // Given atomic().check(key, v).set(...).commit() where stored version is not v
  const conflictRes = await kv.atomic()
    .check(["my_key"], version + 99)
    .set(["my_key"], "val2")
    .commit();

  // when committed, then it returns { ok: false } and does not write
  assertEquals(conflictRes.ok, false);
  assertEquals(await kv.get(["my_key"]), "val1");

  // Successful CAS
  const goodRes = await kv.atomic()
    .check(["my_key"], version)
    .set(["my_key"], "val3")
    .commit();

  assertEquals(goodRes.ok, true);
  assertEquals(await kv.get(["my_key"]), "val3");
});

Deno.test("KVProvider - list and pagination (KV-2)", async () => {
  const kv = getProvider();

  // Given more than limit keys under a prefix
  for (let i = 0; i < 150; i++) {
    const id = i.toString().padStart(3, "0");
    await kv.set(["items", id], i);
  }

  // when list is called
  const page1 = await kv.list(["items"], { limit: 100 });
  assertEquals(page1.keys.length, 100);

  // then the response includes a cursor
  assert(page1.cursor !== undefined, "cursor should be present");

  // and a second call with that cursor returns the next page, not a repeat
  const page2 = await kv.list(["items"], { limit: 100, cursor: page1.cursor });
  assertEquals(page2.keys.length, 50);
  assertEquals(
    page2.cursor,
    undefined,
    "cursor should not be present on last page",
  );

  const allKeys = [...page1.keys, ...page2.keys];
  const uniqueKeys = new Set(allKeys.map((k) => k.key[1]));
  assertEquals(uniqueKeys.size, 150);
});

Deno.test("KVProvider - key validation (KV-4)", async () => {
  const kv = getProvider();

  // Given a key over 32 segments, when set is called, then it throws VALIDATION_FAILED
  const longSegments = new Array(33).fill("a");
  await assertRejects(
    () => kv.set(longSegments, "val"),
    ValidationFailedError,
  );

  // Given a key over 512 bytes, when set is called, then it throws VALIDATION_FAILED
  const largeKey = "a".repeat(513);
  await assertRejects(
    () => kv.set([largeKey], "val"),
    ValidationFailedError,
  );
});
