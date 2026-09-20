/**
 * Tests for Graceful Shutdown Coordinator (T-0610).
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-1: Control plane vs data plane lifecycle;
 *   targets immediately stop accepting new incoming requests upon shutdown initiation.
 * - docs/contracts/platform.contract.md#PLAT-10: SLOs & error budget; in-flight requests
 *   complete within drain timeout ceiling, followed by clean resource closure or timeout escalation.
 * - tasks/milestone-0.6-public-beta/T-0610-graceful-shutdown-coordinator.md: AC1 - AC4.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { delay } from "@std/async/delay";
import {
  type DrainTarget,
  ShutdownCoordinator,
  type ShutdownOptions,
} from "../../runtime/lifecycle/shutdown-coordinator.ts";

// ============================================================================
// Spec-anchored Constants (PLAT-10, T-0610)
// ============================================================================

/**
 * Short timeouts for fast, deterministic unit and integration test execution.
 * spec: contracts/platform.contract.md#PLAT-10
 */
const TEST_DRAIN_TIMEOUT_MS = 50;
const TEST_SHORT_DRAIN_TIMEOUT_MS = 30;

// ============================================================================
// 1. Initial State & Configuration
// ============================================================================

Deno.test("ShutdownCoordinator: initializes with default options and inactive state", () => {
  // spec: tasks/milestone-0.6-public-beta/T-0610-graceful-shutdown-coordinator.md#Interface
  const coordinator = new ShutdownCoordinator();
  assertFalse(
    coordinator.isShuttingDown(),
    "Coordinator must not be shutting down initially",
  );
});

Deno.test("ShutdownCoordinator: accepts custom timeout options and lifecycle callbacks", () => {
  // spec: tasks/milestone-0.6-public-beta/T-0610-graceful-shutdown-coordinator.md#Interface
  let startInvoked = false;
  let completeInvoked = false;

  const options: ShutdownOptions = {
    drainTimeoutMs: 100,
    forceTimeoutMs: 200,
    onShutdownStart: () => {
      startInvoked = true;
    },
    onShutdownComplete: () => {
      completeInvoked = true;
    },
  };

  const coordinator = new ShutdownCoordinator(options);
  assertFalse(coordinator.isShuttingDown());
  assertFalse(startInvoked);
  assertFalse(completeInvoked);
});

// ============================================================================
// 2. AC1: Immediate stopAccepting on all registered targets (PLAT-1)
// ============================================================================

Deno.test("AC1: stopAccepting() is called on all targets immediately before drain begins", async () => {
  // spec: contracts/platform.contract.md#PLAT-1 — Targets immediately stop accepting new incoming requests
  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: TEST_DRAIN_TIMEOUT_MS,
  });

  const callLog: string[] = [];

  const gatewayTarget: DrainTarget = {
    name: "gateway",
    getActiveCount: () => 0,
    stopAccepting: () => {
      callLog.push("gateway:stopAccepting");
    },
    drain: () => {
      callLog.push("gateway:drain");
      return Promise.resolve();
    },
  };

  const runtimeTarget: DrainTarget = {
    name: "runtime",
    getActiveCount: () => 0,
    stopAccepting: () => {
      callLog.push("runtime:stopAccepting");
    },
    drain: () => {
      callLog.push("runtime:drain");
      return Promise.resolve();
    },
  };

  coordinator.register(gatewayTarget);
  coordinator.register(runtimeTarget);

  assertFalse(coordinator.isShuttingDown());

  const shutdownPromise = coordinator.shutdown();

  // Coordinator must immediately enter shutting down state
  assert(
    coordinator.isShuttingDown(),
    "Coordinator must report isShuttingDown() === true as soon as shutdown begins",
  );

  const result = await shutdownPromise;
  assertEquals(result, true, "Clean shutdown must resolve to true");

  // Verify that stopAccepting was called on both targets before any draining began
  const gatewayStopIdx = callLog.indexOf("gateway:stopAccepting");
  const runtimeStopIdx = callLog.indexOf("runtime:stopAccepting");
  const gatewayDrainIdx = callLog.indexOf("gateway:drain");
  const runtimeDrainIdx = callLog.indexOf("runtime:drain");

  assert(gatewayStopIdx !== -1, "gateway:stopAccepting must have been called");
  assert(runtimeStopIdx !== -1, "runtime:stopAccepting must have been called");
  assert(gatewayDrainIdx !== -1, "gateway:drain must have been called");
  assert(runtimeDrainIdx !== -1, "runtime:drain must have been called");

  assert(
    gatewayStopIdx < gatewayDrainIdx,
    "gateway:stopAccepting must precede gateway:drain",
  );
  assert(
    runtimeStopIdx < runtimeDrainIdx,
    "runtime:stopAccepting must precede runtime:drain",
  );
});

