// spec: contracts/platform.contract.md#PLAT-1 — Daemon separation & health check bypass
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & tenant scoping
// spec: contracts/platform.contract.md#PLAT-12 — Canonical error model (PERMISSION_DENIED, status 403)
// spec: contracts/platform.contract.md#PLAT-14 — Request ID propagation (x-request-id & request-id)
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0754-api-key-auth-middleware.md

import type { IdentityContext } from "./verifier.ts";
import { extractBearerToken } from "./verifier.ts";
import type { ApiKeyStore } from "./store.ts";

export interface AuthMiddlewareOptions {
  apiKeyStore?: ApiKeyStore;
  staticTokens?: Record<string, IdentityContext>; // Fallback or bootstrap static keys
  allowAnonymousPaths?: string[]; // Paths bypassing auth (default: ["/healthz", "/login"])
  requireMatchingProject?: boolean; // Ensure token has access to requested projectId
}

export type AuthResult =
  | { ok: true; context: IdentityContext }
  | { ok: false; response: Response };

/**
 * Builds canonical error response according to PLAT-12 error schema with zero secret leakage (PLAT-15).
 */
function createAuthErrorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
): Response {
  const body = JSON.stringify({
    error: {
      code,
      message,
      request_id: requestId,
    },
  });

  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      "request-id": requestId,
    },
  });
}

/**
 * Creates an HTTP authentication middleware for control and runtime daemons.
 *
 * Implements PLAT-1, PLAT-6, PLAT-12, and PLAT-15. Validates incoming caller credentials
 * against configured ApiKeyStore or static tokens, preserves request_id headers,
 * and rejects unauthenticated or unauthorized callers with 403 PERMISSION_DENIED.
 */
export function createAuthMiddleware(
  options: AuthMiddlewareOptions,
): (req: Request, requestId: string) => Promise<AuthResult> {
  const anonymousPaths = new Set(
    options.allowAnonymousPaths ?? ["/healthz", "/login"],
  );

  return async (req: Request, requestId: string): Promise<AuthResult> => {
    const url = new URL(req.url);
    let pathname = url.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }

    // spec: contracts/platform.contract.md#PLAT-1 — Health check & public anonymous paths bypass
    if (anonymousPaths.has(pathname)) {
      return {
        ok: true,
        context: {
          callerId: "anonymous",
          orgId: "",
          callerType: "anonymous",
        },
      };
    }

    // Extract token from Authorization: Bearer <key> or x-api-key: <key>
    let token = extractBearerToken(req.headers.get("authorization"));
    if (!token) {
      const apiKeyHeader = req.headers.get("x-api-key");
      if (apiKeyHeader && apiKeyHeader.trim().length > 0) {
        token = apiKeyHeader.trim();
      }
    }

    // Missing token
    if (!token) {
      return {
        ok: false,
        response: createAuthErrorResponse(
          403,
          "PERMISSION_DENIED",
          "Missing authorization credentials (PLAT-6, PLAT-12). Provide Authorization: Bearer <key> or x-api-key header.",
          requestId,
        ),
      };
    }

    // Step 1: Check static tokens (e.g. bootstrap tokens)
    if (options.staticTokens && Object.hasOwn(options.staticTokens, token)) {
      const context = options.staticTokens[token];
      return { ok: true, context };
    }

    // Step 2: Check persistent ApiKeyStore
    if (options.apiKeyStore) {
      try {
        const identity = await options.apiKeyStore.verifyRawToken(token);
        if (identity) {
          // Check project boundary if enabled
          if (options.requireMatchingProject && identity.projectId) {
            const projectMatch = pathname.match(/^\/v1\/projects\/([^/]+)/);
            if (projectMatch && projectMatch[1] !== identity.projectId) {
              return {
                ok: false,
                response: createAuthErrorResponse(
                  403,
                  "PERMISSION_DENIED",
                  `Access denied: API token is scoped to project '${identity.projectId}' but requested '${
                    projectMatch[1]
                  }' (PLAT-6).`,
                  requestId,
                ),
              };
            }
          }
          return { ok: true, context: identity };
        }
      } catch {
        // Fallthrough to invalid credentials
      }
    }

    // Step 3: Reject invalid credentials (PLAT-15: zero token leakage in message)
    return {
      ok: false,
      response: createAuthErrorResponse(
        403,
        "PERMISSION_DENIED",
        "Invalid or revoked API key (PLAT-6, PLAT-12).",
        requestId,
      ),
    };
  };
}
