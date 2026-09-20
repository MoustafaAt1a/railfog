# T-0807 — Implement Rich Progress Feedback for `rail deploy`

Status: Not started
Milestone: 0.8 Developer Experience & UX Polish
Depends on: T-0804
Blocks: T-0810

## Spec references

`PLAT-3`, `PLAT-15`, `PLAT-19`

## Scope

**In scope**:
- `cli/deploy.ts` — Enhance `runDeploy()` to display animated step spinners and a formatted completion card during deployment:
  - Step 1: Packaging function sources and calculating SHA-256 hashes (`OBJ-4`).
  - Step 2: Static validation of routes and capability permissions (`PLAT-3`, `PLAT-6`).
  - Step 3: Uploading snapshot bundle to Control Plane (`PLAT-1`, `PLAT-8`).
  - Step 4: Verifying deployment activation and health check.
  - Final card: Revision ID, elapsed time, live URL, and deployed route table.
  - Suppression of bound secret values in error traces (`PLAT-15`).
- `tests/unit/cli_deploy_progress_test.ts` — Unit tests asserting progress callbacks, step transitions, and non-TTY / CI silent fallback.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- UI spinner implementation (`cli/spinner.ts` — covered in `T-0804`).
- Modifying deployment snapshot protocols (`packages/protocol/` — stable).
- Backend deployment handling on control server.

## Interface to implement

```typescript
export interface DeployProgressCallbacks {
  onStepStart?: (step: string) => void;
  onStepSuccess?: (step: string, detail?: string) => void;
  onStepFail?: (step: string, error: string) => void;
}

export interface DeployOptions {
  controlUrl?: string;
  projectPath?: string;
  token?: string;
  json?: boolean; // Machine-readable JSON output mode
  progress?: DeployProgressCallbacks;
}

export interface DeploySummary {
  ok: boolean;
  revision: string;
  project: string;
  elapsedMs: number;
  runtimeUrl: string;
  functions: { name: string; route?: string }[];
}
```

## Acceptance criteria (Given/When/Then)

1. Given a user runs `rail deploy` in an interactive terminal, when executing each stage (packaging, checking, uploading, verifying), then an animated spinner displays live progress and marks completed steps with green checkmarks.
2. Given a deployment succeeds, then the CLI outputs a styled deployment card listing the Revision ID, deployment duration, public runtime URL, and route mappings.
3. Given `--json` or a non-interactive CI environment (`CI=true`), then animated terminal controls are omitted and only standard structured output is emitted.
4. Given any step fails (e.g. route validation error), then the spinner halts with a red indicator, shows the error cause without leaking secrets (`PLAT-15`), and exits with code 1.

## Tests required

- [ ] Unit — `tests/unit/cli_deploy_progress_test.ts`: Verify progress event dispatch, `--json` suppression of ANSI spinners, and failure state reporting.
- [ ] Security — Verify deploy progress error handlers suppress bound secret values and tokens (`PLAT-15`).

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly (`PLAT-3`, `PLAT-15`, `PLAT-19`)
- [ ] Spec-anchor comments present at each RailFog-specific decision point
- [ ] Unit tests written first (red), then implementation (green)
- [ ] `deno check` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all required tests passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Reviewer pass complete; security-auditor pass complete if triggered
- [ ] Nothing outside "In scope" touched

## Assumptions made

- Terminal spinners are bypassed when `json: true` is passed to allow scripting in CI pipelines.
