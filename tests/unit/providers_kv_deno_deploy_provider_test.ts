// Spec references: KV-1, KV-2, KV-3, KV-4, KV-5, PLAT-16, PLAT-17, PLAT-12
// Task: T-0204 (Deno Deploy remote strong KV provider)

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import { DenoDeployKVProvider } from "../../providers/kv/deno-deploy-provider.ts";
import {
  PayloadTooLargeError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

/**
 * Helper to initialize a DenoDeployKVProvider pointing to an isolated local
 * temporary SQLite KV database via Deno.openKv(path), ensuring proper cleanup.
 */
async function withProvider(
  fn: (kv: DenoDeployKVProvider) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const tempPath = `${tempDir}/test.kv`;
  const kv = new DenoDeployKVProvider({ path: tempPath });
  try {
    await fn(kv);
  } finally {
    try {
      await kv.close();
    } catch {
      // ignore close errors during cleanup
    }
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // ignore remove errors during cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Unit tests: Key segment counting, key length calculation, TTL translation,
// and payload size checking
// ---------------------------------------------------------------------------

Deno.test("DenoDeployKVProvider - unit: key segment counting and empty key validation (KV-4)", async () => {
  await withProvider(async (kv: KVProvider) => {
    // 0 segments must throw ValidationFailedError
    await assertRejects(
      () => kv.set([], "value"),
      ValidationFailedError,
    );

    // 1 to 32 segments is valid
    const key1 = ["single"];
    await kv.set(key1, "val1");
    assertEquals(await kv.get(key1), "val1");

    const key32 = new Array(32).fill("seg");
    await kv.set(key32, "val32");
    assertEquals(await kv.get(key32), "val32");

    // 33 segments exceeds limit of 32
    const key33 = new Array(33).fill("seg");
    await assertRejects(
      () => kv.set(key33, "val33"),
      ValidationFailedError,
    );
  });
});

Deno.test("DenoDeployKVProvider - unit: key length calculation with multi-byte UTF-8 (KV-4)", async () => {
  await withProvider(async (kv: KVProvider) => {
    // 512 bytes boundary: 128 four-byte UTF-8 emojis = 512 bytes
    const exact512 = ["🦀".repeat(128)];
    await kv.set(exact512, "exact-512");
    assertEquals(await kv.get(exact512), "exact-512");

    // 513 bytes: 128 four-byte UTF-8 emojis + 1 ASCII byte = 513 bytes
    const over512 = ["🦀".repeat(128) + "x"];
    await assertRejects(
      () => kv.set(over512, "over-512"),
      ValidationFailedError,
    );

    // Multiple segments exceeding 512 bytes cumulatively
    const multiSegOver = [...new Array(10).fill("a".repeat(51)), "a".repeat(3)]; // 510 + 3 = 513 bytes
    await assertRejects(
      () => kv.set(multiSegOver, "multi-seg-over"),
      ValidationFailedError,
    );
  });
});

Deno.test("DenoDeployKVProvider - unit: TTL option translation and validation (KV-2)", async () => {
  await withProvider(async (kv: KVProvider) => {
    // Non-positive or non-numeric TTL values must throw ValidationFailedError
    await assertRejects(
      () => kv.set(["ttl", "negative"], "val", { ttl: -5 }),
      ValidationFailedError,
    );
    await assertRejects(
      () => kv.set(["ttl", "zero"], "val", { ttl: 0 }),
      ValidationFailedError,
    );
    await assertRejects(
      () => kv.set(["ttl", "nan"], "val", { ttl: NaN }),
      ValidationFailedError,
    );
  });
});

Deno.test("DenoDeployKVProvider - unit: payload size checking at 256 KB boundary (KV-1, PLAT-12)", async () => {
  await withProvider(async (kv: KVProvider) => {
    // 256 KB exactly (256 * 1024 = 262,144 bytes) should succeed
    const payload256KB = "a".repeat(256 * 1024);
    await kv.set(["payload", "valid"], payload256KB);
    assertEquals(await kv.get(["payload", "valid"]), payload256KB);

    // 256 KB + 1 byte should throw PayloadTooLargeError
    const payloadTooLarge = "a".repeat(256 * 1024 + 1);
    await assertRejects(
      () => kv.set(["payload", "toolarge"], payloadTooLarge),
      PayloadTooLargeError,
    );

    // Atomic builder set should also enforce payload size limit
    await assertRejects(
      async () => {
        await kv.atomic().set(["payload", "atomic_toolarge"], payloadTooLarge)
          .commit();
      },
      PayloadTooLargeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration tests: CRUD, TTL expiry, CAS atomic operations, pagination
// ---------------------------------------------------------------------------

Deno.test("DenoDeployKVProvider - integration: basic CRUD operations and data types", async () => {
  await withProvider(async (kv: KVProvider) => {
    // Primitive types
    await kv.set(["data", "string"], "hello world");
    assertEquals(await kv.get(["data", "string"]), "hello world");

    await kv.set(["data", "number"], 3.14159);
    assertEquals(await kv.get(["data", "number"]), 3.14159);

    await kv.set(["data", "boolean"], true);
    assertEquals(await kv.get(["data", "boolean"]), true);

    // Complex types: nested object and array
    const complexObj = {
      name: "test",
      tags: ["a", "b"],
      config: { active: true },
    };
    await kv.set(["data", "object"], complexObj);
    assertEquals(await kv.get(["data", "object"]), complexObj);

    // Binary / Uint8Array
    const binary = new Uint8Array([1, 2, 3, 4, 255]);
    await kv.set(["data", "binary"], binary);
    assertEquals(await kv.get(["data", "binary"]), binary);

    // Delete
    await kv.delete(["data", "string"]);
    assertEquals(await kv.get(["data", "string"]), null);

    // Non-existent key returns null
    assertEquals(await kv.get(["data", "missing"]), null);
  });
});

// AC1: Given a key stored with ttl: 1 (seconds), when read again after expiration,
// then get returns null (KV-2). Real elapsed time delay per docs/ANTIHALLUCINATION.md Rule 5.
Deno.test("DenoDeployKVProvider - integration: AC1 TTL expiry (KV-2)", async () => {
  await withProvider(async (kv: KVProvider) => {
    // Given a key stored with ttl: 1 (seconds)
    await kv.set(["session", "token-xyz"], { userId: "user-42" }, { ttl: 1 });

    // When read immediately, key is present
    const immediate = await kv.get(["session", "token-xyz"]);
    assertEquals(immediate, { userId: "user-42" });

    // When read again after expiration (1.5s real delay, no fake/mocked clock)
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Then get returns null
    const expired = await kv.get(["session", "token-xyz"]);
    assertEquals(expired, null);
  });
});

// AC2: Given atomic().check(key, expectedVersion).set(key, value).commit(),
// when the version matches, then commit() returns { ok: true, version } and stores the new value (KV-3).
Deno.test("DenoDeployKVProvider - integration: AC2 atomic CAS success (KV-3)", async () => {
  await withProvider(async (kv: KVProvider) => {
    // Write initial key using atomic() to receive version
    const initRes = await kv.atomic()
      .set(["inventory", "sku-1"], { count: 10 })
      .commit();

    assertEquals(initRes.ok, true);
    assert(
      typeof initRes.version === "number",
      "Initial commit must return numeric version",
    );
    const v1 = initRes.version as number;

    // Given check with matching expectedVersion
    const updateRes = await kv.atomic()
      .check(["inventory", "sku-1"], v1)
      .set(["inventory", "sku-1"], { count: 9 })
      .commit();

    // Then commit() returns { ok: true, version } and stores the new value
    assertEquals(updateRes.ok, true);
    assert(
      typeof updateRes.version === "number",
      "Update commit must return numeric version",
    );
    assertEquals(await kv.get(["inventory", "sku-1"]), { count: 9 });
  });
});

// AC3: Given atomic().check(key, expectedVersion).set(key, value).commit(),
// when the version does not match, then commit() returns { ok: false } and leaves stored state unchanged (KV-3).
Deno.test("DenoDeployKVProvider - integration: AC3 atomic CAS conflict (KV-3)", async () => {
  await withProvider(async (kv: KVProvider) => {
    // Write initial key
    const initRes = await kv.atomic()
      .set(["lock", "resource-a"], "holder-1")
      .commit();

    assertEquals(initRes.ok, true);
    const v1 = initRes.version as number;

    // Given check with mismatched version
    const conflictRes = await kv.atomic()
      .check(["lock", "resource-a"], v1 + 100)
      .set(["lock", "resource-a"], "holder-2")
      .commit();

    // Then commit() returns { ok: false } and leaves stored state unchanged
    assertEquals(conflictRes.ok, false);
    assertEquals(await kv.get(["lock", "resource-a"]), "holder-1");
  });
});

Deno.test("DenoDeployKVProvider - integration: atomic CAS check on non-existent keys (KV-3)", async () => {
  await withProvider(async (kv: KVProvider) => {
    // Check non-existent key with non-zero expectedVersion -> conflict
    const mismatchRes = await kv.atomic()
      .check(["unassigned", "key"], 1)
      .set(["unassigned", "key"], "val")
      .commit();

    assertEquals(mismatchRes.ok, false);
    assertEquals(await kv.get(["unassigned", "key"]), null);

    // Check non-existent key with expectedVersion 0 -> succeeds
    const createRes = await kv.atomic()
      .check(["unassigned", "key"], 0)
      .set(["unassigned", "key"], "initial-val")
      .commit();

    assertEquals(createRes.ok, true);
    assertEquals(await kv.get(["unassigned", "key"]), "initial-val");
  });
});

Deno.test("DenoDeployKVProvider - integration: atomic delete with version check (KV-3)", async () => {
  await withProvider(async (kv: KVProvider) => {
    const initRes = await kv.atomic()
      .set(["session", "to-remove"], "active")
      .commit();

    assertEquals(initRes.ok, true);
    const v1 = initRes.version as number;

    // Mismatched check prevents delete
    const failDelete = await kv.atomic()
      .check(["session", "to-remove"], v1 + 99)
      .delete(["session", "to-remove"])
      .commit();

    assertEquals(failDelete.ok, false);
    assertEquals(await kv.get(["session", "to-remove"]), "active");

    // Matching check performs delete
    const successDelete = await kv.atomic()
      .check(["session", "to-remove"], v1)
      .delete(["session", "to-remove"])
      .commit();

    assertEquals(successDelete.ok, true);
    assertEquals(await kv.get(["session", "to-remove"]), null);
  });
});

Deno.test("DenoDeployKVProvider - integration: list with prefix, limit, and cursor pagination (KV-2)", async () => {
  await withProvider(async (kv: KVProvider) => {
    // Seed 25 items under ["logs", "prod"] and 5 items under ["logs", "staging"]
    for (let i = 0; i < 25; i++) {
      const id = i.toString().padStart(2, "0");
      await kv.set(["logs", "prod", id], { id: i });
    }
    for (let i = 0; i < 5; i++) {
      const id = i.toString().padStart(2, "0");
      await kv.set(["logs", "staging", id], { stagingId: i });
    }

    // Page 1: limit 10
    const page1 = await kv.list(["logs", "prod"], { limit: 10 });
    assertEquals(page1.keys.length, 10);
    assert(typeof page1.cursor === "string", "Page 1 cursor must be returned");

    // Page 2: limit 10 using cursor from page 1
    const page2 = await kv.list(["logs", "prod"], {
      limit: 10,
      cursor: page1.cursor,
    });
    assertEquals(page2.keys.length, 10);
    assert(typeof page2.cursor === "string", "Page 2 cursor must be returned");

    // Page 3: limit 10 using cursor from page 2 (remaining 5 items)
    const page3 = await kv.list(["logs", "prod"], {
      limit: 10,
      cursor: page2.cursor,
    });
    assertEquals(page3.keys.length, 5);
    assertEquals(
      page3.cursor,
      undefined,
      "Last page must have undefined cursor",
    );

    // All 25 items retrieved without repetition
    const all = [...page1.keys, ...page2.keys, ...page3.keys];
    assertEquals(all.length, 25);
    const ids = new Set(all.map((item) => (item.value as { id: number }).id));
    assertEquals(ids.size, 25);

    // Staging logs must not be included under prefix ["logs", "prod"]
    for (const item of all) {
      assertEquals(item.key[0], "logs");
      assertEquals(item.key[1], "prod");
    }
  });
});

Deno.test("DenoDeployKVProvider - integration: list default limit (100) per KV-2", async () => {
  await withProvider(async (kv: KVProvider) => {
    // Empty prefix returns empty array and undefined cursor
    const empty = await kv.list(["empty_prefix"]);
    assertEquals(empty.keys, []);
    assertEquals(empty.cursor, undefined);

    // Seed 120 items
    for (let i = 0; i < 120; i++) {
      const id = i.toString().padStart(3, "0");
      await kv.set(["bulk", id], i);
    }

    // Calling list without limit options uses default limit 100
    const defaultPage = await kv.list(["bulk"]);
    assertEquals(defaultPage.keys.length, 100);
    assert(
      defaultPage.cursor !== undefined,
      "Cursor must be returned when more items exist",
    );
  });
});

// ---------------------------------------------------------------------------
// Security tests: Key validation bounds, segment typing, path traversal prevention,
// and segment injection prevention
// ---------------------------------------------------------------------------

Deno.test("DenoDeployKVProvider - security: rejects path traversal segments across all methods (KV-4)", async () => {
  await withProvider(async (kv: KVProvider) => {
    const traversalKeys = [
      ["users", "..", "secrets"],
      ["..", "etc", "passwd"],
      ["users", ".", "profile"],
      ["users", "foo/bar"],
      ["users", "foo\\bar"],
    ];

    for (const badKey of traversalKeys) {
      await assertRejects(
        () => kv.set(badKey, "exploit"),
        ValidationFailedError,
      );
      await assertRejects(
        () => kv.get(badKey),
        ValidationFailedError,
      );
      await assertRejects(
        () => kv.delete(badKey),
        ValidationFailedError,
      );
      await assertRejects(
        () => kv.list(badKey),
        ValidationFailedError,
      );
    }
  });
});

Deno.test("DenoDeployKVProvider - security: rejects null-byte poison and empty segment injection (KV-4)", async () => {
  await withProvider(async (kv: KVProvider) => {
    const maliciousKeys = [
      ["users", "admin\0injection"],
      ["\0", "secrets"],
      ["users", ""],
      ["", "empty_root"],
    ];

    for (const badKey of maliciousKeys) {
      await assertRejects(
        () => kv.set(badKey, "bad"),
        ValidationFailedError,
      );
      await assertRejects(
        () => kv.get(badKey),
        ValidationFailedError,
      );
      await assertRejects(
        () => kv.delete(badKey),
        ValidationFailedError,
      );
      await assertRejects(
        () => kv.list(badKey),
        ValidationFailedError,
      );
    }
  });
});

Deno.test("DenoDeployKVProvider - security: enforces strict string segment typing (KV-4)", async () => {
  await withProvider(async (kv: KVProvider) => {
    const nonStringKeys = [
      ["users", 123 as unknown as string],
      ["users", null as unknown as string],
      ["users", undefined as unknown as string],
      ["users", true as unknown as string],
      ["users", {} as unknown as string],
    ];

    for (const badKey of nonStringKeys) {
      await assertRejects(
        () => kv.set(badKey, "bad_type"),
        ValidationFailedError,
      );
      await assertRejects(
        () => kv.get(badKey),
        ValidationFailedError,
      );
    }
  });
});

Deno.test("DenoDeployKVProvider - security: enforces key and payload validation inside atomic operations (KV-1, KV-4)", async () => {
  await withProvider(async (kv: KVProvider) => {
    // Atomic check with invalid traversal key
    await assertRejects(
      async () => {
        await kv.atomic().check(["users", "..", "root"], 1).commit();
      },
      ValidationFailedError,
    );

    // Atomic set with invalid key
    await assertRejects(
      async () => {
        await kv.atomic().set(["users", "bad\0injection"], "val").commit();
      },
      ValidationFailedError,
    );

    // Atomic delete with invalid key
    await assertRejects(
      async () => {
        await kv.atomic().delete(["..", "bad_del"]).commit();
      },
      ValidationFailedError,
    );
  });
});
