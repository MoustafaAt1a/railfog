# T-0101 — Repository and toolchain scaffold

Status: Done
Milestone: 0.1 Runtime Prototype
Depends on: none
Blocks: T-0102, T-0103, T-0104, T-0105, T-0106, T-0109, T-0110

## Spec references

`PLAT-19` (repository structure)

## Scope

**In scope:**
- Create the directory skeleton exactly as `docs/contracts/platform.contract.md`
  PLAT-19 lists it (`apps/`, `packages/`, `primitives/`, `providers/`,
  `runtime/`, `sdk/typescript/`, `cli/`, `docs/`, `tests/{unit,integration,
  contract,security,e2e}/`, `infra/`), with a `.gitkeep` or README stub per
  empty directory.
- `deno.json` with `tasks`: `dev`, `test`, `check`, `lint`, `fmt` (spec's own
  example task names — reuse them, don't invent new ones).
- Root `railfog.toml` is NOT created here — that's data, not scaffold; leave
  it to whichever later task first needs one.

**Out of scope:**
- Any actual implementation code in any package.
- CI configuration (not part of 0.1's goal).

## Interface to implement

None — this task produces directories and config, no TypeScript.

## Acceptance criteria

1. Given a fresh clone, when `deno task check` is run, then it exits 0 (no
   files yet to fail type-checking).
2. Given the repo root, when listed, then it matches PLAT-19 exactly — no
   extra top-level directories, none missing.

## Tests required

- [x] None (no logic to test)

## Definition of Done

- [x] Directory tree matches PLAT-19 exactly
- [x] `deno.json` tasks match: dev, test, check, lint, fmt
- [x] `deno task check`, `deno task lint`, `deno task fmt --check` all run
      (even trivially) with real output attached

  ```
  $ deno task check
  Task check deno check **/*.ts
  Check cli/main.ts
  EXIT:0

  $ deno task lint
  Task lint deno lint
  Checked 1 file
  EXIT:0

  $ deno task fmt --check
  Task fmt deno fmt '--check'
  Checked 1 file
  EXIT:0
  ```

- [x] Nothing outside "In scope" touched

## Assumptions made

1. `deno fmt` and `deno lint` scope restricted to `**/*.ts`, `**/*.tsx`,
   `**/*.js`, `**/*.json` in `deno.json`. Without this scope, `deno fmt`
   reformats every `.md` file in `docs/`, `.agents/skills/`, and `tasks/`,
   which are not RailFog implementation files. This is an implementation
   choice, not a spec claim.
2. `cli/main.ts` is a comment-only scaffold stub added so that `deno lint`
   and `deno check` have at least one target file on a freshly-cloned repo.
   Without it, both commands exit 1 with "No target files found." The stub
   contains no logic — actual implementation is T-0110.

