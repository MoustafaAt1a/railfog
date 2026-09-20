/**
 * Standalone Runtime Data Plane Daemon Server (T-0606).
 *
 * Implements the railfog-runtime daemon process serving live customer traffic from
 * locally cached immutable configuration snapshots. Polls the control plane in the
 * background, operates fail-static during control plane outages, and executes requests
 * inside an IsolationProvider with fresh context per invocation.
 *
 * Spec references:
 * - PLAT-1: Control plane vs data plane separation (runtime daemon serves live traffic).
 * - PLAT-4: Isolation & defense in depth (IsolationProvider execution boundary).
 * - PLAT-8: Fail-static control/data plane split (local cached snapshot, ~5s background poll, outage resilience).
 * - PLAT-10: SLOs & error budget (99.95% data plane availability via in-memory cached routing).
 * - PLAT-11: Routing specificity algorithm (matchRoute determinism).
 * - PLAT-12: Error model (canonical codes RESOURCE_NOT_FOUND, INTERNAL, request_id propagation).
 * - PLAT-14: ULID 128-bit Crockford Base32 monotonic identifiers for request_id.
 * - FN-1: Function definition and execution interface.
 * - FN-6: Isolation & warm-reuse rule (fresh context and bindings per invocation, zero state bleeding).
 * - FN-8: Request lifecycle (route -> cached snapshot -> isolate -> fresh ctx -> response + request_id).
 * - tasks/milestone-0.6-public-beta/T-0606-runtime-data-plane-server.md
 */

