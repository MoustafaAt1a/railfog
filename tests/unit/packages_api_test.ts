// spec: contracts/platform.contract.md#PLAT-1 — Stage 1 deployment topology (control plane & data plane routes)
// spec: contracts/platform.contract.md#PLAT-12 — Error model (exhaustive code table & response shape)
// spec: contracts/platform.contract.md#PLAT-14 — ULID request identifier format
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: packages/api
// spec: tasks/milestone-0.7-repo-consolidation/T-0703-shared-api-contracts-and-dtos.md

import { assert, assertEquals } from "@std/assert";
import {
  API_ROUTES,
  createErrorResponse,
  type DeploymentManifestDto,
  type InvocationRequestDto,
  type InvocationResponseDto,
  type RailFogErrorCode,
  type RailFogErrorResponse,
} from "@railfog/api";

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const EXPECTED_ERROR_CODES: RailFogErrorCode[] = [
  "RESOURCE_NOT_FOUND",
  "PERMISSION_DENIED",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "CALL_DEPTH_EXCEEDED",
  "TIMEOUT",
  "PAYLOAD_TOO_LARGE",
  "CONFLICT",
  "UNAVAILABLE",
  "INTERNAL",
];

Deno.test("T-0703: API_ROUTES exposes immutable standard endpoint paths (PLAT-1)", () => {
  assertEquals(API_ROUTES.HEALTH, "/healthz");
  assertEquals(API_ROUTES.PROJECTS, "/v1/projects");
  assertEquals(API_ROUTES.FUNCTIONS, "/v1/functions");
  assertEquals(API_ROUTES.DEPLOYMENTS, "/v1/deployments");
  assertEquals(API_ROUTES.INVOCATIONS, "/v1/invocations");
});

Deno.test("T-0703: RailFogErrorCode matches exhaustive PLAT-12 specification", () => {
  assertEquals(EXPECTED_ERROR_CODES.length, 10);
  const codeSet = new Set(EXPECTED_ERROR_CODES);
  assertEquals(codeSet.size, 10);

  // Assert every code is present and valid
  for (const code of EXPECTED_ERROR_CODES) {
    const response = createErrorResponse(
      code,
      "Test error message",
      "01J8Z9W6T8NGR6S00000000000",
    );
    assertEquals(response.error.code, code);
  }
});

Deno.test("T-0703: createErrorResponse formats standard error response with ULID request_id (PLAT-12, PLAT-14)", () => {
  const ulid = "01J8Z9W6T8NGR6S00000000000";
  assert(
    ULID_REGEX.test(ulid),
    "Test ULID fixture must be valid Crockford Base32 26-char string",
  );

  const response: RailFogErrorResponse = createErrorResponse(
    "RESOURCE_NOT_FOUND",
    "Function handler not found",
    ulid,
    { function: "missing-handler" },
  );

  assertEquals(response.error.code, "RESOURCE_NOT_FOUND");
  assertEquals(response.error.message, "Function handler not found");
  assertEquals(response.error.request_id, ulid);
  assert(ULID_REGEX.test(response.error.request_id));
  assertEquals(response.error.details, { function: "missing-handler" });
  assertEquals(response.error.retry_after, undefined);
});

Deno.test("T-0703: createErrorResponse includes retry_after on RATE_LIMITED (PLAT-9, PLAT-12)", () => {
  const ulid = "01J8Z9W6T8NGR6S00000000000";
  const response = createErrorResponse(
    "RATE_LIMITED",
    "Rate limit exceeded",
    ulid,
    undefined,
    5,
  );

  assertEquals(response.error.code, "RATE_LIMITED");
  assertEquals(response.error.retry_after, 5);
  assertEquals(response.error.request_id, ulid);
});

Deno.test("T-0703: DTO structures conform to interface types", () => {
  const manifest: DeploymentManifestDto = {
    projectId: "proj_01J8Z",
    revision: "01J8Z9W6T8NGR6S00000000000",
    functions: {
      api: {
        entrypoint: "functions/api.ts",
        integrity: "sha256-abcdef",
        limits: { cpuMs: 200, timeoutMs: 30000, memoryMb: 128 },
      },
    },
  };
  assertEquals(manifest.projectId, "proj_01J8Z");
  assert(ULID_REGEX.test(manifest.revision));

  const invocationReq: InvocationRequestDto = {
    requestId: "01J8Z9W6T8NGR6S00000000000",
    projectId: "proj_01J8Z",
    functionName: "api",
    payload: { action: "ping" },
  };
  assertEquals(invocationReq.functionName, "api");

  const invocationRes: InvocationResponseDto = {
    requestId: "01J8Z9W6T8NGR6S00000000000",
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true }),
  };
  assertEquals(invocationRes.statusCode, 200);
});
