/**
 * Comprehensive test suite for KV Atomic Circuit Breaker.
 *
 * Spec references:
 * - docs/contracts/queues.contract.md#Q-6 (Composed reliability patterns as library code over kv.atomic())
 * - docs/contracts/kv.contract.md#KV-3 (Optimistic concurrency / CAS: check, set, commit, conflict retry)
 * - docs/contracts/kv.contract.md#KV-5 (Consistency tiers: circuit-breaker state backed by strong tier)
 * - docs/contracts/platform.contract.md#PLAT-10 (Runtime SLOs and error budget)
 * - docs/contracts/platform.contract.md#PLAT-12 (Error model: UNAVAILABLE error code)
 * - tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md (AC1 - AC7, Tests required)
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "@std/assert";
import { UnavailableError } from "../../packages/errors/mod.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import type {
  KVAtomicBuilder,
  KVProvider,
} from "../../primitives/kv/kv-provider.ts";
import {
  type CircuitBreakerStateRecord,
  type CircuitState,
  createCircuitBreaker,
} from "../../packages/policy/circuit-breaker.ts";

function createMemoryKV(): SQLiteKVProvider {
  // spec: contracts/kv.contract.md#KV-5 — strong tier backing circuit-breaker state
  return new SQLiteKVProvider(":memory:");
}

// ============================================================================
// AC1: Closed State & Normal Execution
// ============================================================================

Deno.test("AC1 (Unit): Initial breaker state defaults to Closed with zeroed counters (Q-6, KV-3)", async () => {
  // spec: contracts/queues.contract.md#Q-6
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#Assumptions
  // When kv.get(circuitKey) returns null, breaker initializes in Closed state with version 0.
  const kv = createMemoryKV();
  const circuitKey = ["circuit_breaker", "payment_service"];
  const breaker = createCircuitBreaker(kv, circuitKey);

  const state: CircuitBreakerStateRecord = await breaker.getState();
  assertEquals(state.state, "Closed" as CircuitState);
  assertEquals(state.consecutiveFailures, 0);
  assertEquals(state.consecutiveSuccesses, 0);
  assertEquals(state.version, 0);
});

Deno.test("AC1: Given new circuit breaker in Closed state, when operation succeeds, then result returned and consecutiveFailures remains 0", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#AC1
  const kv = createMemoryKV();
  const breaker = createCircuitBreaker(kv, ["circuit_breaker", "test_ac1"]);

  let executionCount = 0;
  const result = await breaker.execute(async () => {
    await Promise.resolve();
    executionCount++;
    return "ok_result";
  });

  assertEquals(result, "ok_result");
  assertEquals(executionCount, 1);

  const state = await breaker.getState();
  assertEquals(state.state, "Closed");
  assertEquals(state.consecutiveFailures, 0);
});

Deno.test("AC1: Multiple consecutive successful operations return results and preserve consecutiveFailures = 0", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#AC1
  const kv = createMemoryKV();
  const breaker = createCircuitBreaker(kv, [
    "circuit_breaker",
    "test_ac1_multi",
  ]);

  for (let i = 0; i < 5; i++) {
    const res = await breaker.execute(async () => {
      await Promise.resolve();
      return `val_${i}`;
    });
    assertEquals(res, `val_${i}`);
  }

  const state = await breaker.getState();
  assertEquals(state.state, "Closed");
  assertEquals(state.consecutiveFailures, 0);
});

Deno.test("AC1: Successful operation resets non-zero consecutiveFailures counter in Closed state", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#AC1
  const kv = createMemoryKV();
  const breaker = createCircuitBreaker(kv, [
    "circuit_breaker",
    "test_ac1_reset",
  ], {
    failureThreshold: 5,
  });

  // 2 failures (less than threshold 5)
  for (let i = 0; i < 2; i++) {
    await assertRejects(
      () =>
        breaker.execute(async () => {
          await Promise.resolve();
          throw new Error("transient error");
        }),
      Error,
      "transient error",
    );
  }

  let state = await breaker.getState();
  assertEquals(state.state, "Closed");
  assertEquals(state.consecutiveFailures, 2);

  // Next operation succeeds
  const result = await breaker.execute(async () => {
    await Promise.resolve();
    return "recovered";
  });
  assertEquals(result, "recovered");

  // consecutiveFailures must be reset to 0
  state = await breaker.getState();
  assertEquals(state.state, "Closed");
  assertEquals(state.consecutiveFailures, 0);
});

// ============================================================================
// AC2: Closed to Open Transition on Failure Threshold
// ============================================================================

Deno.test("AC2 (Unit): Given Closed state, 5 consecutive failures trip breaker to Open via kv.atomic() CAS", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#AC2
  // spec: contracts/kv.contract.md#KV-3 — atomic state updates with CAS
  const kv = createMemoryKV();
  const breaker = createCircuitBreaker(kv, [
    "circuit_breaker",
    "test_ac2_default",
  ]);

  // 4 failures: remains Closed
  for (let i = 1; i <= 4; i++) {
    await assertRejects(
      () =>
        breaker.execute(async () => {
          await Promise.resolve();
          throw new Error(`err_${i}`);
        }),
      Error,
      `err_${i}`,
    );

    const interimState = await breaker.getState();
    assertEquals(interimState.state, "Closed");
    assertEquals(interimState.consecutiveFailures, i);
  }

  // 5th failure: transitions to Open
  await assertRejects(
    () =>
      breaker.execute(async () => {
        await Promise.resolve();
        throw new Error("err_5");
      }),
    Error,
    "err_5",
  );

  const openState = await breaker.getState();
  assertEquals(openState.state, "Open");
  assertEquals(openState.consecutiveFailures, 5);

  // 6th call: fails fast with UnavailableError without executing operation
  let operationCalled = false;
  const err = await assertRejects(
    () =>
      breaker.execute(async () => {
        await Promise.resolve();
        operationCalled = true;
        return "should_not_run";
      }),
    UnavailableError,
  );

  assertEquals(
    operationCalled,
    false,
    "Operation must not be invoked when Open",
  );
  assertEquals(
    err.code,
    "UNAVAILABLE",
    "Error code must match PLAT-12 UNAVAILABLE",
  );
});

Deno.test("AC2 (Unit): Custom failureThreshold trips breaker at configured count", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#AC2
  const kv = createMemoryKV();
  const breaker = createCircuitBreaker(kv, [
    "circuit_breaker",
    "test_ac2_custom",
  ], {
    failureThreshold: 3,
  });

  for (let i = 1; i <= 2; i++) {
    await assertRejects(
      () =>
        breaker.execute(async () => {
          await Promise.resolve();
          throw new Error("intermittent failure");
        }),
      Error,
      "intermittent failure",
    );
    const s = await breaker.getState();
    assertEquals(s.state, "Closed");
    assertEquals(s.consecutiveFailures, i);
  }

  // 3rd failure trips to Open
  await assertRejects(
    () =>
      breaker.execute(async () => {
        await Promise.resolve();
        throw new Error("tripping failure");
      }),
    Error,
    "tripping failure",
  );

  const state = await breaker.getState();
  assertEquals(state.state, "Open");
  assertEquals(state.consecutiveFailures, 3);
});

// ============================================================================
// AC3 & Checklist (2): Fast-fail rejection when Open (PLAT-12)
// ============================================================================

Deno.test("AC3 & Checklist (2): Calls fast-fail immediately with UnavailableError (PLAT-12 UNAVAILABLE) during cooldown", async () => {
  // spec: contracts/platform.contract.md#PLAT-12 — UNAVAILABLE error code
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#AC3
  const kv = createMemoryKV();
  let currentTime = 10_000;
  const cooldownMs = 30_000;

  const breaker = createCircuitBreaker(kv, ["circuit_breaker", "test_ac3"], {
    failureThreshold: 2,
    cooldownMs,
    nowProvider: () => currentTime,
  });

  // Trip to Open
  for (let i = 0; i < 2; i++) {
    await assertRejects(() =>
      breaker.execute(async () => {
        await Promise.resolve();
        throw new Error("downstream error");
      })
    );
  }

  const openState = await breaker.getState();
  assertEquals(openState.state, "Open");

  // At cooldownMs - 1ms, still fast-fails
  currentTime += cooldownMs - 1;

  let probeAttempted = false;
  const err = await assertRejects(
    () =>
      breaker.execute(async () => {
        await Promise.resolve();
        probeAttempted = true;
        return "not_allowed";
      }),
    UnavailableError,
  );

  assertEquals(probeAttempted, false);
  assertEquals(err.code, "UNAVAILABLE");
  assertInstanceOf(err, UnavailableError);
});

Deno.test("AC3: Fast-fail rejections do not increment failure counters (Assumptions clause)", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#Assumptions
  // Operations that reject with UnavailableError generated by the breaker itself do not increment failure counters.
  const kv = createMemoryKV();
  const currentTime = 5_000;

  const breaker = createCircuitBreaker(kv, [
    "circuit_breaker",
    "test_ac3_counters",
  ], {
    failureThreshold: 2,
    cooldownMs: 10_000,
    nowProvider: () => currentTime,
  });

  // Trip to Open (2 failures)
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("fail 1");
    })
  );
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("fail 2");
    })
  );

  const stateBefore = await breaker.getState();
  assertEquals(stateBefore.consecutiveFailures, 2);

  // Attempt 5 fast-failing calls
  for (let i = 0; i < 5; i++) {
    await assertRejects(
      () =>
        breaker.execute(async () => {
          await Promise.resolve();
          return "fast_fail";
        }),
      UnavailableError,
    );
  }

  const stateAfter = await breaker.getState();
  assertEquals(
    stateAfter.consecutiveFailures,
    2,
    "Fast-fail rejections must not inflate consecutiveFailures",
  );
});

// ============================================================================
// AC4: Cooldown Elapsed Transitions to Half-Open
// ============================================================================

Deno.test("AC4 (Unit): When cooldownMs has elapsed, next call transitions to Half-Open and allows trial execution", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#AC4
  const kv = createMemoryKV();
  let currentTime = 10_000;
  const cooldownMs = 30_000;

  const breaker = createCircuitBreaker(kv, ["circuit_breaker", "test_ac4"], {
    failureThreshold: 2,
    cooldownMs,
    nowProvider: () => currentTime,
  });

  // Trip to Open at t = 10,000
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("trip 1");
    })
  );
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("trip 2");
    })
  );

  assertEquals((await breaker.getState()).state, "Open");

  // Advance time past cooldownMs: t = 40,000 (10,000 + 30,000)
  currentTime = 40_000;

  let trialExecuted = false;
  const result = await breaker.execute(async () => {
    await Promise.resolve();
    trialExecuted = true;
    return "trial_probe_ok";
  });

  assertEquals(
    trialExecuted,
    true,
    "Trial execution must be allowed after cooldown",
  );
  assertEquals(result, "trial_probe_ok");

  const state = await breaker.getState();
  assertEquals(state.state, "Half-Open");
  assertEquals(state.consecutiveSuccesses, 1);
  assertEquals(state.consecutiveFailures, 0);
});

// ============================================================================
// AC5: Half-Open to Closed on Success Threshold
// ============================================================================

Deno.test("AC5 (Unit): Given Half-Open state with halfOpenSuccessThreshold = 2, 2 successful trials transition state to Closed", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#AC5
  const kv = createMemoryKV();
  let currentTime = 1_000;

  const breaker = createCircuitBreaker(kv, [
    "circuit_breaker",
    "test_ac5_default",
  ], {
    failureThreshold: 2,
    cooldownMs: 5_000,
    halfOpenSuccessThreshold: 2,
    nowProvider: () => currentTime,
  });

  // Trip to Open
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("f1");
    })
  );
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("f2");
    })
  );

  // Advance past cooldown
  currentTime += 5_000;

  // 1st trial success: state is Half-Open, consecutiveSuccesses = 1
  const trial1 = await breaker.execute(async () => {
    await Promise.resolve();
    return "trial1_success";
  });
  assertEquals(trial1, "trial1_success");

  let state = await breaker.getState();
  assertEquals(state.state, "Half-Open");
  assertEquals(state.consecutiveSuccesses, 1);

  // 2nd trial success: state transitions to Closed, counters reset
  const trial2 = await breaker.execute(async () => {
    await Promise.resolve();
    return "trial2_success";
  });
  assertEquals(trial2, "trial2_success");

  state = await breaker.getState();
  assertEquals(state.state, "Closed");
  assertEquals(state.consecutiveSuccesses, 0);
  assertEquals(state.consecutiveFailures, 0);

  // Subsequent calls execute normally in Closed state
  const normalCall = await breaker.execute(async () => {
    await Promise.resolve();
    return "normal_ok";
  });
  assertEquals(normalCall, "normal_ok");
  assertEquals((await breaker.getState()).state, "Closed");
});

Deno.test("AC5 (Unit): Custom halfOpenSuccessThreshold requires configured consecutive successes", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#AC5
  const kv = createMemoryKV();
  let currentTime = 1_000;

  const breaker = createCircuitBreaker(kv, [
    "circuit_breaker",
    "test_ac5_custom",
  ], {
    failureThreshold: 1,
    cooldownMs: 2_000,
    halfOpenSuccessThreshold: 3,
    nowProvider: () => currentTime,
  });

  // Trip to Open
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("trip");
    })
  );

  currentTime += 2_000;

  // Trial 1
  await breaker.execute(async () => {
    await Promise.resolve();
    return "trial 1";
  });
  assertEquals((await breaker.getState()).state, "Half-Open");
  assertEquals((await breaker.getState()).consecutiveSuccesses, 1);

  // Trial 2
  await breaker.execute(async () => {
    await Promise.resolve();
    return "trial 2";
  });
  assertEquals((await breaker.getState()).state, "Half-Open");
  assertEquals((await breaker.getState()).consecutiveSuccesses, 2);

  // Trial 3: completes threshold -> Closed
  await breaker.execute(async () => {
    await Promise.resolve();
    return "trial 3";
  });
  const finalState = await breaker.getState();
  assertEquals(finalState.state, "Closed");
  assertEquals(finalState.consecutiveSuccesses, 0);
  assertEquals(finalState.consecutiveFailures, 0);
});

// ============================================================================
// AC6: Half-Open to Open on Trial Failure
// ============================================================================

Deno.test("AC6 (Unit): Given Half-Open state, trial call failure immediately reverts state to Open", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#AC6
  const kv = createMemoryKV();
  let currentTime = 10_000;
  const cooldownMs = 20_000;

  const breaker = createCircuitBreaker(kv, ["circuit_breaker", "test_ac6"], {
    failureThreshold: 2,
    cooldownMs,
    halfOpenSuccessThreshold: 2,
    nowProvider: () => currentTime,
  });

  // Trip to Open at t = 10,000
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("f1");
    })
  );
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("f2");
    })
  );

  // Advance past cooldown to t = 30,000
  currentTime = 30_000;

  // 1st trial succeeds -> Half-Open (consecutiveSuccesses = 1)
  await breaker.execute(async () => {
    await Promise.resolve();
    return "trial_1_ok";
  });
  assertEquals((await breaker.getState()).state, "Half-Open");

  // 2nd trial fails: error is rethrown, state reverts to Open immediately
  currentTime = 31_000;
  const errorThrown = await assertRejects(
    () =>
      breaker.execute(async () => {
        await Promise.resolve();
        throw new Error("downstream probe failure");
      }),
    Error,
    "downstream probe failure",
  );
  assertEquals(errorThrown.message, "downstream probe failure");

  const state = await breaker.getState();
  assertEquals(
    state.state,
    "Open",
    "Must immediately transition back to Open on trial failure",
  );
  assertEquals(state.consecutiveSuccesses, 0, "Trial successes must be reset");

  // Next call immediately fast-fails with UnavailableError (cooldown restarted at t = 31,000)
  currentTime = 32_000;
  let probeExecuted = false;
  await assertRejects(
    () =>
      breaker.execute(async () => {
        await Promise.resolve();
        probeExecuted = true;
        return "not_allowed";
      }),
    UnavailableError,
  );
  assertEquals(
    probeExecuted,
    false,
    "Must fast-fail after trial failure trips breaker to Open",
  );
});

// ============================================================================
// AC7 & Checklist (3): CAS Optimistic Concurrency Retry (KV-3)
// ============================================================================

/**
 * Proxy KVProvider that simulates CAS conflicts on atomic commit.
 */
