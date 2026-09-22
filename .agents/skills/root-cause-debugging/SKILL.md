---
name: root-cause-debugging
description: Use when diagnosing, isolating, and fixing test failures, runtime exceptions, memory leaks, unhandled promise rejections, lock contention, or behavioral discrepancies in RailFog. Enforces scientific hypothesis-driven root cause analysis, stack-trace dissection, deterministic reproduction, and zero-regression surgical fixes.
---

# Root Cause Debugging

Engineering methodology for isolating, diagnosing, and repairing defects in
RailFog with scientific precision. Prioritizes deterministic minimal reproductions,
deep stack-trace dissection, and surgical anti-slop fixes that preserve contract
invariants without side effects.

## The 6-Step Debugging Protocol

### 1. Stack-Trace & Log Dissection
- Read the entire failure trace: identify the exact file, line, and column where
  the error was thrown.
- Separate caller error from callee defect: check if the input was invalid, or
  if the component failed under valid inputs.
- Inspect the error code and error message against `docs/contracts/platform.contract.md#PLAT-12`.

### 2. Contract Alignment Check
- Find the relevant contract clause in `docs/contracts/*.md`.
- Determine whether the observed behavior contradicts an explicit clause guarantee,
  an audit finding fix (`.agents/docs/00-deep-analysis.md`), or an architectural boundary rule
  (`docs/CONSTITUTION.md`).
- Never "fix" an issue by weakening contract requirements or deleting tests.

### 3. Deterministic Minimal Reproduction
- Create the smallest possible reproduction script or isolated unit test that
  reliably triggers the defect.
- Eliminate external variables: mock networks or use in-memory SQLite (`:memory:`)
  unless the bug is specific to an external provider.
- If the bug is timing-sensitive or a race condition, stress test with concurrent
  promises (`Promise.all()`) or explicit microtask scheduling rather than random
  sleeps.

### 4. Hypothesis & Root Cause Isolation
- Formulate a falsifiable hypothesis for why the defect occurs (e.g., "prefix path
  encoding returns `/` when empty, causing `LIKE /%` to reject root-level keys").
- Validate the hypothesis with targeted diagnostics or breakpoints before editing
  production code.
- Check whether identical failure modes exist in peer providers or adjacent modules
  (e.g., SQLite vs Postgres vs Redis vs Cloudflare providers).

### 5. Surgical Anti-Slop Fix
- Modify only the exact root cause: minimal, clean, readable code.
- Follow `.agents/docs/ANTI-SLOP.md`: no magic numbers, no dead code, no speculative generalizations,
  no unnecessary dependencies.
- Retain OOP/SOLID boundaries and DOD hot-path rules (`docs/CONSTITUTION.md`).
- Ensure no secret leakage or security boundary weakening (`PLAT-15`, `PLAT-4`).

### 6. Verification & Regression Gate
- Run the minimal reproduction test to verify it passes (green).
- Run the entire subsystem test suite (e.g., `deno test tests/unit/`).
- Run `deno check` and `deno lint` to ensure zero type errors and zero lint violations.
- Verify that no other tests broke across the repository.

## Non-goals

- Performing broad multi-component refactors during a bugfix.
- Silencing errors via `try {} catch {}` without handling or logging them.
- Changing contract definitions without human/architect approval.
