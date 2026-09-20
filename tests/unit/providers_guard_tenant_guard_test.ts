/**
 * Tenant Prefix Storage Provider Guard Tests
 *
 * Spec references:
 * - PLAT-7: Multi-tenancy & data isolation (physical_key = {org_id}/{project_id}/{resource_name}/{caller_key})
 * - PLAT-12: Error model (PERMISSION_DENIED, VALIDATION_FAILED)
 * - PLAT-16: Provider abstraction
 * - PLAT-17: Local/production parity
 * - KV-2: KV API shape
 * - OBJ-2: Objects API shape
 * - Q-2: Queues API shape
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  PermissionDeniedError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import type {
  KVAtomicBuilder,
  KVProvider,
} from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";

import {
  createGuardedKVProvider,
  createGuardedObjectProvider,
  createGuardedQueueProvider,
  type TenantContext,
} from "../../providers/guard/tenant-guard.ts";

// ============================================================================
// Test Doubles / Mocks for Precise Isolation & Parameter Tracking
// ============================================================================

interface MockKVCall {
  method: string;
  args: unknown[];
}

class MockKVAtomicBuilder implements KVAtomicBuilder {
  public calls: MockKVCall[] = [];

  check(key: string[], expectedVersion: number): KVAtomicBuilder {
    this.calls.push({ method: "check", args: [key, expectedVersion] });
    return this;
  }

  set(key: string[], value: unknown): KVAtomicBuilder {
    this.calls.push({ method: "set", args: [key, value] });
    return this;
  }

  delete(key: string[]): KVAtomicBuilder {
    this.calls.push({ method: "delete", args: [key] });
    return this;
  }

  commit(): Promise<{ ok: boolean; version?: number }> {
    this.calls.push({ method: "commit", args: [] });
    return Promise.resolve({ ok: true, version: 1 });
  }
}

class MockKVProvider implements KVProvider {
  public calls: MockKVCall[] = [];
  public storage = new Map<string, unknown>();
  public lastAtomicBuilder: MockKVAtomicBuilder | null = null;

  get(key: string[]): Promise<unknown | null> {
    this.calls.push({ method: "get", args: [key] });
    const serialized = JSON.stringify(key);
    return Promise.resolve(this.storage.get(serialized) ?? null);
  }

  set(key: string[], value: unknown, opts?: { ttl?: number }): Promise<void> {
    this.calls.push({ method: "set", args: [key, value, opts] });
    const serialized = JSON.stringify(key);
    this.storage.set(serialized, value);
    return Promise.resolve();
  }

  delete(key: string[]): Promise<void> {
    this.calls.push({ method: "delete", args: [key] });
    const serialized = JSON.stringify(key);
    this.storage.delete(serialized);
    return Promise.resolve();
  }

  list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }> {
    this.calls.push({ method: "list", args: [prefix, opts] });
    const keys: { key: string[]; value: unknown }[] = [];
    for (const [kStr, value] of this.storage.entries()) {
      const parsedKey = JSON.parse(kStr) as string[];
      const matches = prefix.every((seg, idx) => parsedKey[idx] === seg);
      if (matches) {
        keys.push({ key: parsedKey, value });
      }
    }
    return Promise.resolve({ keys });
  }

  atomic(): KVAtomicBuilder {
    const builder = new MockKVAtomicBuilder();
    this.lastAtomicBuilder = builder;
    this.calls.push({ method: "atomic", args: [] });
    return builder;
  }
}

interface MockObjectCall {
  method: string;
  args: unknown[];
}

class MockObjectProvider implements ObjectProvider {
  public calls: MockObjectCall[] = [];
  public objects = new Map<string, ArrayBuffer>();

  put(
    key: string,
    data: ArrayBuffer | ReadableStream,
  ): Promise<{ etag: string }> {
    this.calls.push({ method: "put", args: [key, data] });
    if (data instanceof ArrayBuffer) {
      this.objects.set(key, data);
    }
    return Promise.resolve({ etag: "etag-mock-123" });
  }

  get(key: string): Promise<ReadableStream | null> {
    this.calls.push({ method: "get", args: [key] });
    if (!this.objects.has(key)) {
      return Promise.resolve(null);
    }
    const data = this.objects.get(key)!;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(data));
        controller.close();
      },
    });
    return Promise.resolve(stream);
  }

  delete(key: string): Promise<void> {
    this.calls.push({ method: "delete", args: [key] });
    this.objects.delete(key);
    return Promise.resolve();
  }

  head(key: string): Promise<{ size: number; etag: string } | null> {
    this.calls.push({ method: "head", args: [key] });
    if (!this.objects.has(key)) {
      return Promise.resolve(null);
    }
    const data = this.objects.get(key)!;
    return Promise.resolve({ size: data.byteLength, etag: "etag-mock-123" });
  }

  list(
    prefix: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: string[]; cursor?: string }> {
    this.calls.push({ method: "list", args: [prefix, opts] });
    const keys: string[] = [];
    for (const k of this.objects.keys()) {
      if (k.startsWith(prefix)) {
        keys.push(k);
      }
    }
    return Promise.resolve({ keys });
  }

  presign(
    key: string,
    opts: { method: "GET" | "PUT"; expiresIn?: number; maxExpiresIn?: number },
  ): Promise<{ url: string; expiresAt: number }> {
    this.calls.push({ method: "presign", args: [key, opts] });
    return Promise.resolve({
      url: `https://mock-storage.example.com/${key}?signed=true`,
      expiresAt: Date.now() + 3600 * 1000,
    });
  }

  createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    this.calls.push({ method: "createMultipartUpload", args: [key] });
    return Promise.resolve({ uploadId: "upload-id-mock-456" });
  }
}

interface MockQueueCall {
  method: string;
  args: unknown[];
}

class MockQueueProvider implements QueueProvider {
  public calls: MockQueueCall[] = [];
  public queueName?: string;
  public messages: QueueMessage[] = [];

  constructor(queueName?: string) {
    this.queueName = queueName;
  }

  send(body: unknown, opts?: { delay?: number }): Promise<{ id: string }> {
    this.calls.push({ method: "send", args: [body, opts] });
    const id = `msg-${Math.random().toString(36).substring(2, 9)}`;
    this.messages.push({ id, body, attempts: 0 });
    return Promise.resolve({ id });
  }

  sendBatch(bodies: unknown[]): Promise<{ id: string }[]> {
    this.calls.push({ method: "sendBatch", args: [bodies] });
    const results = bodies.map((body) => {
      const id = `msg-${Math.random().toString(36).substring(2, 9)}`;
      this.messages.push({ id, body, attempts: 0 });
      return { id };
    });
    return Promise.resolve(results);
  }

  receive(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null> {
    this.calls.push({ method: "receive", args: [opts] });
    const msg = this.messages.shift();
    if (msg) {
      msg.attempts += 1;
      return Promise.resolve(msg);
    }
    return Promise.resolve(null);
  }

  ack(id: string): Promise<void> {
    this.calls.push({ method: "ack", args: [id] });
    return Promise.resolve();
  }
}

// ============================================================================
// 1. Tenant Context Validation Tests (PLAT-7, PLAT-12)
// ============================================================================

Deno.test("TenantContext Validation - rejects invalid orgId and projectId", () => {
  const kv = new MockKVProvider();
  const obj = new MockObjectProvider();
  const queue = new MockQueueProvider("org_1_proj_1_tasks");

  const invalidContexts: TenantContext[] = [
    { orgId: "", projectId: "proj_1" },
    { orgId: "   ", projectId: "proj_1" },
    { orgId: "org_1", projectId: "" },
    { orgId: "org_1", projectId: " \t\n " },
    { orgId: "..", projectId: "proj_1" },
    { orgId: "org_1", projectId: ".." },
    { orgId: "../escape", projectId: "proj_1" },
    { orgId: "org_1", projectId: "../escape" },
    { orgId: "org/1", projectId: "proj_1" },
    { orgId: "org_1", projectId: "proj/1" },
    { orgId: "org\\1", projectId: "proj_1" },
    { orgId: "org_1", projectId: "proj\\1" },
    { orgId: "org_1\0", projectId: "proj_1" },
    { orgId: "org_1", projectId: "proj_1\0" },
  ];

  for (const ctx of invalidContexts) {
    const errKv = assertThrows(
      () => createGuardedKVProvider(kv, ctx),
      ValidationFailedError,
    );
    assertEquals(errKv.code, "VALIDATION_FAILED");

    const errObj = assertThrows(
      () => createGuardedObjectProvider(obj, ctx),
      ValidationFailedError,
    );
    assertEquals(errObj.code, "VALIDATION_FAILED");

    const errQueue = assertThrows(
      () => createGuardedQueueProvider(queue, ctx),
      ValidationFailedError,
    );
    assertEquals(errQueue.code, "VALIDATION_FAILED");
  }

  // Null or undefined context
  // deno-lint-ignore no-explicit-any
  const nullCtx = null as any;
  assertThrows(
    () => createGuardedKVProvider(kv, nullCtx),
    ValidationFailedError,
  );
  assertThrows(
    () => createGuardedObjectProvider(obj, nullCtx),
    ValidationFailedError,
  );
  assertThrows(
    () => createGuardedQueueProvider(queue, nullCtx),
    ValidationFailedError,
  );
});

// ============================================================================
// 2. Guarded KVProvider - AC1: Permitted Operations
// ============================================================================

Deno.test("AC1 / PLAT-7: Guarded KVProvider allows valid tenant-prefixed keys across all methods", async () => {
  const underlying = new MockKVProvider();
  const tenant: TenantContext = { orgId: "org_1", projectId: "proj_1" };
  const guarded = createGuardedKVProvider(underlying, tenant);

  const key = ["org_1", "proj_1", "app:sessions", "session_abc"];

  // 1. set
  await guarded.set(key, { user: "alice" }, { ttl: 3600 });
  assertEquals(underlying.calls.length, 1);
  assertEquals(underlying.calls[0].method, "set");
  assertEquals(underlying.calls[0].args[0], key);
  assertEquals(underlying.calls[0].args[1], { user: "alice" });

  // 2. get
  const value = await guarded.get(key);
  assertEquals(value, { user: "alice" });
  assertEquals(underlying.calls.length, 2);
  assertEquals(underlying.calls[1].method, "get");
  assertEquals(underlying.calls[1].args[0], key);

  // 3. list with sub-prefix
  const listRes = await guarded.list(["org_1", "proj_1", "app:sessions"]);
  assertEquals(underlying.calls.length, 3);
  assertEquals(underlying.calls[2].method, "list");
  assertEquals(listRes.keys.length, 1);
  assertEquals(listRes.keys[0].key, key);

  // 4. list with exact tenant prefix
  const listAllRes = await guarded.list(["org_1", "proj_1"]);
  assertEquals(listAllRes.keys.length, 1);

  // 5. delete
  await guarded.delete(key);
  assertEquals(underlying.calls.length, 5);
  assertEquals(underlying.calls[4].method, "delete");
  assertEquals(underlying.calls[4].args[0], key);

  // 6. atomic operations
  const atomic = guarded.atomic();
  assert(atomic);
  assert(underlying.lastAtomicBuilder);

  const key2 = ["org_1", "proj_1", "counters", "hits"];
  atomic
    .check(key, 1)
    .set(key2, 42)
    .delete(key);

  const commitRes = await atomic.commit();
  assertEquals(commitRes.ok, true);
  assertEquals(underlying.lastAtomicBuilder.calls.length, 4);
  assertEquals(underlying.lastAtomicBuilder.calls[0].method, "check");
  assertEquals(underlying.lastAtomicBuilder.calls[0].args[0], key);
  assertEquals(underlying.lastAtomicBuilder.calls[1].method, "set");
  assertEquals(underlying.lastAtomicBuilder.calls[1].args[0], key2);
  assertEquals(underlying.lastAtomicBuilder.calls[2].method, "delete");
  assertEquals(underlying.lastAtomicBuilder.calls[2].args[0], key);
  assertEquals(underlying.lastAtomicBuilder.calls[3].method, "commit");
});

// ============================================================================
// 3. Guarded KVProvider - AC2: Cross-Tenant & Security Interception
// ============================================================================

Deno.test("AC2 / PLAT-7 / PLAT-12: Guarded KVProvider rejects cross-tenant prefixes across all methods", async () => {
  const underlying = new MockKVProvider();
  const tenant: TenantContext = { orgId: "org_1", projectId: "proj_1" };
  const guarded = createGuardedKVProvider(underlying, tenant);

  const crossTenantKey = ["org_2", "proj_2", "other"];

  // get
  const errGet = await assertRejects(
    () => guarded.get(crossTenantKey),
    PermissionDeniedError,
  );
  assertEquals(errGet.code, "PERMISSION_DENIED");

  // set
  const errSet = await assertRejects(
    () => guarded.set(crossTenantKey, "val"),
    PermissionDeniedError,
  );
  assertEquals(errSet.code, "PERMISSION_DENIED");

  // delete
  const errDel = await assertRejects(
    () => guarded.delete(crossTenantKey),
    PermissionDeniedError,
  );
  assertEquals(errDel.code, "PERMISSION_DENIED");

  // list
  const errList = await assertRejects(
    () => guarded.list(crossTenantKey),
    PermissionDeniedError,
  );
  assertEquals(errList.code, "PERMISSION_DENIED");

  // atomic
  const atomic = guarded.atomic();
  assertThrows(
    () => atomic.check(crossTenantKey, 1),
    PermissionDeniedError,
  );
  assertThrows(
    () => atomic.set(crossTenantKey, "val"),
    PermissionDeniedError,
  );
  assertThrows(
    () => atomic.delete(crossTenantKey),
    PermissionDeniedError,
  );

  // Verify underlying provider was NEVER called for any rejected operation
  assertEquals(
    underlying.calls.filter((c) => c.method !== "atomic").length,
    0,
  );
});

Deno.test("AC2 / PLAT-7 / PLAT-12: Guarded KVProvider rejects path traversal and empty segments", async () => {
  const underlying = new MockKVProvider();
  const tenant: TenantContext = { orgId: "org_1", projectId: "proj_1" };
  const guarded = createGuardedKVProvider(underlying, tenant);

  const forbiddenKeys: string[][] = [
    // Direct traversal without tenant prefix
    ["..", "escape"],
    [".."],
    [".", "something"],
    // Traversal embedded after valid prefix
    ["org_1", "proj_1", "..", "escape"],
    ["org_1", "proj_1", "a", "..", "b"],
    ["org_1", "proj_1", ".."],
    ["org_1", "proj_1", "."],
    // Delimiter & path traversal inside segment
    ["org_1", "proj_1", "../escape"],
    ["org_1", "proj_1", "..\\escape"],
    ["org_1", "proj_1", "%2e%2e", "escape"],
    ["org_1", "proj_1", "%2E%2E", "escape"],
    // Empty segments
    ["org_1", "proj_1", ""],
    ["org_1", "proj_1", "users", "", "profile"],
    // Slashes inside segment
    ["org_1", "proj_1", "users/secrets"],
    ["org_1", "proj_1", "users\\secrets"],
    // Null byte injection
    ["org_1", "proj_1", "user\0name"],
    ["org_1", "proj_1\0", "key"],
    ["org_1\0", "proj_1", "key"],
  ];

  for (const k of forbiddenKeys) {
    await assertRejects(
      () => guarded.get(k),
      PermissionDeniedError,
      undefined,
      `Expected key ${JSON.stringify(k)} to be rejected on get`,
    );
    await assertRejects(
      () => guarded.set(k, "bad"),
      PermissionDeniedError,
      undefined,
      `Expected key ${JSON.stringify(k)} to be rejected on set`,
    );
    await assertRejects(
      () => guarded.delete(k),
      PermissionDeniedError,
      undefined,
      `Expected key ${JSON.stringify(k)} to be rejected on delete`,
    );

    const atomic = guarded.atomic();
    assertThrows(
      () => atomic.check(k, 1),
      PermissionDeniedError,
      undefined,
      `Expected key ${JSON.stringify(k)} to be rejected on atomic.check`,
    );
    assertThrows(
      () => atomic.set(k, "bad"),
      PermissionDeniedError,
      undefined,
      `Expected key ${JSON.stringify(k)} to be rejected on atomic.set`,
    );
    assertThrows(
      () => atomic.delete(k),
      PermissionDeniedError,
      undefined,
      `Expected key ${JSON.stringify(k)} to be rejected on atomic.delete`,
    );
  }
});

Deno.test("AC2 / PLAT-7: Guarded KVProvider rejects empty or incomplete list prefixes", async () => {
  const underlying = new MockKVProvider();
  const tenant: TenantContext = { orgId: "org_1", projectId: "proj_1" };
  const guarded = createGuardedKVProvider(underlying, tenant);

  // Empty prefix [] cannot be listed (would scan entire KV across all tenants)
  await assertRejects(
    () => guarded.list([]),
    PermissionDeniedError,
  );

  // Incomplete prefix ["org_1"] cannot be listed (would scan all projects in org)
  await assertRejects(
    () => guarded.list(["org_1"]),
    PermissionDeniedError,
  );

  // Mismatched org or project
  await assertRejects(
    () => guarded.list(["org_2", "proj_1"]),
    PermissionDeniedError,
  );
  await assertRejects(
    () => guarded.list(["org_1", "proj_2"]),
    PermissionDeniedError,
  );
});

Deno.test("Security / PLAT-7: Guarded KVProvider rejects sub-namespace spoofing", async () => {
  const underlying = new MockKVProvider();
  const tenant: TenantContext = { orgId: "org_1", projectId: "proj_1" };
  const guarded = createGuardedKVProvider(underlying, tenant);

  // "proj_10" starts with "proj_1" in string prefix, but is a separate namespace segment!
  const spoofKey1 = ["org_1", "proj_10", "secrets"];
  await assertRejects(
    () => guarded.get(spoofKey1),
    PermissionDeniedError,
  );

  // "org_10" starts with "org_1"
  const spoofKey2 = ["org_10", "proj_1", "secrets"];
  await assertRejects(
    () => guarded.get(spoofKey2),
    PermissionDeniedError,
  );
});

// ============================================================================
// 4. Guarded ObjectProvider - AC3: Permitted & Intercepted Operations
// ============================================================================

Deno.test("AC3 / PLAT-7: Guarded ObjectProvider allows valid tenant-prefixed keys across all methods", async () => {
  const underlying = new MockObjectProvider();
  const tenant: TenantContext = { orgId: "org_1", projectId: "proj_1" };
  const guarded = createGuardedObjectProvider(underlying, tenant);

  const key = "org_1/proj_1/uploads/report.pdf";
  const dummyData = new Uint8Array([1, 2, 3, 4]).buffer;

  // 1. put
  const putRes = await guarded.put(key, dummyData);
  assertEquals(putRes.etag, "etag-mock-123");
  assertEquals(underlying.calls.length, 1);
  assertEquals(underlying.calls[0].method, "put");
  assertEquals(underlying.calls[0].args[0], key);

  // 2. get
  const getStream = await guarded.get(key);
  assert(getStream);
  assertEquals(underlying.calls.length, 2);
  assertEquals(underlying.calls[1].method, "get");
  assertEquals(underlying.calls[1].args[0], key);

  // 3. head
  const headRes = await guarded.head(key);
  assert(headRes);
  assertEquals(headRes.size, 4);
  assertEquals(underlying.calls.length, 3);
  assertEquals(underlying.calls[2].method, "head");

  // 4. presign
  const presignRes = await guarded.presign(key, { method: "GET" });
  assert(presignRes.url.includes(key));
  assertEquals(underlying.calls.length, 4);
  assertEquals(underlying.calls[3].method, "presign");

  // 5. createMultipartUpload
  const mpRes = await guarded.createMultipartUpload(key);
  assertEquals(mpRes.uploadId, "upload-id-mock-456");
  assertEquals(underlying.calls.length, 5);
  assertEquals(underlying.calls[4].method, "createMultipartUpload");

  // 6. list with prefix
  const listRes = await guarded.list("org_1/proj_1/uploads/");
  assertEquals(listRes.keys.length, 1);
  assertEquals(listRes.keys[0], key);
  assertEquals(underlying.calls.length, 6);
  assertEquals(underlying.calls[5].method, "list");

  // 7. list with exact tenant root prefix
  const listRootRes = await guarded.list("org_1/proj_1/");
  assertEquals(listRootRes.keys.length, 1);

  // 8. delete
  await guarded.delete(key);
  assertEquals(underlying.calls.length, 8);
  assertEquals(underlying.calls[7].method, "delete");
  assertEquals(underlying.calls[7].args[0], key);
});

Deno.test("AC3 / PLAT-7 / PLAT-12: Guarded ObjectProvider rejects un-prefixed, cross-tenant, and traversal keys", async () => {
  const underlying = new MockObjectProvider();
  const tenant: TenantContext = { orgId: "org_1", projectId: "proj_1" };
  const guarded = createGuardedObjectProvider(underlying, tenant);

  const dummyData = new Uint8Array([1, 2, 3]).buffer;

  const forbiddenKeys = [
    // Cross tenant
    "org_2/proj_2/file.txt",
    "org_1/proj_2/file.txt",
    "org_2/proj_1/file.txt",
    // Unprefixed / relative
    "file.txt",
    "/file.txt",
    "uploads/file.txt",
    // Incomplete prefix without slash
    "org_1/proj_1",
    "org_1/proj_1file.txt",
    // Sub-namespace spoofing
    "org_1/proj_10/file.txt",
    "org_10/proj_1/file.txt",
    "org_1_proj_1/file.txt",
    // Path traversal escapes
    "org_1/proj_1/../escape",
    "org_1/proj_1/..\\escape",
    "../escape",
    "/../escape",
    "org_1/proj_1/sub/../../escape",
    "org_1/proj_1/sub/../",
    "org_1/proj_1/%2e%2e/escape",
    "org_1/proj_1/%2E%2E/escape",
    "org_1/proj_1/..",
    // Delimiter injection / backslash / null byte
    "org_1/proj_1/file\0.txt",
    "org_1/proj_1\\file.txt",
  ];

  for (const k of forbiddenKeys) {
    const errPut = await assertRejects(
      () => guarded.put(k, dummyData),
      PermissionDeniedError,
      undefined,
      `Expected put(${k}) to throw PermissionDeniedError`,
    );
    assertEquals(errPut.code, "PERMISSION_DENIED");

    const errGet = await assertRejects(
      () => guarded.get(k),
      PermissionDeniedError,
      undefined,
      `Expected get(${k}) to throw PermissionDeniedError`,
    );
    assertEquals(errGet.code, "PERMISSION_DENIED");

    const errHead = await assertRejects(
      () => guarded.head(k),
      PermissionDeniedError,
      undefined,
      `Expected head(${k}) to throw PermissionDeniedError`,
    );
    assertEquals(errHead.code, "PERMISSION_DENIED");

    const errDelete = await assertRejects(
      () => guarded.delete(k),
      PermissionDeniedError,
      undefined,
      `Expected delete(${k}) to throw PermissionDeniedError`,
    );
    assertEquals(errDelete.code, "PERMISSION_DENIED");

    const errPresign = await assertRejects(
      () => guarded.presign(k, { method: "GET" }),
      PermissionDeniedError,
      undefined,
      `Expected presign(${k}) to throw PermissionDeniedError`,
    );
    assertEquals(errPresign.code, "PERMISSION_DENIED");

    const errMultipart = await assertRejects(
      () => guarded.createMultipartUpload(k),
      PermissionDeniedError,
      undefined,
      `Expected createMultipartUpload(${k}) to throw PermissionDeniedError`,
    );
    assertEquals(errMultipart.code, "PERMISSION_DENIED");
  }

  // Verify underlying provider was never called
  assertEquals(underlying.calls.length, 0);
});

Deno.test("AC3 / PLAT-7: Guarded ObjectProvider rejects invalid list prefixes", async () => {
  const underlying = new MockObjectProvider();
  const tenant: TenantContext = { orgId: "org_1", projectId: "proj_1" };
  const guarded = createGuardedObjectProvider(underlying, tenant);

  const invalidListPrefixes = [
    "",
    "org_1",
    "org_1/",
    "org_1/proj_1", // Missing trailing slash
    "org_2/proj_2/",
    "org_1/proj_1/../",
    "../",
    "org_1/proj_10/",
  ];

  for (const prefix of invalidListPrefixes) {
    const err = await assertRejects(
      () => guarded.list(prefix),
      PermissionDeniedError,
      undefined,
      `Expected list(${prefix}) to throw PermissionDeniedError`,
    );
    assertEquals(err.code, "PERMISSION_DENIED");
  }

  assertEquals(underlying.calls.length, 0);
});

// ============================================================================
// 5. Guarded QueueProvider - AC4: Permitted & Intercepted Operations
// ============================================================================

Deno.test("AC4 / PLAT-7: Guarded QueueProvider allows operations on valid tenant-prefixed queue name", async () => {
  const underlying = new MockQueueProvider("org_1_proj_1_tasks");
  const tenant: TenantContext = { orgId: "org_1", projectId: "proj_1" };
  const guarded = createGuardedQueueProvider(
    underlying,
    tenant,
    "org_1_proj_1_tasks",
  );

  // 1. send
  const { id } = await guarded.send({ job: "process_image" }, { delay: 10 });
  assert(id);
  assertEquals(underlying.calls.length, 1);
  assertEquals(underlying.calls[0].method, "send");

  // 2. sendBatch
  const batchRes = await guarded.sendBatch([{ a: 1 }, { b: 2 }]);
  assertEquals(batchRes.length, 2);
  assertEquals(underlying.calls.length, 2);
  assertEquals(underlying.calls[1].method, "sendBatch");

  // 3. receive
  const msg = await guarded.receive({ visibilityTimeoutMs: 15000 });
  assert(msg);
  assertEquals(msg.id, id);
  assertEquals(underlying.calls.length, 3);
  assertEquals(underlying.calls[2].method, "receive");

  // 4. ack
  await guarded.ack(id);
  assertEquals(underlying.calls.length, 4);
  assertEquals(underlying.calls[3].method, "ack");
  assertEquals(underlying.calls[3].args[0], id);
});

Deno.test("AC4 / PLAT-7 / PLAT-12: Guarded QueueProvider rejects cross-tenant queue name at bind/creation", () => {
  const underlying = new MockQueueProvider();
  const tenant: TenantContext = { orgId: "org_1", projectId: "proj_1" };

  const invalidQueueNames = [
    "org_2_proj_2_tasks",
    "unprefixed",
    "org_1_proj_2_tasks",
    "org_2_proj_1_tasks",
    "../escape",
    "org_1_proj_10_tasks",
    "org_10_proj_1_tasks",
    "org_1/proj_1/tasks",
    "org_1/proj_1_tasks",
    "org_1_proj_1", // Missing trailing underscore before resource name
    "",
    "   ",
  ];

  for (const name of invalidQueueNames) {
    const err = assertThrows(
      () => createGuardedQueueProvider(underlying, tenant, name),
      PermissionDeniedError,
      undefined,
      `Expected queue name ${name} to throw PermissionDeniedError on bind`,
    );
    assertEquals(err.code, "PERMISSION_DENIED");
  }
});

Deno.test("AC4 / PLAT-7 / PLAT-12: Guarded QueueProvider dynamically checks queue name on send, sendBatch, receive, and ack", async () => {
  // Scenario: An underlying provider initialized with a valid queue name is wrapped
  const underlying = new MockQueueProvider("org_1_proj_1_tasks");
  const tenant: TenantContext = { orgId: "org_1", projectId: "proj_1" };
  const guarded = createGuardedQueueProvider(underlying, tenant);

  // Initially succeeds
  const { id } = await guarded.send({ test: "ok" });
  assert(id);

  // Now dynamically tamper underlying queueName to an out-of-scope tenant queue
  underlying.queueName = "org_2_proj_2_tasks";

  const errSend = await assertRejects(
    () => guarded.send({ test: "tampered" }),
    PermissionDeniedError,
  );
  assertEquals(errSend.code, "PERMISSION_DENIED");

  const errBatch = await assertRejects(
    () => guarded.sendBatch([{ test: "tampered" }]),
    PermissionDeniedError,
  );
  assertEquals(errBatch.code, "PERMISSION_DENIED");

  const errRecv = await assertRejects(
    () => guarded.receive(),
    PermissionDeniedError,
  );
  assertEquals(errRecv.code, "PERMISSION_DENIED");

  const errAck = await assertRejects(
    () => guarded.ack(id),
    PermissionDeniedError,
  );
  assertEquals(errAck.code, "PERMISSION_DENIED");

  // Traversal queue name
  underlying.queueName = "../escape";
  await assertRejects(
    () => guarded.send({ test: "traversal" }),
    PermissionDeniedError,
  );
});

// ============================================================================
// 6. Integration Tests with Real Storage Providers (PLAT-16, PLAT-17)
// ============================================================================

Deno.test("Integration / PLAT-17: Guarded SQLiteKVProvider enforces tenant isolation in real SQLite engine", async () => {
  const realDb = new SQLiteKVProvider(":memory:");
  const tenant: TenantContext = {
    orgId: "acme_corp",
    projectId: "billing_app",
  };
  const guarded = createGuardedKVProvider(realDb, tenant);

  const validKey = ["acme_corp", "billing_app", "invoices", "inv_2026_001"];
  const crossTenantKey = ["globex_corp", "secret_project", "invoices", "inv_1"];

  // 1. Store via guarded provider
  await guarded.set(validKey, { amount: 1500, currency: "USD" });

  // 2. Read back via guarded provider
  const stored = await guarded.get(validKey);
  assertEquals(stored, { amount: 1500, currency: "USD" });

  // 3. List via guarded provider
  const listRes = await guarded.list(["acme_corp", "billing_app", "invoices"]);
  assertEquals(listRes.keys.length, 1);
  assertEquals(listRes.keys[0].key, validKey);

  // 4. Atomic transaction
  const atomic = guarded.atomic();
  const validKey2 = ["acme_corp", "billing_app", "counters", "total_invoices"];
  atomic.set(validKey2, 1);
  const commit = await atomic.commit();
  assertEquals(commit.ok, true);

  const counterVal = await guarded.get(validKey2);
  assertEquals(counterVal, 1);

  // 5. Cross tenant attempts fail
  await assertRejects(
    () => guarded.get(crossTenantKey),
    PermissionDeniedError,
  );
  await assertRejects(
    () => guarded.set(crossTenantKey, { amount: 999999 }),
    PermissionDeniedError,
  );
  await assertRejects(
    () => guarded.list(["globex_corp", "secret_project"]),
    PermissionDeniedError,
  );

  // 6. Verify cross-tenant key does not exist in underlying database
  const directRead = await realDb.get(crossTenantKey);
  assertEquals(directRead, null);
});

Deno.test("Integration / PLAT-17: Guarded LocalFSProvider enforces tenant isolation in real filesystem", async () => {
  const tempDir = Deno.makeTempDirSync({ prefix: "railfog_guard_test_" });
  try {
    const realFS = new LocalFSProvider(tempDir);
    const tenant: TenantContext = {
      orgId: "tenant_alpha",
      projectId: "proj_docs",
    };
    const guarded = createGuardedObjectProvider(realFS, tenant);

    const validKey = "tenant_alpha/proj_docs/reports/annual.txt";
    const crossKey = "tenant_beta/proj_docs/reports/annual.txt";
    const traversalKey = "tenant_alpha/proj_docs/../../escape.txt";

    const content = new TextEncoder().encode("Annual Report 2026").buffer;

    // 1. Put valid object
    const putRes = await guarded.put(validKey, content);
    assert(putRes.etag);

    // 2. Head valid object
    const headRes = await guarded.head(validKey);
    assert(headRes);
    assertEquals(headRes.size, content.byteLength);

    // 3. Get valid object
    const stream = await guarded.get(validKey);
    assert(stream);
    const reader = stream.getReader();
    const { value: chunk } = await reader.read();
    assert(chunk);
    assertEquals(new TextDecoder().decode(chunk), "Annual Report 2026");

    // 4. List valid prefix
    const listRes = await guarded.list("tenant_alpha/proj_docs/");
    assertEquals(listRes.keys.length, 1);
    assertEquals(listRes.keys[0], validKey);

    // 5. Reject cross-tenant and path traversal
    await assertRejects(
      () => guarded.get(crossKey),
      PermissionDeniedError,
    );
    await assertRejects(
      () => guarded.put(crossKey, content),
      PermissionDeniedError,
    );
    await assertRejects(
      () => guarded.get(traversalKey),
      PermissionDeniedError,
    );

    // 6. Delete valid object
    await guarded.delete(validKey);
    const afterDelete = await guarded.head(validKey);
    assertEquals(afterDelete, null);
  } finally {
    try {
      Deno.removeSync(tempDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

Deno.test("Integration / PLAT-17: Guarded SQLiteQueueProvider enforces tenant isolation in real SQLite queue", async () => {
  const realQueue = new SQLiteQueueProvider(":memory:");
  const tenant: TenantContext = { orgId: "corp_x", projectId: "worker_y" };
  const validQueueName = "corp_x_worker_y_pipeline";
  const crossQueueName = "corp_z_worker_y_pipeline";

  const guarded = createGuardedQueueProvider(realQueue, tenant, validQueueName);

  // 1. Send & receive
  const { id } = await guarded.send({ task: "render_frame", frame: 42 });
  assert(id);

  const msg = await guarded.receive();
  assert(msg);
  assertEquals(msg.id, id);
  assertEquals(msg.body, { task: "render_frame", frame: 42 });

  await guarded.ack(id);
  const emptyMsg = await guarded.receive();
  assertEquals(emptyMsg, null);

  // 2. Attempting to bind cross-tenant queue fails
  assertThrows(
    () => createGuardedQueueProvider(realQueue, tenant, crossQueueName),
    PermissionDeniedError,
  );
});

// ============================================================================
// 7. Concurrency & Strict Isolation Tests (PLAT-7)
// ============================================================================

Deno.test("Concurrency / PLAT-7: Multiple tenant guards on shared backend maintain strict isolation under concurrent load", async () => {
  const sharedDb = new SQLiteKVProvider(":memory:");

  const tenantA: TenantContext = { orgId: "org_a", projectId: "proj_a" };
  const tenantB: TenantContext = { orgId: "org_b", projectId: "proj_b" };

  const guardA = createGuardedKVProvider(sharedDb, tenantA);
  const guardB = createGuardedKVProvider(sharedDb, tenantB);

  const CONCURRENCY = 20;

  // Run concurrent writes and reads from Tenant A and Tenant B simultaneously
  const taskA = async (idx: number) => {
    const key = ["org_a", "proj_a", "data", `record_${idx}`];
    await guardA.set(key, { tenant: "A", idx });
    const fetched = await guardA.get(key);
    assertEquals(fetched, { tenant: "A", idx });

    // Attempting to access Tenant B's key from guard A MUST throw PermissionDeniedError
    const crossKey = ["org_b", "proj_b", "data", `record_${idx}`];
    await assertRejects(
      () => guardA.get(crossKey),
      PermissionDeniedError,
    );
    await assertRejects(
      () => guardA.set(crossKey, { hacker: true }),
      PermissionDeniedError,
    );
  };

  const taskB = async (idx: number) => {
    const key = ["org_b", "proj_b", "data", `record_${idx}`];
    await guardB.set(key, { tenant: "B", idx });
    const fetched = await guardB.get(key);
    assertEquals(fetched, { tenant: "B", idx });

    // Attempting to access Tenant A's key from guard B MUST throw PermissionDeniedError
    const crossKey = ["org_a", "proj_a", "data", `record_${idx}`];
    await assertRejects(
      () => guardB.get(crossKey),
      PermissionDeniedError,
    );
    await assertRejects(
      () => guardB.set(crossKey, { hacker: true }),
      PermissionDeniedError,
    );
  };

  const promises: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    promises.push(taskA(i));
    promises.push(taskB(i));
  }

  await Promise.all(promises);

  // Verify list isolation: Tenant A lists only Tenant A keys
  const listA = await guardA.list(["org_a", "proj_a"]);
  assertEquals(listA.keys.length, CONCURRENCY);
  for (const item of listA.keys) {
    assertEquals(item.key[0], "org_a");
    assertEquals(item.key[1], "proj_a");
  }

  // Tenant B lists only Tenant B keys
  const listB = await guardB.list(["org_b", "proj_b"]);
  assertEquals(listB.keys.length, CONCURRENCY);
  for (const item of listB.keys) {
    assertEquals(item.key[0], "org_b");
    assertEquals(item.key[1], "proj_b");
  }
});

// ============================================================================
// 8. Adversarial Security Review Tests (PLAT-7, PLAT-12)
// ============================================================================

Deno.test("Security Adversarial / PLAT-7: KV Key TOCTOU Getter & Proxy Smuggling is blocked", async () => {
  const sharedDb = new SQLiteKVProvider(":memory:");
  const tenantA: TenantContext = { orgId: "org_a", projectId: "proj_a" };
  const guardA = createGuardedKVProvider(sharedDb, tenantA);

  // Pre-seed confidential data in Tenant B's namespace directly
  await sharedDb.set(
    ["org_b", "proj_b", "secrets", "apikey"],
    "CONFIDENTIAL_KEY_B",
  );

  // Attack Vector 1: Getter that returns valid tenant on validation, but switches to target tenant on storage call
  let getAccessCount = 0;
  const evilGetKey = ["org_a", "proj_a", "secrets", "apikey"];
  Object.defineProperty(evilGetKey, 0, {
    get() {
      getAccessCount++;
      return getAccessCount <= 2 ? "org_a" : "org_b";
    },
  });
  Object.defineProperty(evilGetKey, 1, {
    get() {
      return getAccessCount <= 2 ? "proj_a" : "proj_b";
    },
  });

  // Reading via guardA MUST NOT leak Tenant B's data
  const readVal = await guardA.get(evilGetKey);
  assertEquals(
    readVal,
    null,
    "Getter smuggling must not read Tenant B's confidential data",
  );

  // Attack Vector 2: Getter on set() attempt
  let setAccessCount = 0;
  const evilSetKey = ["org_a", "proj_a", "secrets", "apikey"];
  Object.defineProperty(evilSetKey, 0, {
    get() {
      setAccessCount++;
      return setAccessCount <= 2 ? "org_a" : "org_b";
    },
  });
  Object.defineProperty(evilSetKey, 1, {
    get() {
      return setAccessCount <= 2 ? "proj_a" : "proj_b";
    },
  });

  await guardA.set(evilSetKey, "OVERWRITTEN_BY_A");
  // Tenant B's key must remain untouched
  const tenantBDirect = await sharedDb.get([
    "org_b",
    "proj_b",
    "secrets",
    "apikey",
  ]);
  assertEquals(
    tenantBDirect,
    "CONFIDENTIAL_KEY_B",
    "Getter smuggling must not overwrite Tenant B's data",
  );

  // Attack Vector 3: Getter on delete() attempt
  let delAccessCount = 0;
  const evilDelKey = ["org_a", "proj_a", "secrets", "apikey"];
  Object.defineProperty(evilDelKey, 0, {
    get() {
      delAccessCount++;
      return delAccessCount <= 2 ? "org_a" : "org_b";
    },
  });
  Object.defineProperty(evilDelKey, 1, {
    get() {
      return delAccessCount <= 2 ? "proj_a" : "proj_b";
    },
  });

  await guardA.delete(evilDelKey);
  const tenantBAfterDel = await sharedDb.get([
    "org_b",
    "proj_b",
    "secrets",
    "apikey",
  ]);
  assertEquals(
    tenantBAfterDel,
    "CONFIDENTIAL_KEY_B",
    "Getter smuggling must not delete Tenant B's data",
  );

  // Attack Vector 4: Getter on list() prefix
  let listAccessCount = 0;
  const evilListPrefix = ["org_a", "proj_a"];
  Object.defineProperty(evilListPrefix, 0, {
    get() {
      listAccessCount++;
      return listAccessCount <= 2 ? "org_a" : "org_b";
    },
  });
  Object.defineProperty(evilListPrefix, 1, {
    get() {
      return listAccessCount <= 2 ? "proj_a" : "proj_b";
    },
  });

  const listRes = await guardA.list(evilListPrefix);
  // Must only contain Tenant A items, never Tenant B's items
  for (const item of listRes.keys) {
    assertEquals(item.key[0], "org_a");
    assertEquals(item.key[1], "proj_a");
  }
});

Deno.test("Security Adversarial / PLAT-7: KV Atomic Post-Validation Array Reference Mutation is blocked", async () => {
  const sharedDb = new SQLiteKVProvider(":memory:");
  const tenantA: TenantContext = { orgId: "org_a", projectId: "proj_a" };
  const guardA = createGuardedKVProvider(sharedDb, tenantA);

  // Pre-seed confidential data in Tenant B's namespace directly
  await sharedDb.set(["org_b", "proj_b", "ledger", "balance"], 5000);

  // Attack: Create atomic transaction, pass valid key, then mutate array reference before commit()
  const atomic = guardA.atomic();
  const mutableKey = ["org_a", "proj_a", "ledger", "balance"];

  atomic.set(mutableKey, 999999);

  // Malicious caller mutates the array reference after set() registration but before commit()
  mutableKey[0] = "org_b";
  mutableKey[1] = "proj_b";

  await atomic.commit();

  // Tenant B's ledger balance MUST NOT have changed
  const balanceB = await sharedDb.get(["org_b", "proj_b", "ledger", "balance"]);
  assertEquals(
    balanceB,
    5000,
    "Post-validation array mutation must not affect Tenant B's data",
  );

  // Instead, the write must have safely landed in Tenant A's namespace
  const balanceA = await guardA.get(["org_a", "proj_a", "ledger", "balance"]);
  assertEquals(balanceA, 999999, "Write was safely isolated to Tenant A");
});

Deno.test("Security Adversarial / PLAT-7: TenantContext reference mutation attack is blocked across all providers", async () => {
  const realKV = new SQLiteKVProvider(":memory:");
  const tempDir = Deno.makeTempDirSync({
    prefix: "railfog_tenant_mutation_test_",
  });
  const realFS = new LocalFSProvider(tempDir);
  const realQueue = new SQLiteQueueProvider(":memory:");

  try {
    const tenantRef: TenantContext = {
      orgId: "victim_org",
      projectId: "victim_proj",
    };

    const guardedKV = createGuardedKVProvider(realKV, tenantRef);
    const guardedFS = createGuardedObjectProvider(realFS, tenantRef);
    const guardedQueue = createGuardedQueueProvider(
      realQueue,
      tenantRef,
      "victim_org_victim_proj_q",
    );

    // Attacker mutates the tenant object reference that was passed during guard instantiation
    tenantRef.orgId = "attacker_org";
    tenantRef.projectId = "attacker_proj";

    // 1. KV: Attempting to access attacker_org via guardedKV MUST still be rejected as cross-tenant
    await assertRejects(
      () => guardedKV.get(["attacker_org", "attacker_proj", "secret"]),
      PermissionDeniedError,
      undefined,
      "KV guard must not follow mutated tenant context reference",
    );

    // 2. Objects: Attempting to put/get attacker_org object MUST be rejected
    await assertRejects(
      () =>
        guardedFS.put(
          "attacker_org/attacker_proj/doc.txt",
          new Uint8Array([1]).buffer,
        ),
      PermissionDeniedError,
      undefined,
      "Object guard must not follow mutated tenant context reference",
    );
    await assertRejects(
      () => guardedFS.get("attacker_org/attacker_proj/doc.txt"),
      PermissionDeniedError,
      undefined,
      "Object guard must not follow mutated tenant context reference",
    );

    // 3. Queues: Attempting to send to a tampered queue name MUST be rejected
    const queueAttacker = new MockQueueProvider("attacker_org_attacker_proj_q");
    const guardedQueueAttacker = createGuardedQueueProvider(
      queueAttacker,
      tenantRef,
      "attacker_org_attacker_proj_q",
    );
    // tenantRef is now attacker_org, but createGuardedQueueProvider normalizes it
    assertEquals(guardedQueueAttacker !== null, true);

    // The original guardedQueue must still enforce victim_org
    const resSend = await guardedQueue.send({ job: "test" });
    assert(resSend.id);
  } finally {
    try {
      Deno.removeSync(tempDir, { recursive: true });
    } catch {
      // ignore cleanup
    }
  }
});

Deno.test("Security Adversarial / PLAT-7 / PLAT-12: Tenant identifiers with untrimmed whitespace are rejected", () => {
  const kv = new MockKVProvider();
  const untrimmedContexts: TenantContext[] = [
    { orgId: " org_1", projectId: "proj_1" },
    { orgId: "org_1 ", projectId: "proj_1" },
    { orgId: "org_1", projectId: " proj_1" },
    { orgId: "org_1", projectId: "proj_1 " },
  ];

  for (const ctx of untrimmedContexts) {
    const err = assertThrows(
      () => createGuardedKVProvider(kv, ctx),
      ValidationFailedError,
    );
    assertEquals(err.code, "VALIDATION_FAILED");
  }
});