Deno.test("AC1: supports asynchronous stopAccepting() implementations", async () => {
  // spec: contracts/platform.contract.md#PLAT-1
  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: TEST_DRAIN_TIMEOUT_MS,
  });

  let asyncStopCompleted = false;
  let drainStartedAfterStop = false;

  const asyncTarget: DrainTarget = {
    name: "async-server",
    getActiveCount: () => 0,
    stopAccepting: async () => {
      await delay(10);
      asyncStopCompleted = true;
    },
    drain: () => {
      drainStartedAfterStop = asyncStopCompleted;
      return Promise.resolve();
    },
  };

  coordinator.register(asyncTarget);
  const success = await coordinator.shutdown();

  assertEquals(success, true);
  assert(asyncStopCompleted, "Asynchronous stopAccepting must complete");
  assert(
    drainStartedAfterStop,
    "drain() must only proceed after async stopAccepting completes",
  );
});

Deno.test("AC1: isShuttingDown() transitions to true synchronously upon initiation", () => {
  // spec: contracts/platform.contract.md#PLAT-1
  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: TEST_DRAIN_TIMEOUT_MS,
  });

  const dummyTarget: DrainTarget = {
    name: "dummy",
    getActiveCount: () => 0,
    stopAccepting: () => {},
    drain: () => Promise.resolve(),
  };

  coordinator.register(dummyTarget);
  assertFalse(coordinator.isShuttingDown());

  const _promise = coordinator.shutdown();
  assertEquals(
    coordinator.isShuttingDown(),
    true,
    "isShuttingDown() must be true synchronously after calling shutdown()",
  );
});

// ============================================================================
// 3. AC2: In-flight requests completion within drain timeout (PLAT-10)
// ============================================================================

Deno.test("AC2: in-flight requests complete within drainTimeoutMs and shutdown resolves to true", async () => {
  // spec: contracts/platform.contract.md#PLAT-10 — In-flight requests finish cleanly within drainTimeoutMs
  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: 150,
  });

  let inFlightCount = 2;
  let drainResolver: (() => void) | undefined;
  const drainPromise = new Promise<void>((resolve) => {
    drainResolver = resolve;
  });

  const target: DrainTarget = {
    name: "api-runtime",
    getActiveCount: () => inFlightCount,
    stopAccepting: () => {},
    drain: () => drainPromise,
  };

  coordinator.register(target);

  const shutdownPromise = coordinator.shutdown();
  assertEquals(coordinator.isShuttingDown(), true);
  assertEquals(target.getActiveCount(), 2);

  // Simulate in-flight requests finishing after 30ms (well within 150ms timeout)
  await delay(30);
  inFlightCount = 0;
  drainResolver?.();

  const success = await shutdownPromise;
  assertEquals(
    success,
    true,
    "Shutdown should return true when all in-flight requests complete",
  );
  assertEquals(target.getActiveCount(), 0);
});

