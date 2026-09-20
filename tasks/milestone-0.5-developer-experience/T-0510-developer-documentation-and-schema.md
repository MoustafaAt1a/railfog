# T-0510 — Developer Documentation and Configuration Reference

Status: Done
Milestone: 0.5 Developer Experience
Depends on: T-0501, T-0502, T-0503, T-0504
Blocks: T-0511

## Spec references

`PLAT-3`, `PLAT-6`, `PLAT-12`, `PLAT-17`, `PLAT-18`, `PLAT-19`, `FN-1`, `FN-2`, `FN-4`, `FN-5`, `KV-2`, `OBJ-2`, `OBJ-3`, `Q-2`, `Q-4`

## Scope

**In scope**:
- `docs/configuration-reference.md`: Comprehensive reference documentation for `railfog.toml`:
  1. Top-level attributes: `name` (PLAT-18).
  2. Functions table: `[functions.<name>]`, `entry` (FN-1).
  3. Triggers: `[functions.<name>.triggers]` — `queue`, `schedule`, `http`, `webhook` (FN-2).
  4. Capability permissions: `[functions.<name>.permissions]` — `kv`, `objects`, `queues`, `network`, `secrets` (PLAT-6, PLAT-15).
  5. Resource limits: `[functions.<name>.limits]` — `cpu_ms`, `timeout_ms`, `memory_mb`, `concurrency`, `logs.bytes_per_invocation` with default and maximum values from `FN-5`.
  6. Routes table: `[[routes]]` — `pattern`, `function`, with specificity resolution formula (`PLAT-11`).
  7. Resources: `[kv.<name>]` (consistency: `strong` | `eventual`, KV-5), `[objects.<name>]` (OBJ-1), `[queues.<name>]` (`visibility_timeout_ms`, `max_receives`, `retention_days`, `dlq`, Q-3).
- `docs/sdk-guide.md` & `sdk/typescript/README.md`: Developer guide for the TypeScript SDK covering `RailFogContext`, `KVBinding`, `ObjectBinding`, `QueueBinding`, `EnvBinding`, error codes table (`PLAT-12`), and reliability helpers (`withIdempotency`, `withRetry`).
- Update repo root `README.md` to document Milestone 0.5 developer commands (`rail init`, `rail dev`, `rail check`, `rail secrets`, `rail deploy`, `rail logs`, `rail rollback`, `rail export`, `rail import`, `rail status`).

**Out of scope**:
- Non-TypeScript SDK documentation (PLAT-20).
- Undocumented features or hypothetical 1.1+ extensions (canary deployment, multi-region).

## Interface to implement

None — this task produces documentation files and verified code examples.

## Acceptance criteria (Given/When/Then)

1. Given `docs/configuration-reference.md`, when reviewed against `docs/contracts/`, then every configuration key, type, limit default, and error code cites its exact clause ID.
2. Given `docs/sdk-guide.md`, when inspecting the code examples for each primitive, then all examples compile cleanly against `sdk/typescript/mod.ts` without errors.
3. Given the worked-example walkthrough in the SDK guide, when compared to `docs/contracts/worked-example.md`, then it matches the reference implementation shape and `railfog.toml` verbatim.
4. Given `sdk/typescript/README.md`, when read by a new developer, then it clearly explains how to import `RailFogContext`, declare typed handlers (`FunctionHandler`, `QueueConsumerHandler`), and handle errors using the 10 machine-readable codes from `PLAT-12`.

## Tests required

- [x] Unit — Verification script checking that all TypeScript code blocks embedded in `docs/sdk-guide.md` and `docs/configuration-reference.md` are valid TypeScript and pass type-checking.

## Definition of Done

- [x] Documentation matches every cited clause ID exactly
- [x] Spec-anchor citations present for all limits, algorithms, and configuration fields
- [x] Code snippets verified with `deno check`
- [x] No item from `docs/ANTI-SLOP.md` violated (no buzzwords, no restating the obvious)
- [x] Reviewer pass complete; security-auditor pass complete
- [x] Nothing outside "In scope" touched

## Verification Evidence

```shell
$ deno check tests/unit/docs_test.ts
(clean output, exit code 0)

$ deno test -A tests/unit/docs_test.ts
running 8 tests from ./tests/unit/docs_test.ts
docs/configuration-reference.md - existence and required spec citations ... ok (16ms)
docs/configuration-reference.md - documents all configuration keys, limits, and defaults ... ok (10ms)
docs/sdk-guide.md - existence and required spec citations ... ok (5ms)
docs/sdk-guide.md - SDK primitives, reliability helpers, and canonical worked-example ... ok (9ms)
sdk/typescript/README.md - typed handlers, context, reliability helpers, and PLAT-12 error codes ... ok (3ms)
root README.md - documents Milestone 0.5 CLI commands ... ok (3ms)
Code snippets in docs/sdk-guide.md and docs/configuration-reference.md pass deno check ... ok (22s)
TOML snippets in docs/configuration-reference.md parse successfully ... ok (19ms)

ok | 8 passed | 0 failed (22s)

$ deno lint tests/unit/docs_test.ts sdk/typescript/
Checked 7 files
(clean output, exit code 0)
```

## Assumptions made

None.
