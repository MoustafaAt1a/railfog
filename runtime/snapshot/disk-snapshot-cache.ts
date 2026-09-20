/**
 * Fail-Static Snapshot Disk Cache and Cold-Start Recovery
 *
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-1 (Control plane vs data plane; non-blocking reads on request path)
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8 (Fail-static control/data plane split; disk cache, cold start, atomic write)
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-10 (Runtime data plane 99.95% SLO via synchronous in-memory reads)
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12 (Error model: safe fallback on corrupt snapshot, swallow polling errors)
 */

import { dirname } from "@std/path";
import {
  type RoutingSnapshot,
  validateRoutingSnapshot,
} from "../../packages/protocol/snapshot.ts";

// spec: contracts/platform.contract.md#PLAT-8 — Background refresh poll interval (~5s)
const DEFAULT_POLL_INTERVAL_MS = 5000;

export interface DiskSnapshotCacheOptions {
  cacheFilePath: string;
  pollIntervalMs?: number; // default 5000 (PLAT-8)
  fetchSnapshot: () => Promise<RoutingSnapshot>;
}

export interface DiskSnapshotCache {
  getLatestSnapshot(): RoutingSnapshot | null;
  start(): Promise<void>;
  stop(): void;
  forceRefresh(): Promise<void>;
}

class DiskSnapshotCacheImpl implements DiskSnapshotCache {
  private readonly cacheFilePath: string;
  private readonly pollIntervalMs: number;
  private readonly fetchSnapshot: () => Promise<RoutingSnapshot>;
  private latestSnapshot: RoutingSnapshot | null;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;

  constructor(
    options: DiskSnapshotCacheOptions,
    initialSnapshot: RoutingSnapshot | null,
  ) {
    this.cacheFilePath = options.cacheFilePath;
    // spec: contracts/platform.contract.md#PLAT-8 — Background refresh poll interval (~5s)
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.fetchSnapshot = options.fetchSnapshot;
    this.latestSnapshot = initialSnapshot;
  }

  /**
   * Synchronously retrieves the latest cached snapshot.
   * Never initiates disk I/O, network requests, or returns a Promise.
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-1
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-10
   */
  getLatestSnapshot(): RoutingSnapshot | null {
    return this.latestSnapshot;
  }

  /**
   * Starts background polling for snapshot updates and triggers an initial background poll.
   * Returns immediately without blocking startup.
   * Idempotent if already started.
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
   */
  start(): Promise<void> {
    if (this.timerId !== null) {
      return Promise.resolve();
    }
    // spec: contracts/platform.contract.md#PLAT-8 — Polling interval for background snapshot refresh
    this.timerId = setInterval(() => {
      this.pollBackground();
    }, this.pollIntervalMs);
    // spec: contracts/platform.contract.md#PLAT-8 — Trigger initial background poll without blocking startup
    this.pollBackground();
    return Promise.resolve();
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
   * Refreshes the snapshot from the control plane and persists to disk on newer versions.
   * If fetch or validation fails, rethrows while keeping existing in-memory and disk snapshots intact.
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12
   */
  async forceRefresh(): Promise<void> {
    const raw = await this.fetchSnapshot();
    // spec: contracts/platform.contract.md#PLAT-8 — Validate schema and deeply freeze snapshot
    // spec: contracts/platform.contract.md#PLAT-12 — Throw VALIDATION_FAILED on invalid snapshot
    const validated = validateRoutingSnapshot(raw);

    // spec: contracts/platform.contract.md#PLAT-8 — Monotonic versioning: only update on newer version
    if (
      !this.latestSnapshot || validated.version > this.latestSnapshot.version
    ) {
      // In-memory snapshot reference is updated before asynchronous disk write to ensure immediate data-plane availability
      this.latestSnapshot = validated;
      await this.persistToDisk(validated);
    }
  }

  /**
   * Atomically persists snapshot to disk using a temporary file and rename.
   * Cleans up temporary file if write or rename fails.
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
   */
  private async persistToDisk(snapshot: RoutingSnapshot): Promise<void> {
    const parentDir = dirname(this.cacheFilePath);
    await Deno.mkdir(parentDir, { recursive: true });

    const tmpFilePath = `${this.cacheFilePath}.tmp`;
    const serialized = JSON.stringify(snapshot, null, 2);

    try {
      await Deno.writeTextFile(tmpFilePath, serialized);
      // spec: contracts/platform.contract.md#PLAT-8 — Atomic rename guarantees protection against partial writes
      await Deno.rename(tmpFilePath, this.cacheFilePath);
    } catch (error) {
      try {
        await Deno.remove(tmpFilePath);
      } catch {
        // Ignore errors during temp file cleanup
      }
      throw error;
    }
  }

  /**
   * Background polling runner that catches errors silently to maintain fail-static operation.
   * Uses isPolling lock to prevent overlapping polling cycles.
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
      // spec: contracts/platform.contract.md#PLAT-8 — Fail-static: swallow background polling errors
    } finally {
      this.isPolling = false;
    }
  }
}

/**
 * Creates a disk-backed fail-static snapshot cache.
 * Loads the last-known-good snapshot from disk on cold start if available.
 * Safely ignores missing, empty, or corrupted disk files without throwing.
 *
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-8
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-10
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12
 */
export async function createDiskSnapshotCache(
  options: DiskSnapshotCacheOptions,
): Promise<DiskSnapshotCache> {
  let initialSnapshot: RoutingSnapshot | null = null;
  try {
    const content = await Deno.readTextFile(options.cacheFilePath);
    if (content.trim().length > 0) {
      const parsed = JSON.parse(content);
      // spec: contracts/platform.contract.md#PLAT-8 — Validate disk snapshot payload and deeply freeze
      initialSnapshot = validateRoutingSnapshot(parsed);
    }
  } catch {
    // spec: contracts/platform.contract.md#PLAT-8 — Fail-static cold start: recover or initialize as null
    // spec: contracts/platform.contract.md#PLAT-12 — Safe fallback without throwing error on unparseable/invalid disk cache
    initialSnapshot = null;
  }

  return new DiskSnapshotCacheImpl(options, initialSnapshot);
}
