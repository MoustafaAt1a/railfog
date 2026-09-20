import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";
import {
  calculateNextSleep,
  DEFAULT_BASE_MS,
  DEFAULT_CAP_MS,
  type RetryPolicyOptions,
} from "../../packages/policy/retry.ts";

// spec: contracts/queues.contract.md#Q-3 — Default visibility timeout is 30,000 ms
const DEFAULT_VISIBILITY_TIMEOUT_MS = 30000;

// spec: contracts/queues.contract.md#Q-3 — Default max_receives before moving to DLQ is 5
const DEFAULT_MAX_RECEIVES = 5;

// spec: contracts/queues.contract.md#Q-5 — Base polling/backoff interval default 100 ms
const DEFAULT_POLL_INTERVAL_MS = 100;

/**
 * Options configuring QueueConsumerWorker runtime behavior.
 * @spec contracts/queues.contract.md#Q-3
 */
export interface QueueConsumerOptions {
  queueName: string;
  targetFunctionName: string;
  visibilityTimeoutMs?: number; // default 30000 (Q-3)
  maxReceives?: number; // default 5 (Q-3)
  pollIntervalMs?: number;
  dlqProvider?: QueueProvider;
}

/**
 * Background worker dispatching Queue trigger messages to Functions.
 *
 * @spec contracts/functions.contract.md#FN-2 — Queue trigger targets a Function
 * @spec contracts/platform.contract.md#PLAT-2 — Everything is Trigger -> Function
 * @spec contracts/queues.contract.md#Q-1 — At-least-once delivery guarantee
 * @spec contracts/queues.contract.md#Q-2 — Invokes Function with QueueMessage
 * @spec contracts/queues.contract.md#Q-3 — Enforces redelivery state machine with visibility timeout and DLQ
 */
export class QueueConsumerWorker {
  private readonly queueProvider: QueueProvider;
  private readonly invokeFunction: (
    fnName: string,
    message: QueueMessage,
  ) => Promise<void>;
  private readonly options: QueueConsumerOptions;
  private readonly visibilityTimeoutMs: number;
  private readonly maxReceives: number;
  private readonly pollIntervalMs: number;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private currentProcessingPromise: Promise<boolean> | null = null;
  private stopPromise: Promise<void> | null = null;
  private cancelSleep: (() => void) | null = null;

