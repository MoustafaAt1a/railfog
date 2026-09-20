# T-0208 — Fail-static snapshot distribution

Status: Done
Milestone: 0.2 Cloud Prototype
Depends on: T-0102, T-0207
Blocks: T-0211

## Spec references

`PLAT-1` `PLAT-8` `PLAT-12`

## Scope

**In scope:**
- `packages/protocol/snapshot.ts`: defines the immutable, versioned `RoutingSnapshot` data structure.
- `runtime/snapshot/snapshot-cache.ts`: runtime data-plane snapshot client and cache.
- Background refresh loop (~5s poll or push-invalidation).
- Fail-static guarantee per `docs/contracts/platform.contract.md` PLAT-8: runtime nodes never make synchronous calls to the control plane on the request path; if the control plane is unreachable, the runtime node serves the last-known-good snapshot indefinitely.
- Error taxonomy mapping per PLAT-12: unreachable control plane is classified as `UNAVAILABLE`, affecting new deploys only while live data traffic continues unaffected.

**Out of scope:**
- Any synchronous control plane round-trip on the request path (strictly banned per PLAT-8 and `docs/00-deep-analysis.md` §3).
- Direct database writes from runtime nodes to control-plane state.

## Interface to implement

```typescript
import type { RevisionRecord } from "../../apps/api/deployment-service.ts";

export interface FunctionSnapshot {
  functionName: string;
  revisionId: string;
  artifactId: string;
  permissions: {
    kv?: string[];
    objects?: string[];
    queues?: string[];
  };
  limits: {
    cpu_ms: number;
    timeout_ms: number;
    memory_mb: number;
  };
}

export interface RoutingSnapshot {
  snapshotId: string; // snap_{ULID} (PLAT-14)
  version: number;
  routes: Array<{ pattern: string; function: string }>;
  functions: Record<string, FunctionSnapshot>;
  generatedAt: number;
}

export class SnapshotDistributor {
  createSnapshot(
    routes: Array<{ pattern: string; function: string }>,
    activeRevisions: Record<string, RevisionRecord>,
  ): RoutingSnapshot;
}

export class RuntimeSnapshotCache {
  constructor(
    fetchSnapshot: () => Promise<RoutingSnapshot>,
    options?: { pollIntervalMs?: number },
  );
  getLatestSnapshot(): RoutingSnapshot | null;
  start(): void;
  stop(): void;
  forceRefresh(): Promise<void>;
}
```

## Acceptance criteria

1. Given routes and active revisions, when `createSnapshot` is called, then it outputs an immutable, versioned `RoutingSnapshot` containing the active function metadata and routes (PLAT-8).
2. Given a running `RuntimeSnapshotCache`, when `getLatestSnapshot()` is called on a request path, then it returns the snapshot synchronously without initiating any HTTP/RPC call (PLAT-8).
3. Given a cached snapshot, when the control plane becomes unreachable or returns connection errors, then background polling fails gracefully and `getLatestSnapshot()` continues serving the last-known-good snapshot indefinitely (PLAT-8).
4. Given control plane unreachability, when a client attempts a deploy or status check, then it reports `UNAVAILABLE` (PLAT-12), while existing live traffic experiences zero downtime.

## Tests required

- [x] Unit — snapshot JSON serialization/deserialization, synchronous cache access, version ordering
- [x] Integration — background poll updates cache when control plane changes; disconnect control plane and verify cache keeps serving last-known-good snapshot
- [x] Security — audit that request routing code contains zero synchronous network calls to the control plane (PLAT-8)

## Definition of Done

