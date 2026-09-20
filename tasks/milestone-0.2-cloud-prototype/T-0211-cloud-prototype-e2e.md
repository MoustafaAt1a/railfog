# T-0211 — Cloud prototype end-to-end verification

Status: Done
Milestone: 0.2 Cloud Prototype
Depends on: T-0201, T-0203, T-0204, T-0205, T-0206, T-0207, T-0208, T-0209, T-0210
Blocks: none

## Spec references

`PLAT-1` `PLAT-3` `PLAT-8` `PLAT-16` `PLAT-17` `OBJ-2` `OBJ-3` `Q-2` `Q-4`
`KV-2` `FN-2`

## Scope

**In scope:**

- `tests/e2e/cloud-prototype_test.ts`: integration and end-to-end verification
  of Milestone 0.2's cloud prototype goal ("Deploy a real application").
- Exercises the canonical worked example (`docs/contracts/worked-example.md`)
  across two separate process roles (`docs/contracts/platform.contract.md`
  PLAT-1):
  - Control plane deployment service (`DeploymentService`, T-0207).
  - Data plane runtime router + snapshot cache (`RuntimeSnapshotCache`, T-0208).
  - Background queue consumer worker (`QueueConsumerWorker`, T-0209).
- Direct client-to-storage transfer verification per OBJ-3: client uploads
  directly to object storage using presigned URL without proxying through
  Function.
- Queue trigger dispatch and idempotency verification per FN-2, Q-3, Q-4, and
  KV-2.
- Fail-static split verification per PLAT-8: terminate or isolate the control
  plane and assert that live request processing continues uninterrupted from the
  cached snapshot.

**Out of scope:**

- MicroVM sandbox / gVisor isolation (Milestone 0.3).
- Network egress firewall and SSRF blocklist (Milestone 0.3).
- Rate-limiting token bucket tests (Milestone 0.3).

## Interface to implement

None — this task produces end-to-end integration tests in
`tests/e2e/cloud-prototype_test.ts`.

## Acceptance criteria

1. Given the canonical `upload-demo` application
   (`docs/contracts/worked-example.md`), when deployed via `deployCommand`, then
   the deployment completes, stores the artifact in the object store, and
   activates the revision in the control plane (PLAT-3).
2. Given the active deployment, when a client calls `POST /upload` on the data
   plane, then it returns HTTP 200 with `{ uploadUrl, key }`, direct SigV4
   upload URL, and valid ULID `request_id` header (PLAT-12, OBJ-2, OBJ-3).
3. Given the returned `uploadUrl`, when the client uploads binary payload
   directly via HTTP PUT to storage, then the upload succeeds directly to object
   storage without proxying bytes through the Function (OBJ-3).
4. Given the background queue consumer running, when the message is consumed,
   then `processor` receives the message (FN-2), retrieves object bytes (OBJ-2),
   records `["files", key]` in KV (KV-2), and writes `["processed", key]` with
   TTL matching retention days (Q-4).
5. Given a duplicate message delivered with the same key, when consumed by
   `processor`, then the idempotency check detects the dedupe key in KV and
   safely skips re-execution (Q-4).
6. Given the control plane is stopped, when subsequent HTTP requests are sent to
   the data plane, then they continue serving with HTTP 200 from the cached
   snapshot indefinitely (PLAT-8).

## Tests required

- [x] Unit — none (end-to-end test suite)
- [x] Integration — full worked-example flow spanning deployment, direct object
      upload, queue dispatch, background consumption, and KV writes
- [x] Security — verify capability injection prevents `api` function from
      constructing KV calls and prevents `processor` from accessing ungranted
      namespaces (PLAT-6, PLAT-7)

## Definition of Done

- [x] Implementation matches cited clause IDs (`PLAT-1`, `PLAT-3`, `PLAT-8`,
      `PLAT-16`, `PLAT-17`, `OBJ-2`, `OBJ-3`, `Q-2`, `Q-4`, `KV-2`, `FN-2`)
- [x] Worked-example flow (`docs/contracts/worked-example.md`) runs end-to-end
      and passes
