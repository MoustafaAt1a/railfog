# T-0313 — Comprehensive security and adversarial end-to-end test suite

Status: Done
Milestone: 0.3 Security
Depends on: T-0301, T-0302, T-0303, T-0304, T-0305, T-0306, T-0307, T-0308, T-0309, T-0310, T-0311, T-0312
Blocks: none

## Spec references

`PLAT-4` `PLAT-5` `PLAT-6` `PLAT-7` `PLAT-15` `FN-6` `FN-7`

## Scope

**In scope:**
- `tests/security/adversarial_e2e_test.ts`:
  - Comprehensive adversarial test suite validating the defense-in-depth guarantees of Milestone 0.3 across both `LocalIsolationProvider` and `ProcessIsolationProvider`:
    1. Cross-tenant data isolation: attempt key prefix spoofing, path traversal escapes, and cross-project KV/Object/Queue access (PLAT-6, PLAT-7).
    2. Network SSRF & DNS rebinding: attempt requests targeting cloud metadata (`169.254.169.254`, `[fd00:ec2::254]`), loopback (`127.0.0.1`), RFC1918 ranges, and rebinding DNS hostnames (PLAT-5).
    3. Secret exfiltration: attempt reading undeclared secrets, verify invocation-time secret rotation without redeploy, and verify automatic redaction of secret values in logs and error traces (PLAT-15, PLAT-13).
    4. Warm-isolate state bleeding: attempt global state poisoning, stored reference reuse, and credential hijacking across distinct functions and revisions in warm sandboxes (FN-6).
    5. Denial-of-wallet & resource exhaustion: verify token bucket request throttling (PLAT-9), call-depth recursion aborts (FN-7), wall-clock timeouts (FN-5), per-invocation operation quotas (FN-5), and payload size limits (FN-5).
    6. Sandbox boundary escape: attempt host filesystem reads/writes, child process execution (`Deno.Command`), and host environment variable inspection (PLAT-4).

**Out of scope:**
- Automatic retry policies and circuit breakers (Milestone 0.4 Reliability).
- Control plane disaster recovery and failover testing (Milestone 0.4).
- Production deployment canary automation (deliberate 1.1+ deferral per PLAT-20).

## Interface to implement

```typescript
// none — this is an end-to-end adversarial integration test suite
```

## Acceptance criteria (Given/When/Then)

1. Given an adversarial function attempting to read or overwrite another project's storage keys by forging prefixes or traversal sequences, when executed, then the operation is structurally impossible at the binding layer and blocked by the tenant provider guard (PLAT-6, PLAT-7).
2. Given an adversarial function attempting outbound network requests to cloud metadata (`169.254.169.254`) directly or through DNS rebinding, when executed, then the connection is intercepted and terminated by the connect-time IP blocker (PLAT-5).
3. Given an adversarial function attempting to exfiltrate secrets via `ctx.env.get` for undeclared keys or by dumping memory into logs, when executed, then undeclared secrets return `undefined` and bound secret values appear redacted as `[REDACTED]` in all log and error outputs (PLAT-15).
4. Given two functions executing sequentially in a warm isolate, when the first function mutates global state or attempts to cache capability references, then the second invocation runs with fresh bindings and cannot read the prior function's context (FN-6).
5. Given an adversarial function initiating mutual recursive calls (A -> B -> A), when call depth exceeds 8 hops, then the 9th call is aborted with `429 CALL_DEPTH_EXCEEDED` (FN-7).
6. Given an adversarial function attempting to execute `Deno.Command`, read host paths like `/etc/passwd`, or query host environment variables, when executed under `ProcessIsolationProvider`, then all operations fail with security permission errors (PLAT-4).

## Tests required

- [x] Unit — none (end-to-end security integration suite)
- [x] Integration — full lifecycle test verifying multiple isolated functions executing under sandboxed providers
- [x] Security — execute all 6 adversarial vectors and verify zero bypasses, zero unredacted secrets, and zero state leaks (PLAT-4, PLAT-5, PLAT-6, PLAT-7, PLAT-15, FN-6, FN-7)

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Security test suite written first (red), then verified passing (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches PLAT-4, PLAT-5, PLAT-6, PLAT-7, PLAT-15, FN-6, FN-7)
- [x] Nothing outside "In scope" touched

## Assumptions made

Tests run against `LocalIsolationProvider` and `ProcessIsolationProvider` on the local test harness.
