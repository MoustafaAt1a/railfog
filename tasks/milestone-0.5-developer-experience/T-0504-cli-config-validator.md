# T-0504 — CLI Static Configuration Validator

Status: Done
Milestone: 0.5 Developer Experience
Depends on: T-0102, T-0107, T-0109
Blocks: T-0503, T-0505, T-0508, T-0510, T-0511

## Spec references

`PLAT-3`, `PLAT-6`, `PLAT-11`, `PLAT-12`, `PLAT-18`, `KV-5`, `FN-2`, `FN-5`

## Scope

**In scope**:
- `cli/check.ts`: Implement `rail check [path]` command performing rigorous static validation of `railfog.toml`:
  1. Schema structure and required fields (`name`, `functions`, `routes`).
  2. Entrypoint file existence and resolution against the project root.
  3. Permission declaration syntax and namespace scoping (`PLAT-6`).
  4. Consistency tier compatibility (`KV-5`): reject any namespace requesting `strong` consistency backed by an `eventual` provider.
  5. Limit ranges: assert `memory_mb <= 1024`, `cpu_ms`, `timeout_ms` within spec boundaries (`FN-5`).
  6. Trigger specifications: validate schedule cron syntax and queue binding names (`FN-2`).
  7. Route specificity and overlap analysis: sort routes by `score(route) = (literal_segments * 2) + (wildcard_segments * 1)` per `PLAT-11` and warn on shadowed routes.
- Wire `rail check` into `cli/main.ts`.
- `cli/check_test.ts`: Unit tests validating error reporting across all invalid configuration permutations.

**Out of scope**:
- Runtime execution of functions (dev server handles execution, T-0111).
- Remote deployment upload (T-0210).

## Interface to implement

```typescript
// cli/check.ts

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string; // PLAT-12 VALIDATION_FAILED, KV-5, FN-5, etc.
  path: string; // e.g., "functions.api.permissions.kv[0]"
  message: string;
}

export interface CheckResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  routeSummary?: Array<{ pattern: string; functionName: string; score: number }>;
}

export async function checkProject(configPath: string): Promise<CheckResult>;
export async function runCheck(configPath?: string): Promise<number>; // Returns exit code (0 for pass, 1 for fail)
```

## Acceptance criteria (Given/When/Then)

1. Given a valid `railfog.toml` and existing entrypoint files, when running `rail check`, then it reports zero errors, outputs the route specificity table (`PLAT-11`), and exits with code 0.
2. Given a `railfog.toml` pointing to a non-existent entrypoint file, when running `rail check`, then it returns an error with code `VALIDATION_FAILED` pointing to the missing file and exits with code 1.
3. Given a KV namespace configured with consistency `strong` on an `eventual` provider, when validated, then it generates a deploy-time validation error per `KV-5` (never downgrades silently).
4. Given a function declaring `memory_mb = 2048`, when validated, then it rejects with a validation error citing max memory limit of 1024 MB per `FN-5`.
5. Given multiple routes defined in `railfog.toml`, when checked, then it calculates specificity scores using `score = (literal * 2) + (wildcard * 1)` per `PLAT-11` and displays route evaluation order.

## Tests required

- [x] Unit — `cli/check_test.ts`: Test valid config pass, missing entrypoint detection, `KV-5` consistency mismatch rejection, `FN-5` limit boundary violations, and `PLAT-11` route scoring.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-3`, `PLAT-6`, `PLAT-11`, `PLAT-12`, `PLAT-18`, `KV-5`, `FN-2`, `FN-5`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

## Verification Evidence

```console
$ deno check cli/check.ts cli/main.ts cli/check_test.ts
(exit code: 0, 0 errors)

