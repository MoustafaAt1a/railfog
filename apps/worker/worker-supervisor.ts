/**
 * Production Background Worker Supervisor (T-0608)
 *
 * Spec references:
 * - PLAT-1: Control plane vs data plane separation (background worker executes strictly in data plane).
 * - PLAT-2: Everything is Trigger -> Function (queues target Functions directly, no separate worker daemon).
 * - PLAT-10: SLOs & error budget (queue at-least-once delivery guarantee, clean shutdown without hanging).
 * - Q-2: Queue API (receive, ack, message structure).
 * - Q-3: Redelivery model (visibility timeout default 30000ms, unacked messages redeliver on compute error).
 * - Q-5: Retries & backoff (exponential backoff capped at 5000ms on fatal provider error).
 * - FN-2: Triggers targeting Functions (Queue triggers dispatch into Functions).
 * - FN-5: Resource limits (MVP defaults cpuMs: 1000, timeoutMs: 30000, memoryMb: 128).
 * - FN-6: Isolation & warm-reuse rule (fresh context, unique Crockford Base32 ULID requestId, isolated headers per invocation, zero state bleeding).
 * - tasks/milestone-0.6-public-beta/T-0608-production-worker-supervisor.md
 */

import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";
import type {
  Artifact,
  ComputeProvider,
  InvocationRequest,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";

export interface QueueWorkerTarget {
  queueName: string;
  targetFunction: string;
  concurrency?: number; // default: 1
  batchSize?: number; // default: 10
  queueProvider?: QueueProvider; // optional per-target queue provider
}

export interface WorkerSupervisorOptions {
  projectId: string;
  orgId?: string;
  queues: QueueWorkerTarget[];
  queueProvider: QueueProvider;
  computeProvider: ComputeProvider;
  signal?: AbortSignal;
}

export interface WorkerSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  getActiveWorkerCount(): number;
}

/**
 * Worker supervisor implementation managing concurrent queue consumer loops,
 * crash recovery with exponential backoff, and graceful draining.
 *
 * @spec PLAT-1, PLAT-2, PLAT-10, Q-2, Q-3, Q-5, FN-2, FN-6
 */
class WorkerSupervisorImpl implements WorkerSupervisor {
  private readonly options: WorkerSupervisorOptions;
  private running = false;
  private activeWorkers = 0;
  private workerPromises: Promise<void>[] = [];
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly sleepCancelCallbacks = new Set<() => void>();
  private abortListener: (() => void) | null = null;

  constructor(options: WorkerSupervisorOptions) {
    this.options = options;
  }

  getActiveWorkerCount(): number {
    return this.activeWorkers;
  }

  /**
   * Starts all configured worker loops. Idempotent if already started.
   *
   * @spec PLAT-2, FN-2 — Spawns dedicated worker loops matching declared concurrency per queue
   * @spec PLAT-10 — Clean lifecycle handling with abort signal
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    if (this.startPromise) {
      return await this.startPromise;
    }
    if (this.stopPromise) {
      await this.stopPromise;
      if (this.running) {
        return;
      }
    }

    this.startPromise = (async () => {
      this.running = true;

      // Handle AbortSignal integration (AC3, PLAT-10)
      if (this.options.signal) {
        if (this.options.signal.aborted) {
          await this.stop();
          return;
        }
        this.abortListener = () => {
          this.stop().catch(() => {});
        };
        this.options.signal.addEventListener("abort", this.abortListener, {
          once: true,
        });
      }

      this.workerPromises = [];
      this.activeWorkers = 0;

      // spec: contracts/platform.contract.md#PLAT-2, contracts/functions.contract.md#FN-2
      // Spawn dedicated worker loops matching declared concurrency per queue
      for (const target of this.options.queues) {
        const concurrency = target.concurrency !== undefined
          ? Math.max(0, target.concurrency)
          : 1;
        for (let i = 0; i < concurrency; i++) {
          this.workerPromises.push(this.runSupervisedWorker(target));
        }
      }
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /**
   * Gracefully stops all worker loops, wakes up sleeping workers, and drains in-flight tasks.
   *
   * @spec PLAT-10 — Clean shutdown without hanging
   * @spec tasks/milestone-0.6-public-beta/T-0608-production-worker-supervisor.md#AC3
   */
  async stop(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
    }
    if (this.stopPromise) {
      return await this.stopPromise;
    }
    if (!this.running && this.workerPromises.length === 0) {
      return;
    }

