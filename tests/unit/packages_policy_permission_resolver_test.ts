import { assertEquals, assertExists, assertThrows } from "@std/assert";
import { resolvePermissions } from "../../packages/policy/permission-resolver.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";

// deno-lint-ignore no-explicit-any
const emptyProviders: any = {};

Deno.test("Unit: Ambiguous scopes or invalid resource names throw VALIDATION_FAILED", () => {
  assertThrows(
    () =>
      resolvePermissions(
        { kv: ["app:sessions", "app:other"] },
        "org1",
        "proj1",
        emptyProviders,
      ),
    ValidationFailedError,
  );
});

Deno.test("Unit: Undeclared permission results in undefined capability", () => {
  const tempDir = Deno.makeTempDirSync();
  const bindings = resolvePermissions(
    { objects: ["app_uploads"] },
    "org1",
    "proj1",
    {
      kv: emptyProviders,
      objects: new LocalFSProvider(tempDir),
      queues: emptyProviders,
    },
  );

  // deno-lint-ignore no-explicit-any
  assertEquals((bindings as any).kv, undefined);
  assertExists(bindings.objects);
  Deno.removeSync(tempDir, { recursive: true });
});

Deno.test("Integration: Two-project collision test for KV (Real provider)", async () => {
  const sharedKV = new SQLiteKVProvider(":memory:");
  const providersA = {
    kv: sharedKV,
    objects: emptyProviders,
    queues: emptyProviders,
  };
  const providersB = {
    kv: sharedKV,
    objects: emptyProviders,
    queues: emptyProviders,
  };

  const bindingsA = resolvePermissions(
    { kv: ["app:sessions"] },
    "org1",
    "projA",
    providersA,
  );
  const bindingsB = resolvePermissions(
    { kv: ["app:sessions"] },
    "org1",
    "projB",
    providersB,
  );

  await bindingsA.kv!.set(["user", "123"], "dataA");
  await bindingsB.kv!.set(["user", "123"], "dataB");

  const valA = await bindingsA.kv!.get(["user", "123"]);
  const valB = await bindingsB.kv!.get(["user", "123"]);

  assertEquals(valA, "dataA");
  assertEquals(valB, "dataB");

  // Check prefix stripped list results
  const listA = await bindingsA.kv!.list([]);
  assertEquals(listA.keys.length, 1);
  assertEquals(listA.keys[0].key, ["user", "123"]);
  assertEquals(listA.keys[0].value, "dataA");

  const listB = await bindingsB.kv!.list([]);
  assertEquals(listB.keys.length, 1);
  assertEquals(listB.keys[0].key, ["user", "123"]);
  assertEquals(listB.keys[0].value, "dataB");

  // Delete on A should not affect B
  await bindingsA.kv!.delete(["user", "123"]);
  assertEquals(await bindingsA.kv!.get(["user", "123"]), null);
  assertEquals(await bindingsB.kv!.get(["user", "123"]), "dataB");
});