class CASConflictSimulatingKVProvider implements KVProvider {
  private conflictsToInject: number;
  public conflictCount = 0;

  constructor(private inner: KVProvider, conflictsToInject = 1) {
    this.conflictsToInject = conflictsToInject;
  }

  get(key: string[]): Promise<unknown | null> {
    return this.inner.get(key);
  }

  set(key: string[], value: unknown, opts?: { ttl?: number }): Promise<void> {
    return this.inner.set(key, value, opts);
  }

  delete(key: string[]): Promise<void> {
    return this.inner.delete(key);
  }

  list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }> {
    return this.inner.list(prefix, opts);
  }

  atomic(): KVAtomicBuilder {
    const builder = this.inner.atomic();
    const originalCommit = builder.commit.bind(builder);

    builder.commit = async (): Promise<
      { ok: boolean; version?: number }
    > => {
      if (this.conflictCount < this.conflictsToInject) {
        this.conflictCount++;
        // Simulate concurrent process having modified the stored record
        // Spec reference: KV-3 (Optimistic concurrency CAS mismatch)
        return { ok: false };
      }
      return await originalCommit();
    };

    return builder;
  }
}

Deno.test("AC7 & Checklist (3): Given CAS mismatch during kv.atomic(), breaker retries and reapplies state updates without dropping failure counts", async () => {
  // spec: contracts/kv.contract.md#KV-3 — Optimistic concurrency CAS retry
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#AC7
  const memoryKV = createMemoryKV();
  const conflictKV = new CASConflictSimulatingKVProvider(memoryKV, 1);
  const circuitKey = ["circuit_breaker", "test_ac7_cas_retry"];

  const breaker = createCircuitBreaker(conflictKV, circuitKey, {
    failureThreshold: 3,
  });

  // Record a failure: the first commit() will return { ok: false }, triggering retry
  await assertRejects(
    () =>
      breaker.execute(async () => {
        await Promise.resolve();
        throw new Error("simulated failure with CAS conflict");
      }),
    Error,
    "simulated failure with CAS conflict",
  );

  // Verify that the conflict occurred and was recovered from
  assertEquals(
    conflictKV.conflictCount,
    1,
    "Exactly 1 CAS conflict must have been injected",
  );

  const state = await breaker.getState();
  assertEquals(state.state, "Closed");
  assertEquals(
    state.consecutiveFailures,
    1,
    "Failure count must not be dropped despite CAS conflict",
  );
  assert(state.version > 0, "State record version must be incremented");
});

