/**
 * Ingress Reverse Proxy Gateway Server.
 *
 * Edge HTTP reverse proxy terminating incoming connections, enforcing multi-tenant
 * token bucket rate limiting (PLAT-9), injecting monotonic ULID request IDs (PLAT-14),
 * and forwarding requests to control plane or data plane endpoints (PLAT-1, PLAT-8).
 *
 * Spec references:
 * - contracts/platform.contract.md#PLAT-1: Control plane vs data plane routing.
 * - contracts/platform.contract.md#PLAT-8: Fail-static data plane (zero control-plane roundtrips on request path).
 * - contracts/platform.contract.md#PLAT-9: Multi-tenant token bucket rate limiting (429 RATE_LIMITED, Retry-After).
 * - contracts/platform.contract.md#PLAT-11: Routing specificity algorithm.
 * - contracts/platform.contract.md#PLAT-12: Canonical error model (RATE_LIMITED, UNAVAILABLE).
 * - contracts/platform.contract.md#PLAT-14: ULID request_id generation and propagation.
 * - contracts/platform.contract.md#PLAT-19: apps/gateway repository structure.
 * - tasks/milestone-0.6-public-beta/T-0604-ingress-gateway-server.md
 */

import type {
  MultiTenantRateLimiter,
  RateLimitDecision,
} from "./rate-limiter.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";

/**
 * Default network binding parameters.
 * spec: contracts/platform.contract.md#PLAT-19
 */
const DEFAULT_GATEWAY_PORT = 8000;
const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const FALLBACK_CLIENT_IP = "127.0.0.1";

/**
 * Canonical HTTP status codes.
 * spec: contracts/platform.contract.md#PLAT-12
 */
const HTTP_STATUS_NO_CONTENT = 204;
const HTTP_STATUS_NOT_MODIFIED = 304;
const HTTP_STATUS_RATE_LIMITED = 429;
const HTTP_STATUS_UNAVAILABLE = 503;

/**
 * Fallback delay in seconds when Retry-After is unspecified.
 * spec: contracts/platform.contract.md#PLAT-9
 */
const DEFAULT_RETRY_AFTER_SECONDS = 1;

/**
 * Configuration options for starting the gateway server.
 * spec: tasks/milestone-0.6-public-beta/T-0604-ingress-gateway-server.md
 */
export interface GatewayOptions {
  port?: number;
  host?: string;
  controlPlaneUrl: string;
  dataPlaneUrl: string;
  rateLimiter?: MultiTenantRateLimiter;
  signal?: AbortSignal;
}

/**
 * Active gateway server handle.
 * spec: tasks/milestone-0.6-public-beta/T-0604-ingress-gateway-server.md
 */
export interface GatewayServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Resolves or generates the canonical request identifier.
 * Preserves incoming client ID or generates a fresh Crockford Base32 ULID.
 *
 * spec: contracts/platform.contract.md#PLAT-14 — 128-bit monotonic Crockford Base32 ULID
 * spec: contracts/platform.contract.md#PLAT-12 — request_id propagated unchanged
 */
function resolveRequestId(req: Request): string {
  return (
    req.headers.get("x-request-id") ||
    req.headers.get("request-id") ||
    generateUlid()
  );
}

/**
 * Determines target upstream URL based on path routing rules.
 * Management endpoints (/v1/*, /v1) proxy to control plane; all others proxy to data plane.
 *
 * spec: contracts/platform.contract.md#PLAT-1 — Control plane vs data plane path separation
 * spec: contracts/platform.contract.md#PLAT-8 — Zero control plane roundtrips on customer data plane paths
 * spec: contracts/platform.contract.md#PLAT-11 — Route matching specificity
 */
function resolveTargetUrl(incomingUrl: URL, options: GatewayOptions): URL {
  const isControlPlane = incomingUrl.pathname === "/login" ||
    incomingUrl.pathname.startsWith("/login/") ||
    incomingUrl.pathname === "/deploy" ||
    incomingUrl.pathname.startsWith("/deploy/") ||
    incomingUrl.pathname === "/rollback" ||
    incomingUrl.pathname.startsWith("/rollback/") ||
    incomingUrl.pathname === "/export" ||
    incomingUrl.pathname.startsWith("/export/") ||
    incomingUrl.pathname === "/import" ||
    incomingUrl.pathname.startsWith("/import/") ||
    incomingUrl.pathname === "/v1" ||
    incomingUrl.pathname.startsWith("/v1/");
  const baseString = isControlPlane
    ? options.controlPlaneUrl
    : options.dataPlaneUrl;
  const baseUrl = new URL(baseString);

  const basePath = baseUrl.pathname.replace(/\/$/, "");
  return new URL(
    `${basePath}${incomingUrl.pathname}${incomingUrl.search}`,
    baseUrl.origin,
  );
}

/**
 * Evaluates rate limit tiers across IP, Identity (API token), and Project scopes.
 *
 * spec: contracts/platform.contract.md#PLAT-9 — Token bucket evaluation across tenant scopes
 */