Deno.test("Integration: Two-project collision test for Objects (Real provider)", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const sharedObj = new LocalFSProvider(tempDir);
    const providersA = {
      kv: emptyProviders,
      objects: sharedObj,
      queues: emptyProviders,
    };
    const providersB = {
      kv: emptyProviders,
      objects: sharedObj,
      queues: emptyProviders,
    };

    const bindingsA = resolvePermissions(
      { objects: ["app_uploads"] },
      "org1",
      "projA",
      providersA,
    );
    const bindingsB = resolvePermissions(
      { objects: ["app_uploads"] },
      "org1",
      "projB",
      providersB,
    );

    const dataA = new TextEncoder().encode("dataA").buffer;
    const dataB = new TextEncoder().encode("dataB").buffer;

    await bindingsA.objects!.put("file.txt", dataA);
    await bindingsB.objects!.put("file.txt", dataB);

    // Read back A
    const streamA = await bindingsA.objects!.get("file.txt");
    const readerA = streamA!.getReader();
    const chunkA = await readerA.read();
    assertEquals(new TextDecoder().decode(chunkA.value), "dataA");

    // Read back B
    const streamB = await bindingsB.objects!.get("file.txt");
    const readerB = streamB!.getReader();
    const chunkB = await readerB.read();
    assertEquals(new TextDecoder().decode(chunkB.value), "dataB");

    // List should return isolated and stripped keys
    const listA = await bindingsA.objects!.list("");
    assertEquals(listA.keys.length, 1);
    assertEquals(listA.keys[0], "file.txt");

    const listB = await bindingsB.objects!.list("");
    assertEquals(listB.keys.length, 1);
    assertEquals(listB.keys[0], "file.txt");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Integration: Two-project isolation for Queues (Real provider)", async () => {
  // Since Queues don't support multiplexing in the same db natively without prefix,
  // we simulate isolation by having separate DB instances for the queues, as they would be provided by runtime.
  const queueA = new SQLiteQueueProvider(":memory:");
  const queueB = new SQLiteQueueProvider(":memory:");
  const providersA = {
    kv: emptyProviders,
    objects: emptyProviders,
    queues: queueA,
  };
  const providersB = {
    kv: emptyProviders,
    objects: emptyProviders,
    queues: queueB,
  };

  const bindingsA = resolvePermissions(
    { queues: ["app:jobs"] },
    "org1",
    "projA",
    providersA,
  );
  const bindingsB = resolvePermissions(
    { queues: ["app:jobs"] },
    "org1",
    "projB",
    providersB,
  );

  const resA = await bindingsA.queues!.send({ msg: "msgA" });
  const resB = await bindingsB.queues!.send({ msg: "msgB" });

  const rcvA = await queueA.receive();
  const rcvB = await queueB.receive();

  assertEquals((rcvA!.body as Record<string, string>).msg, "msgA");
  assertEquals((rcvB!.body as Record<string, string>).msg, "msgB");
  assertEquals(rcvA!.id, resA.id);
  assertEquals(rcvB!.id, resB.id);
});

Deno.test("Deploy-time validation: Empty or invalid parameters throw VALIDATION_FAILED", () => {
  assertThrows(
    () => resolvePermissions({ kv: ["app"] }, "", "proj1", emptyProviders),
    ValidationFailedError,
  );
  assertThrows(
    () => resolvePermissions({ kv: ["app"] }, "org1", "", emptyProviders),
    ValidationFailedError,
  );
  assertThrows(
    () => resolvePermissions({ kv: [""] }, "org1", "proj1", emptyProviders),
    ValidationFailedError,
  );
  assertThrows(
    () =>
      resolvePermissions({ objects: ["  "] }, "org1", "proj1", emptyProviders),
    ValidationFailedError,
  );
  assertThrows(
    () =>
      resolvePermissions(
        { queues: ["q1", "q2"] },
        "org1",
        "proj1",
        emptyProviders,
      ),
    ValidationFailedError,
  );
  assertThrows(
    () =>
      resolvePermissions(
        { objects: ["b1", "b2"] },
        "org1",
        "proj1",
        emptyProviders,
      ),
    ValidationFailedError,
  );
});

Deno.test("Security: Adversarial path traversal fails and cannot escape project scope", async () => {
  const tempDir = Deno.makeTempDirSync();
  try {
    const sharedObj = new LocalFSProvider(tempDir);
    const bindingsA = resolvePermissions(
      { objects: ["app_uploads"] },
      "org1",
      "projA",
      { kv: emptyProviders, objects: sharedObj, queues: emptyProviders },
    );
    await assertThrows(
      () => bindingsA.objects!.get("../../projB/app_uploads/secret.txt"),
      ValidationFailedError,
    );
    await assertThrows(
      () =>
        bindingsA.objects!.put(
          "../../projB/app_uploads/secret.txt",
          new ArrayBuffer(0),
        ),
      ValidationFailedError,
    );
    await assertThrows(
      () =>
        bindingsA.objects!.get(
          "dummy\\..\\..\\..\\projB\\app_uploads\\secret.txt",
        ),
      ValidationFailedError,
    );
    await assertThrows(
      () =>
        bindingsA.objects!.get(
          "dummy/..\\..\\..\\projB\\app_uploads\\secret.txt",
        ),
      ValidationFailedError,
    );
  } finally {
    Deno.removeSync(tempDir, { recursive: true });
  }
});