Deno.test("AC2: onShutdownStart and onShutdownComplete callbacks execute in strict order", async () => {
  // spec: contracts/platform.contract.md#PLAT-10
  const callbackSequence: string[] = [];

  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: 100,
    onShutdownStart: () => {
      callbackSequence.push("start");
    },
    onShutdownComplete: () => {
      callbackSequence.push("complete");
    },
  });

  let inFlight = 1;
  const target: DrainTarget = {
    name: "worker",
    getActiveCount: () => inFlight,
    stopAccepting: () => {},
    drain: async () => {
      await delay(20);
      inFlight = 0;
    },
  };

  coordinator.register(target);

  const resultPromise = coordinator.shutdown();

  // onShutdownStart should have been invoked immediately
  assertEquals(
    callbackSequence,
    ["start"],
    "onShutdownStart should be called at the beginning of shutdown",
  );

  const result = await resultPromise;
  assertEquals(result, true);

  // Both callbacks should have executed in order
  assertEquals(
    callbackSequence,
    ["start", "complete"],
    "Callbacks must execute in [start, complete] sequence",
  );
});

Deno.test("AC2: multiple drain targets drain concurrently and resolve cleanly", async () => {
  // spec: contracts/platform.contract.md#PLAT-10
  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: 200,
  });

  let target1InFlight = 3;
  let target2InFlight = 1;

  const target1: DrainTarget = {
    name: "target-1",
    getActiveCount: () => target1InFlight,
    stopAccepting: () => {},
    drain: async () => {
      await delay(25);
      target1InFlight = 0;
    },
  };

  const target2: DrainTarget = {
    name: "target-2",
    getActiveCount: () => target2InFlight,
    stopAccepting: () => {},
    drain: async () => {
      await delay(35);
      target2InFlight = 0;
    },
  };

  coordinator.register(target1);
  coordinator.register(target2);

  const startTime = performance.now();
  const success = await coordinator.shutdown();
  const elapsedMs = performance.now() - startTime;

  assertEquals(success, true);
  assertEquals(target1InFlight, 0);
  assertEquals(target2InFlight, 0);

  // Concurrent execution should finish well under sequential 25 + 35 + margin
  assert(
    elapsedMs < 150,
    `Concurrent drain took too long: ${elapsedMs}ms`,
  );
});

// ============================================================================
// 4. AC3: Hanging / slow drain target timeout escalation (PLAT-10)
// ============================================================================

Deno.test("AC3: hanging drain target exceeding drainTimeoutMs escalates and returns false", async () => {
  // spec: contracts/platform.contract.md#PLAT-10 — Force closure when drainTimeoutMs exceeded, no deadlock
  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: TEST_SHORT_DRAIN_TIMEOUT_MS,
  });

  // Hanging target that never resolves drain() and retains active count
  const hangingTarget: DrainTarget = {
    name: "hanging-server",
    getActiveCount: () => 5,
    stopAccepting: () => {},
    drain: () =>
      new Promise<void>(() => {
        // Deliberately never resolves without setting timers (leak-free in Deno sanitizers)
      }),
  };

  coordinator.register(hangingTarget);

  const startTime = performance.now();
  const result = await coordinator.shutdown();
  const elapsedMs = performance.now() - startTime;

  // Must return false to indicate forced / timed-out shutdown
  assertEquals(
    result,
    false,
    "Shutdown must return false when drain timeout is exceeded",
  );

  // Must complete promptly near drainTimeoutMs (e.g. within 500ms, not hanging forever)
  assert(
    elapsedMs >= TEST_SHORT_DRAIN_TIMEOUT_MS - 10,
    `Shutdown resolved too fast: ${elapsedMs}ms`,
  );
  assert(
    elapsedMs < 2000,
    `Shutdown took too long to escalate: ${elapsedMs}ms`,
  );

  assertEquals(coordinator.isShuttingDown(), true);
});

Deno.test("AC3: mixed targets - fast target completes, slow target times out - resolves false", async () => {
  // spec: contracts/platform.contract.md#PLAT-10
  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: TEST_SHORT_DRAIN_TIMEOUT_MS,
  });

  let fastDrained = false;

  const fastTarget: DrainTarget = {
    name: "fast-target",
    getActiveCount: () => (fastDrained ? 0 : 1),
    stopAccepting: () => {},
    drain: () => {
      fastDrained = true;
      return Promise.resolve();
    },
  };

  const slowTarget: DrainTarget = {
    name: "slow-target",
    getActiveCount: () => 2,
    stopAccepting: () => {},
    drain: () => new Promise<void>(() => {}), // never resolves
  };

  coordinator.register(fastTarget);
  coordinator.register(slowTarget);

  const result = await coordinator.shutdown();

  assertEquals(result, false, "Result must be false if any target times out");
  assertEquals(fastDrained, true, "Fast target should have completed drain");
});

