# T-0702 — Configuration Package Extraction

Status: Complete
Milestone: 0.7 Repo Consolidation
Depends on: T-0701
Blocks: T-0708, T-0709, T-0710

## Spec references

`PLAT-12`, `PLAT-18`, `PLAT-19`

## Scope

**In scope**:
- `packages/config/schema.ts`: Strongly typed TypeScript interfaces representing `railfog.toml` structure, mapping the resource hierarchy (Organization -> Project -> Function per `PLAT-18`), function limits (cpu, memory, timeout), triggers (http, queue, schedule, webhook), and permissions (kv, objects, queues, network, secrets).
- `packages/config/parser.ts`: TOML parsing utility with diagnostic issue collection and structured validation error mapping using machine-readable error code `VALIDATION_FAILED` per `PLAT-12`.
- `packages/config/mod.ts`: Barrel export for all configuration schemas, parse functions, and diagnostic validator helpers.
- Remove redundant placeholder `packages/config/.gitkeep`.

**Out of scope**:
- Changing TOML configuration keys, defaults, or schema semantics (spec-locked).
- Rewriting CLI validation logic in `cli/check.ts` (CLI migration to `@railfog/config` is downstream).

## Interface to implement

```typescript
export interface FunctionLimitsConfig {
  cpuMs?: number;
  timeoutMs?: number;
  memoryMb?: number;
  concurrency?: number;
}

export interface FunctionPermissionsConfig {
  kv?: string[];
  objects?: string[];
  queues?: string[];
  network?: string[];
  secrets?: string[];
}

export interface FunctionTriggersConfig {
  http?: string;
  queue?: string;
  schedule?: string;
  webhook?: string;
}

export interface FunctionConfig {
  entrypoint: string;
  triggers?: FunctionTriggersConfig;
  limits?: FunctionLimitsConfig;
  permissions?: FunctionPermissionsConfig;
}

export interface ProjectConfig {
  id: string;
  name?: string;
  orgId: string;
}

export interface RailFogConfig {
  project: ProjectConfig;
  functions: Record<string, FunctionConfig>;
  kv?: Record<string, { consistency?: "strong" | "eventual" }>;
  objects?: Record<string, { public?: boolean }>;
  queues?: Record<string, { maxDeliveryAttempts?: number; retryBackoffMs?: number }>;
}

export interface ConfigDiagnostic {
  severity: "error" | "warning";
  code: string; // PLAT-12 VALIDATION_FAILED
  path: string;
  message: string;
}

export interface ConfigValidationResult {
  valid: boolean;
  config?: RailFogConfig;
  diagnostics: ConfigDiagnostic[];
}

export function parseRailFogConfig(tomlContent: string): ConfigValidationResult;
export function validateRailFogConfig(raw: unknown): ConfigValidationResult;
```

## Acceptance criteria (Given/When/Then)

1. Given a valid TOML configuration string representing `railfog.toml`, when `parseRailFogConfig` is called, then it returns `valid: true`, zero error diagnostics, and a strongly-typed `RailFogConfig` object adhering to `PLAT-18`.
2. Given malformed TOML syntax, when `parseRailFogConfig` is called, then it returns `valid: false` with a diagnostic item containing machine-readable code `VALIDATION_FAILED` (`PLAT-12`) and syntax error details.
3. Given a configuration with invalid resource hierarchy (e.g. missing `project.id` or `project.orgId`), when `validateRailFogConfig` is called, then it returns `valid: false` and a `VALIDATION_FAILED` diagnostic indicating the missing property.
4. Given invalid limits (e.g. `memoryMb` exceeding 1024), when `validateRailFogConfig` is called, then it flags the violation with a `VALIDATION_FAILED` diagnostic.

## Tests required

- [x] Unit — `tests/unit/packages_config_test.ts`: Validate TOML parsing, schema validation, diagnostic generation with `VALIDATION_FAILED` (`PLAT-12`), resource hierarchy mapping (`PLAT-18`), and limit ceiling validations.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Assumptions made

None.