Deno.test("AC7: Concurrent failing operations on same circuit breaker record all failures atomically", async () => {
  // spec: contracts/kv.contract.md#KV-3
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#AC7
  const kv = createMemoryKV();
  const circuitKey = ["circuit_breaker", "test_ac7_concurrent"];
  const breaker = createCircuitBreaker(kv, circuitKey, {
    failureThreshold: 10,
  });

  // Run 5 concurrent failing operations in parallel
  const tasks = Array.from({ length: 5 }, (_, idx) =>
    assertRejects(
      () =>
        breaker.execute(async () => {
          // Add micro-delay to encourage race conditions
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error(`concurrent_err_${idx}`);
        }),
      Error,
    ));

  await Promise.all(tasks);

  const state = await breaker.getState();
  assertEquals(
    state.consecutiveFailures,
    5,
    "All 5 concurrent failures must be recorded without dropping counts",
  );
});

// ============================================================================
// Checklist (1): State Transition Rules Lifecycle (Closed -> Open -> Half-Open -> Closed & Open)
// ============================================================================

Deno.test("Checklist (1): Full state transition cycle Closed -> Open -> Half-Open -> Closed", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#Tests-required
  const kv = createMemoryKV();
  let time = 100_000;
  const cooldownMs = 15_000;

  const breaker = createCircuitBreaker(kv, [
    "circuit_breaker",
    "lifecycle_cycle",
  ], {
    failureThreshold: 2,
    cooldownMs,
    halfOpenSuccessThreshold: 2,
    nowProvider: () => time,
  });

  // 1. Initial Closed
  assertEquals((await breaker.getState()).state, "Closed");

  // 2. Closed -> Open (2 failures)
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("e1");
    })
  );
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("e2");
    })
  );
  assertEquals((await breaker.getState()).state, "Open");

  // 3. Open -> Half-Open (cooldown elapses + trial probe executes)
  time += cooldownMs;
  const probe1 = await breaker.execute(async () => {
    await Promise.resolve();
    return "probe1";
  });
  assertEquals(probe1, "probe1");
  assertEquals((await breaker.getState()).state, "Half-Open");

  // 4. Half-Open -> Closed (2nd trial probe executes and succeeds)
  const probe2 = await breaker.execute(async () => {
    await Promise.resolve();
    return "probe2";
  });
  assertEquals(probe2, "probe2");
  assertEquals((await breaker.getState()).state, "Closed");
  assertEquals((await breaker.getState()).consecutiveFailures, 0);
  assertEquals((await breaker.getState()).consecutiveSuccesses, 0);
});

