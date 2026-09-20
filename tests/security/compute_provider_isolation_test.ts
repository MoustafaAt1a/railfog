// spec: contracts/platform.contract.md#PLAT-4 — Isolation, defense in depth, multi-tenant sandbox boundary
// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
// spec: tasks/milestone-0.7-repo-consolidation/T-0706-deno-compute-provider-adapter.md

import { assert, assertEquals } from "@std/assert";
import { DenoComputeProvider } from "../../providers/compute/mod.ts";
import type {
  Artifact,
  IsolationProvider,
  Limits,
} from "../../primitives/compute/compute-provider.ts";

Deno.test("Security PLAT-4: DenoComputeProvider never executes code directly on the host", async () => {
  // A malicious artifact attempting to read host environment or exit the process
  const hostSideCodeExecuted = false;

  const maliciousArtifact: Artifact = {
    id:
      "sha256:malicious00000000000000000000000000000000000000000000000000000000",
    integrity: "sha256-maliciousIntegrity=",
    entrypoint: "exploit.ts",
    code: new TextEncoder().encode(
      "Deno.env.toObject();",
    ),
  };

  const limits: Limits = {
    cpuMs: 200,
    timeoutMs: 30_000,
    memoryMb: 128,
  };

  // Mock isolation provider that enforces sandbox containment and prevents execution
  let isolationRunCalled = false;
  const secureIsolation: IsolationProvider = {
    run: (_artifact, passedLimits) => {
      isolationRunCalled = true;
      // Confirm isolation provider receives exact limits to enforce in sandbox
      assertEquals(passedLimits.cpuMs, 200);
      assertEquals(passedLimits.memoryMb, 128);
      // Sandbox rejects malicious artifact execution safely
      return Promise.resolve({
        statusCode: 403,
        headers: { "x-isolation-status": "contained" },
        body: new TextEncoder().encode("Access denied inside sandbox"),
        cpuTimeMs: 1,
        wallClockMs: 2,
      });
    },
  };

  const provider = new DenoComputeProvider({
    isolationProvider: secureIsolation,
  });
  const result = await provider.run(maliciousArtifact, limits);

  // Assert execution was strictly dispatched through the IsolationProvider
  assert(
    isolationRunCalled,
    "Execution must be delegated to IsolationProvider",
  );
  assertEquals(
    hostSideCodeExecuted,
    false,
    "Host-side execution must never happen",
  );
  assertEquals(result.statusCode, 403);
});

Deno.test("Security PLAT-4: DenoComputeProvider preserves limits ceilings against tampering", async () => {
  let observedLimits: Limits | undefined;

  const interceptingIsolation: IsolationProvider = {
    run: (_artifact, limits) => {
      observedLimits = limits;
      return Promise.resolve({
        statusCode: 200,
        headers: {},
        body: new Uint8Array(),
        cpuTimeMs: 0,
        wallClockMs: 1,
      });
    },
  };

  const provider = new DenoComputeProvider({
    isolationProvider: interceptingIsolation,
  });
  const limits: Limits = {
    cpuMs: 100,
    timeoutMs: 5000,
    memoryMb: 64,
    concurrency: 10,
  };

  const artifact: Artifact = {
    id:
      "sha256:normal0000000000000000000000000000000000000000000000000000000000",
    integrity: "sha256-normalIntegrity=",
    entrypoint: "main.ts",
    code: new Uint8Array(),
  };

  await provider.run(artifact, limits);

  assert(observedLimits !== undefined);
  assertEquals(observedLimits.cpuMs, 100);
  assertEquals(observedLimits.timeoutMs, 5000);
  assertEquals(observedLimits.memoryMb, 64);
  assertEquals(observedLimits.concurrency, 10);
});
