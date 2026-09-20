// spec: contracts/platform.contract.md#PLAT-12 — Error model (exhaustive code table & response shape)
// spec: contracts/platform.contract.md#PLAT-14 — ULID request identifier format
// spec: contracts/platform.contract.md#PLAT-9 — Rate limiting (retry_after)
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: packages/api
// spec: tasks/milestone-0.7-repo-consolidation/T-0703-shared-api-contracts-and-dtos.md

/**
 * Exhaustive machine-readable error codes per PLAT-12.
 * Do not add a new error code without an ADR.
 */
export type RailFogErrorCode =
  | "RESOURCE_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "CALL_DEPTH_EXCEEDED"
  | "TIMEOUT"
  | "PAYLOAD_TOO_LARGE"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "INTERNAL";

/**
 * Standard JSON error response envelope carrying ULID request_id per PLAT-12 and PLAT-14.
 */
export interface RailFogErrorResponse {
  error: {
    code: RailFogErrorCode;
    message: string;
    request_id: string; // ULID (PLAT-14)
    details?: unknown;
    retry_after?: number; // Present on RATE_LIMITED (PLAT-9, PLAT-12)
  };
}

/**
 * DTO for deployment manifest metadata.
 */
export interface DeploymentManifestDto {
  projectId: string;
  revision: string; // ULID (PLAT-14)
  functions: Record<string, {
    entrypoint: string;
    integrity: string;
    limits: { cpuMs: number; timeoutMs: number; memoryMb: number };
  }>;
}

/**
 * DTO for invocation requests sent across data plane boundaries.
 */
export interface InvocationRequestDto {
  requestId: string;
  projectId: string;
  functionName: string;
  payload?: unknown;
}

/**
 * DTO for invocation responses returned from function executions.
 */
export interface InvocationResponseDto {
  requestId: string;
  statusCode: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

/**
 * Constructs a standardized RailFogErrorResponse per PLAT-12 and PLAT-14.
 */
export function createErrorResponse(
  code: RailFogErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
  retryAfter?: number,
): RailFogErrorResponse {
  const errorObj: RailFogErrorResponse["error"] = {
    code,
    message,
    request_id: requestId,
  };

  if (details !== undefined) {
    errorObj.details = details;
  }

  if (retryAfter !== undefined) {
    errorObj.retry_after = retryAfter;
  }

  return { error: errorObj };
}