Deno.test("Checklist (1): State transition cycle Closed -> Open -> Half-Open -> Open (trial failure)", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#Tests-required
  const kv = createMemoryKV();
  let time = 200_000;
  const cooldownMs = 10_000;

  const breaker = createCircuitBreaker(kv, [
    "circuit_breaker",
    "lifecycle_reopen",
  ], {
    failureThreshold: 1,
    cooldownMs,
    halfOpenSuccessThreshold: 2,
    nowProvider: () => time,
  });

  // Closed -> Open
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("trip");
    })
  );
  assertEquals((await breaker.getState()).state, "Open");

  // Open -> Half-Open on probe 1
  time += cooldownMs;
  await breaker.execute(async () => {
    await Promise.resolve();
    return "probe1";
  });
  assertEquals((await breaker.getState()).state, "Half-Open");

  // Half-Open -> Open on probe 2 failure
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("probe2 failed");
    })
  );
  assertEquals((await breaker.getState()).state, "Open");
  assertEquals((await breaker.getState()).consecutiveSuccesses, 0);
});

// ============================================================================
// Checklist (4): Integration — Simulated downstream failure, cooldown, trial probe
// ============================================================================

Deno.test("Checklist (4) & AC2/3/4/5 (Integration): Downstream outage trips breaker, cooldown elapses, trial probe restores service", async () => {
  // spec: contracts/queues.contract.md#Q-6
  // spec: contracts/platform.contract.md#PLAT-10
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#Checklist
  const kv = createMemoryKV();
  let epochTime = 500_000;
  const cooldownMs = 30_000;

  // Simulated downstream service state
  let downstreamHealthy = true;
  let downstreamCallCount = 0;

  async function mockDownstreamCall(): Promise<
    { status: number; data: string }
  > {
    await Promise.resolve();
    downstreamCallCount++;
    if (!downstreamHealthy) {
      throw new Error("HTTP 503: Service Unavailable");
    }
    return { status: 200, data: "ok" };
  }

  const breaker = createCircuitBreaker(kv, [
    "circuit_breaker",
    "vendor_api_integration",
  ], {
    failureThreshold: 3,
    cooldownMs,
    halfOpenSuccessThreshold: 2,
    nowProvider: () => epochTime,
  });

  // Step 1: Normal healthy operations succeed
  const initialRes = await breaker.execute(mockDownstreamCall);
  assertEquals(initialRes.status, 200);
  assertEquals(downstreamCallCount, 1);
  assertEquals((await breaker.getState()).state, "Closed");

  // Step 2: Downstream goes down; 3 failures occur
  downstreamHealthy = false;

  for (let i = 0; i < 3; i++) {
    await assertRejects(
      () => breaker.execute(mockDownstreamCall),
      Error,
      "HTTP 503: Service Unavailable",
    );
  }
  assertEquals(downstreamCallCount, 4); // 1 initial + 3 failures
  assertEquals((await breaker.getState()).state, "Open");

  // Step 3: Fast-fail protection prevents slamming downstream while down
  for (let i = 0; i < 5; i++) {
    await assertRejects(
      () => breaker.execute(mockDownstreamCall),
      UnavailableError,
    );
  }
  assertEquals(
    downstreamCallCount,
    4,
    "Downstream must NOT be called while breaker is Open during cooldown",
  );

  // Step 4: Downstream recovers, but cooldown has NOT yet elapsed
  downstreamHealthy = true;
  epochTime += cooldownMs - 500; // still 500ms remaining in cooldown

  await assertRejects(
    () => breaker.execute(mockDownstreamCall),
    UnavailableError,
  );
  assertEquals(
    downstreamCallCount,
    4,
    "Still fast-fails before cooldown expires",
  );

  // Step 5: Cooldown elapses; trial probes verify recovery
  epochTime += 1_000; // now past cooldown

  // Trial 1 probe passes through to downstream
  const trial1 = await breaker.execute(mockDownstreamCall);
  assertEquals(trial1.status, 200);
  assertEquals(downstreamCallCount, 5);
  assertEquals((await breaker.getState()).state, "Half-Open");

  // Trial 2 probe passes through to downstream
  const trial2 = await breaker.execute(mockDownstreamCall);
  assertEquals(trial2.status, 200);
  assertEquals(downstreamCallCount, 6);
  assertEquals((await breaker.getState()).state, "Closed");

  // Step 6: Full traffic resumes normally
  const normalRes = await breaker.execute(mockDownstreamCall);
  assertEquals(normalRes.status, 200);
  assertEquals(downstreamCallCount, 7);
  assertEquals((await breaker.getState()).state, "Closed");
});

