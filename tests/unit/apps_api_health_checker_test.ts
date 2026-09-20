import { assertEquals } from "@std/assert";
import {
  executeHealthCheck,
  type HealthCheckResult,
  type HealthProbeOptions,
} from "../../apps/api/health-checker.ts";

// AC1: 3 consecutive HTTP 200 responses return passed: true with consecutiveSuccesses: 3
Deno.test("Unit - health check passes after 3 consecutive 200s", async () => {
  let callCount = 0;
  const mockFetch = (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    callCount++;
    return Promise.resolve(new Response(null, { status: 200 }));
  };

  const options: HealthProbeOptions = {
    probeUrl: "http://localhost:8080/health",
    fetchFn: mockFetch as typeof fetch,
    probeIntervalMs: 10,
    consecutiveSuccessesRequired: 3,
  };

  const result: HealthCheckResult = await executeHealthCheck(options);

  assertEquals(result.passed, true);
  assertEquals(result.consecutiveSuccesses, 3);
  assertEquals(result.probesAttempted, 3);
  assertEquals(result.lastStatusCode, 200);
});

// AC2: Non-200 response resets consecutive successes, passes after 3 consecutive 200s
Deno.test("Unit - non-200 response resets consecutive counter", async () => {
  let callCount = 0;
  const mockFetch = (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    callCount++;
    // Returns 200, 500, 200, 200, 200
    if (callCount === 2) {
      return Promise.resolve(new Response(null, { status: 500 }));
    }
    return Promise.resolve(new Response(null, { status: 200 }));
  };

  const options: HealthProbeOptions = {
    probeUrl: "http://localhost:8080/health",
    fetchFn: mockFetch as typeof fetch,
    probeIntervalMs: 10,
    consecutiveSuccessesRequired: 3,
  };

  const result: HealthCheckResult = await executeHealthCheck(options);

  assertEquals(result.passed, true);
  assertEquals(result.consecutiveSuccesses, 3);
  assertEquals(result.probesAttempted, 5); // 1 success, 1 fail, 3 successes = 5 total
  assertEquals(result.lastStatusCode, 200);
});

// Network error resets consecutive successes
Deno.test("Unit - network error resets consecutive counter", async () => {
  let callCount = 0;
  const mockFetch = (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    callCount++;
    // Returns 200, error, 200, 200, 200
    if (callCount === 2) {
      throw new Error("Connection refused");
    }
    return Promise.resolve(new Response(null, { status: 200 }));
  };

  const options: HealthProbeOptions = {
    probeUrl: "http://localhost:8080/health",
    fetchFn: mockFetch as typeof fetch,
    probeIntervalMs: 10,
    consecutiveSuccessesRequired: 3,
  };

  const result: HealthCheckResult = await executeHealthCheck(options);

  assertEquals(result.passed, true);
  assertEquals(result.consecutiveSuccesses, 3);
  assertEquals(result.probesAttempted, 5);
  assertEquals(result.lastStatusCode, 200);
});

// Per-probe timeout handling
Deno.test("Unit - per-probe timeout resets consecutive counter", async () => {
  let callCount = 0;
  const mockFetch = (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    callCount++;
    if (callCount === 2) {
      // Simulate timeout by throwing AbortError (which is what AbortSignal does)
      const err = new Error("Timeout");
      err.name = "AbortError";
      throw err;
    }
    return Promise.resolve(new Response(null, { status: 200 }));
  };

  const options: HealthProbeOptions = {
    probeUrl: "http://localhost:8080/health",
    fetchFn: mockFetch as typeof fetch,
    probeIntervalMs: 10,
    consecutiveSuccessesRequired: 3,
  };

  const result: HealthCheckResult = await executeHealthCheck(options);

  assertEquals(result.passed, true);
  assertEquals(result.consecutiveSuccesses, 3);
  assertEquals(result.probesAttempted, 5);
  assertEquals(result.lastStatusCode, 200);
});

// AC3: Continual non-200 or timeout halts after totalTimeoutMs and returns passed: false
Deno.test("Unit - total 30-second timeout halts probing and returns failure", async () => {
  const mockFetch = (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    return Promise.resolve(new Response(null, { status: 500 }));
  };

  const options: HealthProbeOptions = {
    probeUrl: "http://localhost:8080/health",
    fetchFn: mockFetch as typeof fetch,
    probeIntervalMs: 10,
    totalTimeoutMs: 100, // use short timeout for fast test
    consecutiveSuccessesRequired: 3,
  };

  const startTime = Date.now();
  const result: HealthCheckResult = await executeHealthCheck(options);
  const elapsed = Date.now() - startTime;

  assertEquals(result.passed, false);
  assertEquals(result.consecutiveSuccesses, 0);
  assertEquals(result.lastStatusCode, 500);
  // Ensure it actually waited around the total timeout
  if (elapsed < 80) {
    throw new Error(
      `Test finished too quickly: ${elapsed}ms. It should wait for totalTimeoutMs.`,
    );
  }
});