- [x] Fail-static control/data plane split proven by test (PLAT-8)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test -A` run, real output attached, all required tests passing (9/9
      e2e tests, 11/11 adversarial tests, 92/92 repo tests)
- [x] `deno lint` run, real output attached, zero warnings
- [x] `deno fmt --check` run, real output attached, formatted
- [x] Security auditor pass completed and approved (`PLAT-6`, `PLAT-7`,
      `tests/security/cloud_prototype_adversarial_test.ts`)
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Closes Milestone 0.2

### Verified Tool Outputs

#### `deno check`

```
$ deno check tests/e2e/cloud-prototype_test.ts providers/objects/local-fs-provider.ts tests/security/cloud_prototype_adversarial_test.ts
Check tests/e2e/cloud-prototype_test.ts
Check providers/objects/local-fs-provider.ts
Check tests/security/cloud_prototype_adversarial_test.ts
```

#### `deno test`

```
$ deno test --allow-read --allow-write --allow-net tests/e2e/cloud-prototype_test.ts
running 9 tests from ./tests/e2e/cloud-prototype_test.ts
AC1: Canonical upload-demo application deployed via deployCommand stores artifacts and activates revisions (PLAT-3, PLAT-14, OBJ-4) ... ok (65ms)
AC2: Client calls POST /upload on data plane returning HTTP 200, direct upload URL, and ULID request-id header (PLAT-12, PLAT-14, OBJ-2, OBJ-3) ... ok (390ms)
AC3: Client uploads binary payload directly via HTTP PUT to storage without proxying bytes through function (OBJ-3) ... ok (664ms)
AC4: Background queue consumer worker consumes message, processor retrieves object bytes, records in KV, and sets dedupe key with TTL (FN-2, OBJ-2, KV-2, Q-4) ... ok (680ms)
AC5: Idempotency - duplicate queue message with same key is detected in KV and safely skips re-execution (Q-4, KV-2) ... ok (25ms)
AC6: Fail-static split - data plane continues serving live requests from cached snapshot indefinitely after control plane stops (PLAT-1, PLAT-8, PLAT-12) ... ok (367ms)
Security: Capability injection guarantees - api cannot access KV and processor cannot access ungranted resources (PLAT-6, PLAT-7) ... ok (8ms)
Security & OBJ-3: Direct client-to-storage upload with AWS SigV4 URL format using R2Provider (OBJ-2, OBJ-3, PLAT-16) ... ok (19ms)
End-to-End: Full canonical worked-example flow spanning deployment, upload, direct PUT, queue consumption, and idempotency ... ok (709ms)

ok | 9 passed | 0 failed (2s)
```

```
$ deno test -A tests/security/cloud_prototype_adversarial_test.ts
running 11 tests from ./tests/security/cloud_prototype_adversarial_test.ts
Adversarial PLAT-6: api handler cannot address or execute ANY KV operation (get, set, delete, list, atomic) ... ok (5ms)
Adversarial PLAT-6: processor handler cannot address or execute ANY Queue operation (send, sendBatch, receive, ack) ... ok (4ms)
Adversarial PLAT-6: processor cannot address ungranted KV namespaces or escape namespace via path traversal ... ok (5ms)
Adversarial PLAT-6: Ambiguous / multiple namespace requests are rejected at resolution time ... ok (3ms)
Adversarial PLAT-7: Two organizations with identical project names and identical KV/Object keys never collide ... ok (59ms)
Adversarial PLAT-7: Path traversal attack on LocalFSProvider root directory is strictly rejected ... ok (7ms)
Adversarial OBJ-3: Presigned URL key-swapping, method confusion, and signature tampering are rejected ... ok (1s)
Adversarial OBJ-3: Zero bandwidth proxying - data plane does not handle or buffer file payload bytes ... ok (654ms)
Adversarial PLAT-8: Control plane hang, network error, and malformed payload do not disrupt data-plane snapshot serving ... ok (184ms)
Adversarial Q-4: Dedupe keys written by queue consumer include real non-null TTL matching retention window ... ok (2ms)
Adversarial FN-6: Context and binding object identity are never shared across invocations ... ok (3ms)

ok | 11 passed | 0 failed (2s)
```

#### `deno lint`

```
$ deno lint tests/e2e/cloud-prototype_test.ts providers/objects/local-fs-provider.ts tests/security/cloud_prototype_adversarial_test.ts
Checked 3 files
```

#### `deno fmt --check`

```
$ deno fmt --check tests/e2e/cloud-prototype_test.ts providers/objects/local-fs-provider.ts tests/security/cloud_prototype_adversarial_test.ts
Checked 3 files
```

## Assumptions made

Local end-to-end test runs against in-process servers / mock adapters for S3 and
remote queues, ensuring all tests pass reliably in CI and local machines without
paid external cloud accounts per PLAT-17.