- [x] Implementation matches cited clause IDs (`PLAT-1`, `PLAT-8`, `PLAT-12`)
- [x] Zero synchronous control-plane calls exist on the data-plane path (Audit Finding #7, PLAT-8 banned pattern)
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing (25/25 task + adversarial tests; 212/212 repo tests)
- [x] `deno lint` run, real output attached, zero warnings
- [x] `deno fmt --check` run, real output attached, formatted
- [x] Independent reviewer pass completed and approved
- [x] Security auditor pass completed and approved (`PLAT-1`, `PLAT-8`, `PLAT-12`, `PLAT-14`)
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched

### Verified Tool Outputs

#### `deno check`
```
$ deno check packages/protocol/snapshot.ts runtime/snapshot/snapshot-cache.ts runtime/snapshot/snapshot-cache_test.ts tests/security/snapshot_adversarial_test.ts
Check packages/protocol/snapshot.ts
Check runtime/snapshot/snapshot-cache.ts
Check runtime/snapshot/snapshot-cache_test.ts
Check tests/security/snapshot_adversarial_test.ts
```

#### `deno test`
```
$ deno test runtime/snapshot/snapshot-cache_test.ts
Check runtime/snapshot/snapshot-cache_test.ts
running 17 tests from ./runtime/snapshot/snapshot-cache_test.ts
SnapshotDistributor - AC1: generates valid snapshotId matching /^snap_[0-9A-HJKMNP-TV-Z]{26}$/ (PLAT-14) ... ok (949µs)
SnapshotDistributor - AC1: produces versioned RoutingSnapshot with monotonically incrementing version ... ok (453µs)
SnapshotDistributor - AC1: correctly maps routes and extracts FunctionSnapshot metadata from manifest ... ok (485µs)
SnapshotDistributor - AC1: records generatedAt timestamp close to invocation time ... ok (210µs)
SnapshotDistributor - AC1: guarantees immutability of returned RoutingSnapshot (PLAT-8) ... ok (294µs)
SnapshotDistributor - Unit: supports full JSON serialization and deserialization without data loss ... ok (559µs)
SnapshotDistributor - Unit: handles empty routes and revisions gracefully ... ok (183µs)
RuntimeSnapshotCache - AC2: getLatestSnapshot() returns null before initial load ... ok (221µs)
RuntimeSnapshotCache - AC2 & Security: getLatestSnapshot() is strictly synchronous and returns RoutingSnapshot without returning Promise (PLAT-8) ... ok (776µs)
RuntimeSnapshotCache - Unit: version ordering ignores stale or older snapshots ... ok (476µs)
RuntimeSnapshotCache - AC3: background polling catches errors gracefully and continues serving last-known-good snapshot indefinitely (PLAT-8) ... ok (128ms)
RuntimeSnapshotCache - AC4: background polling updates cache when control plane recovers with newer snapshot ... ok (142ms)
RuntimeSnapshotCache - AC5: forceRefresh() immediately fetches; preserves last-known-good snapshot on failure ... ok (1ms)
RuntimeSnapshotCache - AC6: stop() halts background polling timer cleanly and is idempotent ... ok (171ms)
RuntimeSnapshotCache - PLAT-12: unreachable control plane is typed as UNAVAILABLE while data plane continues serving ... ok (62ms)
RuntimeSnapshotCache - Security: zero network/fetch calls are invoked during request path getLatestSnapshot() (PLAT-8) ... ok (23ms)
RuntimeSnapshotCache - Security: cached snapshot is tamper-resistant against data-plane in-place mutation ... ok (1ms)

ok | 17 passed | 0 failed (557ms)
```

```
$ deno test -A tests/security/snapshot_adversarial_test.ts
Check tests/security/snapshot_adversarial_test.ts
running 8 tests from ./tests/security/snapshot_adversarial_test.ts
Adversarial PLAT-8: getLatestSnapshot() makes zero network calls and executes in microsecond latency ... ok (27ms)
Adversarial PLAT-8: Hanging fetcher does not block getLatestSnapshot() or fail-static serving ... ok (76ms)
Adversarial PLAT-8/12: Control plane 503 UNAVAILABLE preserves last-known-good snapshot indefinitely ... ok (111ms)
Attack PLAT-8: Corrupt snapshot with higher version throws and does NOT overwrite last-known-good snapshot ... ok (2ms)
Attack PLAT-8: Initial malformed response throws and does NOT brick cache ... ok (787µs)
Attack PLAT-8: Deserialized JSON snapshot is deeply frozen and in-place mutation throws TypeError ... ok (1ms)
Adversarial PLAT-8: Replay of older version is rejected ... ok (398µs)
Attack PLAT-8: Replay of IDENTICAL version number does NOT overwrite active snapshot ... ok (295µs)

ok | 8 passed | 0 failed (233ms)
```

#### `deno lint`
```
$ deno lint packages/protocol/snapshot.ts runtime/snapshot/snapshot-cache.ts runtime/snapshot/snapshot-cache_test.ts tests/security/snapshot_adversarial_test.ts
Checked 4 files
```

#### `deno fmt --check`
```
$ deno fmt --check packages/protocol/snapshot.ts runtime/snapshot/snapshot-cache.ts runtime/snapshot/snapshot-cache_test.ts tests/security/snapshot_adversarial_test.ts
Checked 4 files
```

## Assumptions made

- Snapshot payloads from the control plane undergo strict runtime validation via `validateRoutingSnapshot` before caching, throwing `ValidationFailedError` (PLAT-12) on malformed schema and preventing cache corruption or bricking.
- Network-deserialized snapshot payloads are deeply frozen recursively by `validateRoutingSnapshot` using `deepFreeze` to guarantee immutability in the data plane (PLAT-8).
- Cache updates require strictly monotonic version increments (`validated.version > current.version`), preventing identical-version replays and downgrades.
- Background polling uses an in-flight `isPolling` lock to prevent overlapping request dogpiling on slow or hanging control-plane endpoints.
