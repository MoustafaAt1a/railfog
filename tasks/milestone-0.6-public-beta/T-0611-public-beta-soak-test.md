# T-0611 — Public Beta Chaos Soak Test Suite

Status: Done
Milestone: 0.6 Public Beta
Depends on: T-0603, T-0604, T-0605, T-0606, T-0607, T-0608, T-0609, T-0610
Blocks: none

## Spec references

`PLAT-1`, `PLAT-3`, `PLAT-7`, `PLAT-8`, `PLAT-9`, `PLAT-10`, `PLAT-12`, `PLAT-13`, `PLAT-14`, `PLAT-15`, `PLAT-17`, `PLAT-18`, `FN-1`, `FN-5`, `FN-6`, `FN-8`, `Q-3`, `OBJ-3`

## Scope

**In scope**:
- `tests/e2e/public_beta_soak_test.ts`: Automated multi-process end-to-end soak and chaos test suite closing Milestone 0.6:
  1. Launch the complete production topology: Ingress Gateway (`apps/gateway/gateway-server.ts`), Standalone Control Plane (`apps/api/control-server.ts`), Standalone Runtime Data Plane (`apps/runtime/runtime-server.ts`), and Background Worker Supervisor (`apps/worker/worker-supervisor.ts`).
  2. Deploy canonical multi-function worked example via the control plane (`POST /v1/projects/:id/deploy`), verifying pre-deploy diagnostics and 3 consecutive 200s health check gating (`PLAT-3`).
  3. Drive concurrent multi-tenant workloads: direct upload presigning, payload upload (`OBJ-3`), queue event submission, worker processing, and KV status polling.
  4. Fail-Static Chaos Injection (`PLAT-8`): forcefully terminate the `railfog-control` process mid-traffic. Assert that `railfog-runtime` and `gateway` continue serving 100% of live customer requests fail-static without interruption, dropped sockets, or degraded latency.
  5. Restore control plane: verify runtime background poller reconnects and synchronizes seamlessly.
  6. Rate Limiting Under Soak (`PLAT-9`): verify bursts exceeding limits receive HTTP 429 `RATE_LIMITED` with `Retry-After` without starving compliant tenants.
  7. Graceful Drain Protocol (`PLAT-1`, `PLAT-10`): initiate shutdown coordination and assert in-flight requests and queue workers finish without truncation.
  8. Metering & Cost Audit (`PLAT-13`): verify that usage logs accurately record all invocation, compute, and primitive operations, and CLI `runUsage` outputs exact itemized costs.

**Out of scope**:
- Cloud datacenter multi-region disaster recovery (banned per `PLAT-20`).
- Third-party billing API charging (banned per `PLAT-20`).

## Interface to implement

None — this is the milestone-closing comprehensive end-to-end test suite.

## Acceptance criteria (Given/When/Then)

1. Given the complete two-process production topology (`railfog-control` and `railfog-runtime` connected via gateway), when a project is deployed and verified, then HTTP requests, direct storage transfers (`OBJ-3`), and queue consumers execute with full fidelity.
2. Given a catastrophic crash of `railfog-control` during active traffic, when requests continue arriving at the data plane, then `railfog-runtime` continues serving requests fail-static from its cached snapshot with $\ge 99.95\%$ availability and zero dropped connections (`PLAT-8`, `PLAT-10`).
3. Given traffic exceeding token bucket rate limits during the test, then the gateway cleanly sheds excess at HTTP 429 `RATE_LIMITED` with `Retry-After` headers without impacting non-bursting tenants (`PLAT-9`).
4. Given thousands of requests and background worker tasks processed across the test, when completed, then zero cross-tenant state bleed occurs (`PLAT-7`, `FN-6`) and secrets remain completely unexposed (`PLAT-15`).
5. Given shutdown initiated on the data plane, then the graceful drain coordinator ensures all active in-flight requests complete before the server exits (`PLAT-10`).
6. Given all recorded usage data from the soak run, when `runUsage` is executed, then it calculates and displays accurate itemized compute, storage, and operational costs.

## Tests required

- [x] Integration — `tests/e2e/public_beta_soak_test.ts`: Complete multi-process lifecycle test executing gateway, control plane, runtime data plane, worker supervisor, and chaos failure injection.
- [x] Security — Adversarial check verifying that no secret value leaks in stdout, stderr, logs, or error responses during control-plane crashes or rate-limit shedding (`PLAT-15`).

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-3`, `PLAT-7`, `PLAT-8`, `PLAT-9`, `PLAT-10`, `PLAT-12`, `PLAT-13`, `PLAT-14`, `PLAT-15`, `PLAT-17`, `PLAT-18`, `FN-1`, `FN-5`, `FN-6`, `FN-8`, `Q-3`, `OBJ-3`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Integration tests written first (red), then verified green
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Verification Transcripts

### `deno check tests/e2e/public_beta_soak_test.ts`
```text
Check file:///C:/FM/railfog/tests/e2e/public_beta_soak_test.ts
Exit code: 0
```

### `deno test -A tests/e2e/public_beta_soak_test.ts`
```text
running 6 tests from ./tests/e2e/public_beta_soak_test.ts
AC1: Deployment & End-to-End Workflow Execution (PLAT-1, PLAT-3, OBJ-3, Q-3) ... ok (179ms)
AC2: Fail-Static Chaos Injection During Active Traffic & Seamless Restoration (PLAT-8, PLAT-10) ... ok (3s)
AC3: Token Bucket Rate Limiting Under Burst & Tenant Isolation (PLAT-9, PLAT-12, PLAT-18) ... ok (1s)
AC4 & Security: Zero Cross-Tenant State Bleed & Secret Sanitization (PLAT-7, PLAT-14, PLAT-15, FN-6) ... ok (1s)
AC5: Graceful Shutdown Coordination with In-Flight Request Draining (PLAT-1, PLAT-10) ... ok (139ms)
AC6: Metering and CLI Usage Cost Audit (PLAT-13, PLAT-18) ... ok (15ms)

ok | 6 passed | 0 failed (7s)
```

### `deno lint tests/e2e/public_beta_soak_test.ts`
```text
Checked 1 file
Exit code: 0
```

### Reviewer Verdict
- **Verdict**: PASS (Independent review verified full end-to-end chaos soak coverage across all 6 Acceptance Criteria and all 18 cited specification clauses, zero flakiness, strict resource cleanup in finally blocks, no banned patterns, and zero secret leakage).

### Security Auditor Verdict
- **Verdict**: PASS (Adversarial audit verified multi-tenant isolation, monotonic 26-char Crockford Base32 ULIDs, zero cross-tenant state bleeding, zero canary secret leakage under rate-limit shedding/crash injection/404s, and fail-closed security boundary enforcement).

## Assumptions made

None.
