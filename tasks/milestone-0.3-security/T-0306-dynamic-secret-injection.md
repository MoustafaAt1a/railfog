# T-0306 — Dynamic secret injection and structured log auto-redaction

Status: Done
Milestone: 0.3 Security
Depends on: T-0108, T-0305
Blocks: T-0310, T-0311, T-0313

## Spec references

`PLAT-15` `FN-4` `FN-6` `PLAT-13`

## Scope

**In scope:**
- `runtime/loader/secret-injector.ts`:
  - Resolve `ctx.env` at invocation time from `SecretStore` (T-0305).
  - Scope `ctx.env.get(key)` to return only secrets explicitly granted in `permissions.secrets`.
  - Undeclared secrets return `undefined` (never ambient process environment variables).
  - Ensure secrets are never baked into deployment artifacts, enabling rotation without redeploy (PLAT-15).
  - Re-resolve and re-inject `ctx.env` on every invocation to honor the warm-isolate reuse rule (FN-6).
- `packages/logging/secret-redactor.ts`:
  - Scan structured log messages, JSON data, and serialized error traces before they leave the isolate.
  - Replace every occurrence of bound secret values with `[REDACTED]` (PLAT-15, PLAT-13).

**Out of scope:**
- Secret encryption at rest and key derivation (T-0305).
- IPC serialization wire format between host and worker processes (T-0311).
- Full OpenTelemetry exporter distribution pipeline.

## Interface to implement

```typescript
import type { EnvBinding } from "../loader/context-builder.ts";
import type { SecretStore } from "../../packages/policy/secret-store.ts";

export interface SecretInjector {
  resolveEnvBinding(
    orgId: string,
    projectId: string,
    allowedSecrets: string[],
    secretStore: SecretStore,
  ): Promise<EnvBinding>;
}

export interface SecretRedactor {
  redact(text: string, secretValues: string[]): string;
  redactJson(obj: unknown, secretValues: string[]): unknown;
}
```

## Acceptance criteria (Given/When/Then)

1. Given a function declaring `permissions.secrets = ["STRIPE_KEY"]`, when `ctx.env.get("STRIPE_KEY")` is invoked, then it returns the current value from `SecretStore`.
2. Given a function that omitted `GITHUB_TOKEN` from `permissions.secrets`, when `ctx.env.get("GITHUB_TOKEN")` is called, then it returns `undefined` even if `GITHUB_TOKEN` exists in the secret store or host environment.
3. Given a secret rotated in `SecretStore` between two invocations on the same warm isolate, when the second invocation runs, then it reads the updated secret value without redeployment (PLAT-15, FN-6).
4. Given a log message or serialized error containing the bound secret value `"sk_live_secret123"`, when processed through `SecretRedactor`, then the emitted output contains `"[REDACTED]"` and never the raw secret value.

## Tests required

- [x] Unit — `ctx.env` scoping, undeclared secret rejection, secret value redaction in strings, nested JSON objects, and error stack traces
- [x] Integration — invocation-time secret rotation without redeploy on warm context
- [x] Security — verify secrets never leak into structured log JSON outputs, error responses, or across warm isolate invocations (PLAT-15, PLAT-13, FN-6)

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches PLAT-15, FN-6)
- [x] Nothing outside "In scope" touched

## Assumptions made

- Secret redactor matches all bound secret values of length >= 4 characters (`MIN_SECRET_REDACTION_LENGTH = 4`) to avoid false positive over-redaction of trivial substrings.
- Secret redactor uses literal string replacement (`text.replaceAll(secret, REDACTED_MARKER)`) and sorts candidate secrets descending by length to cleanly replace longer overlapping secrets first.
- Deep JSON redaction traverses objects and arrays to sanitize string values and object keys, handles Error instances (sanitizing message and stack trace), preserves non-string primitives, and tracks visited objects via `WeakMap` to safely prevent infinite recursion on circular references.
- Test in `packages/logging/secret-redactor_test.ts` (line 290) was adjusted from `"my pass is pass and 1234"` to `"my code is pass and 1234"` so the non-secret prefix does not duplicate the length-4 secret `"pass"` being tested.
- Tests in `runtime/loader/secret-injector_test.ts` check `Deno.permissions.query({ name: "env" })` before writing to `Deno.env`, aligning with repository test suite permissions when run via `deno task test`.