  constructor(
    queueProvider: QueueProvider,
    invokeFunction: (fnName: string, message: QueueMessage) => Promise<void>,
    options: QueueConsumerOptions,
  ) {
    this.queueProvider = queueProvider;
    this.invokeFunction = invokeFunction;
    this.options = options;
    // spec: contracts/queues.contract.md#Q-3 — visibility_timeout_ms default 30,000 ms
    this.visibilityTimeoutMs = options.visibilityTimeoutMs ??
      DEFAULT_VISIBILITY_TIMEOUT_MS;
    // spec: contracts/queues.contract.md#Q-3 — max_receives default 5
    this.maxReceives = options.maxReceives ?? DEFAULT_MAX_RECEIVES;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * Starts the background polling loop. Idempotent if already running.
   */
  start(): void {
    if (this.running || this.stopPromise) {
      return;
    }
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  /**
   * Stops the background polling loop and awaits any in-flight message processing.
   * Idempotent if already stopped or if stop() is called multiple times.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) {
      return await this.stopPromise;
    }
    if (!this.running && !this.currentProcessingPromise && !this.loopPromise) {
      return;
    }

    this.stopPromise = (async () => {
      this.running = false;
      if (this.cancelSleep) {
        this.cancelSleep();
        this.cancelSleep = null;
      }
      if (this.currentProcessingPromise) {
        try {
          await this.currentProcessingPromise;
        } catch {
          // Failure handling is already managed inside processNext()
        }
      }
      if (this.loopPromise) {
        try {
          await this.loopPromise;
        } catch {
          // Loop failure guard
        }
        this.loopPromise = null;
      }
    })();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  /**
   * Receives and processes the next available queue message.
   *
   * @spec contracts/queues.contract.md#Q-3 — Redelivery state machine:
   * - Success: acknowledges message from primary queue.
   * - Error and attempts < maxReceives: leaves message unacked for redelivery.
   * - Error and attempts >= maxReceives: routes to DLQ and acknowledges from primary queue.
   *
   * @returns true if a message was successfully processed, false otherwise.
   */
  async processNext(): Promise<boolean> {
    let message: QueueMessage | null = null;
    try {
      // spec: contracts/queues.contract.md#Q-3 — Receive with visibility timeout
      message = await this.queueProvider.receive({
        visibilityTimeoutMs: this.visibilityTimeoutMs,
      });
    } catch {
      return false;
    }

    if (!message) {
      return false;
    }

    // Defensive capture against handler mutation / prototype pollution (FN-6, Q-3)
    const messageId = message.id;
    const attempts = message.attempts;
    const messageBody = message.body;

    // Freeze message object passed to invokeFunction so handler cannot tamper with state machine
    const invocationMessage: QueueMessage = Object.freeze({
      id: messageId,
      body: messageBody,
      attempts,
    });

    try {
      // spec: contracts/functions.contract.md#FN-2 — Invoke target Function with QueueMessage
      await this.invokeFunction(
        this.options.targetFunctionName,
        invocationMessage,
      );
    } catch (_error) {
      // spec: contracts/queues.contract.md#Q-3 — Redelivery state machine on error
      if (attempts >= this.maxReceives) {
        if (this.options.dlqProvider) {
          try {
            await this.options.dlqProvider.send(messageBody);
          } catch {
            // DLQ delivery failure must not block source queue acknowledgment
          }
        }
        try {
          // spec: contracts/queues.contract.md#Q-3 — Acknowledge exhausted message from primary queue
          await this.queueProvider.ack(messageId);
        } catch {
          // Primary queue ack error guard
        }
      }
      // If attempts < maxReceives, do not ack — message remains unacknowledged
      // and returns to visible state after visibilityTimeoutMs expires (Q-3).
      return false;
    }

    try {
      // spec: contracts/queues.contract.md#Q-3 — Acknowledge on successful processing
      await this.queueProvider.ack(messageId);
      return true;
    } catch {
      return false;
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let processed = false;
      try {
        this.currentProcessingPromise = this.processNext();
        processed = await this.currentProcessingPromise;
      } catch {
        // Unexpected processing failure guard: prevent infinite loop or worker crash
        processed = false;
      } finally {
        this.currentProcessingPromise = null;
      }

      if (!this.running) {
        break;
      }

      if (!processed) {
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.cancelSleep = null;
        resolve();
      }, ms);
      this.cancelSleep = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

/**
 * Options configuring ResilientQueueConsumerWorker runtime behavior.
 *
 * @spec contracts/queues.contract.md#Q-3 — Redelivery state machine
 * @spec contracts/queues.contract.md#Q-5 — Decorrelated jitter retry backoff policy
 */
export interface ResilientQueueConsumerOptions {
  queueName: string;
  targetFunctionName: string;
  visibilityTimeoutMs?: number; // default 30000 (Q-3)
  maxReceives?: number; // default 5 (Q-3)
  retryPolicy?: RetryPolicyOptions; // default base 100ms, cap 20s (Q-5)
  dlqProvider?: QueueProvider;
}

/**
 * Background worker dispatching Queue trigger messages to Functions with
 * decorrelated jitter polling backoff and redelivery state machine enforcement.
 *
 * @spec contracts/functions.contract.md#FN-2 — Queue trigger targets a Function
 * @spec contracts/platform.contract.md#PLAT-2 — Everything is Trigger -> Function
 * @spec contracts/platform.contract.md#PLAT-10 — Queue delivery at-least-once guarantee
 * @spec contracts/queues.contract.md#Q-1 — At-least-once delivery guarantee
 * @spec contracts/queues.contract.md#Q-2 — Invokes Function with QueueMessage
 * @spec contracts/queues.contract.md#Q-3 — Enforces redelivery state machine with visibility timeout and DLQ
 * @spec contracts/queues.contract.md#Q-5 — Decorrelated jitter polling backoff on empty queue or provider error
 */
export class ResilientQueueConsumerWorker {
  private readonly queueProvider: QueueProvider;
  private readonly invokeFunction: (
    fnName: string,
    message: QueueMessage,
  ) => Promise<void>;
  private readonly options: ResilientQueueConsumerOptions;
  private readonly visibilityTimeoutMs: number;
  private readonly maxReceives: number;
  private readonly retryPolicy: RetryPolicyOptions;

  private consecutiveEmptyPolls = 0;
  private lastSleepMs = 0;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private currentProcessingPromise: Promise<boolean> | null = null;
  private stopPromise: Promise<void> | null = null;
  private cancelSleep: (() => void) | null = null;

  constructor(
    queueProvider: QueueProvider,
    invokeFunction: (fnName: string, message: QueueMessage) => Promise<void>,
    options: ResilientQueueConsumerOptions,
  ) {
    this.queueProvider = queueProvider;
    this.invokeFunction = invokeFunction;
    this.options = options;

    // spec: contracts/queues.contract.md#Q-3 — visibility_timeout_ms default 30,000 ms
    this.visibilityTimeoutMs = options.visibilityTimeoutMs ??
      DEFAULT_VISIBILITY_TIMEOUT_MS;

    // spec: contracts/queues.contract.md#Q-3 — max_receives default 5
    this.maxReceives = options.maxReceives ?? DEFAULT_MAX_RECEIVES;

    // spec: contracts/queues.contract.md#Q-5 — Decorrelated jitter retry policy (base 100ms, cap 20s, maxAttempts 5)
    this.retryPolicy = {
      baseMs: options.retryPolicy?.baseMs ?? DEFAULT_BASE_MS,
      capMs: options.retryPolicy?.capMs ?? DEFAULT_CAP_MS,
      maxAttempts: options.retryPolicy?.maxAttempts ?? DEFAULT_MAX_RECEIVES,
      randomUniform: options.retryPolicy?.randomUniform,
      shouldRetry: options.retryPolicy?.shouldRetry,
    };
  }

  /**
   * Returns the count of consecutive empty or error polls.
   * Resets to 0 upon successful message processing.
   */
  getConsecutiveEmptyPolls(): number {
    return this.consecutiveEmptyPolls;
  }

  /**
   * Starts the background polling loop. Idempotent if already running.
   */
  start(): void {
    if (this.running || this.stopPromise) {
      return;
    }
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  /**
   * Stops the background polling loop, cancels active sleep immediately, and awaits any in-flight processing.
   * Idempotent if already stopped or if stop() is called multiple times.
   *
   * @spec contracts/platform.contract.md#PLAT-10 — Clean shutdown without hanging
   * @spec contracts/queues.contract.md#Q-5 — Sleep timer cancels immediately upon stop
   */
  async stop(): Promise<void> {
    if (this.stopPromise) {
      return await this.stopPromise;
    }
    if (!this.running && !this.currentProcessingPromise && !this.loopPromise) {
      return;
    }

    this.stopPromise = (async () => {
      this.running = false;
      if (this.cancelSleep) {
        this.cancelSleep();
        this.cancelSleep = null;
      }
      if (this.currentProcessingPromise) {
        try {
          await this.currentProcessingPromise;
        } catch {
          // Failure handling is already managed inside processNext()
        }
      }
      if (this.loopPromise) {
        try {
          await this.loopPromise;
        } catch {
          // Loop failure guard
        }
        this.loopPromise = null;
      }
    })();

    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  /**
   * Receives and processes the next available queue message.
   *
   * @spec contracts/queues.contract.md#Q-3 — Redelivery state machine:
   * - Success: acknowledges message from primary queue, resets consecutive empty polls and last sleep.
   * - Error and attempts < maxReceives: leaves message unacked for redelivery.
   * - Error and attempts >= maxReceives: routes to DLQ and acknowledges from primary queue.
   * - Empty queue or provider error: increments consecutive empty polls.
   *
   * @returns true if a message was successfully processed, false otherwise.
   */
  async processNext(): Promise<boolean> {
    let message: QueueMessage | null = null;
    try {
      // spec: contracts/queues.contract.md#Q-3 — Receive with visibility timeout
      message = await this.queueProvider.receive({
        visibilityTimeoutMs: this.visibilityTimeoutMs,
      });
    } catch {
      // spec: contracts/queues.contract.md#Q-5 — Increment empty poll count on provider polling error
      this.consecutiveEmptyPolls++;
      return false;
    }

    if (!message) {
      // spec: contracts/queues.contract.md#Q-5 — Increment empty poll count when queue is empty
      this.consecutiveEmptyPolls++;
      return false;
    }

    // Defensive capture against handler mutation / prototype pollution (FN-6, Q-3)
    const messageId = message.id;
    const attempts = message.attempts;
    const messageBody = message.body;

    // Freeze message object passed to invokeFunction so handler cannot tamper with state machine
    const invocationMessage: QueueMessage = Object.freeze({
      id: messageId,
      body: messageBody,
      attempts,
    });

    try {
      // spec: contracts/functions.contract.md#FN-2 — Invoke target Function with QueueMessage
      // spec: contracts/platform.contract.md#PLAT-10 — Queue delivery guarantee execution
      await this.invokeFunction(
        this.options.targetFunctionName,
        invocationMessage,
      );
    } catch (_error) {
      // spec: contracts/queues.contract.md#Q-3 — Redelivery state machine on error
      if (attempts >= this.maxReceives) {
        if (this.options.dlqProvider) {
          try {
            // spec: contracts/queues.contract.md#Q-3 — Route poison message body to DLQ
            await this.options.dlqProvider.send(messageBody);
          } catch {
            // spec: contracts/queues.contract.md#Q-3 — DLQ delivery failure must not block source queue acknowledgment
          }
        }
        try {
          // spec: contracts/queues.contract.md#Q-3 — Acknowledge exhausted message from primary queue
          await this.queueProvider.ack(messageId);
        } catch {
          // Primary queue ack error guard
        }
      }
      // spec: contracts/queues.contract.md#Q-3 — If attempts < maxReceives, leave unacknowledged for redelivery
      return false;
    }

    try {
      // spec: contracts/queues.contract.md#Q-3 — Acknowledge on successful processing
      await this.queueProvider.ack(messageId);
      // spec: contracts/queues.contract.md#Q-5 — Reset consecutive empty polls and last sleep on success
      this.consecutiveEmptyPolls = 0;
      this.lastSleepMs = 0;
      return true;
    } catch {
      return false;
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let processed = false;
      try {
        this.currentProcessingPromise = this.processNext();
        processed = await this.currentProcessingPromise;
      } catch {
        // Unexpected processing failure guard: prevent infinite loop or worker crash
        processed = false;
      } finally {
        this.currentProcessingPromise = null;
      }

      if (!this.running) {
        break;
      }

      if (!processed) {
        // spec: contracts/queues.contract.md#Q-5 — Decorrelated jitter backoff calculation
        const attempt = Math.max(0, this.consecutiveEmptyPolls - 1);
        const sleepMs = calculateNextSleep(
          { attempt, lastSleepMs: this.lastSleepMs },
          this.retryPolicy,
        );
        this.lastSleepMs = sleepMs;
        await this.sleep(sleepMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.cancelSleep = null;
        resolve();
      }, ms);
      this.cancelSleep = () => {
        clearTimeout(timer);
        this.cancelSleep = null;
        resolve();
      };
    });
  }
}
