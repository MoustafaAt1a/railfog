/**
 * Standalone Control Plane Daemon Server (railfog-control).
 *
 * Exposes management REST endpoints for project health, immutable versioned
 * configuration snapshot distribution, revision deployment and rollback, and
 * state backup export/import. Never executes customer code.
 *
 * Spec references:
 * - PLAT-1: Control plane vs data plane separation (never executes customer code).
 * - PLAT-3: Deployment pipeline (validation, CAS storage, health check gating, atomic cutover, instant rollback).
 * - PLAT-8: Fail-static snapshot distribution and ETag caching.
 * - PLAT-12: Error model taxonomy (RESOURCE_NOT_FOUND, VALIDATION_FAILED, PERMISSION_DENIED, CONFLICT, request_id).
 * - PLAT-14: ULID monotonic identifier format for request_id, revisions, and snapshots.
 * - PLAT-18: Resource hierarchy Org -> Project -> { Function, KV, Object, Queue } -> Revision.
 * - FN-3: Function lifecycle, immutable revisions, instant pointer-flip rollback without rebuilding.
 * - ADR-0002: State backup and disaster recovery archive specification.
 * - tasks/milestone-0.6-public-beta/T-0605-control-plane-server.md
 */

import {
  type DeploymentResult,
  DeploymentService,
  type RevisionRecord,
} from "./deployment-service.ts";
import type {
  ImportProjectResult,
  StateBackupService,
} from "./state-backup-service.ts";
import {
  type RoutingSnapshot as ProjectSnapshot,
  SnapshotDistributor,
} from "../../packages/protocol/snapshot.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";
import {
  PermissionDeniedError,
  RailFogError,
  type RailFogErrorCode,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import type {
  Manifest,
  PackagedArtifact,
} from "../../packages/core/artifact/packager.ts";
import type { StateBackupArchive } from "../../packages/core/backup/archive-schema.ts";
import { renderLoginPageHtml } from "./login-page.ts";
import type { ApiKeyStore } from "../../packages/auth/store.ts";
import {
  type AuthResult,
  createAuthMiddleware,
} from "../../packages/auth/middleware.ts";
import { extractBearerToken } from "../../packages/auth/verifier.ts";

export type { ProjectSnapshot };

// spec: contracts/platform.contract.md#PLAT-1 — Service identifier
const CONTROL_PLANE_SERVICE_NAME = "railfog-control";

// spec: contracts/platform.contract.md#PLAT-19 — Default network binding parameters
const DEFAULT_CONTROL_PORT = 8081;
const DEFAULT_CONTROL_HOST = "127.0.0.1";

// spec: contracts/platform.contract.md#PLAT-7, #PLAT-18 — Default tenant fallback
const DEFAULT_ORG_ID = "default-org";

// spec: contracts/platform.contract.md#PLAT-12 — Canonical HTTP status codes
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_NOT_MODIFIED = 304;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_CONFLICT = 409;
const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
const HTTP_STATUS_RATE_LIMITED = 429;
const HTTP_STATUS_INTERNAL_ERROR = 500;
const HTTP_STATUS_UNAVAILABLE = 503;
const HTTP_STATUS_GATEWAY_TIMEOUT = 504;

// spec: contracts/platform.contract.md#PLAT-12 — Canonical error codes
const ERROR_INTERNAL = "INTERNAL";

/**
 * Configuration options for starting the control plane server.
 * spec: tasks/milestone-0.6-public-beta/T-0605-control-plane-server.md
 */
export interface ControlServerOptions {
  port?: number;
  host?: string;
  deploymentService: DeploymentService;
  stateBackupService: StateBackupService;
  apiKeyStore?: ApiKeyStore;
  authMiddleware?: (req: Request, requestId: string) => Promise<AuthResult>;
  signal?: AbortSignal;
}

/**
 * Active control plane server handle.
 * spec: tasks/milestone-0.6-public-beta/T-0605-control-plane-server.md
 */
export interface ControlServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Cached snapshot state for a project to maintain version continuity.
 * spec: contracts/platform.contract.md#PLAT-8
 */
interface ProjectSnapshotState {
  distributor: SnapshotDistributor;
  snapshot: ProjectSnapshot;
  revisionFingerprint: string;
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
 * Maps RailFogErrorCode to canonical HTTP status codes.
 * spec: contracts/platform.contract.md#PLAT-12
 */
function statusFromErrorCode(code: RailFogErrorCode): number {
  switch (code) {
    case "VALIDATION_FAILED":
      return HTTP_STATUS_BAD_REQUEST;
    case "PERMISSION_DENIED":
      return HTTP_STATUS_FORBIDDEN;
    case "RESOURCE_NOT_FOUND":
      return HTTP_STATUS_NOT_FOUND;
    case "CONFLICT":
      return HTTP_STATUS_CONFLICT;
    case "PAYLOAD_TOO_LARGE":
      return HTTP_STATUS_PAYLOAD_TOO_LARGE;
    case "RATE_LIMITED":
    case "CALL_DEPTH_EXCEEDED":
      return HTTP_STATUS_RATE_LIMITED;
    case "UNAVAILABLE":
      return HTTP_STATUS_UNAVAILABLE;
    case "TIMEOUT":
      return HTTP_STATUS_GATEWAY_TIMEOUT;
    case "INTERNAL":
    default:
      return HTTP_STATUS_INTERNAL_ERROR;
  }
}

/**
 * Builds standard error response adhering to PLAT-12 error schema.
 * spec: contracts/platform.contract.md#PLAT-12
 */
function buildErrorResponse(err: unknown, requestId: string): Response {
  if (err instanceof RailFogError) {
    const status = statusFromErrorCode(err.code);
    const body = {
      error: {
        code: err.code,
        message: err.message,
        request_id: requestId,
      },
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "request-id": requestId,
      },
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  const body = {
    error: {
      code: ERROR_INTERNAL,
      message,
      request_id: requestId,
    },
  };
  return new Response(JSON.stringify(body), {
    status: HTTP_STATUS_INTERNAL_ERROR,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      "request-id": requestId,
    },
  });
}

/**
 * Safely parses request body as JSON object.
 * spec: contracts/platform.contract.md#PLAT-12
 */
async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text || text.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    throw new ValidationFailedError(
      "VALIDATION_FAILED: Request body must be a JSON object",
    );
  } catch (err) {
    if (err instanceof RailFogError) {
      throw err;
    }
    throw new ValidationFailedError(
      `VALIDATION_FAILED: Malformed JSON payload: ${(err as Error).message}`,
    );
  }
}

