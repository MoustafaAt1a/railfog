# T-0509 — Local/Cloud Provider Parity Contract Test Suite

Status: Done
Milestone: 0.5 Developer Experience
Depends on: T-0111, T-0211, T-0502
Blocks: T-0511

## Spec references

`PLAT-16`, `PLAT-17`, `KV-2`, `KV-5`, `OBJ-2`, `OBJ-3`, `Q-2`, `Q-3`, `Q-4`

## Scope

**In scope**:
- `tests/fixtures/parity-runner.ts`: Implement a provider-agnostic test runner harness that executes a parameterized suite of test cases against any configured provider set:
  1. Local environment: `SQLiteProvider` (KV) + `LocalFSProvider` (Objects) + `SQLiteQueueProvider` (Queues) + `LocalIsolation` (Compute).
  2. Cloud prototype environment: `DenoDeployKVProvider` / `CloudflareKVProvider` + `R2Provider` + `CloudflareQueuesProvider` + `ProcessIsolation`.
- `tests/contract/parity_test.ts`: Execute the matrix of behavioral tests:
  - KV: atomic CAS conflict (`KV-3`), TTL expiration (`KV-2`), key prefix isolation (`PLAT-7`).
  - Objects: binary upload/download, SHA-256 content addressing (`OBJ-4`), presigned URL direct transfer (`OBJ-3`).
  - Queues: at-least-once delivery, delay parameter, batch sending (`Q-2`), visibility timeout, and max receives redelivery (`Q-3`).
  - End-to-end execution of the canonical worked example flow (`docs/contracts/worked-example.md`).
- Verification that application code runs completely unchanged across local and cloud configurations (`PLAT-17`).

**Out of scope**:
- Changing existing provider implementations (any behavioral divergence discovered must be resolved by fixing the divergent provider under its original contract, not by adding provider-specific branching).

## Interface to implement

```typescript
// tests/fixtures/parity-runner.ts

import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type { QueueProvider } from "../../primitives/queues/queue-provider.ts";
import type { ComputeProvider } from "../../primitives/compute/compute-provider.ts";

export interface ProviderBundle {
  name: "local" | "cloud";
  kv: KVProvider;
  objects: ObjectProvider;
  queues: QueueProvider;
  compute: ComputeProvider;
  cleanup(): Promise<void>;
}

export function runParitySuite(bundleFactory: () => Promise<ProviderBundle>): void;
```

## Acceptance criteria (Given/When/Then)

1. Given the parity test suite executed with the Local bundle (`SQLite`, `LocalFS`, `SQLiteQueue`, `LocalIsolation`), when all test cases run, then all assertions pass with zero failures.
2. Given the parity test suite executed with the Cloud prototype bundle (`DenoDeployKV`, `R2`, `CloudflareQueues`, `ProcessIsolation`), when all test cases run, then all assertions pass with identical return values and error codes (`PLAT-12`).
3. Given the worked-example upload pipeline (`docs/contracts/worked-example.md`), when executed on the local bundle and then on the cloud bundle, then both result in identical deduplication behavior (`Q-4`), object storage persistence (`OBJ-2`), and KV status records (`KV-2`).
4. Given presigned URLs generated in both environments, when inspected, then both direct client uploads directly to storage without proxying file bytes through the function or control plane (`OBJ-3`).

## Tests required

- [x] Contract — `tests/contract/parity_test.ts`: Dual-matrix test suite verifying parity across all four primitives and the worked-example flow.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-16`, `PLAT-17`, `KV-2`, `KV-5`, `OBJ-2`, `OBJ-3`, `Q-2`, `Q-3`, `Q-4`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

## Verification Evidence

```shell
$ deno check tests/fixtures/parity-runner.ts tests/contract/parity_test.ts
(clean output, exit code 0)

$ deno test -A tests/contract/parity_test.ts
running 19 tests from ./tests/contract/parity_test.ts
Parity Suite [local]: KV operations - get, set, delete, list with pagination (KV-2, PLAT-16, PLAT-17) ... ok (159ms)
Parity Suite [local]: KV atomic CAS concurrency (KV-3, KV-5, PLAT-16, PLAT-17) ... ok (33ms)
Parity Suite [local]: KV TTL expiration behavior (KV-2, PLAT-16, PLAT-17) ... ok (1s)
Parity Suite [local]: Objects CRUD and lifecycle (OBJ-2, PLAT-16, PLAT-17) ... ok (204ms)
Parity Suite [local]: Objects presigning - direct client transfer and expiration (OBJ-2, OBJ-3, PLAT-16, PLAT-17) ... ok (501ms)
Parity Suite [local]: Queues dispatch - send, sendBatch, receive, ack, visibility (Q-1, Q-2, Q-3, PLAT-16, PLAT-17) ... ok (631ms)
Parity Suite [local]: Compute provider execution - isolated artifact execution (PLAT-4, PLAT-16, FN-1, FN-5, OBJ-4) ... ok (201ms)
Parity Suite [cloud]: KV operations - get, set, delete, list with pagination (KV-2, PLAT-16, PLAT-17) ... ok (202ms)
Parity Suite [cloud]: KV atomic CAS concurrency (KV-3, KV-5, PLAT-16, PLAT-17) ... ok (115ms)
Parity Suite [cloud]: KV TTL expiration behavior (KV-2, PLAT-16, PLAT-17) ... ok (1s)
Parity Suite [cloud]: Objects CRUD and lifecycle (OBJ-2, PLAT-16, PLAT-17) ... ok (336ms)
Parity Suite [cloud]: Objects presigning - direct client transfer and expiration (OBJ-2, OBJ-3, PLAT-16, PLAT-17) ... ok (150ms)
Parity Suite [cloud]: Queues dispatch - send, sendBatch, receive, ack, visibility (Q-1, Q-2, Q-3, PLAT-16, PLAT-17) ... ok (827ms)
Parity Suite [cloud]: Compute provider execution - isolated artifact execution (PLAT-4, PLAT-16, FN-1, FN-5, OBJ-4) ... ok (506ms)
Parity Contract: KV Differential Parity across Local and Cloud bundles (KV-2, KV-3, KV-5, PLAT-17) ... ok (1s)
Parity Contract: Objects Differential Parity across Local and Cloud bundles (OBJ-2, OBJ-3, OBJ-4, PLAT-17) ... ok (564ms)
Parity Contract: Queues Differential Parity across Local and Cloud bundles (Q-2, Q-3, PLAT-17) ... ok (842ms)
Parity Contract: Compute Differential Parity across Local and Cloud bundles (PLAT-4, PLAT-16, PLAT-17, FN-5) ... ok (498ms)
Parity Contract: Worked-Example Canonical Flow Differential Parity across Local and Cloud bundles (worked-example.md, Q-4, KV-2, OBJ-2, OBJ-3, PLAT-12, PLAT-17) ... ok (531ms)

ok | 19 passed | 0 failed (10s)

$ deno lint tests/fixtures/parity-runner.ts tests/contract/parity_test.ts
Checked 2 files
(clean output, exit code 0)
```

## Assumptions made

None.
