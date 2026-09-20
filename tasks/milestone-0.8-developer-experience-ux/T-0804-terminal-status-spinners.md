# T-0804 — Implement Terminal Status Spinners

Status: Complete Milestone: 0.8 Developer Experience & UX Polish Depends on:
none Blocks: T-0805, T-0807

## Spec references

`PLAT-19`

## Scope

**In scope**:

- `cli/spinner.ts` — Terminal spinner and styling implementation:
  - ANSI formatting primitives (`bold`, `dim`, `cyan`, `green`, `yellow`, `red`)
    with automatic detection of `NO_COLOR` and non-interactive environments.
  - `Spinner` class: Animated CLI step indicator (`⠋`, `⠙`, `⠹`, etc.) with
    `start()`, `setText()`, `succeed()`, `fail()`, and `stop()` methods.
  - Graceful static fallback when stdout is not an interactive terminal.
- `tests/unit/cli_spinner_test.ts` — Unit tests verifying spinner
  start/succeed/fail states, interval management, and `NO_COLOR` suppression.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):

- Interactive selection prompts (`cli/prompt.ts` — covered in `T-0805`).
- Deploy command wiring (`cli/deploy.ts` — covered in `T-0807`).

## Interface to implement

```typescript
export interface SpinnerOptions {
  stream?: Deno.WriterSync;
  intervalMs?: number;
}

export interface Spinner {
  start(message: string): this;
  setText(message: string): this;
  succeed(message?: string): void;
  fail(message?: string): void;
  stop(): void;
}

export function createSpinner(options?: SpinnerOptions): Spinner;
```

## Acceptance criteria (Given/When/Then)

1. Given an interactive TTY, when `spinner.start("Packaging functions...")` is
   called, then it displays an animated spinner character and message, updating
   on interval.
2. Given `spinner.succeed("Packaged successfully")` is called, then the spinner
   halts and prints a persistent green checkmark with the success message.
3. Given `spinner.fail("Build failed")` is called, then the spinner halts and
   prints a persistent red cross with the error message.
4. Given a non-interactive TTY (or `NO_COLOR=1` or `CI=true`), when `Spinner`
   methods run, then it prints static non-animated lines without ANSI escape
   characters.

## Tests required

- [x] Unit — `tests/unit/cli_spinner_test.ts`: Verify spinner lifecycle
      transitions, stream writing, timer clearing, and non-TTY fallback.

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

- Standard ANSI terminal escape sequences (`\x1b[?25l`, `\x1b[?25h`, `\r`,
  `\x1b[2K`) are supported by modern terminal emulators.
