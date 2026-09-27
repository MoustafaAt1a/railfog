# T-0914 — Normalize Capability Aliases in Permission Resolver

Status: Done
Milestone: 0.9.1 Unified Four-Primitives & SDK Specification
Depends on: T-0911, T-0912
Blocks: T-0916, T-0917

## Spec references

`PLAT-6`, `PLAT-7`, `KV-2`, `OBJ-2`, `Q-2`, `CONCEPT-2`, `CONCEPT-6`

## Scope

**In scope**:
- Modify `packages/policy/permission-resolver.ts`:
  - Support `state`, `data`, and `signal` in the `declared` permission descriptor, normalizing them to `kv`, `objects`, and `queues`.
  - Disallow conflicting dual declarations (e.g. declaring different namespaces in `state` and `kv`).
  - Align internal `KVBinding`, `ObjectBinding`, and `QueueBinding` signatures with the canonical contract shapes in `docs/contracts/` (reconciling `KVBinding.list` entries structure and removing stray `receive`/`ack` methods from client-facing `QueueBinding`).
- Update `tests/unit/packages_policy_permission_resolver_test.ts` to test normalization and edge cases.

**Out of scope**:
- Direct modifications to SDK files (handled in T-0915 and T-0916).
- Altering the physical namespace prefix format `{org_id}/{project_id}/{resource_name}/{caller_key}` (PLAT-7).

## Interface to implement

```typescript
export interface DeclaredPermissions {
  kv?: string[];
  state?: string[];
  objects?: string[];
  data?: string[];
  queues?: string[];
  signal?: string[];
  network?: string[];
  secrets?: string[];
}

export function normalizeDeclaredCapabilities(
  declared: DeclaredPermissions,
): { kv?: string[]; objects?: string[]; queues?: string[]; network?: string[]; secrets?: string[] };
```

## Acceptance criteria (Given/When/Then)

1. Given a function declaring `state = ["app:sessions"]`, when `resolvePermissions` runs, then `resolved.kv` is bound to `"app:sessions"` with exact prefix scoping per PLAT-7.
2. Given a function declaring `data = ["app:uploads"]` and `signal = ["app:jobs"]`, when `resolvePermissions` runs, then `resolved.objects` and `resolved.queues` are correctly bound.
3. Given a function declaring both alias and primitive (e.g. `state` and `kv`, or `data` and `objects`, or `signal` and `queues`), when `resolvePermissions` runs, then it throws a `ValidationFailedError` citing PLAT-6 mutual exclusivity violation, even if identifiers match.
4. Given a capability identifier containing directory traversal characters (`../`, `/`, `\`) or null bytes, when `resolvePermissions` runs, then it throws a `ValidationFailedError` citing PLAT-7 path traversal isolation violation.
5. Given client-scoped `QueueBinding`, when inspected, then only `send` and `sendBatch` exist per Q-2 (internal `receive`/`ack` methods are purged from client bindings).

## Tests required

- [x] Unit — `tests/unit/packages_policy_permission_resolver_test.ts` verifying alias resolution, normalization, duplicate conflict rejection, and queue method attenuation.
- [x] Integration — none.
- [x] Security — Adversarial check verifying that alias normalization strictly blocks dual declarations (PLAT-6) and path traversal escape sequences (`../`, `/`, `\`) (PLAT-7).

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Assumptions made

`state`, `data`, and `signal` map 1:1 with `kv`, `objects`, and `queues` respectively without changing storage backends.
