# T-0756 — Milestone 0.75 Verification and Security Integrity Audit

Status: Not started
Milestone: 0.75 Backing Services and Auth
Depends on: T-0751, T-0752, T-0753, T-0754, T-0755
Blocks: none

## Spec references

`PLAT-4`, `PLAT-6`, `PLAT-7`, `PLAT-9`, `PLAT-15`, `KV-1`, `KV-2`, `KV-3`, `KV-4`, `KV-5`

## Scope

**In scope**:
- `tests/integration/backing_services_auth_test.ts` — Integration test covering PostgreSQL persistence, Redis caching, API key authentication, and control/runtime daemon interoperability.
- `tests/security/api_key_redaction_audit_test.ts` — Adversarial security audit validating that raw API tokens are never leaked into error messages, structured logs, or serialized cache structures (`PLAT-15`).
- End-to-end milestone verification via `deno check`, `deno test`, and `deno lint`.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Creating new production features or changing API shapes.
- Modifying spec contracts under `docs/contracts/`.

## Interface to implement

None — this is the verification and audit task for Milestone 0.75.

## Acceptance criteria (Given/When/Then)

1. Given the integrated RailFog stack with PostgreSQL, Redis, and API key authentication, when a full end-to-end deployment is triggered with a valid API key, then the deployment succeeds and the updated snapshot is immediately cached and served (`PLAT-3`, `PLAT-8`).
2. Given an invalid or revoked API key, when any control plane management endpoint or protected runtime route is accessed, then the request is denied with canonical `403 PERMISSION_DENIED` (`PLAT-12`).
3. Given an adversarial security test that triggers database errors, cache timeouts, and authentication failures, when inspecting error messages, stack traces, and logs, then zero raw API keys or secrets appear anywhere in the output (`PLAT-15`).
4. Given `deno check`, `deno test`, and `deno lint` commands run across the entire codebase, then all commands exit with code 0 and zero warnings.

## Tests required

- [ ] Unit — All preceding unit tests in `tests/unit/` pass.
- [ ] Integration — `tests/integration/backing_services_auth_test.ts`: Full backing services and auth integration flow.
- [ ] Security — `tests/security/api_key_redaction_audit_test.ts`: Adversarial secret leakage and capability boundary test (`PLAT-6`, `PLAT-15`).

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly
- [ ] Spec-anchor comments verified across all new modules
- [ ] `deno check **/*.ts` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all test suites passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] Security-auditor pass completed for PLAT-6 and PLAT-15 compliance
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] All milestone tasks marked Done with verified DoD checklists

## Assumptions made

- Railway environment variables (`DATABASE_URL`, `REDIS_URL`) or test harness stubs are available during integration testing.