import type {
  Artifact,
  ExecutionResult,
  InvocationRequest,
  IsolationProvider,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import {
  type RoutingSnapshot,
  validateRoutingSnapshot,
} from "../../packages/protocol/snapshot.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";
import { matchRoute } from "../../runtime/router/route-matcher.ts";
import { LocalIsolationProvider } from "../../runtime/sandbox/local-isolation.ts";

/**
 * Service identifier returned in health check responses.
 * spec: contracts/platform.contract.md#PLAT-1
 */
const RUNTIME_SERVICE_NAME = "railfog-runtime";

/**
 * Default networking and polling configuration.
 * spec: contracts/platform.contract.md#PLAT-8, PLAT-19
 */
const DEFAULT_RUNTIME_PORT = 8080;
const DEFAULT_RUNTIME_HOST = "127.0.0.1";
const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * Configuration options for starting the runtime server daemon.
 * spec: tasks/milestone-0.6-public-beta/T-0606-runtime-data-plane-server.md
 */
export interface RuntimeServerOptions {
  port?: number;
  host?: string;
  controlPlaneUrl?: string;
  projectId: string;
  orgId?: string;
  snapshotDiskCachePath?: string;
  isolationProvider: IsolationProvider;
  pollIntervalMs?: number; // default: 5000ms
  signal?: AbortSignal;
}

/**
 * Running instance of the runtime server daemon.
 * spec: tasks/milestone-0.6-public-beta/T-0606-runtime-data-plane-server.md
 */
export interface RuntimeServer {
  port: number;
  getSnapshotVersion(): number;
  close(): Promise<void>;
}

/**
 * Resolves or generates the canonical request identifier.
 * Preserves incoming client ID or generates a fresh 26-char Crockford Base32 ULID.
 *
 * spec: contracts/platform.contract.md#PLAT-12 — request_id propagated unchanged
 * spec: contracts/platform.contract.md#PLAT-14 — 128-bit Crockford Base32 ULID
 */
function resolveRequestId(req: Request): string {
  const incomingId = req.headers.get("x-request-id") ??
    req.headers.get("request-id");
  if (incomingId && incomingId.trim().length > 0) {
    return incomingId.trim();
  }
  return generateUlid();
}

/**
 * Creates canonical error response matching PLAT-12 specification.
 *
 * spec: contracts/platform.contract.md#PLAT-12 — Canonical error shape { error: { code, message, request_id } }
 * spec: contracts/platform.contract.md#PLAT-14 — x-request-id and request-id header propagation
 */
function createErrorResponse(
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
 * Persists routing snapshot to disk cache for cold start resilience.
 *
 * spec: contracts/platform.contract.md#PLAT-8 — Cold start cache persistence
 */
async function writeSnapshotDiskCache(
  path: string,
  snapshot: RoutingSnapshot,
): Promise<void> {
  try {
    await Deno.writeTextFile(path, JSON.stringify(snapshot));
  } catch {
    // Non-fatal: ignore disk cache write failure (e.g. read-only filesystem)
  }
}

/**
 * Starts the standalone Runtime Data Plane Daemon Server (railfog-runtime).
 *
 * spec: contracts/platform.contract.md#PLAT-1 — Modular monolith runtime process serving live traffic
 * spec: contracts/platform.contract.md#PLAT-8 — Fail-static cached snapshot execution and background refresh
 * spec: contracts/platform.contract.md#PLAT-10 — 99.95% data plane SLO via zero synchronous control-plane calls
 * spec: tasks/milestone-0.6-public-beta/T-0606-runtime-data-plane-server.md
 */
export async function startRuntimeServer(
  options: RuntimeServerOptions,
): Promise<RuntimeServer> {
  let currentSnapshot: RoutingSnapshot | null = null;
  let isClosed = false;
  let timerId: ReturnType<typeof setInterval> | undefined = undefined;

  // spec: contracts/platform.contract.md#PLAT-8 — Step 1: Load snapshot from disk cache if present (cold-start resilience)
  if (options.snapshotDiskCachePath) {
    try {
      const cachedText = await Deno.readTextFile(options.snapshotDiskCachePath);
      currentSnapshot = validateRoutingSnapshot(JSON.parse(cachedText));
    } catch {
      // Non-fatal: disk cache absent or corrupt, proceed with initial fetch
    }
  }

  // spec: contracts/platform.contract.md#PLAT-8 — Step 2: Initial snapshot fetch from control plane
  if (options.controlPlaneUrl) {
    try {
      const headers: Record<string, string> = {};
      if (currentSnapshot) {
        headers["if-none-match"] = `"${currentSnapshot.version}"`;
      }
      const snapshotUrl =
        `${options.controlPlaneUrl}/v1/projects/${options.projectId}/snapshot`;
      const res = await fetch(snapshotUrl, { headers });
      if (res.status === 200) {
        const payload = await res.json();
        const validated = validateRoutingSnapshot(payload);
        // spec: contracts/platform.contract.md#PLAT-8 — Monotonic version update (reject stale replay/downgrades)
        if (!currentSnapshot || validated.version > currentSnapshot.version) {
          currentSnapshot = validated;
          if (options.snapshotDiskCachePath) {
            await writeSnapshotDiskCache(
              options.snapshotDiskCachePath,
              validated,
            );
          }
        }
      }
      // Fail-static: On 304, 404, 503, keep currentSnapshot if loaded from disk cache
    } catch {
      // Fail-static: Control plane unreachable at startup; proceed with disk snapshot if present
    }
  }

  // spec: contracts/platform.contract.md#PLAT-8 — Step 3: Background snapshot polling (~5s interval)
  if (options.controlPlaneUrl) {
    const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let isPolling = false;

    const pollControlPlane = async () => {
      if (isClosed || isPolling) {
        return;
      }
      isPolling = true;
      try {
        const headers: Record<string, string> = {};
        if (currentSnapshot) {
          headers["if-none-match"] = `"${currentSnapshot.version}"`;
        }
        const snapshotUrl =
          `${options.controlPlaneUrl}/v1/projects/${options.projectId}/snapshot`;
        const res = await fetch(snapshotUrl, { headers });
        if (isClosed) {
          return;
        }

        if (res.status === 200) {
          const payload = await res.json();
          const validated = validateRoutingSnapshot(payload);
          // spec: contracts/platform.contract.md#PLAT-8 — Monotonic version update (reject stale replay/downgrades)
          if (!currentSnapshot || validated.version > currentSnapshot.version) {
            currentSnapshot = validated;
            if (options.snapshotDiskCachePath) {
              await writeSnapshotDiskCache(
                options.snapshotDiskCachePath,
                validated,
              );
            }
          }
        }
        // spec: contracts/platform.contract.md#PLAT-8 — 304 Not Modified: keep current snapshot
      } catch {
        // spec: contracts/platform.contract.md#PLAT-8 — Network failure/outage: swallow error, fail-static
      } finally {
        isPolling = false;
      }
    };

    timerId = setInterval(pollControlPlane, pollInterval);
  }

  // spec: contracts/platform.contract.md#PLAT-1, PLAT-4, FN-8 — Request dispatch handler
  const handler = async (req: Request): Promise<Response> => {
    // spec: contracts/platform.contract.md#PLAT-12, PLAT-14 — Monotonic ULID request identifier
    const requestId = resolveRequestId(req);

    try {
      const url = new URL(req.url);

      // spec: contracts/platform.contract.md#PLAT-1, PLAT-12, PLAT-14 — Built-in health check endpoint
      if (url.pathname === "/healthz") {
        const healthBody = JSON.stringify({
          status: "ok",
          service: RUNTIME_SERVICE_NAME,
          snapshotVersion: currentSnapshot?.version ?? 0,
          request_id: requestId,
        });

        return new Response(healthBody, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
            "request-id": requestId,
          },
        });
      }

      // spec: contracts/platform.contract.md#PLAT-8, PLAT-11, PLAT-12 — Route matching against local snapshot
      if (!currentSnapshot || currentSnapshot.routes.length === 0) {
        return createErrorResponse(
          404,
          "RESOURCE_NOT_FOUND",
          `No route matching path: ${url.pathname}`,
          requestId,
        );
      }

      // spec: contracts/platform.contract.md#PLAT-11 — Deterministic route matching via specificity score
      const winningRoute = matchRoute(currentSnapshot.routes, url.pathname);
      if (!winningRoute) {
        return createErrorResponse(
          404,
          "RESOURCE_NOT_FOUND",
          `No route matching path: ${url.pathname}`,
          requestId,
        );
      }

      // spec: contracts/platform.contract.md#PLAT-8, PLAT-12 — Safe function metadata lookup (prototype pollution defense)
      const fnSnapshot = Object.hasOwn(
          currentSnapshot.functions,
          winningRoute.function,
        )
        ? currentSnapshot.functions[winningRoute.function]
        : undefined;

      if (!fnSnapshot) {
        return createErrorResponse(
          404,
          "RESOURCE_NOT_FOUND",
          `Function not found: ${winningRoute.function}`,
          requestId,
        );
      }

      // spec: contracts/platform.contract.md#PLAT-4, PLAT-16 — Build deployment artifact descriptor
      const artifact: Artifact = {
        id: fnSnapshot.artifactId,
        integrity: fnSnapshot.artifactId,
        entrypoint: "index.ts",
        code: new Uint8Array(),
      };

      // spec: contracts/functions.contract.md#FN-5 — Resource limits
      const limits: Limits = {
        cpuMs: fnSnapshot.limits.cpu_ms,
        timeoutMs: fnSnapshot.limits.timeout_ms,
        memoryMb: fnSnapshot.limits.memory_mb,
      };

      // spec: contracts/functions.contract.md#FN-6 — Fresh invocation headers (zero bleeding across warm invocations)
      const invocationHeaders: Record<string, string> = {};
      for (const [key, value] of req.headers.entries()) {
        invocationHeaders[key] = value;
      }
      invocationHeaders["x-request-id"] = requestId;
      invocationHeaders["request-id"] = requestId;

      // spec: contracts/functions.contract.md#FN-1 — Request body extraction
      const bodyBytes = req.body
        ? new Uint8Array(await req.arrayBuffer())
        : undefined;

      // spec: contracts/platform.contract.md#PLAT-4, FN-6, FN-8 — Fresh InvocationRequest container
      const invocation: InvocationRequest = {
        requestId,
        method: req.method,
        url: req.url,
        headers: invocationHeaders,
        body: bodyBytes,
      };

      // spec: contracts/platform.contract.md#PLAT-4, FN-8 — Dispatch execution inside IsolationProvider
      const result: ExecutionResult = await options.isolationProvider.run(
        artifact,
        limits,
        invocation,
      );

      // spec: contracts/platform.contract.md#PLAT-12, PLAT-14 — Attach response headers and request IDs
      const responseHeaders = new Headers();
      if (result.headers) {
        for (const [headerKey, headerVal] of Object.entries(result.headers)) {
          responseHeaders.set(headerKey, headerVal);
        }
      }
      responseHeaders.set("x-request-id", requestId);
      responseHeaders.set("request-id", requestId);

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
    } catch (err) {
      // spec: contracts/platform.contract.md#PLAT-12 — Unhandled crash returns canonical INTERNAL error
      const message = err instanceof Error ? err.message : String(err);
      return createErrorResponse(
        500,
        "INTERNAL",
        message,
        requestId,
      );
    }
  };

  // spec: contracts/platform.contract.md#PLAT-1, PLAT-19 — Server binding lifecycle
  const server = Deno.serve(
    {
      port: options.port ?? DEFAULT_RUNTIME_PORT,
      hostname: options.host ?? DEFAULT_RUNTIME_HOST,
      signal: options.signal,
      onListen: () => {},
    },
    handler,
  );

  // Hook AbortSignal for graceful shutdown of background timer
  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      isClosed = true;
      if (timerId !== undefined) {
        clearInterval(timerId);
      }
    });
  }

  const assignedPort = (server.addr as Deno.NetAddr).port;

  const runtimeServer: RuntimeServer = {
    port: assignedPort,
    getSnapshotVersion: () => currentSnapshot?.version ?? 0,
    close: async () => {
      isClosed = true;
      if (timerId !== undefined) {
        clearInterval(timerId);
      }
      try {
        await server.shutdown();
      } catch {
        // Non-fatal: server may already be shut down via AbortSignal
      }
    },
  };

  return runtimeServer;
}

// spec: contracts/platform.contract.md#PLAT-1 — Standalone daemon runner
if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") || "8080", 10);
  const host = Deno.env.get("HOST") || "0.0.0.0";
  const controlPlaneUrl = Deno.env.get("RAILFOG_CONTROL_URL") || undefined;
  const projectId = Deno.env.get("RAILFOG_PROJECT_ID") || "default";
  const orgId = Deno.env.get("RAILFOG_ORG_ID") || "default-org";
  const isolationProvider = new LocalIsolationProvider();

  const server = await startRuntimeServer({
    port,
    host,
    controlPlaneUrl,
    projectId,
    orgId,
    isolationProvider,
  });

  console.log(`[railfog-runtime] listening on http://${host}:${server.port}`);
}
