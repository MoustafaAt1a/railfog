# T-0407 — Fail-static snapshot disk cache and cold-start recovery

Status: Done
Milestone: 0.4 Reliability
Depends on: T-0102, T-0208
Blocks: T-0412

## Spec references

`PLAT-8` `PLAT-10` `PLAT-12`

## Scope

**In scope** (be exact — file/module/interface level, not a feature area):
- `runtime/snapshot/disk-snapshot-cache.ts`: augment `RuntimeSnapshotCache` with local disk persistence to achieve true cold-start resilience per PLAT-8:
  - Cold start under control-plane failure: when a runtime node process starts up while the control plane is down, it recovers by loading the last-known-good snapshot from local disk and immediately serves live traffic (PLAT-8, PLAT-10).
  - Atomic write pattern: when a new valid snapshot is received, it writes to a temporary file (`${cacheFilePath}.tmp`) and atomically renames it to `cacheFilePath` (`Deno.rename`) to guarantee protection against partial writes or power cuts.
  - Fail-static isolation: read operations on the data-plane request path remain strictly synchronous via `getLatestSnapshot()` without blocking on disk I/O or network requests (PLAT-1, PLAT-8).
  - Validation: validates loaded disk contents with `validateRoutingSnapshot`; gracefully handles missing or corrupt files.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Synchronous calls to the control plane on the request path (banned per PLAT-1, PLAT-8).
- Multi-node distributed caching (e.g. Redis, memcached — PLAT-20).
- Encrypting snapshot routing definitions on disk (secrets are injected separately at invocation time per PLAT-15).

## Interface to implement

```typescript
import type { RoutingSnapshot } from "../../packages/protocol/snapshot.ts";

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

export function createDiskSnapshotCache(
  options: DiskSnapshotCacheOptions,
): Promise<DiskSnapshotCache>;
```

## Acceptance criteria (Given/When/Then)

1. Given an existing snapshot saved to disk, when `createDiskSnapshotCache` is initialized with the control plane completely unreachable, then it recovers by loading the disk snapshot and `getLatestSnapshot()` immediately returns the valid snapshot.
2. Given a running cache, when `forceRefresh()` receives a newer snapshot version from the control plane, then the cache is updated in memory and atomically written to disk at `cacheFilePath`.
3. Given an update in progress, when the process is interrupted during writing, then the existing `cacheFilePath` remains uncorrupted due to atomic temporary file rename.
4. Given a corrupted snapshot file on disk (e.g. truncated JSON), when `createDiskSnapshotCache` starts up, then it safely discards the corrupted file and initializes with `latestSnapshot = null` without crashing the runtime.
5. Given a cold start with a valid disk cache and dead control plane, when HTTP requests query routes, then routing resolves synchronously matching PLAT-8 without throwing `UNAVAILABLE`.

## Tests required

- [x] Unit — atomic write and rename verification
- [x] Unit — corrupt disk cache recovery and safe fallback
- [x] Unit — synchronous in-memory read path remains non-blocking
- [x] Integration — cold start recovery during simulated control plane outage

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

### Verified Tool Outputs

#### `deno check`
```
$ deno check runtime/snapshot/disk-snapshot-cache.ts
Check runtime/snapshot/disk-snapshot-cache.ts
```

#### `deno test`
```
$ deno test --allow-read --allow-write --allow-net --allow-run runtime/snapshot/disk-snapshot-cache_test.ts
running 24 tests from ./runtime/snapshot/disk-snapshot-cache_test.ts
createDiskSnapshotCache - AC1 & Integration: cold start loads existing snapshot from disk during control plane outage (PLAT-8) ... ok (31ms)
createDiskSnapshotCache - AC1: cold start with no disk cache and dead control plane initializes with null without throwing ... ok (4ms)
createDiskSnapshotCache - AC1: cold start with live control plane writes initial snapshot to disk ... ok (16ms)
DiskSnapshotCache - AC2 & Unit: forceRefresh updates in-memory cache and writes to disk on newer version (PLAT-8) ... ok (29ms)
DiskSnapshotCache - AC3 & Unit: atomic write writes via .tmp and leaves no leftover temporary file on success (PLAT-8) ... ok (24ms)
DiskSnapshotCache - AC3 & Unit: atomic write preserves existing cache file when temporary file exists or write interrupted (PLAT-8) ... ok (15ms)
DiskSnapshotCache - AC3 & Unit: failed fetchSnapshot preserves original disk snapshot unchanged (PLAT-8) ... ok (17ms)
DiskSnapshotCache - monotonic versioning: older snapshot version from CP does not overwrite newer disk/memory snapshot (PLAT-8) ... ok (15ms)
DiskSnapshotCache - monotonic versioning: identical version from CP is a no-op and preserves disk state (PLAT-8) ... ok (15ms)
createDiskSnapshotCache - AC4 & Unit: truncated JSON on disk is safely discarded on startup, initializing with null (PLAT-8) ... ok (5ms)
createDiskSnapshotCache - AC4 & Unit: schema-invalid snapshot JSON on disk is safely discarded on startup (PLAT-8, PLAT-12) ... ok (5ms)
DiskSnapshotCache - AC4 & Unit: self-heals corrupted disk cache when control plane becomes reachable (PLAT-8) ... ok (15ms)
DiskSnapshotCache - AC5 & Integration: synchronous read path never blocks or throws UNAVAILABLE during CP outage (PLAT-8, PLAT-10) ... ok (39ms)
DiskSnapshotCache - AC5 & Unit: getLatestSnapshot() reads strictly from memory and never hits disk on request path (PLAT-8) ... ok (19ms)
DiskSnapshotCache - directory creation: recursively creates parent directories when cacheFilePath directory is missing ... ok (18ms)
createDiskSnapshotCache - directory creation: gracefully handles missing parent directory on cold start with dead CP ... ok (3ms)
DiskSnapshotCache - AC6: stop() halts background polling timer cleanly and is idempotent ... ok (161ms)
DiskSnapshotCache - Integration: background polling automatically updates memory and writes to disk ... ok (125ms)
DiskSnapshotCache - PLAT-8: background polling swallows CP errors without disrupting cached snapshot ... ok (79ms)
DiskSnapshotCache - Adversarial PLAT-8: deepFreeze enforces strict immutability across all snapshot properties ... ok (14ms)
DiskSnapshotCache - Adversarial PLAT-15: zero secret persistence guarantees credentials never touch disk ... ok (18ms)
DiskSnapshotCache - Adversarial Path Traversal: malicious route patterns and function names cannot escape or corrupt disk ... ok (18ms)
DiskSnapshotCache - Adversarial Disk Injection: arbitrary JS, malformed JSON, and prototype pollution are safely neutralized ... ok (19ms)
DiskSnapshotCache - Adversarial DOS (PLAT-8, PLAT-10): hanging fetcher and slow disk never block getLatestSnapshot() ... ok (19ms)

ok | 24 passed | 0 failed (762ms)
```

#### `deno lint`
```
$ deno lint runtime/snapshot/disk-snapshot-cache.ts runtime/snapshot/disk-snapshot-cache_test.ts
Checked 2 files
```

## Assumptions made

- [Implementation choice] Snapshot file parent directory will be created recursively if it does not already exist.
- [Implementation choice] In-memory snapshot reference is updated before asynchronous disk write to ensure immediate data-plane availability.
