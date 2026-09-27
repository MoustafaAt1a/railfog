# T-0921 — Add Conceptual Primitives to CLI Init Starter Templates

Status: Done
Milestone: 0.9.1 Unified Four-Primitives & SDK Specification
Depends on: T-0915, T-0916
Blocks: T-0917

## Spec references

`PLAT-18`, `PLAT-19`, `PLAT-3`, `PLAT-6`, `FN-1`, `FN-2`, `CONCEPT-1`, `CONCEPT-2`, `CONCEPT-3`, `CONCEPT-4`

## Scope

**In scope**:
- Modify `cli/init.ts`:
  - Update generated `railfog.toml` templates with clear documentation comments demonstrating the unified four-primitives developer model (`Compute`, `State`, `Data`, `Signal`) per CONCEPT-1 through CONCEPT-4.
  - Show how `permissions.state`, `permissions.data`, and `permissions.signal` map to underlying infrastructure primitives (`kv`, `objects`, `queues`).
  - Update sample handler functions generated in `functions/` to showcase idiomatic use of `c.state`, `c.data`, and `c.signal` in addition to the classic bindings.
  - Ensure all scaffolded files strictly pass `deno check`, `deno lint`, and `rail check` out of the box.
- Update `tests/unit/cli_init_test.ts` to assert that scaffolded templates include conceptual guidance and validate cleanly.

**Out of scope**:
- Introducing new CLI init flags or interactive menu choices beyond `minimal` and `worked-example`.
- Modifying prompt or UI rendering libraries (`cli/ui.ts`, `cli/prompt.ts`).

## Interface to implement

```typescript
// Updated template strings and comments within cli/init.ts runInit
```

## Acceptance criteria (Given/When/Then)

1. Given a developer running `rail init my-app --template worked-example`, when files are generated, then `railfog.toml` and sample handler files contain clear spec-anchored comments referencing `CONCEPT-1` through `CONCEPT-4`.
2. Given a scaffolded project, when `rail check` is executed in its directory, then validation passes with 0 errors and 0 warnings.
3. Given a scaffolded handler function importing `@railfog/sdk`, when inspected, then it demonstrates `c.state`, `c.data`, or `c.signal` alongside classic primitives.

## Tests required

- [x] Unit — `tests/unit/cli_init_test.ts` verifying generated file contents, presence of conceptual documentation comments, and structure.
- [x] Integration — Scaffolding a project in a temporary directory and running `rail check` to prove out-of-the-box validity.
- [ ] Security — none.

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

The default template selection (`minimal` and `worked-example`) remains unchanged to preserve existing user workflows.
