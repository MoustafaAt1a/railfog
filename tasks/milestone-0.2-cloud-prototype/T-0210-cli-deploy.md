# T-0210 — CLI rail deploy command

Status: Done
Milestone: 0.2 Cloud Prototype
Depends on: T-0110, T-0202, T-0207
Blocks: T-0211

## Spec references

`PLAT-3` `PLAT-6` `PLAT-14`

## Scope

**In scope:**
- `cli/deploy.ts` and integration into `cli/main.ts`.
- `rail deploy` CLI subcommand.
- Validates `railfog.toml` syntax, entrypoints, and permission declarations (throws `VALIDATION_FAILED` if invalid per `docs/contracts/platform.contract.md` PLAT-3, PLAT-6).
- Bundles function artifacts and generates manifest using `packages/core/artifact/packager.ts` (T-0202).
- Submits deployment payload to the Control Plane API deployment service (T-0207).
- Emits deployed revision ULID (`rev_{ULID}`), deployment state, and route URLs.

**Out of scope:**
- Canary deployment or traffic-splitting flags (banned per PLAT-3 and PLAT-20).
- Local dev server (`rail dev` covered in Milestone 0.1).
- Direct host credential management.

## Interface to implement

```typescript
export interface DeployCommandOptions {
  cwd?: string;
  controlPlaneUrl?: string;
  project?: string;
}

export interface DeployCommandResult {
  revisionId: string;
  state: string;
}

export async function deployCommand(
  options?: DeployCommandOptions,
): Promise<DeployCommandResult>;
```

## Acceptance criteria

1. Given an initialized RailFog project directory with valid `railfog.toml` and functions, when `rail deploy` is executed against a running Control Plane, then it packages the artifacts, submits the deployment, and outputs the resulting revision ULID (PLAT-3, PLAT-14).
2. Given a directory without `railfog.toml`, when `rail deploy` is run, then it outputs an error indicating `railfog.toml` is missing and exits with code 1.
3. Given a `railfog.toml` referencing a non-existent function entry file, when `rail deploy` is executed, then it aborts with `VALIDATION_FAILED` before submitting to the control plane (PLAT-3).
4. Given CLI invocation `rail --help` or `rail deploy --help`, then `deploy` is listed as a valid command with options described.

## Tests required

- [x] Unit — flag parsing (`--control-url`, `--project`), missing config handling, validation failure reporting
- [x] Integration — `rail deploy` executed in a temp directory against a mock Control Plane service verifying revision ID returned
- [x] Security — verify the deploy CLI transmits only explicit function source files and manifests, without reading or leaking ambient parent directory files
- [x] Adversarial — path traversal, symlink isolation, and permission schema fuzzing (`tests/adversarial_cli_test.ts`)

## Definition of Done

- [x] Implementation matches cited clause IDs (`PLAT-3`, `PLAT-6`, `PLAT-14`)
- [x] No canary or gradual rollout flags added (banned per PLAT-3/PLAT-20)
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing (58/58 tests: 29 task + 8 cli + 19 adversarial)
- [x] `deno lint` run, real output attached, zero warnings
- [x] `deno fmt --check` run, real output attached, formatted
- [x] Security auditor pass completed and approved (`PLAT-3`, `PLAT-6`, `tests/adversarial_cli_test.ts`)
- [x] Independent reviewer pass completed and approved
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched

### Verified Tool Outputs

#### `deno check`
```
$ deno check cli/deploy.ts cli/main.ts cli/deploy_test.ts cli/main_test.ts tests/adversarial_cli_test.ts
Check cli/deploy.ts
Check cli/main.ts
Check cli/deploy_test.ts
Check cli/main_test.ts
Check tests/adversarial_cli_test.ts
```

