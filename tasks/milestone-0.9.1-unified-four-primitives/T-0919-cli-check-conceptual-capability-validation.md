# T-0919 — Validate Conceptual Capability Declarations in CLI Check

Status: Done
Milestone: 0.9.1 Unified Four-Primitives & SDK Specification
Depends on: T-0911, T-0913
Blocks: T-0917, T-0920

## Spec references

`PLAT-3`, `PLAT-5`, `PLAT-6`, `PLAT-7`, `PLAT-12`, `CONCEPT-2`, `CONCEPT-6`

## Scope

**In scope**:
- Modify `cli/check.ts`:
  - Add static validation logic for `permissions.state`, `permissions.data`, and `permissions.signal` in parsed `railfog.toml` function configurations.
  - Enforce single-resource scoping per PLAT-6: `state` array length must be at most 1, `data` array length must be at most 1, and `signal` array length must be at most 1.
  - Enforce mutual exclusivity per PLAT-6: report an error if both `kv` and `state` are declared, if both `objects` and `data` are declared, or if both `queues` and `signal` are declared (`code: "PLAT-6"`, severity: `"error"`).
  - Enforce strict identifier naming and path traversal protection per PLAT-7: validate that entries in `kv`, `state`, `objects`, `data`, `queues`, and `signal` do not contain `../`, `/`, `\`, null bytes, or illegal punctuation.
  - Ensure `rail check` correctly reflects conceptual permissions in inspection summary output.
- Update `tests/unit/cli_check_test.ts` with test cases covering conceptual permissions, mutual exclusivity validation, and traversal rejection.

**Out of scope**:
- Modifying `cli/deploy.ts` deployment execution pipeline (handled in T-0920).
- Modifying SSRF IP block rules or route specificity calculation.

## Interface to implement

```typescript
// Validation logic within cli/check.ts checkConfig / validateFunctionPermissions:
export interface FunctionPermissionsConfig {
  kv?: string[];
  state?: string[];
  objects?: string[];
  data?: string[];
  queues?: string[];
  signal?: string[];
  network?: string[];
  secrets?: string[];
}
```

## Acceptance criteria (Given/When/Then)

1. Given a `railfog.toml` with `permissions.state = ["sessions"]`, `permissions.data = ["uploads"]`, and `permissions.signal = ["jobs"]`, when `rail check` runs, then validation succeeds with zero errors.
2. Given a `railfog.toml` declaring `state = ["a", "b"]`, when `rail check` runs, then validation reports an error: `"Ambiguous scope: function cannot declare multiple State namespaces (PLAT-6)"`.
3. Given a `railfog.toml` declaring both `kv = ["sessions"]` and `state = ["sessions"]`, when `rail check` runs, then validation reports an error: `"Conflicting capability declaration: cannot declare both 'kv' and 'state' (PLAT-6)"`.
4. Given a `railfog.toml` declaring a capability identifier with `../` (e.g. `state = ["../secret_store"]`), when `rail check` runs, then validation reports an error: `"Invalid resource identifier: path traversal detected (PLAT-7)"`.
5. Given existing valid configurations using only `kv`, `objects`, and `queues`, when `rail check` runs, then validation passes without regression.

## Tests required

- [x] Unit — `tests/unit/cli_check_test.ts` verifying validation of `state`, `data`, `signal`, array element string checks, and reporting.
- [x] Integration — `rail check` on full test configurations containing conceptual capability declarations.
- [x] Security — Adversarial test verifying that dual declaration (`kv` + `state`) and traversal strings (`../`, `\`) are strictly blocked before packaging (PLAT-6, PLAT-7).

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

`cli/check.ts` continues to report errors as structured `ValidationIssue` objects matching `PLAT-12`.
