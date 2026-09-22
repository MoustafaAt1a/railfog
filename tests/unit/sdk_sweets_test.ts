// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: sdk/typescript testing & ergonomics
// spec: contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
// spec: contracts/functions.contract.md#FN-4 — RailFogContext structure and capability bindings
// spec: contracts/objects.contract.md#OBJ-2 — Object stream helpers (readBytes, readText, readJson)
// spec: contracts/platform.contract.md#PLAT-12 — Canonical error normalization for malformed input
// spec: contracts/platform.contract.md#PLAT-15 — Capability-scoped secret access via env

import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  createMockContext,
  handle,
  readBytes,
  readJson,
  readText,
  ResourceNotFoundError,
  ValidationFailedError,
} from "../../sdk/typescript/mod.ts";

Deno.test("Sweet 1: createMockContext provides zero-config in-memory KV, Objects, Queues, and Env", async () => {
  const ctx = createMockContext({
    env: { STRIPE_SECRET: "sk_live_123" },
    initialKv: [
      [["users", "u_1"], { name: "Alice" }],
    ],
  });

  // KV operations
  assertEquals(await ctx.kv.get(["users", "u_1"]), { name: "Alice" });
  await ctx.kv.set(["users", "u_2"], { name: "Bob" });
  assertEquals(await ctx.kv.get(["users", "u_2"]), { name: "Bob" });

  const listRes = await ctx.kv.list(["users"]);
  assertEquals(listRes.entries.length, 2);

  // KV Atomic CAS check
  const atomicSuccess = await ctx.kv.atomic()
    .check(["users", "u_1"], 1)
    .set(["users", "u_1"], { name: "Alice Updated" })
    .commit();
  assertEquals(atomicSuccess.ok, true);

  const atomicConflict = await ctx.kv.atomic()
    .check(["users", "u_1"], 1) // version was updated to 3
    .set(["users", "u_1"], { name: "Should Fail" })
    .commit();
  assertEquals(atomicConflict.ok, false);

  // Objects operations
  await ctx.objects.put(
    "documents/report.txt",
    new TextEncoder().encode("Annual Report 2026"),
  );
  const head = await ctx.objects.head("documents/report.txt");
  assertExists(head);
  assertEquals(head.sizeBytes, 18);
  assert(head.sha256.startsWith("sha256:"));

  const getStream = await ctx.objects.get("documents/report.txt");
  assertExists(getStream);
  const text = await readText(getStream);
  assertEquals(text, "Annual Report 2026");

  // Queues operations
  const sendRes = await ctx.queues.send({
    task: "send-email",
    to: "alice@example.com",
  });
  assertExists(sendRes.id);
  assertEquals(ctx.storage.queue.length, 1);
  assertEquals(ctx.storage.queue[0].body, {
    task: "send-email",
    to: "alice@example.com",
  });

  // Env secrets operations
  assertEquals(ctx.env.get("STRIPE_SECRET"), "sk_live_123");
  assertEquals(ctx.env.require("STRIPE_SECRET"), "sk_live_123");
  assertThrows(
    () => ctx.env.require("MISSING_SECRET"),
    ValidationFailedError,
  );
});

Deno.test("Sweet 1: createMockContext seamlessly executes with handle() wrapper", async () => {
  const handler = handle(async (c) => {
    const user = await c.kv.get(["current_user"]);
    return {
      authenticated: true,
      user,
      secret: c.env.get("APP_KEY"),
    };
  });

  const ctx = createMockContext({
    env: { APP_KEY: "prod-secret-key" },
    initialKv: [
      [["current_user"], { username: "octocat" }],
    ],
  });

  const res = await handler(
    new Request("https://app.railfog.net/api/whoami"),
    ctx,
  );
  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data, {
    authenticated: true,
    user: { username: "octocat" },
    secret: "prod-secret-key",
  });
});

Deno.test("Sweet 2: readBytes, readText, and readJson decode object streams", async () => {
  const payload = { event: "order_created", amount: 99.5 };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  const parsedJson = await readJson<{ event: string; amount: number }>(stream);
  assertEquals(parsedJson, payload);

  const textStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("Hello RailFog"));
      controller.close();
    },
  });
  assertEquals(await readText(textStream), "Hello RailFog");

  const byteStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.close();
    },
  });
  const readOut = await readBytes(byteStream);
  assertEquals(Array.from(readOut), [1, 2, 3, 4]);
});

Deno.test("Sweet 2: readJson throws ValidationFailedError on malformed stream JSON", async () => {
  const corruptStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{ broken json"));
      controller.close();
    },
  });

  await assertRejects(
    () => readJson(corruptStream),
    ValidationFailedError,
  );
});

Deno.test("Sweet 2: readBytes throws ResourceNotFoundError on null stream", async () => {
  await assertRejects(
    () => readBytes(null),
    ResourceNotFoundError,
  );
});

Deno.test("Sweet 3: c.header, c.cookies, c.cookie, c.setCookie, and c.clearCookie", async () => {
  const handler = handle((c) => {
    const authHeader = c.header("authorization");
    const sessionId = c.cookie("session_id");

    c.setCookie("session_id", "sess_new_999", {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      maxAge: 3600,
    });

    c.setCookie("theme", "dark", { path: "/app" });
    c.clearCookie("old_tracker");

    return {
      auth: authHeader,
      session: sessionId,
      allCookies: c.cookies,
    };
  });

  const ctx = createMockContext();
  const req = new Request("https://app.railfog.net/dashboard", {
    headers: {
      "authorization": "Bearer token_xyz",
      "cookie": "session_id=sess_old_123; user_pref=compact",
    },
  });

  const res = await handler(req, ctx);
  assertEquals(res.status, 200);

  const body = await res.json();
  assertEquals(body.auth, "Bearer token_xyz");
  assertEquals(body.session, "sess_old_123");
  assertEquals(body.allCookies, {
    session_id: "sess_old_123",
    user_pref: "compact",
  });

  // Verify outgoing Set-Cookie headers
  const setCookies = res.headers.getSetCookie();
  assert(setCookies.length >= 3);
  assert(
    setCookies.some((h) =>
      h.includes("session_id=sess_new_999") && h.includes("HttpOnly") &&
      h.includes("Secure") && h.includes("SameSite=Strict")
    ),
  );
  assert(
    setCookies.some((h) => h.includes("theme=dark") && h.includes("Path=/app")),
  );
  assert(
    setCookies.some((h) =>
      h.includes("old_tracker=") && h.includes("Max-Age=0")
    ),
  );
});