#### `deno test`
```
$ deno test --allow-read --allow-write --allow-net --allow-run tests/adversarial_cli_test.ts cli/deploy_test.ts cli/main_test.ts
running 19 tests from ./tests/adversarial_cli_test.ts
ADV-1.1: Path Traversal - entrypoint with relative traversal '../' is rejected ... ok (25ms)
ADV-1.2: Path Traversal - nested traversal 'functions/../../outside.ts' is rejected ... ok (9ms)
ADV-1.3: Path Traversal - deep subdirectory traversal 'a/b/c/../../../../outside.ts' is rejected ... ok (7ms)
ADV-1.4: Path Traversal - Windows backslash traversal 'functions\..\..\outside.ts' is rejected ... ok (7ms)
ADV-1.5: Path Traversal - mixed slashes traversal 'functions/..\../outside.ts' is rejected ... ok (8ms)
ADV-1.6: Path Traversal - absolute path outside cwd is rejected ... ok (27ms)
ADV-1.7: Path Traversal - null byte injection in entrypoint is rejected or throws ... ok (7ms)
ADV-1.8: Path Traversal - directory path '.' or 'functions' is rejected (stat.isFile failure) ... ok (18ms)
ADV-1.9: Path Traversal - Symlink pointing outside cwd is detected/rejected or investigated ... ok (14ms)
ADV-2.1: Capability Injection - multiple KV namespaces rejected with ValidationFailedError ... ok (20ms)
ADV-2.2: Capability Injection - multiple Objects buckets rejected with ValidationFailedError ... ok (17ms)
ADV-2.3: Capability Injection - multiple Queues rejected with ValidationFailedError ... ok (16ms)
ADV-2.4: Malformed permissions - string instead of array for kv: string spreading / ambiguous scope vulnerability ... ok (12ms)
ADV-2.5: Malformed permissions - number instead of array causes unhandled TypeError or should be ValidationFailedError ... ok (14ms)
ADV-2.6: Malformed permissions - non-object permissions table should be rejected with ValidationFailedError ... ok (14ms)
ADV-3.1: Ambient secret leakage - project dir files (.env, private.key, notes) NEVER included in artifact ... ok (20ms)
ADV-3.2: Ambient secret leakage - parent dir files NEVER included in artifact ... ok (21ms)
ADV-4.1: Banned flags - --canary and --weight rejected with non-zero exit code (PLAT-20) ... ok (1s)
ADV-5.1: Pipeline integrity - cutover is atomic pointer flip, no partial state (PLAT-3) ... ok (8ms)
running 29 tests from ./cli/deploy_test.ts
Unit: AC2 - deployCommand rejects when railfog.toml does not exist in cwd ... ok (8ms)
Unit: AC3 - deployCommand aborts with ValidationFailedError when entrypoint file does not exist (PLAT-3) ... ok (16ms)
Unit: AC3 - deployCommand does not invoke control plane when entry validation fails (PLAT-3) ... ok (7ms)
Unit: AC5 - deployCommand defaults to project name defined in railfog.toml ... ok (25ms)
Unit: AC5 - deployCommand options.project overrides project name from railfog.toml (PLAT-18) ... ok (13ms)
Unit: syntax validation - deployCommand rejects malformed railfog.toml with ValidationFailedError ... ok (13ms)
Unit: schema validation - deployCommand rejects railfog.toml missing functions table ... ok (11ms)
Unit: schema validation - deployCommand rejects empty entrypoint string ... ok (11ms)
Unit: PLAT-6 - deployCommand rejects ambiguous permission declarations with ValidationFailedError ... ok (14ms)
Integration: AC1 - deployCommand packages artifact and submits to DeploymentService returning valid rev_{ULID} and state (PLAT-3, PLAT-14) ... ok (19ms)
Integration: AC1 - deployCommand artifact stored in ObjectProvider matches sha256 integrity (OBJ-4, PLAT-3) ... ok (40ms)
Integration: AC1 - deployCommand with controlPlaneUrl submits to running HTTP Control Plane (PLAT-3) ... ok (343ms)
Integration: AC1 - deployCommand handles project with multiple declared functions ... ok (39ms)
Integration: AC2 - rail deploy CLI in directory without railfog.toml exits with code 1 and logs error ... ok (116ms)
Integration: AC3 - rail deploy CLI with missing function entry file exits non-zero and reports validation error (PLAT-3) ... ok (107ms)
Integration: AC4 - rail --help lists deploy as an available command ... ok (116ms)
Integration: AC4 - rail -h lists deploy as an available command ... ok (101ms)
Integration: AC4 - rail deploy --help outputs options including --control-url and --project ... ok (111ms)
Integration: AC4 - rail deploy -h outputs options including --control-url and --project ... ok (98ms)
Integration: AC5 - rail deploy CLI with --project flag passes overridden project name ... ok (458ms)
Integration: AC5 - rail deploy CLI with --control-url flag connects to specified control plane and outputs revision ... ok (447ms)
Integration: AC5 - rail deploy CLI supports --control-url=... and --project=... equal sign syntax ... ok (471ms)
Security: AC6 - PLAT-6 / Path Traversal - entrypoint escaping project directory with relative path ('../') throws ValidationFailedError ... ok (5ms)
Security: AC6 - PLAT-6 / Path Traversal - entrypoint with absolute path outside project root throws ValidationFailedError ... ok (24ms)
Security: AC6 - PLAT-6 / Path Traversal - entrypoint with nested traversal tricks ('functions/../../outside.ts') throws ValidationFailedError ... ok (7ms)
Security: AC6 - PLAT-6 / Path Traversal - control plane is never invoked when path traversal is detected ... ok (12ms)
Security: AC7 - Packaging isolation - deploy CLI packages only explicit function source files, ignoring ambient files in project directory ... ok (27ms)
Security: AC7 - Parent directory isolation - deploy CLI never reads ambient files from parent directories outside project root ... ok (22ms)
Security: AC8 - Banned patterns - CLI rejects or does not accept canary and weight flags (PLAT-3, PLAT-20) ... ok (331ms)
running 8 tests from ./cli/main_test.ts
Unit: starter railfog.toml scaffold content is valid TOML and parses into { name, functions, routes } ... ok (2ms)
Integration: AC1 - rail init creates valid railfog.toml and functions/api.ts, deno check passes ... ok (891ms)
Integration: AC2 - rail status prints loaded functions and routes from railfog.toml ... ok (102ms)
Integration: rail init followed by rail status in a temp directory ... ok (212ms)
Integration: rail dev in empty directory exits non-zero and reports missing railfog.toml ... ok (165ms)
Integration: rail dev starts local dev server and serves initialized application ... ok (331ms)
Integration: rail status in empty directory handles missing railfog.toml ... ok (102ms)
Integration: unknown subcommand beyond init/status/dev/deploy is rejected ... ok (188ms)

ok | 58 passed | 0 failed (6s)
```

#### `deno lint`
```
$ deno lint cli/deploy.ts cli/main.ts cli/deploy_test.ts cli/main_test.ts tests/adversarial_cli_test.ts
Checked 5 files
```

#### `deno fmt --check`
```
$ deno fmt --check cli/deploy.ts cli/main.ts cli/deploy_test.ts cli/main_test.ts tests/adversarial_cli_test.ts
Checked 5 files
```

## Assumptions made

- Fallback Control Plane URL defaults to `http://localhost:8000` or `RAILFOG_CONTROL_PLANE_URL` when `--control-url` is omitted.
- `options.deploymentService` is accepted as an optional property in `DeployCommandOptions` to support in-process programmatic invocation and dependency injection testing without external HTTP daemon startup.
- Multi-function deployments iterate sequentially and deploy all declared functions, with the return value of `deployCommand` reflecting the final function's revision ULID and state.
- Path traversal verification strictly compares canonicalized real paths (`Deno.realPath`) for both `cwd` and entrypoints to prevent symlink bypass of directory confinement.