    this.stopPromise = (async () => {
      this.running = false;

      if (this.abortListener && this.options.signal) {
        this.options.signal.removeEventListener("abort", this.abortListener);
        this.abortListener = null;
      }

      // Wake up all sleeping workers immediately to avoid hanging shutdown
      this.wakeUpAll();

      try {
        // Await all in-flight tasks and worker loops to complete
        await Promise.all(this.workerPromises);
      } finally {
        this.workerPromises = [];
        this.activeWorkers = 0;
      }
    })();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private wakeUpAll(): void {
    for (const cancel of Array.from(this.sleepCancelCallbacks)) {
      cancel();
    }
    this.sleepCancelCallbacks.clear();
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cancel = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        this.sleepCancelCallbacks.delete(cancel);
        resolve();
      };
      timer = setTimeout(() => {
        timer = null;
        this.sleepCancelCallbacks.delete(cancel);
        resolve();
      }, ms);
      this.sleepCancelCallbacks.add(cancel);
    });
  }

  /**
   * Supervised worker loop wrapping execution in crash recovery with exponential backoff.
   *
   * @spec contracts/platform.contract.md#PLAT-10
   * @spec contracts/queues.contract.md#Q-5
   * @spec tasks/milestone-0.6-public-beta/T-0608-production-worker-supervisor.md#AC2
   */
  private async runSupervisedWorker(target: QueueWorkerTarget): Promise<void> {
    this.activeWorkers++;
    let consecutiveErrors = 0;

    try {
      while (this.running) {
        try {
          await this.runWorkerCycle(target);
          consecutiveErrors = 0;
        } catch (_fatalError) {
          if (!this.running) {
            break;
          }
          // spec: contracts/platform.contract.md#PLAT-10, contracts/queues.contract.md#Q-5
          // Fatal error / unhandled crash recovery: exponential backoff capped at 5000ms
          consecutiveErrors++;
          const backoffMs = Math.min(
            5000,
            50 * Math.pow(2, Math.min(consecutiveErrors - 1, 6)),
          );
          await this.interruptibleSleep(backoffMs);
        }
      }
    } finally {
      this.activeWorkers--;
    }
  }

  /**
   * Executes a single receive, dispatch, and acknowledge cycle for a queue message.
   *
   * @spec contracts/queues.contract.md#Q-2, Q-3
   * @spec contracts/functions.contract.md#FN-2, FN-5, FN-6
   * @spec contracts/platform.contract.md#PLAT-2, PLAT-4, PLAT-14
   */
  private async runWorkerCycle(target: QueueWorkerTarget): Promise<void> {
    if (!this.running) {
      return;
    }

    const queueProvider = target.queueProvider ?? this.options.queueProvider;

    // spec: contracts/queues.contract.md#Q-2, Q-3 — Receive message with visibility timeout of 30,000 ms
    const message: QueueMessage | null = await queueProvider.receive({
      visibilityTimeoutMs: 30000,
    });

    if (!this.running) {
      return;
    }

    if (!message) {
      // Empty queue: brief sleep before polling again
      await this.interruptibleSleep(25);
      return;
    }

    // spec: contracts/functions.contract.md#FN-6, contracts/platform.contract.md#PLAT-14
    // Generate fresh Crockford Base32 ULID requestId per invocation
    const requestId = generateUlid();

    // spec: contracts/functions.contract.md#FN-6
    // Fresh InvocationRequest object with independent headers to prevent cross-job state bleed
    const invocation: InvocationRequest = {
      requestId,
      method: "POST",
      url: `http://railfog.internal/${target.targetFunction}`,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "request-id": requestId,
        "x-queue-name": target.queueName,
        ...(this.options.projectId
          ? { "x-project-id": this.options.projectId }
          : {}),
        ...(this.options.orgId ? { "x-org-id": this.options.orgId } : {}),
      },
      body: new TextEncoder().encode(JSON.stringify(message.body ?? null)),
    };

    // spec: contracts/platform.contract.md#PLAT-2, PLAT-4, contracts/functions.contract.md#FN-2
    const artifact: Artifact = {
      id: `fn:${target.targetFunction}`,
      integrity: "sha256-queue-trigger",
      entrypoint: target.targetFunction,
      code: new Uint8Array(),
    };

    // spec: contracts/functions.contract.md#FN-5 — Resource limits
    const limits: Limits = {
      cpuMs: 1000,
      timeoutMs: 30000,
      memoryMb: 128,
    };

    try {
      // spec: contracts/functions.contract.md#FN-2, contracts/platform.contract.md#PLAT-2
      await this.options.computeProvider.run(artifact, limits, invocation);
      // spec: contracts/queues.contract.md#Q-2, Q-3 — Acknowledge message upon successful execution
      await queueProvider.ack(message.id);
    } catch (_computeError) {
      // spec: contracts/queues.contract.md#Q-3 — Compute execution failure
      // Do not acknowledge message when attempts < maxReceives (5)
      // leaving it for visibility timeout expiration and redelivery.
    }
  }
}

/**
 * Creates a new WorkerSupervisor instance.
 *
 * @spec tasks/milestone-0.6-public-beta/T-0608-production-worker-supervisor.md
 */
export function createWorkerSupervisor(
  options: WorkerSupervisorOptions,
): WorkerSupervisor {
  return new WorkerSupervisorImpl(options);
}