function evaluateRateLimits(
  req: Request,
  info: Deno.ServeHandlerInfo,
  rateLimiter: MultiTenantRateLimiter,
): RateLimitDecision {
  const authHeader = req.headers.get("authorization");
  const projectId = req.headers.get("x-project-id");

  // spec: contracts/platform.contract.md#PLAT-9 — Anonymous / IP tier applies to unauthenticated traffic
  if (!authHeader && !projectId) {
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      (info.remoteAddr as Deno.NetAddr)?.hostname ||
      FALLBACK_CLIENT_IP;
    return rateLimiter.check("ip", clientIp);
  }

  let lastAllowedDecision: RateLimitDecision | undefined;

  // Identity tier: API token
  if (authHeader) {
    const decision = rateLimiter.check("identity", authHeader);
    if (!decision.allowed) {
      return decision;
    }
    lastAllowedDecision = decision;
  }

  // Project tier: Project ID
  if (projectId) {
    const decision = rateLimiter.check("project", projectId);
    if (!decision.allowed) {
      return decision;
    }
    lastAllowedDecision = decision;
  }

  return lastAllowedDecision ?? {
    allowed: true,
    remaining: 1,
    limit: 1,
    resetMs: 0,
  };
}

/**
 * Creates canonical error response matching PLAT-12 specification.
 *
 * spec: contracts/platform.contract.md#PLAT-12 — Canonical error shape { error: { code, message, request_id } }
 */
function createErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  additionalHeaders?: Record<string, string>,
): Response {
  const body = JSON.stringify({
    error: {
      code,
      message,
      request_id: requestId,
    },
  });

  const headers = new Headers({
    "content-type": "application/json",
    "x-request-id": requestId,
    "request-id": requestId,
    ...additionalHeaders,
  });

  return new Response(body, {
    status,
    headers,
  });
}

/**
 * Dispatches request upstream and proxies response back to downstream caller.
 *
 * spec: contracts/platform.contract.md#PLAT-1 — Streaming payload forwarding
 * spec: contracts/platform.contract.md#PLAT-12 — UNAVAILABLE error on upstream failure
 * spec: contracts/platform.contract.md#PLAT-14 — Request ID propagation upstream & downstream
 */
async function proxyRequest(
  req: Request,
  targetUrl: URL,
  requestId: string,
): Promise<Response> {
  const upstreamHeaders = new Headers(req.headers);
  upstreamHeaders.set("x-request-id", requestId);
  upstreamHeaders.set("request-id", requestId);

  const hasBody = req.method !== "GET" && req.method !== "HEAD" &&
    req.body !== null;
  const body = hasBody ? req.body : undefined;

  const fetchInit: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: upstreamHeaders,
    body,
    duplex: body ? "half" : undefined,
  };

  try {
    const upstreamRes = await fetch(targetUrl.toString(), fetchInit);

    const responseHeaders = new Headers(upstreamRes.headers);
    responseHeaders.set("x-request-id", requestId);
    responseHeaders.set("request-id", requestId);

    const isNullBodyStatus = upstreamRes.status === HTTP_STATUS_NO_CONTENT ||
      upstreamRes.status === HTTP_STATUS_NOT_MODIFIED;

    return new Response(isNullBodyStatus ? null : upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders,
    });
  } catch (_err) {
    // spec: contracts/platform.contract.md#PLAT-12 — Upstream connection drop yields UNAVAILABLE
    return createErrorResponse(
      HTTP_STATUS_UNAVAILABLE,
      "UNAVAILABLE",
      "Upstream service unavailable.",
      requestId,
    );
  }
}

/**
 * Starts the RailFog Ingress Gateway Reverse Proxy server.
 *
 * spec: contracts/platform.contract.md#PLAT-19 — apps/gateway server lifecycle
 * tasks/milestone-0.6-public-beta/T-0604-ingress-gateway-server.md
 */
export function startGatewayServer(
  options: GatewayOptions,
): Promise<GatewayServer> {
  const server = Deno.serve(
    {
      port: options.port ?? DEFAULT_GATEWAY_PORT,
      hostname: options.host ?? DEFAULT_GATEWAY_HOST,
      signal: options.signal,
      onListen: () => {},
    },
    async (req: Request, info: Deno.ServeHandlerInfo): Promise<Response> => {
      // spec: contracts/platform.contract.md#PLAT-14 — ULID request ID injection
      const requestId = resolveRequestId(req);

      // spec: contracts/platform.contract.md#PLAT-9 — Rate limit verification before backend dispatch
      if (options.rateLimiter) {
        const decision = evaluateRateLimits(req, info, options.rateLimiter);
        if (!decision.allowed) {
          const retryAfter = String(
            decision.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
          );
          return createErrorResponse(
            HTTP_STATUS_RATE_LIMITED,
            "RATE_LIMITED",
            "Rate limit exceeded. Please retry after specified delay.",
            requestId,
            { "retry-after": retryAfter },
          );
        }
      }

      // spec: contracts/platform.contract.md#PLAT-1, PLAT-8 — Route resolution to control/data plane
      const incomingUrl = new URL(req.url);
      const targetUrl = resolveTargetUrl(incomingUrl, options);

      // spec: contracts/platform.contract.md#PLAT-1, PLAT-12, PLAT-14 — Upstream proxy execution
      return await proxyRequest(req, targetUrl, requestId);
    },
  );

  const assignedPort = (server.addr as Deno.NetAddr).port;
  const gatewayServer: GatewayServer = {
    port: assignedPort,
    close: () => server.shutdown(),
  };

  return Promise.resolve(gatewayServer);
}