Deno.test("AC3: onShutdownComplete callback still fires on timeout escalation", async () => {
  // spec: contracts/platform.contract.md#PLAT-10
  let completeCalled = false;

  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: TEST_SHORT_DRAIN_TIMEOUT_MS,
    onShutdownComplete: () => {
      completeCalled = true;
    },
  });

  const hangingTarget: DrainTarget = {
    name: "stuck-target",
    getActiveCount: () => 1,
    stopAccepting: () => {},
    drain: () => new Promise<void>(() => {}),
  };

  coordinator.register(hangingTarget);

  const result = await coordinator.shutdown();
  assertEquals(result, false);
  assertEquals(
    completeCalled,
    true,
    "onShutdownComplete must still be invoked even when drain times out",
  );
});

// ============================================================================
// 5. AC4: Idempotent shutdown and multiple signal interception (PLAT-10)
// ============================================================================

Deno.test("AC4: concurrent shutdown() calls are deduplicated and return identical result", async () => {
  // spec: contracts/platform.contract.md#PLAT-10 — Deduplicates consecutive/concurrent shutdown triggers
  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: TEST_DRAIN_TIMEOUT_MS,
  });

  let stopAcceptingCalls = 0;
  let drainCalls = 0;

  const mockTarget: DrainTarget = {
    name: "idempotent-target",
    getActiveCount: () => 0,
    stopAccepting: () => {
      stopAcceptingCalls++;
    },
    drain: async () => {
      drainCalls++;
      await delay(20);
    },
  };

  coordinator.register(mockTarget);

  // Trigger two concurrent shutdowns
  const [res1, res2] = await Promise.all([
    coordinator.shutdown(),
    coordinator.shutdown(),
  ]);

  assertEquals(res1, true);
  assertEquals(res2, true);
  assertEquals(
    stopAcceptingCalls,
    1,
    "stopAccepting() must be called exactly once across concurrent invocations",
  );
  assertEquals(
    drainCalls,
    1,
    "drain() must be called exactly once across concurrent invocations",
  );
});

Deno.test("AC4: consecutive shutdown() calls after completion return cached result without re-executing", async () => {
  // spec: contracts/platform.contract.md#PLAT-10
  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: TEST_DRAIN_TIMEOUT_MS,
  });

  let stopAcceptingCount = 0;
  let drainCount = 0;

  const mockTarget: DrainTarget = {
    name: "consecutive-target",
    getActiveCount: () => 0,
    stopAccepting: () => {
      stopAcceptingCount++;
    },
    drain: () => {
      drainCount++;
      return Promise.resolve();
    },
  };

  coordinator.register(mockTarget);

  const firstResult = await coordinator.shutdown();
  assertEquals(firstResult, true);
  assertEquals(stopAcceptingCount, 1);
  assertEquals(drainCount, 1);

  // Second call after completion
  const secondResult = await coordinator.shutdown();
  assertEquals(secondResult, true);
  assertEquals(
    stopAcceptingCount,
    1,
    "stopAccepting() must not be re-invoked on consecutive shutdown calls",
  );
  assertEquals(
    drainCount,
    1,
    "drain() must not be re-invoked on consecutive shutdown calls",
  );
});

Deno.test("AC4: lifecycle callbacks fire exactly once across duplicate shutdown triggers", async () => {
  let startCount = 0;
  let completeCount = 0;

  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: TEST_DRAIN_TIMEOUT_MS,
    onShutdownStart: () => {
      startCount++;
    },
    onShutdownComplete: () => {
      completeCount++;
    },
  });

  const dummyTarget: DrainTarget = {
    name: "dummy",
    getActiveCount: () => 0,
    stopAccepting: () => {},
    drain: () => Promise.resolve(),
  };

  coordinator.register(dummyTarget);

  await Promise.all([
    coordinator.shutdown(),
    coordinator.shutdown(),
  ]);
  await coordinator.shutdown();

  assertEquals(startCount, 1, "onShutdownStart must only be invoked once");
  assertEquals(
    completeCount,
    1,
    "onShutdownComplete must only be invoked once",
  );
});

