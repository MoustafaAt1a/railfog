// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: sdk/typescript
// spec: contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
// spec: contracts/functions.contract.md#FN-4 — RailFogContext structure and capability bindings
// spec: contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm
// spec: contracts/platform.contract.md#PLAT-12 — Error model and canonical error responses
// spec: contracts/platform.contract.md#PLAT-15 — Capability-scoped secret access via c.env

import type { FunctionHandler, RailFogContext } from "./types.ts";
import {
  InternalError,
  RailFogError,
  type RailFogErrorCode,
  ResourceNotFoundError,
  toErrorResponseBody,
} from "../../packages/errors/mod.ts";

/**
 * Augmented context provided to ergonomic function handlers.
 * Extends RailFogContext with convenient request accessors and response builders.
 *
 * @spec contracts/functions.contract.md#FN-4 — RailFogContext structure and capability bindings
 * @spec contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
 */
export interface HandlerContext extends RailFogContext {
  req: Request;
  params?: Record<string, string | undefined>;
  body<T = unknown>(): Promise<T>;
  json(data: unknown, status?: number): Response;
  text(str: string, status?: number): Response;
}

/**
 * Allowable return types from ergonomic handler functions.
 * Returned values other than Response are automatically serialized to JSON.
 *
 * @spec contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
 */
export type HandlerResult =
  | Response
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null
  | void;

/**
 * Handler function signature accepted by handle() and api() wrappers.
 *
 * @spec contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
 */
export type HandlerFn = (
  c: HandlerContext,
) => Promise<HandlerResult> | HandlerResult;

/**
 * Route map associating method and path patterns (e.g. "GET /items") with handler functions.
 *
 * @spec contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm
 */
export interface ApiRouteMap {
  [routePattern: string]: HandlerFn;
}

/**
 * Maps PLAT-12 canonical error codes to their standardized HTTP status codes.
 *
 * @spec contracts/platform.contract.md#PLAT-12 — Error model exhaustive code table
 */
function statusFromErrorCode(code: RailFogErrorCode): number {
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

/**
 * Normalizes any caught error into a canonical PLAT-12 JSON HTTP Response.
 *
 * @spec contracts/platform.contract.md#PLAT-12 — Error model and canonical error responses
 */
function normalizeToErrorResponse(
  err: unknown,
  defaultRequestId: string,
): Response {
  let railFogError: RailFogError;
  let requestId: string;

  if (err instanceof RailFogError) {
    requestId = err.requestId ?? defaultRequestId;
    railFogError = err;
  } else {
    requestId = defaultRequestId;
    const message = err instanceof Error ? err.message : String(err);
    railFogError = new InternalError(message, requestId);
  }

  const status = statusFromErrorCode(railFogError.code);
  const body = toErrorResponseBody(railFogError);
  if (!body.error.request_id && requestId) {
    body.error.request_id = requestId;
  }

  return Response.json(body, {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      "request-id": requestId,
    },
  });
}

/**
 * Wraps an ergonomic handler function into a standard RailFog FunctionHandler.
 * Automatically handles JSON response serialization, explicit Response passthrough,
 * body parsing caching, and PLAT-12 error normalization.
 *
 * @spec contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
 * @spec contracts/functions.contract.md#FN-4 — RailFogContext structure and capability bindings
 * @spec contracts/platform.contract.md#PLAT-12 — Error model and canonical error responses
 */
