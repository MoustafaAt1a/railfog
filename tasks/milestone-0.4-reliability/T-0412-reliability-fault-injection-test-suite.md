# T-0412 — Reliability and fault injection integration test suite

Status: Done
Milestone: 0.4 Reliability
Depends on: T-0401, T-0402, T-0403, T-0404, T-0405, T-0406, T-0407, T-0408, T-0409, T-0410, T-0411
Blocks: none

## Spec references

`Q-1` `Q-3` `Q-4` `Q-5` `Q-6` `KV-3` `KV-5` `PLAT-3` `PLAT-7` `PLAT-8` `PLAT-10` `PLAT-12` `PLAT-13` `PLAT-14` `PLAT-15` `PLAT-16` `PLAT-18` `OBJ-1` `OBJ-4` `FN-3`

## Scope

**In scope** (be exact — file/module/interface level, not a feature area):
- `tests/integration/reliability_test.ts`: comprehensive integration and fault injection test suite verifying all Milestone 0.4 reliability and disaster recovery capabilities under simulated real-world failures:
  - Control plane outage simulation: runtime data plane serves live traffic continuously from memory/disk snapshot when control plane drops (PLAT-8, PLAT-10); new runtime node cold-boots from disk snapshot during control plane downtime without throwing `UNAVAILABLE`.
  - Deployment safety & rollback: failing health check keeps candidate revision inactive and preserves serving revision (PLAT-3, FN-3); instant pointer-flip rollback swaps active revisions without rebuilding artifacts.
  - Queue redelivery & DLQ: consumer retries failing message with decorrelated jitter backoff and visibility timeout; after 5 attempts, message routes to dead-letter queue and clears primary queue (Q-1, Q-3, Q-5).
  - Atomic circuit breaker: repeated provider errors trip circuit breaker to `Open` state, fast-failing subsequent requests with `UNAVAILABLE` and protecting 99.95% SLO (Q-6, KV-3, PLAT-10).
  - Usage accounting & metrics: data-plane collector buffers execution metrics and exports valid OTLP JSON / Prometheus text (PLAT-13).
  - Disaster recovery roundtrip: project state export and restore preserves revision records, KV state, object manifests, and queue configs while strictly enforcing tenant prefix boundaries (PLAT-7, PLAT-18, ADR-0002).

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Multi-region active-active failover or WAN partition tests (banned per PLAT-20).
- Gradual canary / traffic-splitting tests (banned per PLAT-3, PLAT-20).
- Live cloud account credentials (tests run under local provider parity harness per PLAT-17).

## Interface to implement

none — this defines no new interface; test suite implementation only.

## Acceptance criteria (Given/When/Then)

1. Given a live runtime node serving traffic, when the control plane process is terminated, then HTTP requests continue receiving 200 OK responses with matching route specificity indefinitely (PLAT-8, PLAT-10).
2. Given a dead control plane, when a secondary runtime node cold-starts, then it recovers routes from the fail-static disk cache and serves traffic immediately (PLAT-8).
3. Given a new revision whose health check endpoint returns 500, when deployed, then the candidate revision transitions to `Failed`, traffic pointer remains at the previous revision, and live traffic experiences zero downtime (PLAT-3, FN-3).
4. Given revision `rev_02` deployed, when `rail rollback api --to rev_01` is executed, then the pointer flips to `rev_01` instantly without compiling or rebuilding code (FN-3).
5. Given a poison queue message that crashes the consumer 5 times, when processed, then the message is delivered to the DLQ and acknowledged from the source queue (Q-3, Q-5).
6. Given an external provider experiencing an outage, when failure count reaches threshold, then the KV atomic circuit breaker trips to `Open` and rejects incoming calls with `UnavailableError` (Q-6, PLAT-10, PLAT-12).
7. Given simulated function invocations and storage calls, when flushed, then `MetricsExporter` outputs valid OTLP and Prometheus formats with matching counters and histograms (PLAT-13).
8. Given a full project export archive, when restored into a different tenant project, then all restored entities are re-scoped to the target project's physical prefix and revisions with conflicting hashes are rejected with `ConflictError` (PLAT-7, PLAT-18, ADR-0002).

## Tests required

- [x] Integration — control plane outage fail-static and cold boot recovery test
- [x] Integration — health check deployment gating and pointer-flip rollback test
- [x] Integration — queue consumer redelivery and DLQ fault injection test
- [x] Integration — provider circuit breaker trip and recovery test
- [x] Integration — usage metrics accumulation and export test
- [x] Security — verify tenant prefix isolation (PLAT-7) and secret redaction (PLAT-15) remain invariant under simulated failure and disaster recovery import

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Integration tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches PLAT-7 and PLAT-15)
- [x] Nothing outside "In scope" touched

```
$ deno check tests/integration/reliability_test.ts
Exit code: 0

$ deno test --allow-read --allow-write --allow-net --allow-run tests/integration/reliability_test.ts
running 9 tests from ./tests/integration/reliability_test.ts
Reliability AC1 - Live runtime serves traffic from snapshot cache indefinitely during CP outage (PLAT-8, PLAT-10) ... ok (56ms)
Reliability AC2 - Cold-starting secondary runtime node recovers routes from disk cache during CP outage (PLAT-8) ... ok (81ms)
Reliability AC3 - Failing health check keeps revision in Failed state and preserves serving revision (PLAT-3, FN-3) ... ok (15ms)
Reliability AC4 - Rollback flips traffic pointer instantly without rebuilding code (FN-3, PLAT-3) ... ok (16ms)
Reliability AC5 - Poison queue message retried with visibility timeout and delivered to DLQ after 5 attempts (Q-3, Q-5) ... ok (13ms)
Reliability AC6 - Atomic circuit breaker trips to Open after threshold failures and recovers via Half-Open (Q-6, PLAT-10, PLAT-12) ... ok (5ms)
Reliability AC7 - MetricsExporter accumulates usage records and outputs valid OTLP and Prometheus text (PLAT-13) ... ok (3ms)
Security - AC8, PLAT-7: disaster recovery export and restore enforces strict tenant physical prefix re-scoping ... ok (76ms)
Security - PLAT-15: auto-redacts sensitive credentials across provider failures and error normalization ... ok (14ms)

ok | 9 passed | 0 failed (359ms)
Exit code: 0

$ deno lint tests/integration/reliability_test.ts
Checked 1 file
Exit code: 0

$ deno fmt --check tests/integration/reliability_test.ts
Checked 1 file
Exit code: 0
```

## Assumptions made

- Fault injection uses deterministic mock providers and in-memory error injectors to test failure states without requiring external network dependencies or flaky test sleeps.
