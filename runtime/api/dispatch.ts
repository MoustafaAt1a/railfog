// spec: contracts/platform.contract.md#PLAT-1 — Stage 1 deployment topology
// spec: contracts/platform.contract.md#PLAT-4 — Isolation & defense in depth (ComputeProvider execution boundary)
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & tenant scoping
// spec: contracts/platform.contract.md#PLAT-7 — Multi-tenancy & data isolation
// spec: contracts/platform.contract.md#PLAT-12 — Error model (canonical error codes & response shape)
// spec: contracts/platform.contract.md#PLAT-14 — ULID request identifier format
// spec: contracts/functions.contract.md#FN-5 — Resource limits
// spec: contracts/functions.contract.md#FN-7 — Call-depth guard (default limit 8)
// spec: tasks/milestone-0.7-repo-consolidation/T-0707-runtime-api-execution-boundary.md

import type {
  Artifact,
  ComputeProvider,
  InvocationRequest,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import type { IdentityContext } from "@railfog/auth";
import { createErrorResponse, type RailFogErrorCode } from "@railfog/api";
import { generateUlid, isValidUlid } from "../../packages/core/id/ulid.ts";

/**
 * Default maximum invocation call depth before recursion cut-off.
 * spec: contracts/functions.contract.md#FN-5, FN-7
 */
export const DEFAULT_CALL_DEPTH_MAX = 8;

/**
 * Canonical HTTP Status Codes used in Runtime API boundaries.
 * spec: contracts/platform.contract.md#PLAT-12
 */
const STATUS_BAD_REQUEST = 400;
const STATUS_FORBIDDEN = 403;
const STATUS_NOT_FOUND = 404;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_INTERNAL_SERVER_ERROR = 500;
const STATUS_GATEWAY_TIMEOUT = 504;

/**
 * Resolved routing target for an incoming request.
 * spec: contracts/platform.contract.md#PLAT-11, PLAT-18
 */
export interface RouteTarget {
  projectId: string;
  functionName: string;
  revision: string;
  artifact: Artifact;
  limits: Limits;
}

/**
 * Options for configuring the RuntimeDispatcher controller.
 * spec: tasks/milestone-0.7-repo-consolidation/T-0707-runtime-api-execution-boundary.md
 */
export interface RuntimeDispatcherOptions {
  computeProvider: ComputeProvider;
  resolveRoute: (url: URL) => RouteTarget | null;
  authenticateCaller?: (req: Request) => Promise<IdentityContext | null>;
  callDepthMax?: number;
}

/**
 * Layer 2 Runtime API execution boundary dispatch controller coordinating live request handling.
 * Coordinates route resolution, ULID generation/propagation, call-depth guard enforcement,
 * authentication verification, and sandboxed compute invocation.
 *
 * spec: contracts/platform.contract.md#PLAT-1, PLAT-4, PLAT-12, PLAT-14
 * spec: contracts/functions.contract.md#FN-5, FN-7
 */
export class RuntimeDispatcher {
  private readonly computeProvider: ComputeProvider;
  private readonly resolveRoute: (url: URL) => RouteTarget | null;
  private readonly authenticateCaller?: (
    req: Request,
  ) => Promise<IdentityContext | null>;
  private readonly callDepthMax: number;

  constructor(options: RuntimeDispatcherOptions) {
    if (!options.computeProvider) {
      throw new Error("computeProvider is required");
    }
    if (typeof options.resolveRoute !== "function") {
      throw new Error("resolveRoute function is required");
    }

    this.computeProvider = options.computeProvider;
    this.resolveRoute = options.resolveRoute;
    this.authenticateCaller = options.authenticateCaller;
    this.callDepthMax = options.callDepthMax ?? DEFAULT_CALL_DEPTH_MAX;
  }

  /**
   * Dispatches an incoming HTTP request through the runtime isolation boundary.
   *
   * spec: contracts/functions.contract.md#FN-8 — Request lifecycle
   */
  public async handleRequest(request: Request): Promise<Response> {
    const requestId = this.resolveRequestId(request);
    const currentDepth = this.parseCallDepth(request);

    // Call depth limit check (FN-7, PLAT-12)
    if (currentDepth >= this.callDepthMax) {
      return this.buildErrorResponse(
        STATUS_TOO_MANY_REQUESTS,
        "CALL_DEPTH_EXCEEDED",
        `Call depth limit exceeded (maximum ${this.callDepthMax})`,
        requestId,
        currentDepth,
      );
    }

    // Caller authentication and capability inspection if configured (PLAT-6)
    let identity: IdentityContext | null = null;
    if (this.authenticateCaller) {
      try {
        identity = await this.authenticateCaller(request);
      } catch {
        return this.buildErrorResponse(
          STATUS_FORBIDDEN,
          "PERMISSION_DENIED",
          "Authentication verification failed",
          requestId,
          currentDepth,
        );
      }

      if (!identity) {
        return this.buildErrorResponse(
          STATUS_FORBIDDEN,
          "PERMISSION_DENIED",
          "Authentication failed or caller identity not permitted",
          requestId,
          currentDepth,
        );
      }
    }

    // Ingress route resolution (PLAT-11, PLAT-12)
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return this.buildErrorResponse(
        STATUS_BAD_REQUEST,
        "VALIDATION_FAILED",
        "Malformed request URL",
        requestId,
        currentDepth,
      );
    }

    const target = this.resolveRoute(url);
    if (!target) {
      return this.buildErrorResponse(
        STATUS_NOT_FOUND,
        "RESOURCE_NOT_FOUND",
        "No matching route found for the requested resource",
        requestId,
        currentDepth,
      );
    }

    // Tenant boundary enforcement (PLAT-6, PLAT-7)
    if (
      identity && identity.projectId && identity.projectId !== target.projectId
    ) {
      return this.buildErrorResponse(
        STATUS_FORBIDDEN,
        "PERMISSION_DENIED",
        "Caller identity is not authorized for target project",
        requestId,
        currentDepth,
      );
    }

    // Increment call depth for the isolate boundary hop (FN-7)
    const nextDepth = currentDepth + 1;

    // Build InvocationRequest headers propagating ULID and call depth (PLAT-14, FN-7)
    const invocationHeaders: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      invocationHeaders[key.toLowerCase()] = value;
    });
    invocationHeaders["x-request-id"] = requestId;
    invocationHeaders["request-id"] = requestId;
    invocationHeaders["x-railfog-call-depth"] = nextDepth.toString();

    let body: Uint8Array | undefined;
    if (request.body) {
      body = new Uint8Array(await request.arrayBuffer());
    }

    const invocation: InvocationRequest = {
      requestId,
      method: request.method,
      url: request.url,
      headers: invocationHeaders,
      body,
    };

    // Sandboxed compute execution (PLAT-4, PLAT-16, FN-5)
    try {
      const result = await this.computeProvider.run(
        target.artifact,
        target.limits,
        invocation,
      );

      const responseHeaders = new Headers();
      for (const [key, val] of Object.entries(result.headers)) {
        responseHeaders.set(key, val);
      }
      responseHeaders.set("x-request-id", requestId);
      responseHeaders.set("request-id", requestId);
      responseHeaders.set("x-railfog-call-depth", nextDepth.toString());

      const isNullBodyStatus = result.statusCode === 204 ||
        result.statusCode === 205 ||
        result.statusCode === 304;

      return new Response(
        isNullBodyStatus ? null : (result.body as unknown as BodyInit),
        {
          status: result.statusCode,
          headers: responseHeaders,
        },
      );
    } catch (err: unknown) {
      const isTimeout = err instanceof Error &&
        (err.name === "TimeoutError" || /timeout/i.test(err.message));

      if (isTimeout) {
        return this.buildErrorResponse(
          STATUS_GATEWAY_TIMEOUT,
          "TIMEOUT",
          "Function execution deadline exceeded",
          requestId,
          nextDepth,
        );
      }

      // Safe internal error response without leaking host stack traces (PLAT-4, PLAT-15)
      return this.buildErrorResponse(
        STATUS_INTERNAL_SERVER_ERROR,
        "INTERNAL",
        "Internal function execution error",
        requestId,
        nextDepth,
      );
    }
  }

  /**
   * Resolves or generates the canonical ULID request identifier.
   * Preserves incoming client ULID or generates a fresh 26-char Crockford Base32 ULID.
   *
   * spec: contracts/platform.contract.md#PLAT-12, PLAT-14
   */
  private resolveRequestId(req: Request): string {
    const incomingId = req.headers.get("x-request-id") ??
      req.headers.get("request-id");
    if (incomingId) {
      const trimmed = incomingId.trim();
      if (isValidUlid(trimmed)) {
        return trimmed;
      }
    }
    return generateUlid();
  }

  /**
   * Safely parses and normalizes the X-RailFog-Call-Depth header.
   * Malformed or negative values are safely clamped to 0.
   *
   * spec: contracts/functions.contract.md#FN-7
   */
  private parseCallDepth(req: Request): number {
    const raw = req.headers.get("x-railfog-call-depth");
    if (!raw) {
      return 0;
    }
    const parsed = parseInt(raw.trim(), 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      return 0;
    }
    return parsed;
  }

  /**
   * Builds a standardized JSON error response adhering to PLAT-12.
   *
   * spec: contracts/platform.contract.md#PLAT-12
   */
  private buildErrorResponse(
    status: number,
    code: RailFogErrorCode,
    message: string,
    requestId: string,
    callDepth?: number,
  ): Response {
    const errorBody = createErrorResponse(code, message, requestId);
    const headers = new Headers({
      "content-type": "application/json",
      "x-request-id": requestId,
      "request-id": requestId,
    });
    if (callDepth !== undefined) {
      headers.set("x-railfog-call-depth", callDepth.toString());
    }

    return new Response(JSON.stringify(errorBody), {
      status,
      headers,
    });
  }
}
