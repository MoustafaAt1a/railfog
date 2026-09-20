// spec: contracts/platform.contract.md#PLAT-18 — Resource hierarchy (Organization -> Project -> Function)
// spec: contracts/platform.contract.md#PLAT-12 — Error model (VALIDATION_FAILED)
// spec: contracts/functions.contract.md#FN-5 — Resource limits (CPU, memory, timeout ceilings)
// spec: tasks/milestone-0.7-repo-consolidation/T-0702-configuration-package-extraction.md

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
  queues?: Record<
    string,
    { maxDeliveryAttempts?: number; retryBackoffMs?: number }
  >;
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
