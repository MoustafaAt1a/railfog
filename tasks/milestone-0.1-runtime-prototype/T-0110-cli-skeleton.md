# T-0110 — `rail` CLI skeleton

Status: Done
Milestone: 0.1 Runtime Prototype
Depends on: T-0101, T-0108
Blocks: T-0111

## Spec references

`PLAT-19` (repo has `cli/`), plus the command list implied by the LTS §8.4
CLI table — this milestone implements only `init`, `dev` (stub calling
T-0111 once it exists), and `status`.

## Scope

**In scope:**
- `cli/main.ts`: `rail init` scaffolds a starter `railfog.toml` + one example
  Function file. `rail status` prints loaded Functions/routes from the local
  config (no health data yet — 0.4). `rail dev` is a thin entry point that
  will call T-0111's server once that task exists (may be a documented stub
  returning "not yet implemented" if built before T-0111 lands).

**Out of scope:**
- `rail deploy`, `rail logs`, `rail function`, `rail kv`, `rail object`,
  `rail queue` subcommands — all require the deployment pipeline or remote
  providers (0.2+).

## Interface to implement

```typescript
// cli/main.ts — Deno.args-driven dispatch
// rail init   → scaffolds railfog.toml + functions/api.ts
// rail status → parses railfog.toml, prints functions + routes as a table
// rail dev    → delegates to runtime/dev-server (T-0111)
```

## Acceptance criteria

1. Given an empty directory, when `rail init` runs, then a valid
   `railfog.toml` and one example Function file exist afterward, and
   `deno task check` on the new Function file passes.
2. Given a directory with a `railfog.toml` containing two routes, when
   `rail status` runs, then both routes and their target Functions are
   printed.

## Tests required

- [x] Unit — `railfog.toml` scaffold content is valid TOML and parses
- [x] Integration — `rail init` then `rail status` in a temp directory,
      real filesystem, real CLI invocation
- [ ] Security — n/a this task

## Definition of Done

- [x] No subcommand beyond `init`/`status`/`dev` exists yet (no scope creep
      into 0.2's `deploy` etc.)
- [x] `deno check` / `deno test` / `deno lint` clean, real output attached

## Assumptions made

Output formatting for `rail status` (table vs. JSON) is an implementation
choice — human-readable table by default, since no `--json` flag is
specified anywhere in the spec yet.

## Verification Evidence

```
$ deno check **/*.ts
Check cli/main.ts
Check cli/main_test.ts
Check packages/core/crypto/content-address.ts
Check packages/core/crypto/content-address_test.ts
Check packages/core/id/ulid.ts
Check packages/core/id/ulid_test.ts
Check packages/errors/mod.ts
Check packages/errors/mod_test.ts
Check packages/policy/permission-resolver.ts
Check packages/policy/permission-resolver_test.ts
Check primitives/kv/kv-provider.ts
Check primitives/objects/object-provider.ts
Check primitives/queues/queue-provider.ts
Check providers/kv/sqlite-provider.ts
Check providers/kv/sqlite-provider_test.ts
Check providers/objects/local-fs-provider.ts
Check providers/objects/local-fs-provider_test.ts
Check providers/queues/sqlite-queue-provider.ts
Check providers/queues/sqlite-queue-provider_test.ts
Check runtime/loader/context-builder.ts
Check runtime/loader/function-loader.ts
Check runtime/loader/function-loader_test.ts
Check runtime/router/route-matcher.ts
Check runtime/router/route-matcher_test.ts
Check tests/fixtures/functions/invalid_no_export.ts
Check tests/fixtures/functions/invalid_null_export.ts
Check tests/fixtures/functions/invalid_object_export.ts
Check tests/fixtures/functions/invalid_wrong_type.ts
Check tests/fixtures/functions/valid_function.ts
Check tests/security/loader_security_test.ts

$ deno test --allow-read --allow-write --allow-run cli/main_test.ts
running 7 tests from ./cli/main_test.ts
Unit: starter railfog.toml scaffold content is valid TOML and parses into { name, functions, routes } ... ok (3ms)
Integration: AC1 - rail init creates valid railfog.toml and functions/api.ts, deno check passes ... ok (859ms)
Integration: AC2 - rail status prints loaded functions and routes from railfog.toml ... ok (105ms)
Integration: rail init followed by rail status in a temp directory ... ok (189ms)
Integration: rail dev stub exits 0 and reports not yet implemented (T-0111) ... ok (101ms)
Integration: rail status in empty directory handles missing railfog.toml ... ok (119ms)
Integration: unknown subcommand beyond init/status/dev is rejected ... ok (93ms)

ok | 7 passed | 0 failed (1s)

$ deno task test
Task test deno test --allow-read --allow-write --allow-net --allow-run
running 7 tests from ./cli/main_test.ts ... ok
running 2 tests from ./packages/core/crypto/content-address_test.ts ... ok
running 5 tests from ./packages/core/id/ulid_test.ts ... ok
running 3 tests from ./packages/errors/mod_test.ts ... ok
running 9 tests from ./packages/policy/permission-resolver_test.ts ... ok
running 5 tests from ./providers/kv/sqlite-provider_test.ts ... ok
running 8 tests from ./providers/objects/local-fs-provider_test.ts ... ok
running 7 tests from ./providers/queues/sqlite-queue-provider_test.ts ... ok
running 10 tests from ./runtime/loader/function-loader_test.ts ... ok
running 7 tests from ./runtime/router/route-matcher_test.ts ... ok
running 10 tests from ./tests/security/loader_security_test.ts ... ok

ok | 73 passed | 0 failed (8s)

$ deno lint
Checked 30 files

$ deno fmt --check
Checked 31 files
```