$ deno test -A cli/check_test.ts
running 32 tests from ./cli/check_test.ts
AC1 (PLAT-3, PLAT-11): Given a valid railfog.toml and existing entrypoint files, checkProject reports valid=true and outputs route specificity summary ... ok (45ms)
AC2 (PLAT-3): Given a railfog.toml pointing to a non-existent entrypoint file, checkProject rejects with VALIDATION_FAILED and exit code 1 ... ok (21ms)
PLAT-6: Entrypoint escaping project root directory via path traversal is rejected with VALIDATION_FAILED ... ok (6ms)
AC3 (KV-5): Given a KV namespace configured with consistency 'strong' on an 'eventual' provider, rejects with KV-5 deploy-time error ... ok (7ms)
AC3 (KV-5): Given a KV namespace configured with consistency 'strong' on Workers KV provider alias, rejects with KV-5 ... ok (7ms)
KV-5: Given consistency 'strong' on a CAS-capable provider (deno-deploy or sqlite), validation passes ... ok (6ms)
AC4 (FN-5): Function declaring memory_mb > 1024 is rejected with error citing 1024 MB ceiling ... ok (24ms)
FN-5: Function declaring memory_mb <= 0 is rejected ... ok (9ms)
FN-5: HTTP Function declaring timeout_ms > 30000 is rejected with max 30s ceiling ... ok (25ms)
FN-5: Background trigger Function declaring timeout_ms > 900000 is rejected ... ok (8ms)
FN-5: Background trigger Function accepting timeout_ms <= 900000 passes validation ... ok (6ms)
FN-5: Function declaring cpu_ms <= 0 is rejected ... ok (8ms)
AC5 (PLAT-11): Multiple routes are evaluated and sorted by specificity score = (literal * 2) + (wildcard_or_named * 1) ... ok (11ms)
PLAT-11: Duplicate or shadowed route patterns generate warnings in route analysis ... ok (8ms)
FN-2: Malformed cron schedule syntax is rejected with validation error ... ok (8ms)
FN-2: Cron schedule with fewer or more than 5 fields is rejected ... ok (8ms)
FN-2: Empty or non-string queue binding trigger name is rejected ... ok (8ms)
PLAT-5 & PLAT-6: Network permission containing SSRF-blocked IP addresses (metadata, loopback, RFC1918) is rejected ... ok (68ms)
PLAT-6 & PLAT-15: Secret names containing invalid characters or whitespace are rejected ... ok (51ms)
PLAT-6: Multiple KV namespaces or Objects buckets declared for a single function are rejected as ambiguous scope ... ok (9ms)
PLAT-18: Missing or empty 'name' attribute is rejected with VALIDATION_FAILED ... ok (13ms)
PLAT-3: Missing or empty 'functions' table is rejected with VALIDATION_FAILED ... ok (22ms)
PLAT-3: Missing 'routes' table is rejected with VALIDATION_FAILED ... ok (10ms)
PLAT-3: Route referencing non-existent function name is rejected with VALIDATION_FAILED ... ok (11ms)
PLAT-12: Invalid TOML syntax is caught and reported as VALIDATION_FAILED with exit code 1 ... ok (22ms)
PLAT-12: Non-existent directory or missing railfog.toml is reported as error with exit code 1 ... ok (3ms)
Adversarial (PLAT-5): isSsrfBlockedIp strictly blocks all metadata, loopback, RFC1918, link-local, and URL obfuscations ... ok (1ms)
Adversarial (PLAT-6): Path traversal and capability boundary escape attacks are strictly rejected ... ok (72ms)
Adversarial (PLAT-6): Ambiguous capability scope injection across KV, Objects, and Queues is strictly rejected ... ok (64ms)
Adversarial (PLAT-15): Secret name injection and smuggling tokens are strictly rejected ... ok (102ms)
Adversarial (KV-5): Consistency downgrade evasion across case variations and aliases is strictly caught ... ok (74ms)
Adversarial (FN-5): Resource limit smuggling via NaN, Infinity, floats, and non-positive numbers is strictly rejected ... ok (104ms)

ok | 32 passed | 0 failed (892ms)

$ deno lint cli/
Checked 10 files
(0 problems found)
```

## Assumptions made

None.
