# T-0108 — RailFogContext and Function loader

Status: Done
Milestone: 0.1 Runtime Prototype
Depends on: T-0102, T-0103, T-0107
Blocks: T-0110, T-0111

## Spec references

`FN-1` `FN-3` `FN-4` `FN-6`

## Scope

**In scope:**
- `runtime/loader/function-loader.ts`: loads a Function module (a plain
  TypeScript file exporting a default handler, FN-1) and its declared
  triggers/limits/permissions from `railfog.toml`.
- `runtime/loader/context-builder.ts`: builds one `RailFogContext` per
  invocation from T-0107's resolved bindings plus a fresh `requestId`
  (T-0103's ULID) and a `deadline` derived from the Function's `timeout_ms`.
- Warm-reuse rule (FN-6): the loader may cache the *loaded module* across
  invocations of the same Function+Revision, but `context-builder` must be
  called fresh on every invocation — no `RailFogContext` or binding is ever
  reused across invocations.

**Out of scope:**
- Any actual isolation boundary (OS sandbox / microVM — 0.3). This milestone
  runs Functions in-process for local dev; `docs/contracts/
  platform.contract.md` PLAT-17 explicitly allows "Isolation: none (trusted
  dev machine)" for local.
- Enforcing `cpu_ms`/`memory_mb` limits (0.3) — `timeout_ms` only, since it's
  needed just to make `deadline`/`timeRemaining()` meaningful.

## Interface to implement

```typescript
interface RailFogContext {
  requestId: string; project: string; function: string; revision: string;
  deadline: number; timeRemaining(): number;
  kv: KVBinding; objects: ObjectBinding; queues: QueueBinding; env: EnvBinding;
}
function loadFunction(entry: string): Promise<{ handler: (req: Request, ctx: RailFogContext) => Promise<Response> }>;
function buildContext(fn: LoadedFunctionMeta, bindings: ResolvedBindings): RailFogContext;
```

## Acceptance criteria

1. Given a Function loaded twice for the same Revision, when compared, then
   the module reference is reused (warm cache) but two separately-built
   `RailFogContext` objects for two invocations are never `===` and never
   share a binding instance (FN-6).
2. Given `timeout_ms: 30000`, when `ctx.timeRemaining()` is called 100ms
   after context creation, then it returns approximately `29900` (real
   elapsed time, not a mocked clock — `docs/ANTIHALLUCINATION.md` Rule 5).
3. Given a Function file with no default export, when loaded, then it throws
   a clear `VALIDATION_FAILED`, not a generic runtime error.

## Tests required

- [x] Unit — deadline/timeRemaining math, missing-export validation
- [x] Integration — warm-cache reuse across two invocations, binding
      freshness assertion (criterion 1)
- [x] Security — FN-6 & PLAT-15 adversarial security audit in `tests/security/loader_security_test.ts` (passed)

## Definition of Done

- [x] No binding or `RailFogContext` field is ever assigned in module scope
      and read across invocations (FN-6, enforced by test, not by comment)
- [x] `env` binding returns only secrets explicitly declared — with no
      secrets store yet (0.3), this returns an empty/no-op `EnvBinding` this
      milestone, not a stub that silently exposes `Deno.env`
- [x] `deno check` / `deno test` / `deno lint` clean, real output attached

### Verification Output

```
> deno task check
Task check deno check **/*.ts
Check cli/main.ts
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
Check tests/fixtures/functions/invalid_no_export.ts
Check tests/fixtures/functions/invalid_null_export.ts
Check tests/fixtures/functions/invalid_object_export.ts
Check tests/fixtures/functions/invalid_wrong_type.ts
Check tests/fixtures/functions/valid_function.ts
Check tests/security/loader_security_test.ts

> deno test --allow-read --allow-write --allow-net runtime/loader
running 10 tests from ./runtime/loader/function-loader_test.ts
buildContext: returns valid ULID for requestId ... ok (1ms)
buildContext: deadline math and timeRemaining ... ok (121ms)
buildContext: default timeout uses DEFAULT_TIMEOUT_MS if omitted ... ok (177µs)
buildContext: env binding is empty and does not expose Deno.env ... ok (105µs)
buildContext: project, function, revision match meta ... ok (145µs)
Warm-reuse rule (FN-6): buildContext returns separate contexts and bindings per invocation ... ok (168µs)
loadFunction: successfully loads a valid function and caches it ... ok (6ms)
loadFunction: throws ValidationFailedError if file missing ... ok (1ms)
loadFunction: throws ValidationFailedError if no default export ... ok (3ms)
loadFunction: throws ValidationFailedError if default export is not a function ... ok (4ms)

ok | 10 passed | 0 failed (163ms)

> deno task test
Task test deno test --allow-read --allow-write --allow-net
running 2 tests from ./packages/core/crypto/content-address_test.ts ... ok
running 5 tests from ./packages/core/id/ulid_test.ts ... ok
running 3 tests from ./packages/errors/mod_test.ts ... ok
running 9 tests from ./packages/policy/permission-resolver_test.ts ... ok
running 5 tests from ./providers/kv/sqlite-provider_test.ts ... ok
running 8 tests from ./providers/objects/local-fs-provider_test.ts ... ok
running 7 tests from ./providers/queues/sqlite-queue-provider_test.ts ... ok
running 10 tests from ./runtime/loader/function-loader_test.ts ... ok
running 10 tests from ./tests/security/loader_security_test.ts ... ok

ok | 59 passed | 0 failed (6s)

> deno task lint
Task lint deno lint
Checked 27 files

> deno task fmt --check
Task fmt deno fmt '--check'
Checked 28 files
```

## Assumptions made

`EnvBinding` this milestone is a placeholder that always denies (no secret
store exists yet) rather than a working implementation — flagged so it isn't
mistaken for PLAT-15 being satisfied; PLAT-15 is explicitly 0.3 scope.