export function handle(fn: HandlerFn): FunctionHandler {
  return async (req: Request, ctx: RailFogContext): Promise<Response> => {
    let parsedBody: unknown;
    let bodyParsed = false;

    // spec: contracts/functions.contract.md#FN-4 — Capability and context injection
    const c: HandlerContext = {
      ...ctx,
      timeRemaining: () => ctx.timeRemaining(),
      req,
      async body<T = unknown>(): Promise<T> {
        if (!bodyParsed) {
          parsedBody = await req.json();
          bodyParsed = true;
        }
        return parsedBody as T;
      },
      json(data: unknown, status = 200): Response {
        return Response.json(data, {
          status,
          headers: { "content-type": "application/json" },
        });
      },
      text(str: string, status = 200): Response {
        return new Response(str, {
          status,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    };

    try {
      const result = await fn(c);

      // spec: contracts/functions.contract.md#FN-1 — Verbatim Web API Response passthrough
      if (result instanceof Response) {
        return result;
      }

      // Empty/void returns yield 204 No Content
      if (result === undefined) {
        return new Response(null, { status: 204 });
      }

      // spec: contracts/functions.contract.md#FN-1 — Auto-serialize plain returned values to JSON
      return Response.json(result, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      // spec: contracts/platform.contract.md#PLAT-12 — Canonical error normalization
      return normalizeToErrorResponse(err, ctx.requestId);
    }
  };
}

const LITERAL_SEGMENT_WEIGHT = 2;
const WILDCARD_OR_NAMED_SEGMENT_WEIGHT = 1;

function isWildcardOrNamedSegment(segment: string): boolean {
  return (
    segment.includes("*") ||
    segment.includes(":") ||
    segment.includes("(") ||
    segment.includes("{")
  );
}

// spec: contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm
function specificityScore(pattern: string): number {
  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  let score = 0;
  for (const segment of segments) {
    if (isWildcardOrNamedSegment(segment)) {
      score += WILDCARD_OR_NAMED_SEGMENT_WEIGHT;
    } else {
      score += LITERAL_SEGMENT_WEIGHT;
    }
  }
  return score;
}

interface CompiledRoute {
  method: string;
  pattern: string;
  urlPattern: URLPattern;
  score: number;
  handler: HandlerFn;
}

function parseRouteKey(routeKey: string): { method: string; pattern: string } {
  const trimmed = routeKey.trim();
  const match = trimmed.match(/^([A-Za-z*]+)\s+(.+)$/);
  let method: string;
  let rawPattern: string;

  if (match) {
    method = match[1].toUpperCase();
    rawPattern = match[2].trim();
  } else if (trimmed.startsWith("/")) {
    method = "*";
    rawPattern = trimmed;
  } else {
    method = trimmed.toUpperCase();
    rawPattern = "/*";
  }

  const pattern = rawPattern.startsWith("/") ? rawPattern : `/${rawPattern}`;
  return { method, pattern };
}

/**
 * Creates a micro-router function handler that matches requests by HTTP method and URLPattern.
 * Overlapping routes resolve deterministically by PLAT-11 specificity score.
 * Unmatched routes return canonical 404 RESOURCE_NOT_FOUND error responses.
 *
 * @spec contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm
 * @spec contracts/platform.contract.md#PLAT-12 — Canonical error responses (404 RESOURCE_NOT_FOUND)
 * @spec contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
 */
export function api(routes: ApiRouteMap): FunctionHandler {
  // Precompile route patterns and calculate PLAT-11 specificity scores
  const compiledRoutes: CompiledRoute[] = Object.entries(routes).map(
    ([routeKey, handler]) => {
      const { method, pattern } = parseRouteKey(routeKey);
      const urlPattern = new URLPattern({ pathname: pattern });
      const score = specificityScore(pattern);

      return {
        method,
        pattern,
        urlPattern,
        score,
        handler,
      };
    },
  );

  return handle(async (c: HandlerContext): Promise<HandlerResult> => {
    const url = new URL(c.req.url, "http://railfog.internal");
    const pathname = url.pathname;
    const reqMethod = c.req.method.toUpperCase();

    let winningRoute: CompiledRoute | null = null;
    let highestScore = -1;

    // spec: contracts/platform.contract.md#PLAT-11 — Highest score wins; ties break by declaration order
    for (const route of compiledRoutes) {
      if (route.method !== "*" && route.method !== reqMethod) {
        continue;
      }
      if (route.urlPattern.test({ pathname })) {
        if (route.score > highestScore) {
          highestScore = route.score;
          winningRoute = route;
        }
      }
    }

    if (!winningRoute) {
      // spec: contracts/platform.contract.md#PLAT-12 — RESOURCE_NOT_FOUND on unmatched route
      throw new ResourceNotFoundError(
        `No route matched ${c.req.method} ${pathname}`,
        c.requestId,
      );
    }

    const match = winningRoute.urlPattern.exec({ pathname });
    const params: Record<string, string | undefined> =
      match?.pathname?.groups ?? {};
    const routeContext: HandlerContext = {
      ...c,
      params,
    };

    return await winningRoute.handler(routeContext);
  });
}
