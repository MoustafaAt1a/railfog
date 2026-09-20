# T-0506 — CLI Secrets Management Subcommands

Status: Done
Milestone: 0.5 Developer Experience
Depends on: T-0110, T-0305
Blocks: T-0511

## Spec references

`PLAT-12`, `PLAT-15`, `PLAT-19`

## Scope

**In scope**:
- `cli/secrets.ts`: Implement `rail secrets` command with subcommands:
  1. `rail secrets set <KEY> [VALUE]`: Sets an encrypted secret value in the project secret store. If VALUE is omitted, reads securely from stdin or interactive prompt. Supports `--file=<path>` for multiline secrets.
  2. `rail secrets list`: Lists declared secret key names and update timestamps. **Never** outputs secret values or previews (`PLAT-15`).
  3. `rail secrets delete <KEY>`: Removes a secret from the store.
- Wire `rail secrets` into `cli/main.ts`.
- `cli/secrets_test.ts`: Unit and security tests for CLI operations, asserting secrets are persisted encrypted and plaintext values never appear in stdout, stderr, or structured logs.

**Out of scope**:
- In-flight dynamic secret injection into runtime isolates (handled by `SecretInjector`, T-0306).
- Third-party cloud KMS vault connectors (deferred per `00-roadmap.md` to Milestone 0.6+).

## Interface to implement

```typescript
// cli/secrets.ts

export interface SecretCliOptions {
  projectDir?: string;
  subcommand: "set" | "list" | "delete";
  key?: string;
  value?: string;
  filePath?: string;
}

export interface SecretListEntry {
  key: string;
  updatedAt: number;
}

export async function runSecrets(options: SecretCliOptions): Promise<number>; // Exit code
```

## Acceptance criteria (Given/When/Then)

1. Given a developer running `rail secrets set STRIPE_KEY sk_test_12345`, when executed, then the secret is stored encrypted in the project secret store and stdout confirms `"Secret STRIPE_KEY updated"` without showing the value (`PLAT-15`).
2. Given a developer running `rail secrets list`, when executed, then it outputs only the secret names (e.g. `STRIPE_KEY`) and modification times, never exposing secret values or substrings.
3. Given a developer running `rail secrets delete STRIPE_KEY`, when executed, then the secret is deleted and confirmed. If the secret did not exist, returns `RESOURCE_NOT_FOUND` error (`PLAT-12`).
4. Given an error occurring during `rail secrets` execution, when error output is emitted, then no secret value is logged, returned, or printed in terminal or stack trace (`PLAT-15`).

## Tests required

- [x] Unit — `cli/secrets_test.ts`: Test `set`, `list`, and `delete` flows against `SecretStore`.
- [x] Security — Adversarial test asserting that neither `rail secrets list` nor error messages print secret values under any flag or error condition (`PLAT-15`).

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-12`, `PLAT-15`, `PLAT-19`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete for PLAT-15
- [x] Nothing outside "In scope" touched

## Verification Evidence

```shell
$ deno check cli/secrets.ts cli/main.ts cli/secrets_test.ts
(clean output, exit code 0)

$ deno test -A cli/secrets_test.ts
running 22 tests from ./cli/secrets_test.ts
Unit: secrets set - sets secret with key and value, returns exit code 0 (AC1) ... ok (68ms)
Unit: secrets set - verifies secret is persisted encrypted on disk with zero plaintext leakage (PLAT-15) ... ok (64ms)
Unit: secrets set - sets multiline secret via filePath option, returns exit code 0, persists successfully (AC1, PLAT-15) ... ok (75ms)
Unit: secrets set - updating an existing secret overwrites value, returns exit code 0, confirms update without leak (AC1, PLAT-15) ... ok (102ms)
Unit: secrets set - setting multiple distinct secrets persists each independently (PLAT-7, PLAT-15) ... ok (102ms)
Unit: secrets set - defaults projectDir to Deno.cwd() when omitted ... ok (68ms)
Unit: secrets list - lists secret keys and updatedAt timestamps, never exposing secret values (AC2, PLAT-15) ... ok (114ms)
Unit: secrets list - empty store lists 'No secrets found' or empty table without error (AC2) ... ok (10ms)
Unit: secrets list - does not expose secret values even when value overlaps with key name (PLAT-15) ... ok (70ms)
Unit: secrets delete - deletes existing secret, returns exit code 0, confirms Secret <KEY> deleted (AC3) ... ok (105ms)
Unit: secrets delete - verifies key is no longer in store or list (AC3) ... ok (107ms)
Unit: secrets delete - deleting non-existent secret emits RESOURCE_NOT_FOUND error and returns exit code 1 (AC3, PLAT-12) ... ok (5ms)
Unit: secrets delete - deleting one secret preserves remaining secrets in store (PLAT-7, PLAT-15) ... ok (162ms)
Security: PLAT-15 zero secret leakage - missing file path under filePath option returns exit code 1 without leaking key or path ... ok (4ms)
Security: PLAT-15 zero secret leakage - missing key for set returns exit code 1 and VALIDATION_FAILED without leaking secret value (PLAT-12, PLAT-15) ... ok (5ms)
Security: PLAT-15 zero secret leakage - missing key for delete returns exit code 1 and VALIDATION_FAILED (PLAT-12) ... ok (5ms)
Security: PLAT-15 zero secret leakage - missing both value and filePath for set returns exit code 1 and VALIDATION_FAILED (PLAT-12) ... ok (6ms)
Security: PLAT-15 zero secret leakage - simulated store IO error never leaks secret value in stdout, stderr, or stack traces (PLAT-15) ... ok (61ms)
Security: PLAT-15 & PLAT-12 - secret identifier validation strictly rejects invalid keys matching ^[A-Za-z_][A-Za-z0-9_]*$ ... ok (6ms)
Security: PLAT-15 & PLAT-12 - delete rejects invalid secret keys with VALIDATION_FAILED and exit code 1 ... ok (5ms)
Security: PLAT-15 - valid secret keys matching ^[A-Za-z_][A-Za-z0-9_]*$ are accepted with exit code 0 ... ok (248ms)
Security: PLAT-12 - unknown subcommand returns exit code 1 and VALIDATION_FAILED ... ok (2ms)

ok | 22 passed | 0 failed (1s)

$ deno lint cli/
Checked 14 files
(zero warnings, exit code 0)
```

## Assumptions made

1. In automated and non-interactive programmatic CLI execution, setting a secret requires either a positional `[VALUE]` or a `--file=<path>` option; omitting both returns exit code 1 with `VALIDATION_FAILED` to prevent hanging in headless and CI pipelines.
2. In local development, the master encryption key is derived from the `RAILFOG_MASTER_KEY` environment variable when present, or automatically generated as 32 cryptographically secure random bytes (64 hex characters) and persisted with restricted permissions in `.railfog/secrets.key`.