/**
 * Determines whether incoming If-None-Match header matches the current ETag.
 * Strips weak prefix W/ and quotes for standard comparison.
 * spec: contracts/platform.contract.md#PLAT-8
 */
function isEtagMatch(ifNoneMatchHeader: string, currentEtag: string): boolean {
  const cleanCurrent = currentEtag
    .trim()
    .replace(/^W\//, "")
    .replace(/^"/, "")
    .replace(/"$/, "");
  const parts = ifNoneMatchHeader.split(",").map((p) => p.trim());
  for (const part of parts) {
    if (part === "*") {
      return true;
    }
    const cleanPart = part
      .replace(/^W\//, "")
      .replace(/^"/, "")
      .replace(/"$/, "");
    if (cleanPart === cleanCurrent) {
      return true;
    }
  }
  return false;
}

/**
 * Starts the standalone control plane daemon HTTP server.
 *
 * Spec references:
 * - PLAT-1: Control plane never executes customer code.
 * - PLAT-3: Deployment pipeline and instant rollback.
 * - PLAT-8: Fail-static snapshot distribution and ETag caching.
 * - PLAT-12: Error model and request_id propagation.
 * - PLAT-14: ULID monotonic identifiers.
 * - PLAT-18: Org -> Project -> Function hierarchy.
 * - FN-3: Function lifecycle and pointer flip rollback.
 * - ADR-0002: State backup export and restore.
 */
export function startControlServer(
  options: ControlServerOptions,
): Promise<ControlServer> {
  const snapshotStates = new Map<string, ProjectSnapshotState>();

  const authMiddleware = options.authMiddleware ??
    (options.apiKeyStore
      ? createAuthMiddleware({
        apiKeyStore: options.apiKeyStore,
        allowAnonymousPaths: [
          "/healthz",
          "/login",
          "/v1/auth/keys",
          "/v1/auth/verify",
        ],
      })
      : undefined);

  /**
   * Retrieves or builds the current snapshot for a project.
   * If active revisions have changed, advances snapshot version.
   * spec: contracts/platform.contract.md#PLAT-8
   */
  async function getProjectSnapshot(
    projectId: string,
  ): Promise<ProjectSnapshot> {
    const fnNames = options.deploymentService.listFunctions(projectId).sort();
    const activeRevisions: Record<string, RevisionRecord> = {};

    for (const fnName of fnNames) {
      const rev = await options.deploymentService.getActiveRevision(
        projectId,
        fnName,
      );
      if (rev) {
        activeRevisions[fnName] = rev;
      }
    }

    const fingerprint = Object.entries(activeRevisions)
      .map(([k, v]) => `${k}:${v.id}:${v.artifactId}:${v.state}`)
      .sort()
      .join(";");

    let state = snapshotStates.get(projectId);
    if (!state) {
      const distributor = new SnapshotDistributor();
      const routes = Object.keys(activeRevisions).sort().map((fn) => ({
        pattern: `/${fn}`,
        function: fn,
      }));
      const snapshot = distributor.createSnapshot(routes, activeRevisions);
      state = { distributor, snapshot, revisionFingerprint: fingerprint };
      snapshotStates.set(projectId, state);
    } else if (state.revisionFingerprint !== fingerprint) {
      const routes = Object.keys(activeRevisions).sort().map((fn) => ({
        pattern: `/${fn}`,
        function: fn,
      }));
      state.snapshot = state.distributor.createSnapshot(
        routes,
        activeRevisions,
      );
      state.revisionFingerprint = fingerprint;
    }

    return state.snapshot;
  }

  /**
   * Marks cached snapshot dirty to ensure re-generation on mutation.
   * spec: contracts/platform.contract.md#PLAT-8
   */
  function invalidateProjectSnapshot(projectId: string): void {
    const state = snapshotStates.get(projectId);
    if (state) {
      state.revisionFingerprint = "";
    }
  }

  // HTTP Request Dispatcher
  const handler = async (req: Request): Promise<Response> => {
    // spec: contracts/platform.contract.md#PLAT-14 — Request ID resolution
    const requestId = resolveRequestId(req);

    try {
      const url = new URL(req.url);
      let pathname = url.pathname;
      if (pathname.length > 1 && pathname.endsWith("/")) {
        pathname = pathname.slice(0, -1);
      }

      // AC1: GET /healthz (PLAT-1, PLAT-12, PLAT-14)
      if (pathname === "/healthz") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          throw new ValidationFailedError(
            `VALIDATION_FAILED: Method ${req.method} not allowed for /healthz (PLAT-12)`,
            requestId,
          );
        }
        const body = {
          status: "ok",
          service: CONTROL_PLANE_SERVICE_NAME,
          request_id: requestId,
        };
        return new Response(JSON.stringify(body), {
          status: HTTP_STATUS_OK,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
            "request-id": requestId,
          },
        });
      }

      // AC: GET /login — Web authentication page (T-0756)
      if (pathname === "/login") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          throw new ValidationFailedError(
            `VALIDATION_FAILED: Method ${req.method} not allowed for /login (PLAT-12)`,
            requestId,
          );
        }
        const callbackUrl = url.searchParams.get("callback") ?? undefined;
        const state = url.searchParams.get("state") ?? undefined;
        const orgId = url.searchParams.get("orgId") ?? undefined;
        const html = renderLoginPageHtml({
          serviceName: "RailFog Cloud",
          callbackUrl,
          state,
          orgId,
        });
        return new Response(html, {
          status: HTTP_STATUS_OK,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-request-id": requestId,
            "request-id": requestId,
          },
        });
      }

      // AC: POST /v1/auth/keys — Generate API key (T-0756, PLAT-15)
      if (pathname === "/v1/auth/keys") {
        if (req.method !== "POST") {
          throw new ValidationFailedError(
            `VALIDATION_FAILED: Method ${req.method} not allowed for /v1/auth/keys (PLAT-12)`,
            requestId,
          );
        }
        if (!options.apiKeyStore) {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: ApiKeyStore is not configured on control server.",
            requestId,
          );
        }
        const body = await parseJsonBody(req);
        const orgId = typeof body.orgId === "string" && body.orgId.trim() !== ""
          ? body.orgId.trim()
          : DEFAULT_ORG_ID;
        const name = typeof body.name === "string" && body.name.trim() !== ""
          ? body.name.trim()
          : "cli-key";
        const projectId =
          typeof body.projectId === "string" && body.projectId.trim() !== ""
            ? body.projectId.trim()
            : undefined;

        const result = await options.apiKeyStore.createKey({
          orgId,
          name,
          projectId,
        });

        return new Response(
          JSON.stringify({
            ok: true,
            id: result.id,
            rawToken: result.rawToken,
            record: result.record,
            request_id: requestId,
          }),
          {
            status: HTTP_STATUS_OK,
            headers: {
              "content-type": "application/json",
              "x-request-id": requestId,
              "request-id": requestId,
            },
          },
        );
      }

      // AC: GET /v1/auth/verify — Validate API token (T-0756, PLAT-6)
      if (pathname === "/v1/auth/verify") {
        if (!options.apiKeyStore) {
          return new Response(
            JSON.stringify({
              ok: true,
              identity: {
                callerId: "anonymous",
                orgId: DEFAULT_ORG_ID,
                callerType: "anonymous",
              },
              request_id: requestId,
            }),
            {
              status: HTTP_STATUS_OK,
              headers: {
                "content-type": "application/json",
                "x-request-id": requestId,
                "request-id": requestId,
              },
            },
          );
        }
        const token = extractBearerToken(req.headers.get("authorization")) ||
          req.headers.get("x-api-key")?.trim();
        if (!token) {
          throw new PermissionDeniedError(
            "PERMISSION_DENIED: Missing authorization credentials (PLAT-12)",
            requestId,
          );
        }
        const identity = await options.apiKeyStore.verifyRawToken(token);
        if (!identity) {
          throw new PermissionDeniedError(
            "PERMISSION_DENIED: Invalid or revoked API token (PLAT-12)",
            requestId,
          );
        }
        return new Response(
          JSON.stringify({ ok: true, identity, request_id: requestId }),
          {
            status: HTTP_STATUS_OK,
            headers: {
              "content-type": "application/json",
              "x-request-id": requestId,
              "request-id": requestId,
            },
          },
        );
      }

      // Enforce authentication on all protected management endpoints (PLAT-6)
      if (authMiddleware) {
        const authRes = await authMiddleware(req, requestId);
        if (!authRes.ok) {
          return authRes.response;
        }
      }

      // Customer Code Rejection (PLAT-1)
      // Fast check for explicit invocation or customer-facing paths
      if (
        pathname === "/invoke" ||
        pathname === "/run" ||
        pathname.startsWith("/api/") ||
        pathname.endsWith("/invoke") ||
        pathname === "/customer-function"
      ) {
        throw new PermissionDeniedError(
          "PERMISSION_DENIED: Control plane never executes customer code per PLAT-1.",
          requestId,
        );
      }

      // Pattern: /v1/projects/:projectId/:action
      const projectMatch = pathname.match(
        /^\/v1\/projects\/([^/]+)\/(snapshot|deploy|rollback|export|import)$/,
      );

      // AC2: Snapshot Distribution & ETag Caching (PLAT-8)
      if (projectMatch && projectMatch[2] === "snapshot") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          throw new ValidationFailedError(
            `VALIDATION_FAILED: Method ${req.method} not allowed for snapshot (PLAT-12)`,
            requestId,
          );
        }
        const projectId = decodeURIComponent(projectMatch[1]);
        const snapshot = await getProjectSnapshot(projectId);
        const currentEtag = `"${snapshot.version}"`;

        const ifNoneMatch = req.headers.get("if-none-match");
        if (ifNoneMatch && isEtagMatch(ifNoneMatch, currentEtag)) {
          // spec: contracts/platform.contract.md#PLAT-8 — 304 Not Modified without body payload
          return new Response(null, {
            status: HTTP_STATUS_NOT_MODIFIED,
            headers: {
              "etag": currentEtag,
              "x-request-id": requestId,
              "request-id": requestId,
            },
          });
        }

        return new Response(JSON.stringify(snapshot), {
          status: HTTP_STATUS_OK,
          headers: {
            "content-type": "application/json",
            "etag": currentEtag,
            "x-request-id": requestId,
            "request-id": requestId,
          },
        });
      }

      // AC3: Revision Deployment Pipeline (PLAT-3)
      if (
        (projectMatch && projectMatch[2] === "deploy") ||
        pathname === "/deploy"
      ) {
        if (req.method !== "POST") {
          throw new ValidationFailedError(
            `VALIDATION_FAILED: Method ${req.method} not allowed for deploy (PLAT-12)`,
            requestId,
          );
        }

        const body = await parseJsonBody(req);
        const projectId =
          (projectMatch ? decodeURIComponent(projectMatch[1]) : "") ||
          (typeof body.project === "string" ? body.project : "") ||
          (typeof body.projectId === "string" ? body.projectId : "");

        if (!projectId || projectId.trim().length === 0) {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Missing project identifier for deployment (PLAT-12)",
            requestId,
          );
        }

        if (
          !body.functionName ||
          typeof body.functionName !== "string" ||
          body.functionName.trim().length === 0
        ) {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Missing functionName for deployment (PLAT-12)",
            requestId,
          );
        }

        if (
          !body.artifact ||
          typeof body.artifact !== "object" ||
          body.artifact === null
        ) {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Missing artifact for deployment (PLAT-12)",
            requestId,
          );
        }

        const rawArtifact = body.artifact as Record<string, unknown>;
        let bytes: Uint8Array;
        if (rawArtifact.bytes instanceof Uint8Array) {
          bytes = rawArtifact.bytes;
        } else if (Array.isArray(rawArtifact.bytes)) {
          bytes = new Uint8Array(rawArtifact.bytes as number[]);
        } else if (
          typeof rawArtifact.bytes === "object" &&
          rawArtifact.bytes !== null
        ) {
          bytes = new Uint8Array(
            Object.values(rawArtifact.bytes) as number[],
          );
        } else {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Missing or invalid artifact bytes (OBJ-4, PLAT-12)",
            requestId,
          );
        }

        const artifact: PackagedArtifact = {
          id: String(rawArtifact.id ?? ""),
          integrity: String(rawArtifact.integrity ?? ""),
          manifest: (rawArtifact.manifest ?? {}) as Manifest,
          bytes,
        };

        const deployResult: DeploymentResult = await options.deploymentService
          .deploy(projectId, body.functionName.trim(), artifact);

        // spec: contracts/platform.contract.md#PLAT-8 — Advance snapshot version
        invalidateProjectSnapshot(projectId);
        await getProjectSnapshot(projectId);

        return new Response(JSON.stringify(deployResult), {
          status: HTTP_STATUS_OK,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
            "request-id": requestId,
          },
        });
      }

      // AC4: Instant Pointer-Flip Rollback (PLAT-3, FN-3)
      if (
        (projectMatch && projectMatch[2] === "rollback") ||
        pathname === "/rollback"
      ) {
        if (req.method !== "POST") {
          throw new ValidationFailedError(
            `VALIDATION_FAILED: Method ${req.method} not allowed for rollback (PLAT-12)`,
            requestId,
          );
        }

        const body = await parseJsonBody(req);
        const projectId =
          (projectMatch ? decodeURIComponent(projectMatch[1]) : "") ||
          (typeof body.project === "string" ? body.project : "") ||
          (typeof body.projectId === "string" ? body.projectId : "");

        if (!projectId || projectId.trim().length === 0) {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Missing project identifier for rollback (PLAT-12)",
            requestId,
          );
        }

        if (
          !body.functionName ||
          typeof body.functionName !== "string" ||
          body.functionName.trim().length === 0
        ) {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Missing functionName for rollback (PLAT-12)",
            requestId,
          );
        }

        if (
          !body.targetRevisionId ||
          typeof body.targetRevisionId !== "string" ||
          body.targetRevisionId.trim().length === 0
        ) {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Missing targetRevisionId for rollback (PLAT-12)",
            requestId,
          );
        }

        const rollbackResult = await options.deploymentService.rollback(
          projectId,
          body.functionName.trim(),
          body.targetRevisionId.trim(),
        );

        // spec: contracts/platform.contract.md#PLAT-8, FN-3 — Invalidate snapshot
        invalidateProjectSnapshot(projectId);
        await getProjectSnapshot(projectId);

        return new Response(JSON.stringify(rollbackResult), {
          status: HTTP_STATUS_OK,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
            "request-id": requestId,
          },
        });
      }

      // AC5: State Backup Export (ADR-0002)
      if (
        (projectMatch && projectMatch[2] === "export") ||
        pathname === "/export"
      ) {
        if (req.method !== "POST" && req.method !== "GET") {
          throw new ValidationFailedError(
            `VALIDATION_FAILED: Method ${req.method} not allowed for export (PLAT-12)`,
            requestId,
          );
        }

        let body: Record<string, unknown> = {};
        if (req.method === "POST") {
          try {
            body = await parseJsonBody(req);
          } catch {
            // Body is optional for export if parameters are provided in query or headers
          }
        }

        const projectId =
          (projectMatch ? decodeURIComponent(projectMatch[1]) : "") ||
          url.searchParams.get("projectId") ||
          (typeof body.projectId === "string" ? body.projectId : "") ||
          (typeof body.project === "string" ? body.project : "");

        if (!projectId || projectId.trim().length === 0) {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Missing projectId for export (PLAT-12)",
            requestId,
          );
        }

        const orgId = url.searchParams.get("orgId") ||
          req.headers.get("x-org-id") ||
          (typeof body.orgId === "string" ? body.orgId : "") ||
          DEFAULT_ORG_ID;

        const archive: StateBackupArchive = await options.stateBackupService
          .exportProject({
            orgId,
            projectId,
          });

        return new Response(JSON.stringify(archive), {
          status: HTTP_STATUS_OK,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
            "request-id": requestId,
          },
        });
      }

      // AC5: State Backup Import (ADR-0002)
      if (
        (projectMatch && projectMatch[2] === "import") ||
        pathname === "/import"
      ) {
        if (req.method !== "POST") {
          throw new ValidationFailedError(
            `VALIDATION_FAILED: Method ${req.method} not allowed for import (PLAT-12)`,
            requestId,
          );
        }

        const body = await parseJsonBody(req);
        const projectId =
          (projectMatch ? decodeURIComponent(projectMatch[1]) : "") ||
          (typeof body.targetProjectId === "string"
            ? body.targetProjectId
            : "") ||
          (typeof body.projectId === "string" ? body.projectId : "") ||
          (typeof body.project === "string" ? body.project : "");

        if (!projectId || projectId.trim().length === 0) {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Missing targetProjectId for import (PLAT-12)",
            requestId,
          );
        }

        if (
          !body.archive ||
          typeof body.archive !== "object" ||
          body.archive === null
        ) {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Missing archive payload in import request body (PLAT-12, ADR-0002)",
            requestId,
          );
        }

        const targetOrgId =
          (typeof body.targetOrgId === "string" ? body.targetOrgId : "") ||
          url.searchParams.get("orgId") ||
          req.headers.get("x-org-id") ||
          (typeof body.orgId === "string" ? body.orgId : "") ||
          DEFAULT_ORG_ID;

        const overwriteKv = body.overwriteKv === true;

        const importResult: ImportProjectResult = await options
          .stateBackupService.importProject({
            targetOrgId,
            targetProjectId: projectId,
            archive: body.archive as StateBackupArchive,
            overwriteKv,
          });

        // spec: contracts/platform.contract.md#PLAT-8 — Advance snapshot version
        invalidateProjectSnapshot(projectId);
        await getProjectSnapshot(projectId);

        return new Response(JSON.stringify(importResult), {
          status: HTTP_STATUS_OK,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
            "request-id": requestId,
          },
        });
      }

      // AC6: Unmatched route rejection per PLAT-1 & PLAT-12
      // spec: contracts/platform.contract.md#PLAT-1 — Control plane never executes customer code
      throw new PermissionDeniedError(
        "PERMISSION_DENIED: Control plane never executes customer code per PLAT-1.",
        requestId,
      );
    } catch (err) {
      return buildErrorResponse(err, requestId);
    }
  };

  // spec: contracts/platform.contract.md#PLAT-19 — Bind HTTP daemon
  const server = Deno.serve(
    {
      port: options.port ?? DEFAULT_CONTROL_PORT,
      hostname: options.host ?? DEFAULT_CONTROL_HOST,
      signal: options.signal,
      onListen: () => {},
    },
    handler,
  );

  const assignedPort = (server.addr as Deno.NetAddr).port;
  const controlServer: ControlServer = {
    port: assignedPort,
    close: async () => {
      try {
        await server.shutdown();
      } catch {
        // Shutdown may be called after AbortSignal or already closed
      }
      snapshotStates.clear();
    },
  };

  return Promise.resolve(controlServer);
}