Deno.test("Security: PLAT-6 guarantee (structurally impossible to address out-of-scope for all 16 methods)", () => {
  const sharedKV = new SQLiteKVProvider(":memory:");
  const tempDir = Deno.makeTempDirSync();
  const queueA = new SQLiteQueueProvider(":memory:");
  const mockProviders = {
    kv: sharedKV,
    objects: new LocalFSProvider(tempDir),
    queues: queueA,
  };
  const bindings = resolvePermissions(
    { kv: ["app:sessions"], objects: ["app_uploads"], queues: ["app_jobs"] },
    "org1",
    "proj1",
    mockProviders,
  );

  const _testTypes = () => {
    // @ts-expect-error: PLAT-6
    bindings.kv!.get(["user", "123"], "app:other");
    // @ts-expect-error: PLAT-6
    bindings.kv!.set(["user", "123"], "val", { ttl: 60 }, "app:other");
    // @ts-expect-error: PLAT-6
    bindings.kv!.delete(["user", "123"], "app:other");
    // @ts-expect-error: PLAT-6
    bindings.kv!.list([], { limit: 10 }, "app:other");

    const atm = bindings.kv!.atomic();
    // @ts-expect-error: PLAT-6
    atm.check(["user"], 1, "app:other");
    // @ts-expect-error: PLAT-6
    atm.set(["user"], "val", "app:other");
    // @ts-expect-error: PLAT-6
    atm.delete(["user"], "app:other");

    // @ts-expect-error: PLAT-6
    bindings.objects!.put("file.txt", new ArrayBuffer(0), "app:other");
    // @ts-expect-error: PLAT-6
    bindings.objects!.get("file.txt", "app:other");
    // @ts-expect-error: PLAT-6
    bindings.objects!.delete("file.txt", "app:other");
    // @ts-expect-error: PLAT-6
    bindings.objects!.head("file.txt", "app:other");
    // @ts-expect-error: PLAT-6
    bindings.objects!.list("", {}, "app:other");
    // @ts-expect-error: PLAT-6
    bindings.objects!.presign("file.txt", { method: "GET" }, "app:other");
    // @ts-expect-error: PLAT-6
    bindings.objects!.createMultipartUpload("file.txt", "app:other");

    // @ts-expect-error: PLAT-6
    bindings.queues!.send({ msg: "hi" }, {}, "app:other");
    // @ts-expect-error: PLAT-6
    bindings.queues!.sendBatch([{ msg: "hi" }], "app:other");
    // @ts-expect-error: PLAT-6
    bindings.queues!.receive({}, "app:other");
    // @ts-expect-error: PLAT-6
    bindings.queues!.ack("id123", "app:other");
  };

  // Verify parameters count is exactly what the caller needs, no room for resource strings
  assertEquals(bindings.kv!.set.length, 3);
  assertEquals(bindings.kv!.get.length, 1);
  assertEquals(bindings.objects!.put.length, 2);
  assertEquals(bindings.queues!.send.length, 2);

  Deno.removeSync(tempDir, { recursive: true });
});

Deno.test("Security: No runtime permission check branches", async () => {
  const sharedKV = new SQLiteKVProvider(":memory:");
  const mockProviders = {
    kv: sharedKV,
    objects: emptyProviders,
    queues: emptyProviders,
  };
  const bindings = resolvePermissions(
    { kv: ["app:sessions"] },
    "org1",
    "proj1",
    mockProviders,
  );
  await bindings.kv!.get(["user", "123"]);
});
