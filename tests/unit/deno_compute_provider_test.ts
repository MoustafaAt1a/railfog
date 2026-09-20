// spec: contracts/platform.contract.md#PLAT-4 — Isolation, defense in depth
// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction: ComputeProvider & IsolationProvider
// spec: docs/adr/0001-isolation-provider-invocation-protocol.md#ADR-0001
// spec: tasks/milestone-0.7-repo-consolidation/T-0706-deno-compute-provider-adapter.md

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  DenoComputeProvider,
  type DenoComputeProviderOptions,
} from "../../providers/compute/mod.ts";
import type {
  Artifact,
  ExecutionResult,
  InvocationRequest,
  IsolationProvider,
  Limits,
} from "../../primitives/compute/compute-provider.ts";

function createMockArtifact(): Artifact {
  return {
    id:
      "sha256:11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
    integrity: "sha256-ESIzRFVmd4mZAKq7zN3u/xEiM0RVZneJmQCqu8zd7v8=",
    entrypoint: "api.ts",
    code: new TextEncoder().encode("export default () => new Response('ok');"),
  };
}

function createMockLimits(): Limits {
  return {
    cpuMs: 200,
    timeoutMs: 30_000,
    memoryMb: 128,
    concurrency: 50,
  };
}

Deno.test("T-0706: DenoComputeProvider initializes and exposes isolation provider (PLAT-16)", () => {
  const mockIsolation: IsolationProvider = {
    run: (_artifact, _limits, _invocation) =>
      Promise.resolve({} as ExecutionResult),
  };

  const provider = new DenoComputeProvider({
    isolationProvider: mockIsolation,
  });
  assertEquals(provider.isolation, mockIsolation);
});

Deno.test("T-0706: DenoComputeProvider requires isolationProvider in options", () => {
  assertThrows(
    () => {
      new DenoComputeProvider({} as unknown as DenoComputeProviderOptions);
    },
    Error,
    "isolationProvider",
  );
});

Deno.test("T-0706: DenoComputeProvider forwards invocation and returns ExecutionResult (PLAT-4, PLAT-16)", async () => {
  let capturedArtifact: Artifact | undefined;
  let capturedLimits: Limits | undefined;
  let capturedInvocation: InvocationRequest | undefined;

  const mockResult: ExecutionResult = {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify({ success: true })),
    cpuTimeMs: 12,
    wallClockMs: 25,
  };

  const mockIsolation: IsolationProvider = {
    run: (artifact, limits, invocation) => {
      capturedArtifact = artifact;
      capturedLimits = limits;
      capturedInvocation = invocation;
      return Promise.resolve(mockResult);
    },
  };

  const provider = new DenoComputeProvider({
    isolationProvider: mockIsolation,
  });
  const artifact = createMockArtifact();
  const limits = createMockLimits();
  const invocation: InvocationRequest = {
    requestId: "01J8Z9W6T8NGR6S00000000000",
    method: "POST",
    url: "https://example.com/items",
    headers: { authorization: "Bearer secret" },
    body: new TextEncoder().encode("test-payload"),
  };

  const result = await provider.run(artifact, limits, invocation);

  assertEquals(result, mockResult);
  assertEquals(capturedArtifact, artifact);
  assertEquals(capturedLimits, limits);
  assertEquals(capturedInvocation, invocation);
});

Deno.test("T-0706: DenoComputeProvider synthesizes default GET invocation if omitted (ADR-0001)", async () => {
  let capturedInvocation: InvocationRequest | undefined;

  const mockIsolation: IsolationProvider = {
    run: (_artifact, _limits, invocation) => {
      capturedInvocation = invocation;
      return Promise.resolve({
        statusCode: 200,
        headers: {},
        body: new Uint8Array(),
        cpuTimeMs: 5,
        wallClockMs: 10,
      });
    },
  };

  const provider = new DenoComputeProvider({
    isolationProvider: mockIsolation,
  });
  const artifact = createMockArtifact();
  const limits = createMockLimits();

  // Call run without invocation argument
  await provider.run(artifact, limits);

  assert(
    capturedInvocation !== undefined,
    "Default invocation must be synthesized",
  );
  assertEquals(capturedInvocation.method, "GET");
  assert(
    capturedInvocation.requestId !== undefined &&
      capturedInvocation.requestId.length > 0,
  );
});

Deno.test("T-0706: DenoComputeProvider cleanly bubbles underlying isolation errors without masking", async () => {
  const customError = new Error("Sandbox memory limit exceeded");
  const mockIsolation: IsolationProvider = {
    run: () => Promise.reject(customError),
  };

  const provider = new DenoComputeProvider({
    isolationProvider: mockIsolation,
  });
  const artifact = createMockArtifact();
  const limits = createMockLimits();

  await assertRejects(
    async () => {
      await provider.run(artifact, limits);
    },
    Error,
    "Sandbox memory limit exceeded",
  );
});
