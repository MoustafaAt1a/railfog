# T-0901 — Lexical Analysis Engine for Static Syntax & AST Scanner

Status: Done
Milestone: 0.9 Deep System Audit & Hardening
Depends on: none
Blocks: T-0905

## Spec references

`FN-1`, `PLAT-3`, `PLAT-6`, `PLAT-12`

## Scope

**In scope**:
- `packages/core/diagnostics/deploy-analyzer.ts`: Implement a deterministic, single-pass DFA scanner (`countUnbalancedCurlyBraces`) to accurately count open/closed curly braces in TypeScript/JavaScript files while ignoring comments and strings.
- Elimination of the fragile regex `replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "")` that truncated string literals containing `//` (such as `http://`, `https://`, and `file:///`).

**Out of scope**:
- Full AST parser compilation (e.g. SWC/Babel) inside the lightweight pre-deploy analyzer.
- Modifying `railfog.toml` schema validation.

## Interface to implement

```typescript
export function countUnbalancedCurlyBraces(code: string): number;
```

## Acceptance criteria (Given/When/Then)

1. Given a function source file containing string literals with protocol prefixes like `"http://example.com"` or `"file:///path/mod.ts"`, when analyzed for syntax validation, then the strings are not truncated as comments and curly braces balance to 0.
2. Given a function source file with template literals containing expressions `${...}`, when analyzed, then curly braces inside `${...}` are tracked correctly and balance to 0.
3. Given a function with unclosed `{` or excess `}`, when analyzed, then `countUnbalancedCurlyBraces` returns a non-zero count triggering a `VALIDATION_FAILED` diagnostic issue.

## Tests required

- [x] Unit — `tests/unit/packages_core_diagnostics_deploy_analyzer_test.ts`
- [x] E2E — `tests/e2e/scratch_cli_full_app_test.ts`

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] `deno check` run, zero errors
- [x] `deno test` run, all required tests passing
- [x] `deno lint` run, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched

## Assumptions made

None.
