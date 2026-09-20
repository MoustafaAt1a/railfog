# T-0511 — Developer Experience End-to-End Test Suite

Status: Done
Milestone: 0.5 Developer Experience
Depends on: T-0502, T-0503, T-0504, T-0505, T-0506, T-0507, T-0508, T-0509, T-0510
Blocks: none

## Spec references

`PLAT-3`, `PLAT-12`, `PLAT-13`, `PLAT-14`, `PLAT-15`, `PLAT-17`, `PLAT-19`, `FN-1`, `FN-2`, `FN-3`, `FN-4`, `FN-5`, `FN-6`, `FN-7`, `FN-8`, `KV-2`, `OBJ-2`, `OBJ-3`, `Q-2`, `Q-3`, `Q-4`

## Scope

**In scope**:
- `tests/e2e/developer_experience_test.ts`: Automated end-to-end integration test validating the entire developer journey across the CLI, runtime, and SDK:
  1. Initialize: execute `rail init` to scaffold a project using the canonical worked-example template.
  2. Validate: run `rail check` and assert exit code 0 and clean diagnostic output.
  3. Secrets: run `rail secrets set` and `rail secrets list`, verifying encryption and zero plaintext exposure.
  4. Local Run & Hot-Reload: launch `rail dev`, invoke HTTP endpoint, verify queue triggering, edit a handler file, and confirm live reload takes effect without server crash.
  5. Deploy with Diagnostics: run `rail deploy`, assert pre-deploy diagnostics pass, artifact hash is computed (`sha256:` hex per `OBJ-4`), and health checks pass (3 consecutive 200s within 30s per `PLAT-3`).
  6. Log Inspection: execute `rail logs` and verify structured format with ULID `request_id` and secret masking.
  7. Rollback: trigger a faulty revision deployment (health check fails, stays inactive per `PLAT-3`), then verify `rail rollback` cleanly flips the active pointer.

**Out of scope**:
- Public beta multi-tenant load testing (Milestone 0.6).
- Deployment to live third-party cloud infrastructure requiring active credit card billing accounts.

## Interface to implement

None — this is the milestone-closing comprehensive end-to-end test suite.

## Acceptance criteria (Given/When/Then)

1. Given an empty temporary directory, when running `rail init --template=worked-example`, then the project files are created and pass `rail check` with zero errors.
2. Given a secret set via `rail secrets set TEST_KEY secret123`, when listed with `rail secrets list`, then `TEST_KEY` is shown and the plaintext `secret123` is never output.
3. Given the worked-example flow running under `rail dev`, when a client requests `POST /upload`, then presigned URL is returned (`OBJ-2`, `OBJ-3`), queue event is processed (`Q-2`, `Q-3`), and status is stored in KV (`KV-2`).
4. Given `rail deploy` executed on the project, when pre-deploy diagnostics run, then artifact digest is emitted (`OBJ-4`), health checks verify 3 consecutive 200s (`PLAT-3`), and revision flips active.
5. Given `rail logs --format=pretty`, when output is captured, then every line displays human-readable timing, ULID request ID (`PLAT-14`), and redacted secrets (`PLAT-15`).
6. Given a simulated bad revision failing health checks, when deployed, then the previous revision remains active, and running `rail rollback` confirms pointer stability.

## Tests required

- [x] Integration — `tests/e2e/developer_experience_test.ts`: Complete lifecycle sequence executing CLI commands and asserting expected state and stdout/stderr output.
- [x] Security — Adversarial check verifying that no secret value leaks in `rail logs`, `rail secrets list`, or `rail deploy` output.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-3`, `PLAT-12`, `PLAT-13`, `PLAT-14`, `PLAT-15`, `PLAT-17`, `PLAT-19`, `FN-1..FN-8`, `KV-2`, `OBJ-2`, `OBJ-3`, `Q-2`, `Q-3`, `Q-4`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Integration tests written first (red), then verified green
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete for PLAT-15
- [x] Nothing outside "In scope" touched

### Verification Outputs

```
$ deno check tests/e2e/developer_experience_test.ts
(clean exit code 0, zero errors)
```

```
$ deno test -A tests/e2e/developer_experience_test.ts
running 4 tests from ./tests/e2e/developer_experience_test.ts
E2E Developer Journey: Init -> Check -> Secrets -> Dev/Hot-Reload -> Deploy -> Logs -> Rollback (T-0511 AC1-AC6) ...
------- output -------

Route Specificity Summary (PLAT-11):
  SCORE  ROUTE PATTERN                  FUNCTION
  -----  -----------------------------  --------
      2  /upload                        api

Configuration valid. Zero errors found.
Listening on http://localhost:31160/
RailFog dev server running on http://localhost:31161

Local providers (PLAT-17 parity):
  KV & Queues: SQLite
  Objects:     LocalFS

Routes:
  /upload              -> api              (score: 2)
[01M2Y0HD8J200DTPM99QNJEJ5V] POST /upload 200 121ms
Reloaded functions/api.ts
[01M2Y0HE2XEH7CAAKAJPEX9YPF] POST /upload 200 82ms
Rolled back function 'api' in project 'railfog-e2e-journey-a74be8b9d16212a6' to revision rev_01M2Y0HE65200JEKXXSEGSXY26.
----- output end -----
E2E Developer Journey: Init -> Check -> Secrets -> Dev/Hot-Reload -> Deploy -> Logs -> Rollback (T-0511 AC1-AC6) ... ok (2s)
Security: Adversarial verification - zero secret leakage across secrets list, deploy, and structured logs (PLAT-15, AC2, AC5) ...
------- output -------
Secret API_KEY updated
Secret DB_PASSWORD updated
----- output end -----
Security: Adversarial verification - zero secret leakage across secrets list, deploy, and structured logs (PLAT-15, AC2, AC5) ... ok (484ms)
Parity & Data Transfer: Direct client-to-storage upload (OBJ-2, OBJ-3) and KV idempotency deduplication (Q-4, KV-2) ...Listening on http://localhost:15409/
 ok (368ms)
Lifecycle: Rollback pointer stability and health check gating (PLAT-3, FN-3) ...
------- output -------
Rolled back function 'api' in project 'lifecycle-project' to revision rev_01M2Y0HFAJYYZ2BG0YASWF7X3P.
----- output end -----
Lifecycle: Rollback pointer stability and health check gating (PLAT-3, FN-3) ... ok (85ms)

ok | 4 passed | 0 failed (3s)
```

```
$ deno lint tests/e2e/developer_experience_test.ts
Checked 1 file
(clean exit code 0, zero warnings)
```

```
$ deno test -A
...
ok | 1062 passed | 0 failed (3m57s)
```

## Assumptions made

None.
