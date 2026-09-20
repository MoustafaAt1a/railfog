# T-0805 — Implement Terminal Selection Prompts

Status: Complete Milestone: 0.8 Developer Experience & UX Polish Depends on:
T-0804 Blocks: T-0806

## Spec references

`PLAT-19`

## Scope

**In scope**:

- `cli/prompt.ts` — Terminal interaction and layout utilities:
  - `selectPrompt`: Interactive terminal prompt supporting arrow-key selection
    and numbered choice fallback.
  - `formatTable`: Formatted, column-aligned ASCII/Unicode table rendering for
    status tables.
- `tests/unit/cli_prompt_test.ts` — Unit tests verifying choice selection
  parsing, arrow-key escape sequences, and table padding alignment.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):

- Terminal spinner animation (`cli/spinner.ts` — covered in `T-0804`).
- Project scaffolding logic (`cli/init.ts` — covered in `T-0806`).

## Interface to implement

```typescript
export interface Choice<T = string> {
  label: string;
  value: T;
  description?: string;
}

export interface SelectPromptOptions<T = string> {
  message: string;
  choices: Choice<T>[];
  defaultIndex?: number;
  stdinReader?: () => Promise<string>;
}

export function selectPrompt<T = string>(
  options: SelectPromptOptions<T>,
): Promise<T>;

export function formatTable(headers: string[], rows: string[][]): string;
```

## Acceptance criteria (Given/When/Then)

1. Given `selectPrompt` is called in an interactive terminal, when rendered,
   then choices are displayed with an indicator pointing to the active
   selection.
2. Given a non-interactive stdin or fallback input stream, when a choice index
   or label is received, then the corresponding choice value is resolved.
3. Given `formatTable` is called with headers and rows, then it returns a
   formatted string with consistent column widths, borders, and cell padding.

## Tests required

- [x] Unit — `tests/unit/cli_prompt_test.ts`: Verify `selectPrompt` selection
      resolution, default index handling, and `formatTable` border/column
      alignment.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-19`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Assumptions made

- Non-interactive environments fallback cleanly to index-based prompts.
- `SelectPromptOptions` supports both `outputWriter`/`stream` and
  `isInteractive`/`interactive` option fields for maximum compatibility with
  both callers and tests.
- ANSI escape codes are stripped via regular expression when computing visible
  cell width in `formatTable`.
