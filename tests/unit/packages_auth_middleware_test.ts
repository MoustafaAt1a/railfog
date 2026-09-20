// spec: contracts/platform.contract.md#PLAT-1 — Daemon separation & health check
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & tenant scoping
// spec: contracts/platform.contract.md#PLAT-12 — Canonical error model (PERMISSION_DENIED, status 403)
// spec: contracts/platform.contract.md#PLAT-14 — Request ID propagation
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0754-api-key-auth-middleware.md

import { assertEquals } from "@std/assert";
import { createAuthMiddleware } from "../../packages/auth/middleware.ts";
import { ApiKeyStore } from "../../packages/auth/store.ts";
import { PostgresKVProvider } from "../../providers/kv/postgres-provider.ts";

Deno.test("T-0754: createAuthMiddleware bypasses allowAnonymousPaths (/healthz)", async () => {
  const middleware = createAuthMiddleware({
    allowAnonymousPaths: ["/healthz", "/login"],
  });

  const req = new Request("http://localhost:8081/healthz");
  const result = await middleware(req, "req_01J8Z000000000000000000001");

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.context.callerType, "anonymous");
  }
});

Deno.test("T-0754: createAuthMiddleware rejects missing credentials with 403 PERMISSION_DENIED (PLAT-12)", async () => {
  const middleware = createAuthMiddleware({});
  const req = new Request("http://localhost:8081/v1/projects/my-app/deploy", {
    method: "POST",
  });

  const result = await middleware(req, "req_01J8Z000000000000000000002");
  assertEquals(result.ok, false);

  if (!result.ok) {
    assertEquals(result.response.status, 403);
    assertEquals(result.response.headers.get("x-request-id"), "req_01J8Z000000000000000000002");
    const body = await result.response.json();
    assertEquals(body.error.code, "PERMISSION_DENIED");
    assertEquals(body.error.request_id, "req_01J8Z000000000000000000002");
  }
});

Deno.test("T-0754: createAuthMiddleware validates Bearer token and x-api-key via ApiKeyStore (PLAT-6, PLAT-15)", async () => {
  const storage = new PostgresKVProvider();
  const store = new ApiKeyStore({ storageProvider: storage });
  const { rawToken } = await store.createKey({
    name: "ci-runner",
    orgId: "org-prod",
    projectId: "app-backend",
  });

  const middleware = createAuthMiddleware({ apiKeyStore: store });

  // 1. Valid Authorization: Bearer <key>
  const bearerReq = new Request("http://localhost:8081/v1/projects/app-backend/deploy", {
    headers: { authorization: `Bearer ${rawToken}` },
  });
  const bearerRes = await middleware(bearerReq, "req_01J8Z000000000000000000003");
  assertEquals(bearerRes.ok, true);
  if (bearerRes.ok) {
    assertEquals(bearerRes.context.callerId, "ci-runner");
    assertEquals(bearerRes.context.orgId, "org-prod");
  }

  // 2. Valid x-api-key: <key>
  const xApiKeyReq = new Request("http://localhost:8081/v1/projects/app-backend/deploy", {
    headers: { "x-api-key": rawToken },
  });
  const xApiKeyRes = await middleware(xApiKeyReq, "req_01J8Z000000000000000000004");
  assertEquals(xApiKeyRes.ok, true);
  if (xApiKeyRes.ok) {
    assertEquals(xApiKeyRes.context.callerId, "ci-runner");
  }

  // 3. Invalid token
  const badReq = new Request("http://localhost:8081/v1/projects/app-backend/deploy", {
    headers: { authorization: "Bearer rfk_fake_bad_token_999" },
  });
  const badRes = await middleware(badReq, "req_01J8Z000000000000000000005");
  assertEquals(badRes.ok, false);
  if (!badRes.ok) {
    assertEquals(badRes.response.status, 403);
    const body = await badRes.response.json();
    assertEquals(body.error.code, "PERMISSION_DENIED");
    // Ensure raw secret is not echoed in error body (PLAT-15)
    assertEquals(body.error.message.includes("rfk_fake_bad_token_999"), false);
  }

  await storage.close();
});
