// spec: contracts/platform.contract.md#PLAT-1 — Stage 1 deployment topology
// spec: contracts/platform.contract.md#PLAT-4 — Isolation, defense in depth
// spec: contracts/platform.contract.md#PLAT-12 — Error model (RESOURCE_NOT_FOUND, CALL_DEPTH_EXCEEDED)
// spec: contracts/platform.contract.md#PLAT-14 — ULID request identifier format
// spec: contracts/functions.contract.md#FN-5 — Resource limits
// spec: contracts/functions.contract.md#FN-7 — Call-depth guard (default limit 8)
// spec: tasks/milestone-0.7-repo-consolidation/T-0707-runtime-api-execution-boundary.md

import { assertEquals, assertMatch } from "@std/assert";
import { type RouteTarget, RuntimeDispatcher } from "../../runtime/api/mod.ts";
import type {
  Artifact,
  ComputeProvider,
  ExecutionResult,
  InvocationRequest,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import { isValidUlid } from "../../packages/core/id/ulid.ts";
import type { IdentityContext } from "@railfog/auth";

class MockComputeProvider implements ComputeProvider {
  public lastArtifact?: Artifact;
  public lastLimits?: Limits;
  public lastInvocation?: InvocationRequest;
  public mockResult: ExecutionResult = {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify({ ok: true })),
    cpuTimeMs: 5,
    wallClockMs: 12,
  };

  run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult> {
    this.lastArtifact = artifact;
    this.lastLimits = limits;
    this.lastInvocation = invocation;
    return Promise.resolve(this.mockResult);
  }
}

function createDummyTarget(overrides: Partial<RouteTarget> = {}): RouteTarget {
  return {
    projectId: "proj_test_01",
    functionName: "api_handler",
    revision: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    artifact: {
      id:
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
      entrypoint: "handler.ts",
      code: new Uint8Array([1, 2, 3]),
    },
    limits: {
      cpuMs: 200,
      timeoutMs: 30000,
      memoryMb: 128,
    },
    ...overrides,
  };
}

Deno.test("T-0707: RuntimeDispatcher resolves route and executes via ComputeProvider (PLAT-1, PLAT-4)", async () => {
  const mockCompute = new MockComputeProvider();
  const dummyTarget = createDummyTarget();

  const dispatcher = new RuntimeDispatcher({
    computeProvider: mockCompute,
    resolveRoute: (url: URL) => {
      if (url.pathname === "/api/test") {
        return dummyTarget;
      }
      return null;
    },
  });

  const req = new Request("http://localhost:8080/api/test", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "hello world",
  });

  const res = await dispatcher.handleRequest(req);
  assertEquals(res.status, 200);

  // Validate ULID request_id was generated and attached (PLAT-14)
  const reqId = res.headers.get("x-request-id");
  assertEquals(typeof reqId, "string");
  assertEquals(isValidUlid(reqId!), true);
  assertEquals(res.headers.get("request-id"), reqId);

  // Validate call depth header was initialized and incremented to 1 (FN-7)
  assertEquals(res.headers.get("x-railfog-call-depth"), "1");

  // Validate ComputeProvider received correct invocation arguments
  assertEquals(mockCompute.lastArtifact, dummyTarget.artifact);
  assertEquals(mockCompute.lastLimits, dummyTarget.limits);
  assertEquals(mockCompute.lastInvocation?.requestId, reqId);
  assertEquals(mockCompute.lastInvocation?.method, "POST");
  assertEquals(
    new TextDecoder().decode(mockCompute.lastInvocation?.body),
    "hello world",
  );
});

Deno.test("T-0707: RuntimeDispatcher propagates incoming valid ULID request_id (PLAT-12, PLAT-14)", async () => {
  const mockCompute = new MockComputeProvider();
  const dummyTarget = createDummyTarget();
  const validUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

  const dispatcher = new RuntimeDispatcher({
    computeProvider: mockCompute,
    resolveRoute: () => dummyTarget,
  });

  const req = new Request("http://localhost:8080/api/test", {
    headers: { "x-request-id": validUlid },
  });

  const res = await dispatcher.handleRequest(req);
  assertEquals(res.headers.get("x-request-id"), validUlid);
  assertEquals(res.headers.get("request-id"), validUlid);
  assertEquals(mockCompute.lastInvocation?.requestId, validUlid);
});

