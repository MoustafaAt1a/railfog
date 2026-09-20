import { assertEquals } from "@std/assert";
import {
  CallDepthExceededError,
  ConflictError,
  InternalError,
  PayloadTooLargeError,
  PermissionDeniedError,
  RailFogError,
  RateLimitedError,
  ResourceNotFoundError,
  TimeoutError,
  toErrorResponseBody,
  UnavailableError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

Deno.test("RailFogError classes extend Error and RailFogError", () => {
  const error = new ResourceNotFoundError("test");
  assertEquals(error instanceof Error, true);
  assertEquals(error instanceof RailFogError, true);
});

Deno.test("Error classes initialize and serialize correctly without requestId", () => {
  const cases = [
    { Class: ResourceNotFoundError, code: "RESOURCE_NOT_FOUND" },
    { Class: PermissionDeniedError, code: "PERMISSION_DENIED" },
    { Class: ValidationFailedError, code: "VALIDATION_FAILED" },
    { Class: RateLimitedError, code: "RATE_LIMITED" },
    { Class: CallDepthExceededError, code: "CALL_DEPTH_EXCEEDED" },
    { Class: TimeoutError, code: "TIMEOUT" },
    { Class: PayloadTooLargeError, code: "PAYLOAD_TOO_LARGE" },
    { Class: ConflictError, code: "CONFLICT" },
    { Class: UnavailableError, code: "UNAVAILABLE" },
    { Class: InternalError, code: "INTERNAL" },
  ];

  for (const { Class, code } of cases) {
    const error = new Class("test message");
    assertEquals(error.code, code);
    assertEquals(error.message, "test message");
    assertEquals(error.requestId, undefined);

    const body = toErrorResponseBody(error);
    assertEquals(body, {
      error: {
        code,
        message: "test message",
      },
    });
  }
});

Deno.test("Error classes initialize and serialize correctly with requestId", () => {
  const error = new ResourceNotFoundError("test message", "req_123");
  const body = toErrorResponseBody(error);
  assertEquals(body, {
    error: {
      code: "RESOURCE_NOT_FOUND",
      message: "test message",
      request_id: "req_123",
    },
  });
});
