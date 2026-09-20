/**
 * Real Developer Simulation End-to-End Test Suite.
 *
 * Simulates a real developer building realistic, multi-tenant applications on RailFog.
 * Exhaustively exercises all primitives and developer experience components:
 * 1. Full HTTP function handling with handle(), plain objects auto-JSON serialization, status codes, custom headers.
 * 2. Micro-routing with api() for multi-method routing (GET /api/users, POST /api/users, GET /api/users/:id, PUT, DELETE).
 * 3. Chunked response streaming with c.stream() and Server-Sent Events with c.sse().
 * 4. Hierarchical KV keys, atomic CAS transactions, expiration/TTL deduplication, and prefix listing.
 * 5. Object storage streaming upload, download, and presigning with HMAC verification.
 * 6. Queue publishing, receiving, and idempotent worker execution with withIdempotency().
 * 7. Full RPC client (createRpcClient()) consuming endpoints and validating PLAT-12 error normalization.
 * 8. Embedded local dev dashboard API endpoints (/__railfog/api/info and /__railfog/api/kv).
 * 9. Comprehensive real-world developer workflow integrating all primitives into a complete application.
 *
 * Spec references:
 * - contracts/functions.contract.md#FN-1 — Function definition and ergonomic HTTP handler wrapper
 * - contracts/functions.contract.md#FN-2 — Trigger declarations (HTTP, Queue)
 * - contracts/functions.contract.md#FN-4 — RailFogContext structure and capability bindings
 * - contracts/functions.contract.md#FN-6 — Invocation isolation and context injection
 * - contracts/functions.contract.md#FN-8 — Request lifecycle and error normalization
 * - contracts/platform.contract.md#PLAT-7 — Tenant scoping and physical prefixing
 * - contracts/platform.contract.md#PLAT-11 — Routing specificity scoring algorithm
 * - contracts/platform.contract.md#PLAT-12 — Canonical error taxonomy and request_id propagation
 * - contracts/platform.contract.md#PLAT-14 — ULID identifier format (128-bit Crockford Base32)
 * - contracts/platform.contract.md#PLAT-16 — Backing service provider abstraction
 * - contracts/platform.contract.md#PLAT-17 — Local development parity with SQLite and LocalFS
 * - contracts/platform.contract.md#PLAT-19 — Repository structure, developer experience, and dashboard
 * - contracts/kv.contract.md#KV-2 — KV binding API, hierarchical keys, and mandatory TTL
 * - contracts/kv.contract.md#KV-3 — Optimistic concurrency CAS conflict error normalization
 * - contracts/kv.contract.md#KV-4 — Key model and segment limits
 * - contracts/objects.contract.md#OBJ-2 — Object binding API shape and streaming transfer
 * - contracts/objects.contract.md#OBJ-3 — Presigned direct storage transfer
 * - contracts/objects.contract.md#OBJ-4 — Content addressing and SHA-256 ETag format
 * - contracts/queues.contract.md#Q-1 — Queue delivery guarantees (at-least-once)
 * - contracts/queues.contract.md#Q-2 — Queue message payload and API
 * - contracts/queues.contract.md#Q-3 — Visibility timeout and worker retry model
 * - contracts/queues.contract.md#Q-4 — Idempotency helper (withIdempotency) with mandatory TTL
 * - contracts/queues.contract.md#Q-6 — Composed reliability patterns as library code over KV
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { join } from "@std/path";

// SDK exports
import {
  api,
  createRpcClient,
  handle,
  type RpcClient,
  withIdempotency,
} from "../../sdk/typescript/mod.ts";

import type {
  EnvBinding,
  KVAtomicOperation,
  KVBinding,
  ListOptions,
  ObjectBinding,
  QueueBinding,
  RailFogContext,
} from "../../sdk/typescript/types.ts";

// Canonical PLAT-12 Error classes
import {
  ConflictError,
  InternalError,
  ResourceNotFoundError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

// Identifiers and Providers
import { generateUlid, isValidUlid } from "../../packages/core/id/ulid.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";
import type { QueueMessage } from "../../primitives/queues/queue-provider.ts";
import { QueueConsumerWorker } from "../../apps/worker/queue-consumer.ts";

// Dev server
import {
  type LocalServer,
  startLocalServer,
} from "../../runtime/dev-server/local-server.ts";

// =============================================================================
// Direct Storage Server Helper for Presigned Uploads/Downloads (OBJ-3)
// =============================================================================

class DirectStorageLocalFSProvider extends LocalFSProvider {
  private directPort = 0;

  setDirectPort(port: number) {
    this.directPort = port;
  }

  override async presign(
    key: string,
    opts: { method: "GET" | "PUT"; expiresIn?: number; maxExpiresIn?: number },
  ) {
    const res = await super.presign(key, opts);
    if (this.directPort > 0) {
      res.url = res.url.replace(
        "http://localhost/",
        `http://localhost:${this.directPort}/`,
      );
    }
    return res;
  }
}

function startDirectStorageServer(provider: DirectStorageLocalFSProvider): {
  port: number;
  close: () => Promise<void>;
} {
  const server = Deno.serve({ port: 0 }, async (req: Request) => {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/local-fs/")) {
      const rawKey = url.pathname.replace(/^\/local-fs\//, "");
      const key = decodeURIComponent(rawKey);

      const valid = await provider.verifyPresignedUrl(
        req.url,
        req.method as "GET" | "PUT",
      );
      if (!valid) {
        return new Response("Unauthorized presigned token", { status: 403 });
      }

      if (req.method === "PUT") {
        const body = await req.arrayBuffer();
        await provider.put(key, body);
        return new Response(null, { status: 200 });
      }

      if (req.method === "GET") {
        const stream = await provider.get(key);
        if (!stream) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  });

  const port = (server.addr as Deno.NetAddr).port;
  provider.setDirectPort(port);

  return {
    port,
    close: () => server.shutdown(),
  };
}

// =============================================================================
// Helper: Adapt SQLiteKVProvider to SDK KVBinding interface
// =============================================================================

function adaptKVProvider(provider: SQLiteKVProvider): KVBinding {
  return {
    get: async <T = unknown>(key: string[]): Promise<T | null> => {
      const val = await provider.get(key);
      return (val as T) ?? null;
    },
    set: (key: string[], value: unknown, opts?: { ttl?: number }) =>
      provider.set(key, value, opts),
    delete: (key: string[]) => provider.delete(key),
    list: async <T = unknown>(
      prefix: string[],
      opts?: ListOptions,
    ): Promise<{
      entries: Array<{ key: string[]; value: T; version: number }>;
      cursor?: string;
    }> => {
      const res = await provider.list(prefix, opts);
      return {
        entries: res.keys.map((k) => ({
          key: k.key,
          value: k.value as T,
          version: 1,
        })),
        cursor: res.cursor,
      };
    },
    atomic: (): KVAtomicOperation => {
      const atm = provider.atomic();
      const op: KVAtomicOperation = {
        check(key: string[], expectedVersion: number): KVAtomicOperation {
          atm.check(key, expectedVersion);
          return op;
        },
        set(
          key: string[],
          value: unknown,
          _opts?: { ttl?: number },
        ): KVAtomicOperation {
          atm.set(key, value);
          return op;
        },
        delete(key: string[]): KVAtomicOperation {
          atm.delete(key);
          return op;
        },
        commit: () => atm.commit(),
      };
      return op;
    },
  };
}

// =============================================================================
// Test Fixture Context Builder
// =============================================================================

function createMockContext(
  overrides?: Partial<RailFogContext>,
): RailFogContext {
  const deadline = Date.now() + 30000;
  const requestId = generateUlid();

  const mockKv: KVBinding = {
    get: <T = unknown>(_key: string[]): Promise<T | null> =>
      Promise.resolve(null),
    set: (_key, _value, _opts) => Promise.resolve(),
    delete: (_key) => Promise.resolve(),
    list: <T = unknown>(_prefix: string[]) =>
      Promise.resolve({
        entries: [] as Array<{ key: string[]; value: T; version: number }>,
      }),
    atomic: () => ({
      check: function () {
        return this;
      },
      set: function () {
        return this;
      },
      delete: function () {
        return this;
      },
      commit: () => Promise.resolve({ ok: true, version: 1 }),
    } as unknown as KVAtomicOperation),
  };

  const mockObjects: ObjectBinding = {
    put: () => Promise.resolve(),
    get: () => Promise.resolve(null),
    delete: () => Promise.resolve(),
    head: () => Promise.resolve(null),
    list: () => Promise.resolve({ keys: [] }),
    createMultipartUpload: () =>
      Promise.resolve({ uploadId: "mock-upload-id" }),
    presign: (key: string) =>
      Promise.resolve({
        url: `http://localhost/local-fs/${key}?token=mock`,
        headers: {},
      }),
  };

  const mockQueues: QueueBinding = {
    send: () => Promise.resolve({ id: generateUlid() }),
    sendBatch: (messages) =>
      Promise.resolve(messages.map(() => ({ id: generateUlid() }))),
  };

  const mockEnv: EnvBinding = {
    get: (_k: string) => undefined,
    require: (k: string) => {
      throw new Error(`Missing required secret: ${k}`);
    },
  };

  return {
    requestId,
    project: "simulation-project",
    function: "simulation-fn",
    revision: "local-rev",
    deadline,
    timeRemaining: () => Math.max(0, deadline - Date.now()),
    kv: overrides?.kv ?? mockKv,
    objects: overrides?.objects ?? mockObjects,
    queues: overrides?.queues ?? mockQueues,
    env: overrides?.env ?? mockEnv,
    ...overrides,
  };
}

// =============================================================================
// SCENARIO 1: Full HTTP Function Handling with handle()
// =============================================================================

Deno.test("RealDevSimulation - Scenario 1: Full HTTP function handling with handle()", async (t) => {
  // 1a: Plain object return with auto-JSON serialization (FN-1)
  await t.step(
    "1a: Plain object returns auto-serialize to JSON with 200 OK",
    async () => {
      const fn = handle((_c) => {
        return {
          status: "healthy",
          uptime_seconds: 1420,
          meta: { region: "us-east", active: true },
        };
      });

      const ctx = createMockContext();
      const req = new Request("http://localhost/health");
      const res = await fn(req, ctx);

      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "application/json");

      const data = await res.json();
      assertEquals(data, {
        status: "healthy",
        uptime_seconds: 1420,
        meta: { region: "us-east", active: true },
      });
    },
  );

  // 1b: Explicit Response with custom status codes and headers (FN-1)
  await t.step(
    "1b: Explicit Response passes through custom status codes and headers",
    async () => {
      const fn = handle((_c) => {
        return new Response(
          JSON.stringify({ created: true, id: "item_98765" }),
          {
            status: 201,
            headers: {
              "content-type": "application/json",
              "x-tenant-tier": "enterprise",
              "x-custom-audit": "audit_trace_xyz",
            },
          },
        );
      });

      const ctx = createMockContext();
      const req = new Request("http://localhost/items", { method: "POST" });
      const res = await fn(req, ctx);

      assertEquals(res.status, 201);
      assertEquals(res.headers.get("x-tenant-tier"), "enterprise");
      assertEquals(res.headers.get("x-custom-audit"), "audit_trace_xyz");

      const data = await res.json();
      assertEquals(data.created, true);
      assertEquals(data.id, "item_98765");
    },
  );

  // 1c: Empty/void returns yield 204 No Content
  await t.step(
    "1c: Empty or void handler returns yield 204 No Content with null body",
    async () => {
      const fn = handle((_c) => {
        // Intentional void return (e.g. fire-and-forget or acknowledge)
        return;
      });

      const ctx = createMockContext();
      const req = new Request("http://localhost/ack", { method: "POST" });
      const res = await fn(req, ctx);

      assertEquals(res.status, 204);
      const body = await res.text();
      assertEquals(body, "");
    },
  );

  // 1d: Response helpers: c.json() and c.text()
  await t.step(
    "1d: Response helpers c.json() and c.text() construct valid responses",
    async () => {
      const jsonFn = handle((c) => c.json({ accepted: true }, 202));
      const textFn = handle((c) => c.text("Job queued successfully", 200));

      const ctx = createMockContext();
      const jsonRes = await jsonFn(new Request("http://localhost/async"), ctx);
      assertEquals(jsonRes.status, 202);
      assertEquals(jsonRes.headers.get("content-type"), "application/json");
      assertEquals(await jsonRes.json(), { accepted: true });

      const textRes = await textFn(new Request("http://localhost/txt"), ctx);
      assertEquals(textRes.status, 200);
      assertEquals(
        textRes.headers.get("content-type"),
        "text/plain; charset=utf-8",
      );
      assertEquals(await textRes.text(), "Job queued successfully");
    },
  );

  // 1e: Error normalization: typed RailFogError and untyped Error (PLAT-12)
  await t.step(
    "1e: Thrown errors normalize to canonical PLAT-12 HTTP responses",
    async () => {
      const valErrFn = handle((c) => {
        throw new ValidationFailedError("Invalid email format", c.requestId);
      });
      const conflictErrFn = handle((c) => {
        throw new ConflictError("Resource version mismatch", c.requestId);
      });
      const unhandledErrFn = handle((_c) => {
        throw new Error("Unexpected database socket termination");
      });

      const ctx = createMockContext();

      // Validation error -> 400
      const valRes = await valErrFn(new Request("http://localhost/test"), ctx);
      assertEquals(valRes.status, 400);
      assertEquals(valRes.headers.get("content-type"), "application/json");
      assertEquals(valRes.headers.get("x-request-id"), ctx.requestId);
      const valBody = await valRes.json();
      assertEquals(valBody.error.code, "VALIDATION_FAILED");
      assertEquals(valBody.error.message, "Invalid email format");
      assertEquals(valBody.error.request_id, ctx.requestId);

      // Conflict error -> 409
      const confRes = await conflictErrFn(
        new Request("http://localhost/test"),
        ctx,
      );
      assertEquals(confRes.status, 409);
      const confBody = await confRes.json();
      assertEquals(confBody.error.code, "CONFLICT");

      // Unhandled generic error -> 500 INTERNAL
      const unhandledRes = await unhandledErrFn(
        new Request("http://localhost/test"),
        ctx,
      );
      assertEquals(unhandledRes.status, 500);
      const unhandledBody = await unhandledRes.json();
      assertEquals(unhandledBody.error.code, "INTERNAL");
      assertEquals(
        unhandledBody.error.message,
        "Unexpected database socket termination",
      );
    },
  );
});

// =============================================================================
// SCENARIO 2: Micro-routing with api() for Multi-Method Routing
// =============================================================================

Deno.test("RealDevSimulation - Scenario 2: Micro-routing with api() for multi-method routing", async (t) => {
  // In-memory backing store for users
  const userDatabase = new Map<
    string,
    { id: string; name: string; email: string; role: string }
  >();
  userDatabase.set("usr_1", {
    id: "usr_1",
    name: "Ada Lovelace",
    email: "ada@analytical.org",
    role: "admin",
  });
  userDatabase.set("usr_2", {
    id: "usr_2",
    name: "Charles Babbage",
    email: "charles@difference.org",
    role: "member",
  });

  const appRouter = api({
    // List users
    "GET /api/users": (_c) => {
      return { users: Array.from(userDatabase.values()) };
    },

    // Specific literal route (PLAT-11 Specificity testing)
    "GET /api/users/me": (_c) => {
      return { id: "usr_current", name: "Authenticated Dev", role: "owner" };
    },

    // Get user by ID (parameterized route)
    "GET /api/users/:id": (c) => {
      const id = c.params?.id;
      if (!id) throw new ValidationFailedError("Missing user id", c.requestId);
      const user = userDatabase.get(id);
      if (!user) {
        throw new ResourceNotFoundError(`User '${id}' not found`, c.requestId);
      }
      return user;
    },

    // Create user
    "POST /api/users": async (c) => {
      const body = await c.body<
        { name?: string; email?: string; role?: string }
      >();
      if (!body.name || body.name.trim() === "") {
        throw new ValidationFailedError("Name is required", c.requestId);
      }
      if (!body.email || !body.email.includes("@")) {
        throw new ValidationFailedError("Valid email is required", c.requestId);
      }
      const id = "usr_" + generateUlid().toLowerCase().slice(0, 8);
      const newUser = {
        id,
        name: body.name,
        email: body.email,
        role: body.role ?? "member",
      };
      userDatabase.set(id, newUser);
      return new Response(JSON.stringify(newUser), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },

    // Update user
    "PUT /api/users/:id": async (c) => {
      const id = c.params?.id;
      if (!id) throw new ValidationFailedError("Missing user id", c.requestId);
      const user = userDatabase.get(id);
      if (!user) {
        throw new ResourceNotFoundError(`User '${id}' not found`, c.requestId);
      }
      const body = await c.body<
        { name?: string; email?: string; role?: string }
      >();
      const updated = {
        ...user,
        name: body.name ?? user.name,
        email: body.email ?? user.email,
        role: body.role ?? user.role,
      };
      userDatabase.set(id, updated);
      return updated;
    },

    // Delete user
    "DELETE /api/users/:id": (c) => {
      const id = c.params?.id;
      if (!id) throw new ValidationFailedError("Missing user id", c.requestId);
      const user = userDatabase.get(id);
      if (!user) {
        throw new ResourceNotFoundError(`User '${id}' not found`, c.requestId);
      }
      userDatabase.delete(id);
      return { deleted: true, id };
    },
  });

  const ctx = createMockContext();

  // 2a: GET /api/users
  await t.step("2a: GET /api/users retrieves all users", async () => {
    const req = new Request("http://localhost/api/users", { method: "GET" });
    const res = await appRouter(req, ctx);
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.users.length >= 2, true);
    assertEquals(data.users[0].name, "Ada Lovelace");
  });

  // 2b: POST /api/users
  let createdId = "";
  await t.step(
    "2b: POST /api/users creates a user with validation and 201 status",
    async () => {
      const req = new Request("http://localhost/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Alan Turing",
          email: "alan@bletchley.org",
          role: "admin",
        }),
      });
      const res = await appRouter(req, ctx);
      assertEquals(res.status, 201);
      const data = await res.json();
      assertEquals(data.name, "Alan Turing");
      assertEquals(data.email, "alan@bletchley.org");
      assert(data.id.startsWith("usr_"));
      createdId = data.id;
    },
  );

  // 2c: GET /api/users/:id
  await t.step(
    "2c: GET /api/users/:id extracts c.params.id and retrieves user",
    async () => {
      const req = new Request(`http://localhost/api/users/${createdId}`);
      const res = await appRouter(req, ctx);
      assertEquals(res.status, 200);
      const data = await res.json();
      assertEquals(data.id, createdId);
      assertEquals(data.name, "Alan Turing");
    },
  );

  // 2d: PUT /api/users/:id
  await t.step("2d: PUT /api/users/:id updates user record", async () => {
    const req = new Request(`http://localhost/api/users/${createdId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "fellow" }),
    });
    const res = await appRouter(req, ctx);
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.role, "fellow");
    assertEquals(data.name, "Alan Turing");
  });

  // 2e: DELETE /api/users/:id
  await t.step("2e: DELETE /api/users/:id deletes user record", async () => {
    const req = new Request(`http://localhost/api/users/${createdId}`, {
      method: "DELETE",
    });
    const res = await appRouter(req, ctx);
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.deleted, true);
    assertEquals(data.id, createdId);

    // Verify subsequent GET returns 404
    const getRes = await appRouter(
      new Request(`http://localhost/api/users/${createdId}`),
      ctx,
    );
    assertEquals(getRes.status, 404);
  });

  // 2f: PLAT-11 Specificity scoring: literal GET /api/users/me beats parameterized GET /api/users/:id
  await t.step(
    "2f: PLAT-11 Routing specificity: literal /api/users/me wins over /api/users/:id",
    async () => {
      const req = new Request("http://localhost/api/users/me");
      const res = await appRouter(req, ctx);
      assertEquals(res.status, 200);
      const data = await res.json();
      assertEquals(data.id, "usr_current");
      assertEquals(data.name, "Authenticated Dev");
      assertEquals(data.role, "owner");
    },
  );

  // 2g: Unmatched route yields 404 RESOURCE_NOT_FOUND (PLAT-12)
  await t.step(
    "2g: Unmatched route returns canonical 404 RESOURCE_NOT_FOUND",
    async () => {
      const req = new Request("http://localhost/api/unknown-endpoint");
      const res = await appRouter(req, ctx);
      assertEquals(res.status, 404);
      const data = await res.json();
      assertEquals(data.error.code, "RESOURCE_NOT_FOUND");
      assert(data.error.message.includes("No route matched"));
    },
  );
});

// =============================================================================
// SCENARIO 3: Chunked Response Streaming and Server-Sent Events (SSE)
// =============================================================================

Deno.test("RealDevSimulation - Scenario 3: Chunked response streaming with c.stream() and Server-Sent Events with c.sse()", async (t) => {
  // 3a: c.stream() chunked byte stream
  await t.step(
    "3a: c.stream() emits sequential chunks without buffering entire payload",
    async () => {
      const streamFn = handle((c) => {
        return c.stream(async (writer) => {
          await writer.write("timestamp,metric,value\n");
          await writer.write("2026-09-20T20:00:00Z,cpu_util,42.5\n");
          await writer.write("2026-09-20T20:01:00Z,cpu_util,48.1\n");
          await writer.write("2026-09-20T20:02:00Z,cpu_util,39.9\n");
          await writer.close();
        }, {
          headers: { "content-type": "text/csv; charset=utf-8" },
        });
      });

      const ctx = createMockContext();
      const req = new Request("http://localhost/export/metrics.csv");
      const res = await streamFn(req, ctx);

      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "text/csv; charset=utf-8");

      // Read chunks via ReadableStream reader
      assert(res.body !== null);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let chunkCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        chunkCount++;
      }

      assert(chunkCount >= 1, "Must receive one or more streaming chunks");
      assert(accumulated.includes("timestamp,metric,value\n"));
      assert(accumulated.includes("cpu_util,42.5\n"));
      assert(accumulated.includes("cpu_util,39.9\n"));
    },
  );

  // 3b: c.sse() Server-Sent Events
  await t.step(
    "3b: c.sse() emits formatted text/event-stream events",
    async () => {
      const sseFn = handle((c) => {
        return c.sse(async (sse) => {
          await sse.send({
            id: "evt_1",
            event: "pipeline_start",
            data: { stage: "build", progress: 0 },
          });
          await sse.send({
            id: "evt_2",
            event: "pipeline_progress",
            data: { stage: "test", progress: 50 },
          });
          await sse.send({
            id: "evt_3",
            event: "pipeline_complete",
            data: { stage: "deploy", progress: 100 },
          });
          await sse.close();
        });
      });

      const ctx = createMockContext();
      const req = new Request("http://localhost/events/deploy");
      const res = await sseFn(req, ctx);

      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "text/event-stream");
      assertEquals(res.headers.get("cache-control"), "no-cache");
      assertEquals(res.headers.get("connection"), "keep-alive");

      const bodyText = await res.text();
      assert(bodyText.includes("id: evt_1\n"));
      assert(bodyText.includes("event: pipeline_start\n"));
      assert(bodyText.includes('data: {"stage":"build","progress":0}\n\n'));

      assert(bodyText.includes("id: evt_2\n"));
      assert(bodyText.includes("event: pipeline_progress\n"));
      assert(bodyText.includes('data: {"stage":"test","progress":50}\n\n'));

      assert(bodyText.includes("id: evt_3\n"));
      assert(bodyText.includes("event: pipeline_complete\n"));
      assert(bodyText.includes('data: {"stage":"deploy","progress":100}\n\n'));
    },
  );
});

// =============================================================================
// SCENARIO 4: Hierarchical KV Keys, CAS Transactions, TTL, and Prefix Listing
// =============================================================================

Deno.test("RealDevSimulation - Scenario 4: Hierarchical KV keys, atomic CAS, TTL deduplication, and prefix listing", async (t) => {
  const kvProvider = new SQLiteKVProvider(":memory:");

  try {
    // 4a: Multi-segment hierarchical keys (KV-4)
    await t.step(
      "4a: Multi-segment hierarchical keys store and retrieve deep records",
      async () => {
        const keyOrg1User1 = ["tenants", "org_alpha", "users", "usr_001"];
        const keyOrg1User2 = ["tenants", "org_alpha", "users", "usr_002"];
        const keyOrg2User1 = ["tenants", "org_beta", "users", "usr_003"];

        await kvProvider.set(keyOrg1User1, { name: "Alpha Leader", score: 95 });
        await kvProvider.set(keyOrg1User2, { name: "Alpha Scout", score: 80 });
        await kvProvider.set(keyOrg2User1, {
          name: "Beta Commander",
          score: 88,
        });

        const fetched = await kvProvider.get(keyOrg1User1);
        assertEquals(fetched, { name: "Alpha Leader", score: 95 });
      },
    );

    // 4b: Prefix listing and tenant isolation (KV-2, PLAT-7)
    await t.step(
      "4b: Prefix listing filters hierarchical keys with tenant isolation",
      async () => {
        const alphaPrefix = ["tenants", "org_alpha", "users"];
        const listRes = await kvProvider.list(alphaPrefix);

        assertEquals(listRes.keys.length, 2);
        const userNames = listRes.keys.map((k) =>
          (k.value as { name: string }).name
        );
        assert(userNames.includes("Alpha Leader"));
        assert(userNames.includes("Alpha Scout"));
        assertFalse(userNames.includes("Beta Commander"));
      },
    );

    // 4c: Pagination with limits and cursors (KV-2)
    await t.step(
      "4c: Prefix listing supports limit pagination and cursor continuation",
      async () => {
        const alphaPrefix = ["tenants", "org_alpha", "users"];
        const page1 = await kvProvider.list(alphaPrefix, { limit: 1 });

        assertEquals(page1.keys.length, 1);
        assert(page1.cursor !== undefined, "Page 1 must have a next cursor");

        const page2 = await kvProvider.list(alphaPrefix, {
          limit: 1,
          cursor: page1.cursor,
        });
        assertEquals(page2.keys.length, 1);
        assertNotEquals(page1.keys[0].key, page2.keys[0].key);
      },
    );

    // 4d: Atomic CAS transactions: version checks and concurrency collisions (KV-3)
    await t.step(
      "4d: Atomic CAS transactions commit on version match and reject on stale version",
      async () => {
        const casKey = ["inventory", "warehouse_1", "product_sku_100"];

        // 1. Check version 0 (non-existent) and initialize
        const initTx = await kvProvider.atomic()
          .check(casKey, 0)
          .set(casKey, { stock: 50, reserved: 0 })
          .commit();
        assertEquals(
          initTx.ok,
          true,
          "Initial creation CAS check(0) must succeed",
        );
        assertEquals(initTx.version, 1);

        // 2. Client A updates from version 1 to 2
        const updateTxA = await kvProvider.atomic()
          .check(casKey, 1)
          .set(casKey, { stock: 45, reserved: 5 })
          .commit();
        assertEquals(updateTxA.ok, true, "Valid CAS check(1) must succeed");
        assertEquals(updateTxA.version, 2);

        // 3. Client B attempts stale update with check(1) — must fail
        const updateTxB = await kvProvider.atomic()
          .check(casKey, 1)
          .set(casKey, { stock: 40, reserved: 10 })
          .commit();
        assertEquals(
          updateTxB.ok,
          false,
          "Stale CAS check(1) when version is 2 must reject with ok: false (KV-3)",
        );

        // Current value remains Client A's update
        const currentVal = await kvProvider.get(casKey);
        assertEquals(currentVal, { stock: 45, reserved: 5 });
      },
    );

    // 4e: Expiration / TTL deduplication (KV-2)
    await t.step(
      "4e: TTL expiration removes entries and resets CAS version to 0",
      async () => {
        const ttlKey = ["cache", "session_tokens", "tok_quick_expire"];
        await kvProvider.set(ttlKey, { active: true }, { ttl: 1 });

        const immediateRead = await kvProvider.get(ttlKey);
        assertEquals(immediateRead, { active: true });

        // Wait 1.1s for TTL expiration
        await new Promise((resolve) => setTimeout(resolve, 1100));

        const expiredRead = await kvProvider.get(ttlKey);
        assertEquals(
          expiredRead,
          null,
          "Expired TTL key must return null on retrieval (KV-2)",
        );

        // CAS transaction on expired key treats version as 0
        const reviveTx = await kvProvider.atomic()
          .check(ttlKey, 0)
          .set(ttlKey, { active: true, revived: true })
          .commit();
        assertEquals(
          reviveTx.ok,
          true,
          "CAS on expired key treats current version as 0 (KV-3)",
        );
      },
    );
  } finally {
    kvProvider.close();
  }
});

// =============================================================================
// SCENARIO 5: Object Storage Streaming Upload, Download, and Presigning
// =============================================================================

Deno.test("RealDevSimulation - Scenario 5: Object storage streaming upload and presigning", async (t) => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-test-objects-" });
  const objectProvider = new DirectStorageLocalFSProvider(tempDir);
  const directServer = startDirectStorageServer(objectProvider);

  try {
    const objectKey = "documents/reports/q3_annual_summary.pdf";
    const sampleText =
      "RailFog Cloud Platform — High Reliability Enterprise Q3 Summary Data Chunks.";
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(sampleText);

    // 5a: Streaming upload with ReadableStream (OBJ-2)
    let uploadedEtag = "";
    await t.step(
      "5a: Streaming upload writes ReadableStream chunks directly to storage",
      async () => {
        // Chunk payload into 3 slices
        const chunkSize = Math.ceil(dataBytes.length / 3);
        const chunk1 = dataBytes.slice(0, chunkSize);
        const chunk2 = dataBytes.slice(chunkSize, chunkSize * 2);
        const chunk3 = dataBytes.slice(chunkSize * 2);

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk1);
            controller.enqueue(chunk2);
            controller.enqueue(chunk3);
            controller.close();
          },
        });

        const res = await objectProvider.put(objectKey, stream);
        assert(
          /^[0-9a-f]{64}$/.test(res.etag),
          "Object put must return 64-character SHA-256 hex ETag (OBJ-4)",
        );
        uploadedEtag = res.etag;
      },
    );

    // 5b: Head metadata inspection (OBJ-2)
    await t.step(
      "5b: Head metadata inspects size and matching content-addressed ETag",
      async () => {
        const headRes = await objectProvider.head(objectKey);
        assert(headRes !== null);
        assertEquals(headRes.size, dataBytes.length);
        assertEquals(headRes.etag, uploadedEtag);
      },
    );

    // 5c: Streaming download (OBJ-2)
    await t.step(
      "5c: Streaming download reads object chunks byte-for-byte identical to source",
      async () => {
        const readStream = await objectProvider.get(objectKey);
        assert(readStream !== null);

        const reader = readStream.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }

        const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        const assembled = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
          assembled.set(chunk, offset);
          offset += chunk.length;
        }

        const readText = new TextDecoder().decode(assembled);
        assertEquals(readText, sampleText);
      },
    );

    // 5d: Presigning: Direct client upload and download via signed URL (OBJ-3)
    await t.step(
      "5d: Direct client-to-storage presigned URLs verify HMAC integrity and HTTP methods",
      async () => {
        const directKey = "uploads/direct/incoming_dataset.bin";

        // Presign PUT URL
        const presignPut = await objectProvider.presign(directKey, {
          method: "PUT",
          expiresIn: 300,
        });
        assert(presignPut.url.includes("token="));
        assert(presignPut.url.includes("sig="));
        assert(presignPut.expiresAt > Date.now());

        // Client performs direct PUT to storage using presigned URL
        const uploadBytes = new TextEncoder().encode(
          "DIRECT_STORAGE_TRANSFER_PAYLOAD_12345",
        );
        const putRes = await fetch(presignPut.url, {
          method: "PUT",
          body: uploadBytes,
        });
        assertEquals(
          putRes.status,
          200,
          "Direct presigned PUT must return 200 OK",
        );

        // Presign GET URL
        const presignGet = await objectProvider.presign(directKey, {
          method: "GET",
          expiresIn: 300,
        });
        const getRes = await fetch(presignGet.url, { method: "GET" });
        assertEquals(
          getRes.status,
          200,
          "Direct presigned GET must return 200 OK",
        );
        const fetchedText = await getRes.text();
        assertEquals(fetchedText, "DIRECT_STORAGE_TRANSFER_PAYLOAD_12345");

        // Verify HMAC tampering detection
        const tamperedUrl = presignGet.url.slice(0, -4) + "0000";
        const tamperedRes = await fetch(tamperedUrl, { method: "GET" });
        assertEquals(
          tamperedRes.status,
          403,
          "Tampered presigned URL must be rejected with 403",
        );

        // Verify method enforcement (presigned for GET invoked with PUT)
        const wrongMethodRes = await fetch(presignGet.url, {
          method: "PUT",
          body: "malicious",
        });
        assertEquals(
          wrongMethodRes.status,
          403,
          "Presigned URL with mismatched HTTP method must be rejected with 403",
        );

        // Verify maxExpiresIn validation limit
        await assertRejects(
          () =>
            objectProvider.presign("key", {
              method: "GET",
              expiresIn: 100_000,
              maxExpiresIn: 86400,
            }),
          ValidationFailedError,
        );
      },
    );
  } finally {
    await directServer.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});

// =============================================================================
// SCENARIO 6: Queue Publishing, Receiving, and Idempotent Worker Execution
// =============================================================================

Deno.test("RealDevSimulation - Scenario 6: Queue publishing, receiving, and idempotent worker execution with withIdempotency()", async (t) => {
  const queueProvider = new SQLiteQueueProvider(":memory:");
  const kvProvider = new SQLiteKVProvider(":memory:");

  try {
    // 6a: Publishing and receiving queue messages (Q-1, Q-2)
    let messageId = "";
    await t.step(
      "6a: Publishing and receiving queue messages with ULID tracking",
      async () => {
        const sendRes = await queueProvider.send({
          jobType: "TRANSCODE_MEDIA",
          assetId: "ast_45678",
          resolution: "1080p",
        });

        assert(
          isValidUlid(sendRes.id),
          "Queue message ID must be valid ULID (PLAT-14)",
        );
        messageId = sendRes.id;

        const received = await queueProvider.receive({
          visibilityTimeoutMs: 5000,
        });
        assert(received !== null);
        assertEquals(received.id, messageId);
        assertEquals(
          (received.body as { assetId: string }).assetId,
          "ast_45678",
        );
        assertEquals(received.attempts, 1);

        // Acknowledge message
        await queueProvider.ack(received.id);
        const nextMsg = await queueProvider.receive();
        assertEquals(
          nextMsg,
          null,
          "Acknowledged message must not be redelivered",
        );
      },
    );

    // 6b: Idempotent worker execution with withIdempotency() (Q-4, KV-2)
    await t.step(
      "6b: withIdempotency() executes action on first delivery and skips duplicate deliveries",
      async () => {
        const dedupeJobId = "job_dedupe_test_" + generateUlid();
        let sideEffectCounter = 0;
        const kvBinding = adaptKVProvider(kvProvider);

        // 1st delivery
        const run1 = await withIdempotency(
          kvBinding,
          ["dedupe", dedupeJobId],
          () => {
            sideEffectCounter++;
            return { status: "processed", count: sideEffectCounter };
          },
          { ttlSeconds: 3600 },
        );

        assertEquals(
          run1.processed,
          true,
          "First run must execute successfully",
        );
        assertEquals(run1.result?.count, 1);
        assertEquals(sideEffectCounter, 1);

        // Verify deduplication record in KV with TTL (Q-4)
        const dedupeMarker = await kvProvider.get(["dedupe", dedupeJobId]);
        assertEquals(
          dedupeMarker,
          true,
          "Dedupe marker must be recorded in KV",
        );

        // 2nd delivery (duplicate redelivery simulation)
        const run2 = await withIdempotency(
          kvBinding,
          ["dedupe", dedupeJobId],
          () => {
            sideEffectCounter++;
            return { status: "processed", count: sideEffectCounter };
          },
        );

        assertEquals(
          run2.processed,
          false,
          "Duplicate run must detect dedupe marker and skip execution (Q-4)",
        );
        assertEquals(run2.result, undefined);
        assertEquals(
          sideEffectCounter,
          1,
          "Side effect must NOT execute more than once",
        );
      },
    );

    // 6c: Action failure resilience: dedupe key is not written on throw
    await t.step(
      "6c: withIdempotency() does NOT write dedupe marker if action throws",
      async () => {
        const failJobId = "job_fail_" + generateUlid();
        const kvBinding = adaptKVProvider(kvProvider);

        await assertRejects(
          () =>
            withIdempotency(kvBinding, ["dedupe", failJobId], () => {
              throw new Error("Simulated network timeout during transcode");
            }),
          Error,
          "Simulated network timeout during transcode",
        );

        // Verify marker was NOT written
        const marker = await kvProvider.get(["dedupe", failJobId]);
        assertEquals(
          marker,
          null,
          "Failed attempt must not write dedupe marker, allowing retry",
        );

        // Subsequent attempt succeeds
        const retryRun = await withIdempotency(
          kvBinding,
          ["dedupe", failJobId],
          () => "success_after_retry",
        );
        assertEquals(retryRun.processed, true);
        assertEquals(retryRun.result, "success_after_retry");
      },
    );

    // 6d: Full QueueConsumerWorker integration with withIdempotency (FN-2, Q-3)
    await t.step(
      "6d: QueueConsumerWorker processes and acknowledges messages idempotently",
      async () => {
        const testAssetId = "asset_pipeline_" + generateUlid();
        await queueProvider.send({ assetId: testAssetId, action: "OPTIMIZE" });

        let workerProcessedCount = 0;
        const worker = new QueueConsumerWorker(
          queueProvider,
          async (_fnName: string, message: QueueMessage) => {
            const body = message.body as { assetId: string };
            const kvBinding = adaptKVProvider(kvProvider);

            const idem = await withIdempotency(
              kvBinding,
              ["worker_processed", body.assetId],
              async () => {
                workerProcessedCount++;
                await kvProvider.set(["asset_status", body.assetId], "READY");
              },
            );
            assert(idem.processed);
          },
          {
            queueName: "optimize-queue",
            targetFunctionName: "optimizer",
            visibilityTimeoutMs: 5000,
          },
        );

        const processed = await worker.processNext();
        assertEquals(processed, true, "Worker must process queued message");
        assertEquals(workerProcessedCount, 1);

        const statusInKv = await kvProvider.get(["asset_status", testAssetId]);
        assertEquals(statusInKv, "READY");

        // Verify queue is now empty
        const nextMsg = await queueProvider.receive();
        assertEquals(
          nextMsg,
          null,
          "Worker must acknowledge processed message",
        );
      },
    );
  } finally {
    queueProvider.close();
    kvProvider.close();
  }
});

// =============================================================================
// SCENARIOS 7 & 8 & 9: Full Real-World Live Dev Server Integration
// Exercises:
// - Live startLocalServer()
// - Full createRpcClient() consuming endpoints
// - PLAT-12 typed error normalization across all error classes
// - Embedded dev dashboard API (/__railfog/api/info and /__railfog/api/kv)
// =============================================================================

Deno.test("RealDevSimulation - Scenarios 7, 8, & 9: Live Dev Server, Full RPC Client, and Local Dashboard API", async (t) => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-live-dev-" });
  const fnDir = join(tempDir, "functions");
  await Deno.mkdir(fnDir, { recursive: true });

  const kvProvider = new SQLiteKVProvider(":memory:");
  const objectProvider = new DirectStorageLocalFSProvider(
    join(tempDir, "objects"),
  );
  const queueProvider = new SQLiteQueueProvider(":memory:");
  const directServer = startDirectStorageServer(objectProvider);

  let devServer: LocalServer | null = null;

  try {
    // 1. Write railfog.toml
    const tomlContent = `name = "cloud-assets-suite"

[functions.api]
entry = "functions/api.ts"
permissions = { kv = ["app_store"], objects = ["app_media"], queues = ["app_jobs"] }

[[routes]]
pattern = "/api"
function = "api"

[[routes]]
pattern = "/api/*"
function = "api"
`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

    // 2. Write functions/api.ts implementing the multi-method router
    const apiSourceCode = `
import { api, type HandlerContext } from "@railfog/sdk";
import {
  ConflictError,
  ResourceNotFoundError,
  ValidationFailedError,
} from "@railfog/errors";

export default api({
  // GET /api/users — List users from KV
  "GET /api/users": async (c: HandlerContext) => {
    const listRes: any = await c.kv.list(["users"]);
    const items = listRes.keys || listRes.entries || [];
    const users = items.map((k: any) => k.value);
    return { users };
  },

  // POST /api/users — Create user with CAS check and publish queue event
  "POST /api/users": async (c: HandlerContext) => {
    const body = await c.body<{ id?: string; name?: string; email?: string }>();
    if (!body || !body.name || body.name.trim() === "") {
      throw new ValidationFailedError("Name is required", c.requestId);
    }
    if (!body.email || !body.email.includes("@")) {
      throw new ValidationFailedError("Valid email is required", c.requestId);
    }

    const id = body.id || ("usr_" + Math.random().toString(36).slice(2, 9));
    const userKey = ["users", id];

    // Check duplicate by email
    const allUsers: any = await c.kv.list(["users"]);
    const items = allUsers.keys || allUsers.entries || [];
    const emailConflict = items.some(
      (k: any) => k.value && k.value.email === body.email,
    );
    if (emailConflict) {
      throw new ConflictError(
        \`Email '\${body.email}' is already registered\`,
        c.requestId,
      );
    }

    const newUser = {
      id,
      name: body.name,
      email: body.email,
      createdAt: Date.now(),
    };

    // Atomic CAS creation (KV-3)
    const commitRes = await c.kv.atomic()
      .check(userKey, 0)
      .set(userKey, newUser)
      .commit();

    if (!commitRes.ok) {
      throw new ConflictError(\`User '\${id}' already exists\`, c.requestId);
    }

    // Publish welcome event to queue
    await c.queues.send({ type: "WELCOME_EMAIL", userId: id, email: body.email });

    return newUser;
  },

  // Literal route (PLAT-11 Specificity)
  "GET /api/users/me": (_c: HandlerContext) => {
    return { id: "usr_lead_architect", name: "System Architect", role: "admin" };
  },

  // GET /api/users/:id — Get user by ID
  "GET /api/users/:id": async (c: HandlerContext) => {
    const id = c.params?.id;
    if (!id) throw new ValidationFailedError("Missing user id", c.requestId);
    const user = await c.kv.get(["users", id]);
    if (!user) {
      throw new ResourceNotFoundError(\`User '\${id}' not found\`, c.requestId);
    }
    return user;
  },

  // PUT /api/users/:id — Update user
  "PUT /api/users/:id": async (c: HandlerContext) => {
    const id = c.params?.id;
    if (!id) throw new ValidationFailedError("Missing user id", c.requestId);
    const user = await c.kv.get(["users", id]);
    if (!user) {
      throw new ResourceNotFoundError(\`User '\${id}' not found\`, c.requestId);
    }
    const body = await c.body<{ name?: string }>();
    const updated = { ...(user as any), name: body.name ?? (user as any).name };
    await c.kv.set(["users", id], updated);
    return updated;
  },

  // DELETE /api/users/:id — Delete user
  "DELETE /api/users/:id": async (c: HandlerContext) => {
    const id = c.params?.id;
    if (!id) throw new ValidationFailedError("Missing user id", c.requestId);
    const user = await c.kv.get(["users", id]);
    if (!user) {
      throw new ResourceNotFoundError(\`User '\${id}' not found\`, c.requestId);
    }
    await c.kv.delete(["users", id]);
    return { deleted: true, id };
  },

  // GET /api/export — Chunked streaming export
  "GET /api/export": (c: HandlerContext) => {
    return c.stream(async (writer) => {
      await writer.write("user_id,status,score\\n");
      await writer.write("usr_001,active,95\\n");
      await writer.write("usr_002,active,88\\n");
      await writer.close();
    }, { headers: { "content-type": "text/csv" } });
  },

  // GET /api/events — Server-Sent Events
  "GET /api/events": (c: HandlerContext) => {
    return c.sse(async (sse) => {
      await sse.send({ id: "1", event: "notification", data: { text: "ready" } });
      await sse.close();
    });
  },

  // Endpoints triggering specific errors for RPC client normalization tests
  "GET /api/panic": (_c: HandlerContext) => {
    throw new Error("Unhandled platform panic simulation");
  },
  "GET /api/error/validation": (c: HandlerContext) => {
    throw new ValidationFailedError("Field 'tier' is invalid", c.requestId);
  },
  "GET /api/error/conflict": (c: HandlerContext) => {
    throw new ConflictError("Document concurrency conflict", c.requestId);
  },
});
`;
    await Deno.writeTextFile(join(fnDir, "api.ts"), apiSourceCode);

    // 3. Start live local development server
    devServer = await startLocalServer(
      {
        name: "cloud-assets-suite",
        functions: {
          api: {
            entry: "functions/api.ts",
            permissions: {
              kv: ["app_store"],
              objects: ["app_media"],
              queues: ["app_jobs"],
            },
          },
        },
        routes: [
          { pattern: "/api", function: "api" },
          { pattern: "/api/*", function: "api" },
        ],
      },
      0,
      {
        cwd: tempDir,
        watch: false,
        logRequests: false,
        providers: {
          kv: kvProvider,
          objects: objectProvider,
          queues: queueProvider,
        },
      },
    );

    const baseUrl = `http://localhost:${devServer.port}`;
    const rpcClient: RpcClient = createRpcClient(baseUrl);

    // =========================================================================
    // SCENARIO 7: Full RPC Client Testing & PLAT-12 Error Normalization
    // =========================================================================

    await t.step(
      "7a: RPC client executes standard CRUD calls over HTTP",
      async () => {
        // 1. Initial list empty
        const initialUsers = await rpcClient.get<{ users: unknown[] }>(
          "/api/users",
        );
        assertEquals(initialUsers.users.length, 0);

        // 2. Create user via POST
        const createdUser = await rpcClient.post<{
          id: string;
          name: string;
          email: string;
        }>("/api/users", {
          name: "Margaret Hamilton",
          email: "margaret@apollo.nasa.gov",
        });
        assert(createdUser.id.startsWith("usr_"));
        assertEquals(createdUser.name, "Margaret Hamilton");

        // 3. Retrieve user via GET /api/users/:id
        const fetchedUser = await rpcClient.get<{ id: string; name: string }>(
          `/api/users/${createdUser.id}`,
        );
        assertEquals(fetchedUser.id, createdUser.id);
        assertEquals(fetchedUser.name, "Margaret Hamilton");

        // 4. Update user via PUT /api/users/:id
        const updatedUser = await rpcClient.put<{ id: string; name: string }>(
          `/api/users/${createdUser.id}`,
          { name: "Margaret H. (Apollo Director)" },
        );
        assertEquals(updatedUser.name, "Margaret H. (Apollo Director)");

        // 5. PLAT-11 Specificity via RPC client
        const meUser = await rpcClient.get<{ id: string; name: string }>(
          "/api/users/me",
        );
        assertEquals(meUser.id, "usr_lead_architect");

        // 6. Delete user via DELETE /api/users/:id
        const delRes = await rpcClient.delete<{ deleted: boolean; id: string }>(
          `/api/users/${createdUser.id}`,
        );
        assertEquals(delRes.deleted, true);
      },
    );

    await t.step(
      "7b: RPC client normalizes PLAT-12 VALIDATION_FAILED error",
      async () => {
        // Missing name triggers 400 VALIDATION_FAILED
        const err = await assertRejects(
          () =>
            rpcClient.post("/api/users", { name: "", email: "bad@test.org" }),
          ValidationFailedError,
        );

        assertEquals(err.code, "VALIDATION_FAILED");
        assertEquals(err.message, "Name is required");
        assert(
          isValidUlid(err.requestId ?? ""),
          `Request ID must be valid ULID, got ${err.requestId}`,
        );
      },
    );

    await t.step(
      "7c: RPC client normalizes PLAT-12 RESOURCE_NOT_FOUND error",
      async () => {
        // Nonexistent user triggers 404 RESOURCE_NOT_FOUND
        const err = await assertRejects(
          () => rpcClient.get("/api/users/usr_nonexistent_id"),
          ResourceNotFoundError,
        );

        assertEquals(err.code, "RESOURCE_NOT_FOUND");
        assert(err.message.includes("not found"));
        assert(isValidUlid(err.requestId ?? ""));
      },
    );

    await t.step(
      "7d: RPC client normalizes PLAT-12 CONFLICT error",
      async () => {
        // Create user
        await rpcClient.post("/api/users", {
          name: "Unique Person",
          email: "unique@platform.internal",
        });

        // Attempt duplicate email registration -> 409 CONFLICT
        const err = await assertRejects(
          () =>
            rpcClient.post("/api/users", {
              name: "Duplicate Imposter",
              email: "unique@platform.internal",
            }),
          ConflictError,
        );

        assertEquals(err.code, "CONFLICT");
        assert(err.message.includes("already registered"));
        assert(isValidUlid(err.requestId ?? ""));
      },
    );

    await t.step(
      "7e: RPC client normalizes unhandled crash to PLAT-12 INTERNAL error",
      async () => {
        const err = await assertRejects(
          () => rpcClient.get("/api/panic"),
          InternalError,
        );

        assertEquals(err.code, "INTERNAL");
        assert(err.message.includes("Unhandled platform panic simulation"));
        assert(isValidUlid(err.requestId ?? ""));
      },
    );

    // =========================================================================
    // SCENARIO 8: Embedded Local Dev Dashboard API Endpoints
    // =========================================================================

    await t.step(
      "8a: GET /__railfog/api/info returns live project metadata and routes",
      async () => {
        const res = await fetch(`${baseUrl}/__railfog/api/info`);
        assertEquals(res.status, 200);
        const data = await res.json();
        assertEquals(data.project, "cloud-assets-suite");
        assert(Array.isArray(data.routes));
        assertEquals(data.routes.length, 2);
        assert(data.functions["api"] !== undefined);
      },
    );

    await t.step(
      "8b: POST, GET, and DELETE /__railfog/api/kv manage dev state",
      async () => {
        // 1. Set key via dashboard API
        const setRes = await fetch(`${baseUrl}/__railfog/api/kv`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            key: "dev:feature_flags",
            value: { beta_transcoder: true, max_upload_mb: 50 },
          }),
        });
        assertEquals(setRes.status, 200);
        const setJson = await setRes.json();
        assertEquals(setJson.ok, true);

        // 2. List keys via dashboard API
        const listRes = await fetch(`${baseUrl}/__railfog/api/kv`);
        assertEquals(listRes.status, 200);
        const listJson = await listRes.json();
        assert(Array.isArray(listJson.keys));

        const foundKey = listJson.keys.find(
          (k: { key: string }) => k.key === "dev:feature_flags",
        );
        assert(foundKey !== undefined, "Set key must appear in dashboard list");
        assertEquals(foundKey.value, {
          beta_transcoder: true,
          max_upload_mb: 50,
        });

        // 3. Delete key via dashboard API
        const delRes = await fetch(
          `${baseUrl}/__railfog/api/kv?key=dev:feature_flags`,
          { method: "DELETE" },
        );
        assertEquals(delRes.status, 200);
        const delJson = await delRes.json();
        assertEquals(delJson.ok, true);

        // 4. Verify key was removed
        const verifyRes = await fetch(`${baseUrl}/__railfog/api/kv`);
        const verifyJson = await verifyRes.json();
        const removedKey = verifyJson.keys.find(
          (k: { key: string }) => k.key === "dev:feature_flags",
        );
        assertEquals(removedKey, undefined);
      },
    );

    await t.step(
      "8c: GET /__railfog serves embedded HTML dashboard UI",
      async () => {
        const res = await fetch(`${baseUrl}/__railfog`);
        assertEquals(res.status, 200);
        assertEquals(
          res.headers.get("content-type"),
          "text/html; charset=utf-8",
        );
        const html = await res.text();
        assert(html.includes("RailFog Local Dashboard"));
        assert(html.includes("cloud-assets-suite"));
        assert(html.includes("/api/*"));
      },
    );

    // =========================================================================
    // SCENARIO 9: Complete Real-World Developer Workflow Simulation
    // =========================================================================

    await t.step(
      "9: Real-world workflow: create user -> queue event -> transcode asset -> stream report",
      async () => {
        // Drain any prior queue messages from earlier test steps
        while (true) {
          const prior = await queueProvider.receive();
          if (!prior) break;
          await queueProvider.ack(prior.id);
        }

        // Step 1: Client registers user via RPC
        const user = await rpcClient.post<
          { id: string; name: string; email: string }
        >(
          "/api/users",
          {
            name: "Katherine Johnson",
            email: "katherine@nasa.gov",
          },
        );
        assert(user.id.startsWith("usr_"));

        // Step 2: Receive and process published welcome queue message with withIdempotency
        const msg = await queueProvider.receive();
        assert(msg !== null, "Welcome email message must be queued");
        const body = msg.body as {
          type: string;
          userId: string;
          email: string;
        };
        assertEquals(body.type, "WELCOME_EMAIL");
        assertEquals(body.userId, user.id);

        let emailSentCount = 0;
        const sendEmailAction = () => {
          emailSentCount++;
          return { sentAt: Date.now(), to: body.email };
        };

        const kvBinding = adaptKVProvider(kvProvider);

        // Idempotent execution (Q-4)
        const idem1 = await withIdempotency(
          kvBinding,
          ["email_sent", msg.id],
          sendEmailAction,
        );
        assertEquals(idem1.processed, true);
        assertEquals(emailSentCount, 1);
        await queueProvider.ack(msg.id);

        // Simulate redelivery: duplicate execution must be skipped
        const idem2 = await withIdempotency(
          kvBinding,
          ["email_sent", msg.id],
          sendEmailAction,
        );
        assertEquals(idem2.processed, false);
        assertEquals(emailSentCount, 1);

        // Step 3: Streamed export report
        const exportRes = await fetch(`${baseUrl}/api/export`);
        assertEquals(exportRes.status, 200);
        const exportText = await exportRes.text();
        assert(exportText.includes("user_id,status,score\n"));
        assert(exportText.includes("usr_001,active,95\n"));

        // Step 4: Server-Sent Events stream
        const sseRes = await fetch(`${baseUrl}/api/events`);
        assertEquals(sseRes.status, 200);
        assertEquals(sseRes.headers.get("content-type"), "text/event-stream");
        const sseText = await sseRes.text();
        assert(sseText.includes("event: notification\n"));
        assert(sseText.includes('data: {"text":"ready"}\n\n'));
      },
    );
  } finally {
    if (devServer) await devServer.close();
    await directServer.close();
    kvProvider.close();
    queueProvider.close();
    await Deno.remove(tempDir, { recursive: true });
  }
});