Deno.test("T-0707: RuntimeDispatcher returns 404 RESOURCE_NOT_FOUND for unmatched route (PLAT-12)", async () => {
  const mockCompute = new MockComputeProvider();
  const dispatcher = new RuntimeDispatcher({
    computeProvider: mockCompute,
    resolveRoute: () => null,
  });

  const req = new Request("http://localhost:8080/unknown/path");
  const res = await dispatcher.handleRequest(req);

  assertEquals(res.status, 404);
  assertEquals(res.headers.get("content-type"), "application/json");

  const reqId = res.headers.get("x-request-id");
  assertEquals(typeof reqId, "string");
  assertEquals(isValidUlid(reqId!), true);

  const body = await res.json();
  assertEquals(body.error.code, "RESOURCE_NOT_FOUND");
  assertEquals(body.error.request_id, reqId);
});

Deno.test("T-0707: RuntimeDispatcher rejects when call depth exceeds callDepthMax (FN-7, PLAT-12)", async () => {
  const mockCompute = new MockComputeProvider();
  const dispatcher = new RuntimeDispatcher({
    computeProvider: mockCompute,
    resolveRoute: () => createDummyTarget(),
    callDepthMax: 8,
  });

  // Call with depth equal to max (8)
  const req = new Request("http://localhost:8080/api/recursive", {
    headers: { "x-railfog-call-depth": "8" },
  });

  const res = await dispatcher.handleRequest(req);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("content-type"), "application/json");

  const body = await res.json();
  assertEquals(body.error.code, "CALL_DEPTH_EXCEEDED");
  assertMatch(body.error.message, /call depth/i);
});

Deno.test("T-0707: RuntimeDispatcher increments call depth for nested calls (FN-7)", async () => {
  const mockCompute = new MockComputeProvider();
  const dispatcher = new RuntimeDispatcher({
    computeProvider: mockCompute,
    resolveRoute: () => createDummyTarget(),
    callDepthMax: 8,
  });

  const req = new Request("http://localhost:8080/api/step", {
    headers: { "x-railfog-call-depth": "3" },
  });

  const res = await dispatcher.handleRequest(req);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("x-railfog-call-depth"), "4");
  assertEquals(
    mockCompute.lastInvocation?.headers?.["x-railfog-call-depth"],
    "4",
  );
});

Deno.test("T-0707: RuntimeDispatcher enforces authentication when configured (PLAT-6, PLAT-12)", async () => {
  const mockCompute = new MockComputeProvider();
  const dispatcher = new RuntimeDispatcher({
    computeProvider: mockCompute,
    resolveRoute: () => createDummyTarget({ projectId: "proj_secure" }),
    authenticateCaller: (req: Request): Promise<IdentityContext | null> => {
      const auth = req.headers.get("authorization");
      if (auth === "Bearer valid-token") {
        return Promise.resolve({
          callerId: "user_123",
          orgId: "org_456",
          projectId: "proj_secure",
          callerType: "token",
        });
      }
      return Promise.resolve(null);
    },
  });

  // Unauthenticated request
  const unauthReq = new Request("http://localhost:8080/api/secure");
  const unauthRes = await dispatcher.handleRequest(unauthReq);
  assertEquals(unauthRes.status, 403);
  const unauthBody = await unauthRes.json();
  assertEquals(unauthBody.error.code, "PERMISSION_DENIED");

  // Authenticated request
  const authReq = new Request("http://localhost:8080/api/secure", {
    headers: { authorization: "Bearer valid-token" },
  });
  const authRes = await dispatcher.handleRequest(authReq);
  assertEquals(authRes.status, 200);
});
