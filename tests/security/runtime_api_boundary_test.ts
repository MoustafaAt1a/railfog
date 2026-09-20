// spec: contracts/platform.contract.md#PLAT-4 — Isolation, defense in depth
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & tenant scoping
// spec: contracts/platform.contract.md#PLAT-7 — Multi-tenancy & data isolation
// spec: contracts/platform.contract.md#PLAT-12 — Error model
// spec: contracts/platform.contract.md#PLAT-15 — Secrets protection (zero leakage)
// spec: contracts/functions.contract.md#FN-5 — Resource limits
// spec: contracts/functions.contract.md#FN-7 — Call-depth guard
// spec: tasks/milestone-0.7-repo-consolidation/T-0707-runtime-api-execution-boundary.md

import { assertEquals } from "@std/assert";
import { type RouteTarget, RuntimeDispatcher } from "../../runtime/api/mod.ts";
import type {
  Artifact,
  ComputeProvider,
  ExecutionResult,
  InvocationRequest,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import type { IdentityContext } from "@railfog/auth";

class ThrowingComputeProvider implements ComputeProvider {
  constructor(private readonly errorToThrow: Error) {}

  run(
    _artifact: Artifact,
    _limits: Limits,
    _invocation?: InvocationRequest,
  ): Promise<ExecutionResult> {
    return Promise.reject(this.errorToThrow);
  }
}

class TrackingComputeProvider implements ComputeProvider {
  public receivedInvocations: InvocationRequest[] = [];

  run(
    _artifact: Artifact,
    _limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult> {
    if (invocation) {
      this.receivedInvocations.push(invocation);
    }
    return Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: new Uint8Array([123, 125]), // {}
      cpuTimeMs: 1,
      wallClockMs: 2,
    });
  }
}

function createSecureTarget(projectId: string = "proj_target"): RouteTarget {
  return {
    projectId,
    functionName: "secure_fn",
    revision: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    artifact: {
      id:
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
      entrypoint: "handler.ts",
      code: new Uint8Array([0]),
    },
    limits: {
      cpuMs: 200,
      timeoutMs: 30000,
      memoryMb: 128,
    },
  };
}

Deno.test("Security PLAT-4: RuntimeDispatcher isolates host from compute failure and redacts internal stack traces", async () => {
  const secretHostPath = "C:\\Windows\\System32\\host-internal-credential.key";
  const hostileError = new Error(`Critical host failure at ${secretHostPath}`);
  hostileError.stack =
    `Error: Critical host failure at ${secretHostPath}\n    at InternalHostFunction (host.ts:42:13)`;

  const compute = new ThrowingComputeProvider(hostileError);
  const dispatcher = new RuntimeDispatcher({
    computeProvider: compute,
    resolveRoute: () => createSecureTarget(),
  });

  const req = new Request("http://localhost:8080/crash");
  const res = await dispatcher.handleRequest(req);

  assertEquals(res.status, 500);
  assertEquals(res.headers.get("content-type"), "application/json");

  const body = await res.json();
  assertEquals(body.error.code, "INTERNAL");

  // Host path and internals must not be leaked into caller response
  const rawBodyText = JSON.stringify(body);
  assertEquals(rawBodyText.includes(secretHostPath), false);
  assertEquals(rawBodyText.includes("host.ts"), false);
});

Deno.test("Security PLAT-6 & PLAT-7: Cross-tenant project isolation prevents unauthorized dispatch", async () => {
  const compute = new TrackingComputeProvider();
  const dispatcher = new RuntimeDispatcher({
    computeProvider: compute,
    resolveRoute: () => createSecureTarget("proj_victim"),
    authenticateCaller: (_req: Request): Promise<IdentityContext | null> => {
      // Caller has valid token, but for a different project
      return Promise.resolve({
        callerId: "attacker_token_01",
        orgId: "org_attacker",
        projectId: "proj_attacker",
        callerType: "token",
      });
    },
  });

  const req = new Request("http://localhost:8080/victim/resource");
  const res = await dispatcher.handleRequest(req);

  // Must be rejected under PERMISSION_DENIED
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error.code, "PERMISSION_DENIED");

  // Compute provider must never have been invoked
  assertEquals(compute.receivedInvocations.length, 0);
});

Deno.test("Security PLAT-4 & FN-7: Call depth header tampering and malformed values are neutralized", async () => {
  const compute = new TrackingComputeProvider();
  const dispatcher = new RuntimeDispatcher({
    computeProvider: compute,
    resolveRoute: () => createSecureTarget(),
    callDepthMax: 8,
  });

  // Attempt 1: Negative call depth to attempt bypass of limit
  const negativeReq = new Request("http://localhost:8080/bypass", {
    headers: { "x-railfog-call-depth": "-999" },
  });
  const res1 = await dispatcher.handleRequest(negativeReq);
  assertEquals(res1.status, 200);
  // Neutralized to 0 + 1 = 1
  assertEquals(res1.headers.get("x-railfog-call-depth"), "1");

  // Attempt 2: Non-numeric malicious payload in call depth
  const payloadReq = new Request("http://localhost:8080/bypass", {
    headers: { "x-railfog-call-depth": "NaN; DROP TABLE users; --" },
  });
  const res2 = await dispatcher.handleRequest(payloadReq);
  assertEquals(res2.status, 200);
  // Non-numeric neutralized to 0 + 1 = 1
  assertEquals(res2.headers.get("x-railfog-call-depth"), "1");

  // Attempt 3: Floating point or overflow
  const overflowReq = new Request("http://localhost:8080/bypass", {
    headers: { "x-railfog-call-depth": "9999999999" },
  });
  const res3 = await dispatcher.handleRequest(overflowReq);
  assertEquals(res3.status, 429);
  const body3 = await res3.json();
  assertEquals(body3.error.code, "CALL_DEPTH_EXCEEDED");
});
