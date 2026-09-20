# T-0107 — Capability injection (permission resolver)

Status: Done
Milestone: 0.1 Runtime Prototype
Depends on: T-0102, T-0104, T-0105, T-0106
Blocks: T-0108, T-0111

## Spec references

`PLAT-6` `PLAT-7` `KV-4`

This is the single most important task in the milestone —
`docs/00-deep-analysis.md` §3 names capability injection as the spec's most
novel and most easily-regressed decision. Read `PLAT-6` in full before
starting, not just this task file.

## Scope

**In scope:**
- `packages/policy/permission-resolver.ts`: given a parsed `railfog.toml`
  permissions block for one Function and the three raw providers
  (T-0104/0105/0106), produce pre-scoped binding objects (`KVBinding`,
  `ObjectBinding`, `QueueBinding`) that physically cannot address anything
  outside the declared scope.
- Physical key namespacing per PLAT-7:
  `{org_id}/{project_id}/{resource_name}/{caller_key}` — applied inside the
  binding closures, invisible to and unconstructable by the Function.
- Deploy-time validation: an unresolvable or ambiguous scope in
  `railfog.toml` throws `VALIDATION_FAILED` at resolution time, never at
  first use.

**Out of scope:**
- Network permission enforcement (PLAT-5 — 0.3).
- Secret permission enforcement (PLAT-15 — 0.3).
- Anything about the Function loader consuming these bindings (T-0108).

## Interface to implement

```typescript
interface ResolvedBindings { kv: KVBinding; objects: ObjectBinding; queues: QueueBinding; }
function resolvePermissions(
  declared: { kv?: string[]; objects?: string[]; queues?: string[] },
  orgId: string, projectId: string,
  providers: { kv: KVProvider; objects: ObjectProvider; queues: QueueProvider },
): ResolvedBindings;   // throws VALIDATION_FAILED on unresolvable scope
```

A `KVBinding` exposes the *same shape* as `KVProvider` (`get`/`set`/`delete`/
`list`/`atomic`) but every call is pre-namespaced — there is no parameter on
any binding method through which a caller could specify a different resource
name or another project's prefix. If such a parameter would need to exist for
this to work, the design is wrong; stop and escalate per `AGENTS.md` §8.

## Acceptance criteria

1. Given a Function permitted only `kv = ["app:sessions"]`, when its
   `KVBinding` is inspected, then no method on it can read or write any key
   under `app:other-namespace` — prove this with a test that *attempts* the
   unpermitted access and asserts it is a compile-time or structurally
   impossible call, not merely a runtime-denied one (`docs/contracts/
   platform.contract.md` PLAT-6's testability requirement, added specifically
   for this task).
2. Given two Functions in different projects with identically-named resource
   permissions (`kv = ["app:sessions"]` in both), when each writes to its
   binding, then the physical keys never collide (PLAT-7 prefix includes
   `project_id`).
3. Given a `railfog.toml` permissions block naming a KV resource that doesn't
   exist in config, when resolved, then it throws `VALIDATION_FAILED`
   immediately, not on first use inside the Function.

## Tests required

- [x] Unit — namespace prefix construction, ambiguous-scope rejection
- [x] Integration — two-project collision test (criterion 2) against real
      T-0104 SQLite provider
- [x] Security — attempt every unpermitted-resource access pattern and
      confirm it is inexpressible, not just denied (`docs/contracts/
      platform.contract.md` PLAT-6 note, `docs/ANTIHALLUCINATION.md` Rule 2
      banned-pattern: no runtime `if (hasPermission(...))` check anywhere in
      this module)

## Definition of Done

- [x] Zero runtime permission-check branches anywhere in this module — the
      binding's method set itself is the enforcement mechanism
- [x] Security-auditor pass required before this task can close
      (`AGENTS.md` §7 — this task touches PLAT-6/PLAT-7, both in the security-auditor trigger set)
- [x] `deno check` / `deno test` / `deno lint` clean, real output attached

```
$ deno task check
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
EXIT: 0

$ deno task test
Task test deno test --allow-read --allow-write --allow-net
running 2 tests from ./packages/core/crypto/content-address_test.ts
... (2 passed)
running 5 tests from ./packages/core/id/ulid_test.ts
... (5 passed)
running 3 tests from ./packages/errors/mod_test.ts
... (3 passed)
running 9 tests from ./packages/policy/permission-resolver_test.ts
Unit: Ambiguous scopes or invalid resource names throw VALIDATION_FAILED ... ok (1ms)
Unit: Undeclared permission results in undefined capability ... ok (2ms)
Integration: Two-project collision test for KV (Real provider) ... ok (2ms)
Integration: Two-project collision test for Objects (Real provider) ... ok (39ms)
Integration: Two-project isolation for Queues (Real provider) ... ok (2ms)
Deploy-time validation: Empty or invalid parameters throw VALIDATION_FAILED ... ok (1ms)
Security: Adversarial path traversal fails and cannot escape project scope ... ok (3ms)
Security: PLAT-6 guarantee (structurally impossible to address out-of-scope for all 16 methods) ... ok (3ms)
Security: No runtime permission check branches ... ok (1ms)
running 5 tests from ./providers/kv/sqlite-provider_test.ts
... (5 passed)
running 8 tests from ./providers/objects/local-fs-provider_test.ts
... (8 passed)
running 7 tests from ./providers/queues/sqlite-queue-provider_test.ts
... (7 passed)
ok | 39 passed | 0 failed (6s)
EXIT: 0

$ deno task lint
Task lint deno lint
Checked 18 files
EXIT: 0

$ deno fmt --check
Checked 19 files
EXIT: 0
```

## Assumptions made

`org_id`/`project_id` are passed in as already-resolved strings; this task
does not implement identity/auth resolution (out of scope — later milestone).
Using placeholder single-org/single-project values in local dev is an
implementation convenience, not a spec claim about auth.

