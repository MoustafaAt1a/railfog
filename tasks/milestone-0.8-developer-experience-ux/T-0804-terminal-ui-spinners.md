# T-0804 — Implement Terminal UI Components and Spinners

Status: Not started
Milestone: 0.8 Developer Experience & UX Polish
Depends on: none
Blocks: T-0805, T-0806

## Spec references

`PLAT-19`

## Scope

**In scope**:
- `cli/ui.ts` — Terminal user interface helpers including:
  - ANSI formatting utilities (`bold`, `dim`, `cyan`, `green`, `yellow`, `red`) respecting `NO_COLOR` environment variable and non-interactive TTY mode.
  - `Spinner` class: Animated CLI step indicator (`⠋`, `⠙`, `⠹`, etc.) with `start()`, `succeed()`, `fail()`, and `setText()` methods.
  - `selectPrompt`: Arrow-key and numbered terminal prompt for selecting from an array of choices.
  - `formatTable`: Formatted aligned ASCII/Unicode table rendering for status and inspect commands.
- `tests/unit/cli_ui_test.ts` — Unit tests verifying formatting, non-TTY fallback, spinner lifecycle, and table alignment.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Scaffolding command logic (`cli/init.ts` — covered in `T-0805`).
- Deploy command logic (`cli/deploy.ts` — covered in `T-0806`).
- Heavy external dependencies (must be implemented with standard Deno / Web APIs).

## Interface to implement

```typescript
export interface Spinner {
  start(message: string): this;
  setText(message: string): this;
  succeed(message?: string): void;
  fail(message?: string): void;
  stop(): void;
}

export function createSpinner(options?: { stream?: Deno.WriterSync }): Spinner;

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

export function selectPrompt<T = string>(options: SelectPromptOptions<T>): Promise<T>;

export function formatTable(headers: string[], rows: string[][]): string;
```

## Acceptance criteria (Given/When/Then)

1. Given a `Spinner` is created in an interactive TTY, when `start("Packaging...")` is called, then it renders an animated spinner character and message, updating on interval.
2. Given a non-interactive TTY (or CI environment / `NO_COLOR=1`), when `Spinner` runs, then it logs static messages without ANSI escape code spam.
3. Given `selectPrompt` is called with choices, when user inputs an index or navigates, then it returns the selected choice value.
4. Given `formatTable` is called with headers and data rows, then it returns a formatted, column-aligned string with clean borders and padding.

## Tests required

- [ ] Unit — `tests/unit/cli_ui_test.ts`: Verify spinner start/succeed/fail states, `NO_COLOR` handling, table padding alignment, and choice selection.

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly (`PLAT-19`)
- [ ] Spec-anchor comments present at each RailFog-specific decision point
- [ ] Unit tests written first (red), then implementation (green)
- [ ] `deno check` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all required tests passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Reviewer pass complete
- [ ] Nothing outside "In scope" touched

## Assumptions made

- Terminal cursor controls use standard ANSI sequences (`\x1b[?25l`, `\x1b[?25h`, `\x1b[2K`, `\r`).