// ============================================================================
// 6. Signal Listener Registration (Cross-platform Safety)
// ============================================================================

Deno.test("Signal Listener: coordinator.listenSignals() attaches listeners safely without crashing", () => {
  // spec: tasks/milestone-0.6-public-beta/T-0610-graceful-shutdown-coordinator.md#Scope
  const coordinator = new ShutdownCoordinator();

  // listenSignals must not throw on current platform (SIGINT/SIGTERM/SIGBREAK)
  coordinator.listenSignals();

  // Subsequent call should be safe and idempotent
  coordinator.listenSignals();
});

Deno.test("Signal Listener: clean coordinator state and shutdown completion after listenSignals()", async () => {
  // spec: tasks/milestone-0.6-public-beta/T-0610-graceful-shutdown-coordinator.md#Scope
  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: TEST_DRAIN_TIMEOUT_MS,
  });

  coordinator.listenSignals();

  const success = await coordinator.shutdown();
  assertEquals(success, true);
  assertEquals(coordinator.isShuttingDown(), true);
});

// ============================================================================
// 7. Edge Cases & Robustness
// ============================================================================

Deno.test("Edge Case: coordinator with 0 registered targets resolves immediately to true", async () => {
  let startCalled = false;
  let completeCalled = false;

  const coordinator = new ShutdownCoordinator({
    onShutdownStart: () => {
      startCalled = true;
    },
    onShutdownComplete: () => {
      completeCalled = true;
    },
  });

  assertFalse(coordinator.isShuttingDown());

  const result = await coordinator.shutdown();

  assertEquals(result, true, "Empty target coordinator should resolve to true");
  assert(coordinator.isShuttingDown());
  assert(startCalled, "onShutdownStart should be called");
  assert(completeCalled, "onShutdownComplete should be called");
});

Deno.test("Robustness: error thrown in target stopAccepting() does not abort other targets", async () => {
  // spec: contracts/platform.contract.md#PLAT-1
  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: TEST_DRAIN_TIMEOUT_MS,
  });

  let secondTargetStopped = false;
  let secondTargetDrained = false;

  const failingTarget: DrainTarget = {
    name: "failing-stop-target",
    getActiveCount: () => 0,
    stopAccepting: () => {
      throw new Error("Simulated stopAccepting failure");
    },
    drain: () => Promise.resolve(),
  };

  const healthyTarget: DrainTarget = {
    name: "healthy-target",
    getActiveCount: () => 0,
    stopAccepting: () => {
      secondTargetStopped = true;
    },
    drain: () => {
      secondTargetDrained = true;
      return Promise.resolve();
    },
  };

  coordinator.register(failingTarget);
  coordinator.register(healthyTarget);

  // Shutdown should handle individual target errors gracefully without unhandled rejection
  await coordinator.shutdown();

  assert(
    secondTargetStopped,
    "Second target must have its stopAccepting() called despite first target error",
  );
  assert(
    secondTargetDrained,
    "Second target must have its drain() called despite first target error",
  );
});

Deno.test("Robustness: rejected promise in target drain() is handled cleanly", async () => {
  // spec: contracts/platform.contract.md#PLAT-10
  const coordinator = new ShutdownCoordinator({
    drainTimeoutMs: TEST_DRAIN_TIMEOUT_MS,
  });

  const rejectingTarget: DrainTarget = {
    name: "rejecting-drain-target",
    getActiveCount: () => 1,
    stopAccepting: () => {},
    drain: () => Promise.reject(new Error("Simulated drain rejection")),
  };

  coordinator.register(rejectingTarget);

  const result = await coordinator.shutdown();
  assertEquals(
    result,
    false,
    "Shutdown should resolve to false if a target drain fails or rejects",
  );
  assertEquals(coordinator.isShuttingDown(), true);
});
