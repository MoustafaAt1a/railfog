# T-0805 — Implement Interactive Project Scaffolding in `rail init`

Status: Not started
Milestone: 0.8 Developer Experience & UX Polish
Depends on: T-0804
Blocks: T-0809

## Spec references

`PLAT-18`, `PLAT-19`

## Scope

**In scope**:
- `cli/init.ts` — Enhance `runInit()` and the CLI handler to support an interactive questionnaire when run without positional arguments in an interactive terminal:
  - Prompts for project directory and name.
  - Prompts for starter template selection (`minimal` or `worked-example`) using `selectPrompt` (`T-0804`).
  - Renders a clean formatted completion card displaying created files, configured commands, and next steps (`rail dev`, `rail deploy`).
- `tests/unit/cli_init_test.ts` — Add test coverage for interactive scaffolding options and completion output.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Low-level ANSI / prompt helpers (`cli/ui.ts` — covered in `T-0804`).
- Modifying project template schemas or contracts under `docs/contracts/`.

## Interface to implement

```typescript
export interface InteractiveInitOptions extends InitOptions {
  interactive?: boolean;
  promptReader?: (message: string, defaultValue?: string) => Promise<string>;
  templateSelector?: (choices: Choice<"minimal" | "worked-example">[]) => Promise<"minimal" | "worked-example">;
}

export function runInteractiveInit(options?: InteractiveInitOptions): Promise<InitResult>;
```

## Acceptance criteria (Given/When/Then)

1. Given a user runs `rail init` without flags in an interactive terminal, when executed, then it interactively prompts for the project name/path and template choice before scaffolding.
2. Given a user selects the `minimal` or `worked-example` template, then the matching template files are scaffolded per `PLAT-19` and `docs/contracts/worked-example.md`.
3. Given existing arguments are passed (`rail init my-app --template worked-example`), then `rail init` runs non-interactively in headless mode with 100% backward compatibility.
4. Given successful scaffolding, then the CLI outputs a styled summary box with created files, `deno.json` scripts, and instructions to run `rail dev`.

## Tests required

- [ ] Unit — `tests/unit/cli_init_test.ts`: Verify interactive prompt flow, default value handling, and backward-compatible flag execution.

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly (`PLAT-18`, `PLAT-19`)
- [ ] Spec-anchor comments present at each RailFog-specific decision point
- [ ] Unit tests written first (red), then implementation (green)
- [ ] `deno check` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all required tests passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Reviewer pass complete
- [ ] Nothing outside "In scope" touched

## Assumptions made

- If `Deno.stdin.isTerminal()` is false, `rail init` defaults to non-interactive mode without hanging.