// spec: contracts/platform.contract.md#PLAT-1 — Standalone control plane daemon runner
if (import.meta.main) {
  const { LocalFSProvider } = await import(
    "../../providers/objects/local-fs-provider.ts"
  );
  const { SQLiteKVProvider } = await import(
    "../../providers/kv/sqlite-provider.ts"
  );
  const { PostgresKVProvider } = await import(
    "../../providers/kv/postgres-provider.ts"
  );
  const { RedisKVProvider } = await import(
    "../../providers/kv/redis-provider.ts"
  );
  const { ApiKeyStore } = await import("../../packages/auth/store.ts");
  const { createStateBackupService } = await import(
    "./state-backup-service.ts"
  );

  const port = parseInt(Deno.env.get("PORT") || "8081", 10);
  const host = Deno.env.get("HOST") || "0.0.0.0";
  const storageDir = Deno.env.get("RAILFOG_OBJECTS_DIR") || ".railfog/objects";
  const storage = new LocalFSProvider(storageDir);

  const databaseUrl = Deno.env.get("DATABASE_URL");
  const redisUrl = Deno.env.get("REDIS_URL");

  let kv: import("../../primitives/kv/kv-provider.ts").KVProvider;
  if (databaseUrl && databaseUrl.trim().length > 0) {
    const pgKv = new PostgresKVProvider({ connectionString: databaseUrl });
    await pgKv.initSchema();
    kv = pgKv;
    console.log("[railfog-control] using PostgreSQL KV provider");
  } else {
    kv = new SQLiteKVProvider();
    console.log("[railfog-control] using SQLite KV provider");
  }

  let cacheProvider:
    | import("../../primitives/kv/kv-provider.ts").KVProvider
    | undefined;
  if (redisUrl && redisUrl.trim().length > 0) {
    cacheProvider = new RedisKVProvider({ url: redisUrl });
    console.log("[railfog-control] using Redis cache provider");
  }

  const apiKeyStore = new ApiKeyStore({
    storageProvider: kv,
    cacheProvider,
  });

  const bootstrapKey = Deno.env.get("RAILFOG_API_KEY");
  if (bootstrapKey) {
    const hash = await (await import("../../packages/auth/token.ts"))
      .hashApiToken(bootstrapKey);
    await kv.set(["_auth", "tokens", hash], {
      id: "bootstrap-id",
      tokenHash: hash,
      name: "bootstrap-key",
      orgId: "default-org",
      createdAt: new Date().toISOString(),
    });
    console.log(
      "[railfog-control] initialized bootstrap API key from RAILFOG_API_KEY",
    );
  }

  const deploymentService = new DeploymentService(storage);
  const stateBackupService = createStateBackupService(
    deploymentService,
    kv,
    storage,
  );

  const server = await startControlServer({
    port,
    host,
    deploymentService,
    stateBackupService,
    apiKeyStore,
  });

  console.log(`[railfog-control] listening on http://${host}:${server.port}`);
}