// ============================================================================
// Breaker reset() Method
// ============================================================================

Deno.test("CircuitBreaker.reset(): Manually resets Open breaker to Closed with zeroed counters", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#Interface
  const kv = createMemoryKV();
  const breaker = createCircuitBreaker(kv, ["circuit_breaker", "test_reset"], {
    failureThreshold: 2,
  });

  // Trip to Open
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("f1");
    })
  );
  await assertRejects(() =>
    breaker.execute(async () => {
      await Promise.resolve();
      throw new Error("f2");
    })
  );
  assertEquals((await breaker.getState()).state, "Open");

  // Reset breaker
  await breaker.reset();

  const state = await breaker.getState();
  assertEquals(state.state, "Closed");
  assertEquals(state.consecutiveFailures, 0);
  assertEquals(state.consecutiveSuccesses, 0);

  // Calls immediately succeed again
  const result = await breaker.execute(async () => {
    await Promise.resolve();
    return "post_reset_success";
  });
  assertEquals(result, "post_reset_success");
});

// ============================================================================
// Multi-breaker Key Isolation
// ============================================================================

Deno.test("Key isolation: Breakers with different circuitKeys operate independently on same KV store", async () => {
  // spec: contracts/kv.contract.md#KV-4
  // spec: tasks/milestone-0.4-reliability/T-0402-kv-atomic-circuit-breaker.md#Assumptions
  const kv = createMemoryKV();

  const breakerA = createCircuitBreaker(kv, ["circuit_breaker", "service_A"], {
    failureThreshold: 2,
  });
  const breakerB = createCircuitBreaker(kv, ["circuit_breaker", "service_B"], {
    failureThreshold: 2,
  });

  // Trip Breaker A to Open
  await assertRejects(() =>
    breakerA.execute(async () => {
      await Promise.resolve();
      throw new Error("A1");
    })
  );
  await assertRejects(() =>
    breakerA.execute(async () => {
      await Promise.resolve();
      throw new Error("A2");
    })
  );

  assertEquals((await breakerA.getState()).state, "Open");
  assertEquals((await breakerB.getState()).state, "Closed");

  // Breaker B still processes calls normally
  const resultB = await breakerB.execute(async () => {
    await Promise.resolve();
    return "service_B_ok";
  });
  assertEquals(resultB, "service_B_ok");

  // Breaker A rejects
  await assertRejects(
    () =>
      breakerA.execute(async () => {
        await Promise.resolve();
        return "service_A_call";
      }),
    UnavailableError,
  );
});
