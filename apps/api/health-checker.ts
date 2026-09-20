/**
 * Deployment Health Check Gating Probe Executor
 *
 * Spec references:
 * - PLAT-3: Deployment pipeline (Health check: 3 consecutive 200s within 30s before traffic cutover)
 * - FN-3: Function lifecycle (Ready -> Deployed on pass, Failed on failure)
 * - PLAT-12: Error model & diagnostics
 */

export interface HealthProbeOptions {
  probeUrl: string;
  consecutiveSuccessesRequired?: number; // default 3 (PLAT-3)
  totalTimeoutMs?: number; // default 30000 (PLAT-3)
  probeIntervalMs?: number; // default 1000
  probeTimeoutMs?: number; // default 5000
  fetchFn?: typeof fetch;
}

export interface HealthCheckResult {
  passed: boolean;
  consecutiveSuccesses: number;
  probesAttempted: number;
  elapsedMs: number;
  lastStatusCode?: number;
  lastError?: string;
}

// spec: contracts/platform.contract.md#PLAT-3 — 3 consecutive 200s required
const DEFAULT_CONSECUTIVE_SUCCESSES_REQUIRED = 3;
// spec: contracts/platform.contract.md#PLAT-3 — 30s total deadline
const DEFAULT_TOTAL_TIMEOUT_MS = 30000;
const DEFAULT_PROBE_INTERVAL_MS = 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

export async function executeHealthCheck(
  options: HealthProbeOptions,
): Promise<HealthCheckResult> {
  const {
    probeUrl,
    consecutiveSuccessesRequired = DEFAULT_CONSECUTIVE_SUCCESSES_REQUIRED, // spec: contracts/platform.contract.md#PLAT-3
    totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS, // spec: contracts/platform.contract.md#PLAT-3
    probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    fetchFn = globalThis.fetch,
  } = options;

  const startTime = Date.now();
  let consecutiveSuccesses = 0;
  let probesAttempted = 0;
  let lastStatusCode: number | undefined;
  let lastError: string | undefined;

  const totalDeadline = startTime + totalTimeoutMs;

  while (Date.now() < totalDeadline) {
    const loopStartTime = Date.now();
    probesAttempted++;
    let success = false;
    lastError = undefined;
    lastStatusCode = undefined;

    try {
      const abortController = new AbortController();
      const timeoutId = setTimeout(
        () => abortController.abort(),
        probeTimeoutMs,
      );

      const response = await fetchFn(probeUrl, {
        signal: abortController.signal,
      });
      clearTimeout(timeoutId);

      lastStatusCode = response.status;
      if (response.status === 200) {
        success = true;
      }
    } catch (e: unknown) {
      const err = e as Error;
      lastError = err.message || String(e);
      if (err.name === "AbortError") {
        lastError = "Timeout";
      }
    }

    if (success) {
      consecutiveSuccesses++;
      // spec: contracts/platform.contract.md#PLAT-3 — 3 consecutive 200s satisfy health check gate
      if (consecutiveSuccesses >= consecutiveSuccessesRequired) {
        return {
          passed: true,
          consecutiveSuccesses,
          probesAttempted,
          elapsedMs: Date.now() - startTime,
          lastStatusCode,
          lastError,
        };
      }
    } else {
      // spec: contracts/platform.contract.md#PLAT-3 — non-200, connection failure, or timeout resets consecutive counter
      consecutiveSuccesses = 0;
    }

    // Respect probeIntervalMs before next attempt
    const elapsedInLoop = Date.now() - loopStartTime;
    const remainingInterval = probeIntervalMs - elapsedInLoop;

    // Check if waiting would exceed total timeout
    const timeLeftBeforeTotalTimeout = totalDeadline - Date.now();
    const sleepTime = Math.max(
      0,
      Math.min(remainingInterval, timeLeftBeforeTotalTimeout),
    );

    if (sleepTime > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
    }
  }

  // spec: contracts/platform.contract.md#PLAT-3 — Total timeout elapsed without achieving required successes
  return {
    passed: false,
    consecutiveSuccesses,
    probesAttempted,
    elapsedMs: Date.now() - startTime,
    lastStatusCode,
    lastError,
  };
}
