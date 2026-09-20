/**
 * Runtime Snapshot Cache
 *
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-1 (Never calls control plane synchronously on request path)
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8 (Fail-static: serve last-known-good snapshot indefinitely on control plane outage)
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12 (Control plane outage does not affect live traffic)
 */

import {
  type RoutingSnapshot,
  validateRoutingSnapshot,
} from "../../packages/protocol/snapshot.ts";

// spec: contracts/platform.contract.md#PLAT-8 — Local cache refreshed in background (~5s poll)
const DEFAULT_POLL_INTERVAL_MS = 5000;

export interface RuntimeSnapshotCacheOptions {
  pollIntervalMs?: number;
}

/**
 * Fail-static snapshot cache for runtime data plane.
 * Provides strictly synchronous snapshot reads on the request path while polling in the background.
 *
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-1
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12
 */
export class RuntimeSnapshotCache {
  private readonly fetchSnapshot: () => Promise<RoutingSnapshot>;
  private readonly pollIntervalMs: number;
  private latestSnapshot: RoutingSnapshot | null = null;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;

  constructor(
    fetchSnapshot: () => Promise<RoutingSnapshot>,
    options?: RuntimeSnapshotCacheOptions,
  ) {
    this.fetchSnapshot = fetchSnapshot;
    this.pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * Synchronously retrieves the latest cached snapshot.
   * Never initiates a network call or returns a Promise.
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
   */
  getLatestSnapshot(): RoutingSnapshot | null {
    return this.latestSnapshot;
  }

  /**
   * Starts background polling for snapshot updates and triggers an immediate background poll.
   * Idempotent if already started.
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
   */
  start(): void {
    if (this.timerId !== null) {
      return;
    }
    this.timerId = setInterval(() => {
      this.pollBackground();
    }, this.pollIntervalMs);
    this.pollBackground();
  }

  /**
   * Stops background polling.
   * Idempotent if already stopped.
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
   */
  stop(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Explicitly refreshes the snapshot from the control plane.
   * Validates the payload structure and updates if newer than the current version.
   * If fetch or validation rejects, rethrows while preserving the last-known-good snapshot.
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12
   */
  async forceRefresh(): Promise<void> {
    const raw = await this.fetchSnapshot();
    const validated = validateRoutingSnapshot(raw);
    if (
      !this.latestSnapshot || validated.version > this.latestSnapshot.version
    ) {
      this.latestSnapshot = validated;
    }
  }

  /**
   * Background polling runner that catches errors silently to maintain fail-static operation.
   * Uses isPolling lock to prevent dogpiling on slow or hanging network requests.
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
   */
  private async pollBackground(): Promise<void> {
    if (this.isPolling) {
      return;
    }
    this.isPolling = true;
    try {
      await this.forceRefresh();
    } catch {
      // spec: contracts/platform.contract.md#PLAT-8 — fail-static: swallow background polling errors
    } finally {
      this.isPolling = false;
    }
  }
}
