# T-0812 — Run Milestone 0.8 E2E Verification Suite

Status: Not started
Milestone: 0.8 Developer Experience & UX Polish
Depends on: T-0801, T-0802, T-0803, T-0804, T-0805, T-0806, T-0807, T-0808, T-0809, T-0810, T-0811
Blocks: none

## Spec references

`PLAT-1`, `PLAT-3`, `PLAT-15`, `PLAT-17`, `PLAT-19`, `FN-1`

## Scope

**In scope**:
- `tests/e2e/ux_dx_milestone_08_test.ts` — Comprehensive end-to-end UX/DX test covering:
  1. Full zero-copy callback login flow: Spawns control server with `/login`, triggers `rail login`, simulates browser authorization redirect to loopback listener, verifies credentials stored in `~/.railfog/config.json`.
  2. Fallback mode: Tests `--manual` flag and timeout handling falling back to stdin prompt.
  3. Interactive scaffolding: Validates `rail init` interactive selection and file creation.
  4. Rich deploy progress: Validates animated spinners and step feedback during `rail deploy`.
  5. Minimalist SDK: Validates function execution using `handle()` and `api()` micro-router helpers.
  6. CLI dependency addition: Validates `rail add sdk` injection into `deno.json`.
  7. Installer scripts: Verifies syntax integrity of `scripts/install.sh` and `scripts/install.ps1`.
- Complete verification of Milestone 0.8 via `deno check`, `deno test`, and `deno lint`.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Web dashboard implementation (explicitly excluded per user request).
- Modifying core platform contracts.

## Interface to implement

None — this is the verification and audit task for Milestone 0.8.

## Acceptance criteria (Given/When/Then)

1. Given the integrated RailFog CLI and control plane, when running `rail login` in callback mode, then the complete authentication completes in < 2 seconds without manual copy-pasting, preserving zero secret leakage (`PLAT-15`).
2. Given an interactive `rail init` session, then all prompts guide the user cleanly and scaffold a fully valid project.
3. Given an interactive `rail deploy`, then all step spinners execute cleanly and render a professional completion card with live URL.
4. Given a function using `handle(({ kv }) => kv.get(["items"]))` or `api({ "GET /": ... })`, then it executes and returns properly serialized JSON responses.
5. Given `rail add sdk` in an empty or existing project, then `@railfog/sdk` is mapped cleanly.
6. Given `scripts/install.sh` and `scripts/install.ps1`, then both scripts pass static syntax checks and error-handling audits.
7. Given `deno check`, `deno test`, and `deno lint` run across the workspace, then all checks exit with code 0 and zero warnings.

## Tests required

- [ ] E2E — `tests/e2e/ux_dx_milestone_08_test.ts`: End-to-end verification of callback login, interactive CLI, deployment feedback, minimal SDK, and `rail add sdk`.
- [ ] Security — Verify zero secret leakage across the end-to-end callback authentication lifecycle (`PLAT-15`).
- [ ] Unit — All unit tests in `tests/unit/` pass.

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly
- [ ] Spec-anchor comments present across all new modules
- [ ] `deno check **/*.ts` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all test suites passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Reviewer pass complete; security-auditor pass complete if triggered
- [ ] Nothing outside "In scope" touched
- [ ] All milestone tasks marked Done with verified DoD checklists

## Assumptions made

- Local loopback port binding (`127.0.0.1`) is permitted in the test environment.
