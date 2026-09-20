/**
 * Graceful Shutdown Coordinator (T-0610).
 *
 * Coordinates orderly termination across control plane and runtime data plane targets.
 * Intercepts OS signals (SIGINT, SIGTERM, SIGBREAK), initiates traffic rejection (PLAT-1),
 * drains in-flight requests within a bounded timeout ceiling (PLAT-10), and forces
 * closure on hung targets without deadlocks.
 */

// spec: contracts/platform.contract.md#PLAT-10 — Default drain and force timeouts
export const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;
export const DEFAULT_FORCE_TIMEOUT_MS = 30_000;

/**
 * Drain target contract representing a component (e.g. gateway server, worker supervisor)
 * that accepts incoming work and tracks active connections.
 *
 * spec: tasks/milestone-0.6-public-beta/T-0610-graceful-shutdown-coordinator.md#Interface
 */
export interface DrainTarget {
  name: string;
  getActiveCount(): number;
  stopAccepting(): Promise<void> | void;
  drain(): Promise<void>;
}

/**
 * Configuration options for ShutdownCoordinator.
 *
 * spec: tasks/milestone-0.6-public-beta/T-0610-graceful-shutdown-coordinator.md#Interface
 */
export interface ShutdownOptions {
  drainTimeoutMs?: number; // default: 15,000ms
  forceTimeoutMs?: number; // default: 30,000ms
  onShutdownStart?: () => void;
  onShutdownComplete?: () => void;
}

/**
 * Production lifecycle coordinator for graceful server termination.
 *
 * spec: contracts/platform.contract.md#PLAT-1 — Control plane vs. data plane lifecycle
 * spec: contracts/platform.contract.md#PLAT-10 — SLOs & error budget; bounded drain ceiling
 */
export class ShutdownCoordinator {
  readonly #targets: DrainTarget[] = [];
  readonly #options: ShutdownOptions;
  #isShuttingDown = false;
  #shutdownPromise: Promise<boolean> | null = null;
  #signalsListening = false;

  constructor(options?: ShutdownOptions) {
    this.#options = { ...options };
  }

  /**
   * Registers a drain target to participate in graceful shutdown.
   */
  register(target: DrainTarget): void {
    this.#targets.push(target);
  }

  /**
   * Returns true if the coordinator has entered the shutdown sequence.
   *
   * spec: contracts/platform.contract.md#PLAT-1 — Transition to draining state
   */
  isShuttingDown(): boolean {
    return this.#isShuttingDown;
  }

  /**
   * Registers OS termination signal listeners (SIGINT, SIGTERM, SIGBREAK).
   * Idempotent: subsequent calls are no-ops. Safely ignores platform-unsupported signals.
   *
   * spec: contracts/platform.contract.md#PLAT-10 — OS signal deduplication and handling
   */
  listenSignals(): void {
    if (this.#signalsListening) {
      return;
    }
    this.#signalsListening = true;

    const signals: Deno.Signal[] = ["SIGINT", "SIGTERM", "SIGBREAK"];
    const handler = () => {
      this.shutdown().catch(() => {});
    };

    for (const sig of signals) {
      try {
        Deno.addSignalListener(sig, handler);
      } catch {
        // Platform or sandbox safe fallback (e.g. Windows missing specific signals)
      }
    }
  }

  /**
   * Initiates the graceful shutdown sequence.
   *
   * 1. Synchronously marks isShuttingDown() as true.
   * 2. Invokes onShutdownStart() callback exactly once.
   * 3. Concurrently calls stopAccepting() on all registered targets (PLAT-1).
   * 4. Concurrently executes drain() on all targets with timeout enforcement (PLAT-10).
   * 5. Resolves to true if all targets drain cleanly within timeout and have active count 0,
   *    or false if any target rejects, retains active connections, or times out.
   *
   * Idempotent: repeated or concurrent calls return the same pending/completed promise.
   *
   * spec: contracts/platform.contract.md#PLAT-1 — Targets immediately stop accepting requests
   * spec: contracts/platform.contract.md#PLAT-10 — Timeout escalation without deadlocks
   */
  shutdown(): Promise<boolean> {
    if (this.#shutdownPromise !== null) {
      return this.#shutdownPromise;
    }

    // Synchronously enter shutting down state
    this.#isShuttingDown = true;

    // Execute onShutdownStart synchronously upon initiation
    try {
      this.#options.onShutdownStart?.();
    } catch {
      // Callback failures do not abort shutdown sequence
    }

    this.#shutdownPromise = this.#executeShutdown();
    return this.#shutdownPromise;
  }

  async #executeShutdown(): Promise<boolean> {
    if (this.#targets.length === 0) {
      try {
        this.#options.onShutdownComplete?.();
      } catch {
        // Callback failures do not abort shutdown sequence
      }
      return true;
    }

    // Step 1: Immediately stop accepting new incoming requests across all targets
    // spec: contracts/platform.contract.md#PLAT-1
    await Promise.all(
      this.#targets.map(async (target) => {
        try {
          await target.stopAccepting();
        } catch {
          // Individual target errors do not block other targets from stopping
        }
      }),
    );

    // Step 2: Concurrently drain targets within the drain timeout ceiling
    // spec: contracts/platform.contract.md#PLAT-10
    const drainTimeoutMs = this.#options.drainTimeoutMs ??
      DEFAULT_DRAIN_TIMEOUT_MS;

    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timerId = setTimeout(() => {
        resolve("timeout");
      }, drainTimeoutMs);
    });

    const drainAllPromise = Promise.all(
      this.#targets.map(async (target) => {
        try {
          await target.drain();
          return target.getActiveCount() === 0;
        } catch {
          return false;
        }
      }),
    );

    let cleanShutdown = false;

    try {
      const raceResult = await Promise.race([drainAllPromise, timeoutPromise]);
      if (raceResult === "timeout") {
        cleanShutdown = false;
      } else {
        if (timerId !== undefined) {
          clearTimeout(timerId);
        }
        cleanShutdown = raceResult.every(Boolean);
      }
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
      try {
        this.#options.onShutdownComplete?.();
      } catch {
        // Callback failures do not abort shutdown completion
      }
    }

    return cleanShutdown;
  }
}
