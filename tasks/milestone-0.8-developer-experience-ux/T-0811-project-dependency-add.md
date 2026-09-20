# T-0811 — Implement Project Dependency Management in `rail add`

Status: Not started
Milestone: 0.8 Developer Experience & UX Polish
Depends on: none
Blocks: T-0812

## Spec references

`PLAT-19`

## Scope

**In scope**:
- `cli/add.ts` — CLI subcommand to add dependencies and primitives to the current project:
  - `rail add sdk`: Discovers `deno.json` in the current working directory, inserts or updates `"@railfog/sdk": "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/sdk/typescript/mod.ts"` under `imports`, and formats JSON cleanly.
  - If no `deno.json` exists, scaffolds a minimal `deno.json` with the import mapping.
  - Emits styled confirmation: `✓ Added @railfog/sdk to deno.json`.
- `cli/main.ts` — Register `rail add` subcommand and help text.
- `tests/unit/cli_add_test.ts` — Unit tests verifying `deno.json` parsing, import insertion, idempotent re-runs, and non-destructive JSON editing.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Function handler wrapper implementation (`sdk/typescript/wrapper.ts` — covered in `T-0810`).
- Running npm/yarn/pnpm commands.
- Modifying `railfog.toml`.

## Interface to implement

```typescript
export interface AddOptions {
  packageOrPrimitive: string; // e.g. "sdk"
  cwd?: string;
}

export interface AddResult {
  ok: boolean;
  targetFile: string;
  addedImport: string;
  createdNewFile: boolean;
}

export function runAdd(options: AddOptions): Promise<AddResult>;
```

## Acceptance criteria (Given/When/Then)

1. Given a project directory containing `deno.json`, when `rail add sdk` is executed, then `@railfog/sdk` is injected into `imports` without disrupting existing keys or formatting.
2. Given a directory with no `deno.json`, when `rail add sdk` is executed, then a new `deno.json` is created containing standard tasks (`dev`, `check`, `test`) and the `@railfog/sdk` import mapping.
3. Given `rail add sdk` is executed on a project where `@railfog/sdk` is already mapped, then the command completes idempotently and confirms the dependency is up to date.
4. Given an unknown argument (`rail add unknown`), then the command outputs a helpful error listing supported additions (`sdk`).

## Tests required

- [ ] Unit — `tests/unit/cli_add_test.ts`: Verify import injection, non-destructive editing of existing `deno.json`, creation of new `deno.json`, and idempotent execution.

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly (`PLAT-19`)
- [ ] Spec-anchor comments present at each RailFog-specific decision point
- [ ] Unit tests written first (red), then implementation (green)
- [ ] `deno check` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all required tests passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Reviewer pass complete; security-auditor pass complete if triggered
- [ ] Nothing outside "In scope" touched

## Assumptions made

- `deno.json` formatting uses 2 spaces and preserves existing indentation where possible.
