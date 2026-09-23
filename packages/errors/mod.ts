/**
 * Core error taxonomy for RailFog.
 *
 * Implements PLAT-12 (error model — exhaustive code table) and provides typed
 * errors with fixed codes and a unified serialization function.
 *
 * Spec references:
 * - PLAT-12: Error model exhaustive code table.
 */

/**
 * The exhaustive list of RailFog error codes per PLAT-12.
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
 * Base error class for all RailFog errors.
 * Carries the required fields: code, message, and an optional requestId.
 */
export abstract class RailFogError extends Error {
  abstract readonly code: RailFogErrorCode;

  constructor(message: string, public readonly requestId?: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * Converts a RailFogError to the exact JSON response body shape defined in PLAT-12.
 */
export function toErrorResponseBody(err: RailFogError): {
  error: { code: string; message: string; request_id?: string };
} {
  const body: { code: string; message: string; request_id?: string } = {
    code: err.code,
    message: err.message,
  };

  if (err.requestId !== undefined) {
    body.request_id = err.requestId;
  }

  return { error: body };
}

/**
 * Maps a PLAT-12 error code to its canonical HTTP status.
 * Single source of truth — runtime sandboxes, the SDK, and docs all derive
 * status codes from here.
 *
 * spec: contracts/platform.contract.md#PLAT-12 — Error model status mapping
 */
export function statusFromErrorCode(code: RailFogErrorCode): number {
  switch (code) {
    case "RESOURCE_NOT_FOUND":
      return 404;
    case "PERMISSION_DENIED":
      return 403;
    case "VALIDATION_FAILED":
      return 400;
    case "RATE_LIMITED":
    case "CALL_DEPTH_EXCEEDED":
      return 429;
    case "TIMEOUT":
      return 504;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "CONFLICT":
      return 409;
    case "UNAVAILABLE":
      return 503;
    case "INTERNAL":
    default:
      return 500;
  }
}

export class ResourceNotFoundError extends RailFogError {
  readonly code = "RESOURCE_NOT_FOUND";
}

export class PermissionDeniedError extends RailFogError {
  readonly code = "PERMISSION_DENIED";
}

export class ValidationFailedError extends RailFogError {
  readonly code = "VALIDATION_FAILED";
}

export class RateLimitedError extends RailFogError {
  readonly code = "RATE_LIMITED";
}

export class CallDepthExceededError extends RailFogError {
  readonly code = "CALL_DEPTH_EXCEEDED";
}

export class TimeoutError extends RailFogError {
  readonly code = "TIMEOUT";
}

export class PayloadTooLargeError extends RailFogError {
  readonly code = "PAYLOAD_TOO_LARGE";
}

export class ConflictError extends RailFogError {
  readonly code = "CONFLICT";
}

export class UnavailableError extends RailFogError {
  readonly code = "UNAVAILABLE";
}

export class InternalError extends RailFogError {
  readonly code = "INTERNAL";
}
