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
import { MultiTenantRateLimiter } from "../gateway/rate-limiter.ts";

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
  const projectSnapshots = new Map<string, RoutingSnapshot>();
  const artifactCache = new Map<string, Uint8Array>();
  const rateLimiter = new MultiTenantRateLimiter();
  let isClosed = false;
  let timerId: ReturnType<typeof setInterval> | undefined = undefined;

  // In-memory PLAT-13 structured log ring buffer
  const MAX_LOG_ENTRIES = 1000;
  const logEntries: Array<{
    timestamp: string;
    level: "debug" | "info" | "warn" | "error";
    project: string;
    function: string;
    revision: string;
    request_id: string;
    duration_ms?: number;
    message?: string;
    [key: string]: unknown;
  }> = [];

  const recordLogEntry = (entry: (typeof logEntries)[0]) => {
    logEntries.push(entry);
    if (logEntries.length > MAX_LOG_ENTRIES) {
      logEntries.shift();
    }
  };

  // Cron schedule tickers
  const cronTimers = new Map<string, ReturnType<typeof setInterval>>();

  const syncCronSchedules = (snapshot: RoutingSnapshot, pId: string) => {
    for (const [key, timer] of cronTimers.entries()) {
      if (key.startsWith(`${pId}:`)) {
        clearInterval(timer);
        cronTimers.delete(key);
      }
    }

    for (const [fnName, fnSnap] of Object.entries(snapshot.functions)) {
      const fnAny = fnSnap as unknown as Record<string, unknown>;
      const triggers = fnAny.triggers as Record<string, unknown> | undefined;
      const schedule = triggers?.schedule ?? fnAny.schedule;
      if (schedule || fnAny.type === "cron") {
        const intervalMs = 60000;
        const timerKey = `${pId}:${fnName}`;
        const timer = setInterval(async () => {
          if (isClosed) return;
          try {
            let artifactCode = artifactCache.get(fnSnap.artifactId);
            if (
              (!artifactCode || artifactCode.byteLength === 0) &&
              options.controlPlaneUrl
            ) {
              try {
                const baseUrl = options.controlPlaneUrl.replace(/\/+$/, "");
                const artUrl = `${baseUrl}/v1/artifacts/${
                  encodeURIComponent(fnSnap.artifactId)
                }`;
                const artRes = await fetch(artUrl);
                if (artRes.status === 200) {
                  artifactCode = new Uint8Array(await artRes.arrayBuffer());
                  artifactCache.set(fnSnap.artifactId, artifactCode);
                }
              } catch {
                // ignore
              }
            }

            const cronArtifact: Artifact = {
              id: fnSnap.artifactId,
              integrity: fnSnap.artifactId,
              entrypoint: "index.ts",
              code: artifactCode ?? new Uint8Array(),
            };

            const cronLimits: Limits = {
              cpuMs: fnSnap.limits.cpu_ms,
              timeoutMs: fnSnap.limits.timeout_ms,
              memoryMb: fnSnap.limits.memory_mb,
            };

            const reqId = generateUlid();
            const invocation: InvocationRequest = {
              requestId: reqId,
              method: "POST",
              url: `https://internal.railfog/cron/${fnName}`,
              headers: {
                "x-railfog-trigger": "schedule",
                "x-railfog-project": pId,
                "x-railfog-function": fnName,
                "x-railfog-revision": fnSnap.revisionId,
                "x-railfog-org": options.orgId ?? "default-org",
                "x-request-id": reqId,
                "request-id": reqId,
                "content-type": "application/json",
              },
              body: new TextEncoder().encode(
                JSON.stringify({ scheduledTime: Date.now() }),
              ),
            };

            const res = await options.isolationProvider.run(
              cronArtifact,
              cronLimits,
              invocation,
            );
            recordLogEntry({
              timestamp: new Date().toISOString(),
              level: res.statusCode >= 400 ? "error" : "info",
              project: pId,
              function: fnName,
              revision: fnSnap.revisionId,
              request_id: reqId,
              duration_ms: res.wallClockMs,
              message:
                `Cron job [${fnName}] executed -> ${res.statusCode} (${res.wallClockMs}ms)`,
            });
          } catch (e) {
            console.error(`[Cron Failure] ${fnName}:`, e);
          }
        }, intervalMs);

        cronTimers.set(timerKey, timer);
      }
    }
  };

  // Wire Queue Dispatcher if isolationProvider supports it
  if (
    options.isolationProvider &&
    typeof (options.isolationProvider as unknown as Record<string, unknown>)
        .setQueueDispatcher === "function"
  ) {
    (
      options.isolationProvider as unknown as {
        setQueueDispatcher: (
          dispatcher: (
            queueName: string,
            message: unknown,
            projectId: string,
          ) => Promise<void> | void,
        ) => void;
      }
    ).setQueueDispatcher(
      async (queueName: string, message: unknown, projectId: string) => {
        try {
          const snap = projectSnapshots.get(projectId) ?? currentSnapshot;
          if (!snap) return;

          let targetFnName: string | null = null;
          let targetFnSnap: typeof snap.functions[string] | null = null;

          for (const [name, fn] of Object.entries(snap.functions)) {
            const trg = (fn as unknown as Record<string, unknown>).triggers as
              | Record<string, unknown>
              | undefined;
            if (trg?.queue === queueName || trg?.queue === "default") {
              targetFnName = name;
              targetFnSnap = fn;
              break;
            }
          }

          if (!targetFnName) {
            for (const [name, fn] of Object.entries(snap.functions)) {
              if (
                name.toLowerCase() === "worker" ||
                name.toLowerCase() === "queue" ||
                name.toLowerCase().includes("worker") ||
                name.toLowerCase() === queueName.toLowerCase()
              ) {
                targetFnName = name;
                targetFnSnap = fn;
                break;
              }
            }
          }

          if (!targetFnName || !targetFnSnap) {
            return;
          }

          let artifactCode = artifactCache.get(targetFnSnap.artifactId);
          if (
            (!artifactCode || artifactCode.byteLength === 0) &&
            options.controlPlaneUrl
          ) {
            try {
              const baseUrl = options.controlPlaneUrl.replace(/\/+$/, "");
              const artUrl = `${baseUrl}/v1/artifacts/${
                encodeURIComponent(targetFnSnap.artifactId)
              }`;
              const artRes = await fetch(artUrl);
              if (artRes.status === 200) {
                artifactCode = new Uint8Array(await artRes.arrayBuffer());
                artifactCache.set(targetFnSnap.artifactId, artifactCode);
              }
            } catch {
              // ignore
            }
          }

          const workerArtifact: Artifact = {
            id: targetFnSnap.artifactId,
            integrity: targetFnSnap.artifactId,
            entrypoint: "index.ts",
            code: artifactCode ?? new Uint8Array(),
          };

          const workerLimits: Limits = {
            cpuMs: targetFnSnap.limits.cpu_ms,
            timeoutMs: targetFnSnap.limits.timeout_ms,
            memoryMb: targetFnSnap.limits.memory_mb,
          };

          const workerReqId = generateUlid();
          const rawPayload = typeof message === "string"
            ? message
            : JSON.stringify(message);

          const invocation: InvocationRequest = {
            requestId: workerReqId,
            method: "POST",
            url: `https://internal.railfog/queues/${queueName}`,
            headers: {
              "x-railfog-trigger": "queue",
              "x-railfog-project": projectId,
              "x-railfog-function": targetFnName,
              "x-railfog-revision": targetFnSnap.revisionId,
              "x-railfog-org": options.orgId ?? "default-org",
              "x-request-id": workerReqId,
              "request-id": workerReqId,
              "content-type": "application/json",
            },
            body: new TextEncoder().encode(rawPayload),
          };

          const execStart = performance.now();
          const res = await options.isolationProvider.run(
            workerArtifact,
            workerLimits,
            invocation,
          );
          const duration = Math.round(performance.now() - execStart);

          recordLogEntry({
            timestamp: new Date().toISOString(),
            level: res.statusCode >= 400 ? "error" : "info",
            project: projectId,
            function: targetFnName,
            revision: targetFnSnap.revisionId,
            request_id: workerReqId,
            duration_ms: duration,
            message:
              `Queue worker [${targetFnName}] processed message for queue [${queueName}] -> ${res.statusCode} (${duration}ms)`,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[Queue Worker Failure]`, errMsg);
        }
      },
    );
  }

  // spec: contracts/platform.contract.md#PLAT-8 — Step 1: Load snapshot from disk cache if present (cold-start resilience)
  if (options.snapshotDiskCachePath) {
    try {
      const cachedText = await Deno.readTextFile(options.snapshotDiskCachePath);
      currentSnapshot = validateRoutingSnapshot(JSON.parse(cachedText));
      if (currentSnapshot) {
        projectSnapshots.set(options.projectId, currentSnapshot);
        syncCronSchedules(currentSnapshot, options.projectId);
      }
    } catch {
      // Non-fatal: disk cache absent or corrupt, proceed with initial fetch
    }
  }

  // spec: contracts/platform.contract.md#PLAT-8 — Helper to fetch and update snapshot for a given project
  const fetchSnapshotForProject = async (
    pId: string,
  ): Promise<RoutingSnapshot | null> => {
    if (!options.controlPlaneUrl) return null;
    try {
      const existing = pId === options.projectId
        ? currentSnapshot
        : projectSnapshots.get(pId);
      const headers: Record<string, string> = {};
      if (existing) {
        headers["if-none-match"] = `"${existing.version}"`;
      }
      const baseUrl = options.controlPlaneUrl.replace(/\/+$/, "");
      const snapshotUrl = `${baseUrl}/v1/projects/${
        encodeURIComponent(pId)
      }/snapshot`;
      const res = await fetch(snapshotUrl, { headers });
      if (isClosed) return null;

      if (res.status === 200) {
        const payload = await res.json();
        const validated = validateRoutingSnapshot(payload);
        if (!existing || validated.version > existing.version) {
          projectSnapshots.set(pId, validated);
          syncCronSchedules(validated, pId);
          if (pId === options.projectId) {
            currentSnapshot = validated;
            if (options.snapshotDiskCachePath) {
              await writeSnapshotDiskCache(
                options.snapshotDiskCachePath,
                validated,
              );
            }
          }
          return validated;
        }
      }
    } catch {
      // Fail-static: Control plane unreachable; proceed with cached snapshot
    }
    return null;
  };

  // spec: contracts/platform.contract.md#PLAT-8 — Discover and poll all active projects from control plane
  const pollControlPlane = async () => {
    if (isClosed) return;
    try {
      await fetchSnapshotForProject(options.projectId);

      if (options.controlPlaneUrl) {
        const baseUrl = options.controlPlaneUrl.replace(/\/+$/, "");
        const projectsUrl = `${baseUrl}/v1/projects`;
        try {
          const pRes = await fetch(projectsUrl);
          if (!isClosed && pRes.status === 200) {
            const data = (await pRes.json()) as { projects?: string[] };
            if (Array.isArray(data.projects)) {
              for (const p of data.projects) {
                if (p !== options.projectId) {
                  await fetchSnapshotForProject(p);
                }
              }
            }
          }
        } catch {
          // Fail-static
        }
      }
    } catch {
      // Fail-static
    }
  };

  // spec: contracts/platform.contract.md#PLAT-8 — Step 2: Initial snapshot fetch from control plane
  if (options.controlPlaneUrl) {
    await pollControlPlane();
  }

  // spec: contracts/platform.contract.md#PLAT-8 — Step 3: Background snapshot polling (~5s interval)
  if (options.controlPlaneUrl) {
    const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let isPolling = false;

    const runPoll = async () => {
      if (isClosed || isPolling) return;
      isPolling = true;
      try {
        await pollControlPlane();
      } finally {
        isPolling = false;
      }
    };

    timerId = setInterval(runPoll, pollInterval);
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

      // Direct object download / presigned retrieval
      if (url.pathname.startsWith("/local-fs/")) {
        const objPath = url.pathname.slice("/local-fs/".length);
        const iso = options.isolationProvider as unknown as {
          tempDir?: string;
        };
        const tempDir = iso?.tempDir;
        if (tempDir) {
          const filePath = `${tempDir}/objects/${
            options.orgId ?? "default-org"
          }/${options.projectId}/${objPath}`;
          try {
            const data = await Deno.readFile(filePath);
            return new Response(data, {
              status: 200,
              headers: {
                "content-type": "application/octet-stream",
                "x-request-id": requestId,
                "request-id": requestId,
              },
            });
          } catch {
            // fallback
          }
        }
        return createErrorResponse(
          404,
          "RESOURCE_NOT_FOUND",
          `Object not found: ${objPath}`,
          requestId,
        );
      }

      // Live structured logs endpoint
      const logsMatch = url.pathname.match(/^\/v1\/projects\/([^/]+)\/logs$/);
      if (
        logsMatch || url.pathname === "/logs" || url.pathname === "/v1/logs"
      ) {
        const targetProject = logsMatch
          ? decodeURIComponent(logsMatch[1])
          : (url.searchParams.get("project") ?? options.projectId);
        const limit = Math.min(
          1000,
          Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)),
        );
        const filterLevel = url.searchParams.get("level")?.toLowerCase();
        const filterFn = url.searchParams.get("function");

        let filtered = logEntries.filter(
          (l) =>
            !targetProject ||
            l.project === targetProject ||
            targetProject === "all",
        );
        if (filterFn) {
          filtered = filtered.filter((l) => l.function === filterFn);
        }
        if (filterLevel) {
          filtered = filtered.filter((l) => l.level === filterLevel);
        }
        const resultLogs = filtered.slice(-limit);
        return new Response(JSON.stringify(resultLogs), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
            "request-id": requestId,
          },
        });
      }

      // Proxy or handle Control Plane management endpoints (/login, /v1/*, /deploy, etc.)
      const isControlPlanePath = url.pathname === "/login" ||
        url.pathname.startsWith("/login/") ||
        url.pathname === "/deploy" ||
        url.pathname.startsWith("/deploy/") ||
        url.pathname === "/rollback" ||
        url.pathname.startsWith("/rollback/") ||
        url.pathname === "/export" ||
        url.pathname.startsWith("/export/") ||
        url.pathname === "/import" ||
        url.pathname.startsWith("/import/") ||
        url.pathname === "/v1" ||
        url.pathname.startsWith("/v1/");

      if (isControlPlanePath) {
        if (options.controlPlaneUrl) {
          const baseUrl = options.controlPlaneUrl.replace(/\/+$/, "");
          const targetUrl = new URL(`${baseUrl}${url.pathname}${url.search}`);
          const headers = new Headers(req.headers);
          headers.set("x-request-id", requestId);
          headers.set("request-id", requestId);
          return await fetch(targetUrl.toString(), {
            method: req.method,
            headers,
            body: req.body,
            redirect: "manual",
          });
        }

        return createErrorResponse(
          404,
          "RESOURCE_NOT_FOUND",
          `Endpoint ${url.pathname} is a Control Plane route. This instance is running railfog-runtime (Data Plane). Please route requests to railfog-control (Port 8081) or configure RAILFOG_CONTROL_URL.`,
          requestId,
        );
      }

      // spec: contracts/platform.contract.md#PLAT-9 — Token Bucket Rate Limiting (IP Scope)
      const clientIp = req.headers.get("cf-connecting-ip") ||
        req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
        "127.0.0.1";
      const ipDecision = rateLimiter.check("ip", clientIp);
      if (!ipDecision.allowed) {
        return new Response(
          JSON.stringify({
            error: {
              code: "RATE_LIMITED",
              message: "Rate limit exceeded. Please retry later.",
              request_id: requestId,
              retry_after: ipDecision.retryAfterSeconds ?? 1,
            },
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": String(ipDecision.retryAfterSeconds ?? 1),
              "x-ratelimit-limit": String(ipDecision.limit),
              "x-ratelimit-remaining": String(ipDecision.remaining),
              "x-request-id": requestId,
              "request-id": requestId,
            },
          },
        );
      }

      // spec: contracts/platform.contract.md#PLAT-9 — Token Bucket Rate Limiting (Identity Scope)
      const authHeader = req.headers.get("authorization");
      if (authHeader) {
        const idDecision = rateLimiter.check("identity", authHeader);
        if (!idDecision.allowed) {
          return new Response(
            JSON.stringify({
              error: {
                code: "RATE_LIMITED",
                message: "Rate limit exceeded for token. Please retry later.",
                request_id: requestId,
                retry_after: idDecision.retryAfterSeconds ?? 1,
              },
            }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": String(idDecision.retryAfterSeconds ?? 1),
                "x-ratelimit-limit": String(idDecision.limit),
                "x-ratelimit-remaining": String(idDecision.remaining),
                "x-request-id": requestId,
                "request-id": requestId,
              },
            },
          );
        }
      }

      // spec: contracts/platform.contract.md#PLAT-7, PLAT-8, PLAT-11, PLAT-15 — Multi-tenant project resolution
      let requestedProject = req.headers.get("x-railfog-project")?.trim();
      let lookupPath = url.pathname;

      // 1. Host resolution (custom domains or subdomains)
      const hostHeader = req.headers.get("host") || url.host;
      if (!requestedProject && hostHeader) {
        const hostname = hostHeader.split(":")[0].toLowerCase();
        // Check declared custom domains across snapshots
        for (const [pId, snap] of projectSnapshots.entries()) {
          if (
            snap.domains &&
            snap.domains.some((d) => d.toLowerCase() === hostname)
          ) {
            requestedProject = pId;
            break;
          }
        }
        if (!requestedProject) {
          const parts = hostname.split(".");
          if (parts.length >= 3) {
            const subdomain = parts[0].toLowerCase();
            if (
              projectSnapshots.has(subdomain) ||
              (currentSnapshot && options.projectId.toLowerCase() === subdomain)
            ) {
              requestedProject = subdomain;
            }
          }
        }
      }

      // 2. Path-prefix resolution with environment support: e.g. "/cloud-demo/api/hello" or "/cloud-demo/staging/api/hello"
      if (!requestedProject) {
        const candidateProjects = new Set<string>();
        if (options.projectId) candidateProjects.add(options.projectId);
        for (const p of projectSnapshots.keys()) candidateProjects.add(p);

        for (const pId of candidateProjects) {
          const prefixWithEnv = `/${pId}/`;
          if (url.pathname.startsWith(prefixWithEnv)) {
            const rest = url.pathname.slice(prefixWithEnv.length);
            const nextSlash = rest.indexOf("/");
            const firstSeg = nextSlash !== -1 ? rest.slice(0, nextSlash) : rest;
            if (
              firstSeg === "staging" || firstSeg === "production" ||
              firstSeg === "dev"
            ) {
              requestedProject = pId;
              lookupPath = nextSlash !== -1 ? rest.slice(nextSlash) : "/";
              break;
            }
          }

          if (
            url.pathname === `/${pId}` || url.pathname.startsWith(`/${pId}/`)
          ) {
            requestedProject = pId;
            lookupPath = url.pathname.slice(pId.length + 1) || "/";
            break;
          }
        }
      }

      let activeSnapshot: RoutingSnapshot | null = null;
      let winningRoute: { pattern: string; function: string } | null = null;
      let resolvedProjectId = options.projectId;

      if (requestedProject && projectSnapshots.has(requestedProject)) {
        const snap = projectSnapshots.get(requestedProject)!;
        const match = matchRoute(snap.routes, lookupPath);
        if (match) {
          activeSnapshot = snap;
          winningRoute = match;
          resolvedProjectId = requestedProject;
        }
      }

      if (
        !winningRoute && currentSnapshot && currentSnapshot.routes.length > 0
      ) {
        const match = matchRoute(currentSnapshot.routes, lookupPath);
        if (match) {
          activeSnapshot = currentSnapshot;
          winningRoute = match;
          resolvedProjectId = options.projectId;
        }
      }

      if (!winningRoute) {
        // Match against any discovered project snapshots
        for (const [pId, snap] of projectSnapshots.entries()) {
          const match = matchRoute(snap.routes, lookupPath);
          if (match) {
            activeSnapshot = snap;
            winningRoute = match;
            resolvedProjectId = pId;
            break;
          }
        }
      }

      if (!activeSnapshot || !winningRoute) {
        return createErrorResponse(
          404,
          "RESOURCE_NOT_FOUND",
          `No route matching path: ${url.pathname}`,
          requestId,
        );
      }

      // spec: contracts/platform.contract.md#PLAT-9 — Token Bucket Rate Limiting (Project Scope)
      const projectDecision = rateLimiter.check("project", resolvedProjectId);
      if (!projectDecision.allowed) {
        return new Response(
          JSON.stringify({
            error: {
              code: "RATE_LIMITED",
              message: "Rate limit exceeded for project. Please retry later.",
              request_id: requestId,
              retry_after: projectDecision.retryAfterSeconds ?? 1,
            },
          }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": String(projectDecision.retryAfterSeconds ?? 1),
              "x-ratelimit-limit": String(projectDecision.limit),
              "x-ratelimit-remaining": String(projectDecision.remaining),
              "x-request-id": requestId,
              "request-id": requestId,
            },
          },
        );
      }

      // spec: contracts/platform.contract.md#PLAT-8, PLAT-12 — Safe function metadata lookup (prototype pollution defense)
      const fnSnapshot = Object.hasOwn(
          activeSnapshot.functions,
          winningRoute.function,
        )
        ? activeSnapshot.functions[winningRoute.function]
        : undefined;

      if (!fnSnapshot) {
        return createErrorResponse(
          404,
          "RESOURCE_NOT_FOUND",
          `Function not found: ${winningRoute.function}`,
          requestId,
        );
      }

      // Declarative Authentication Gate: auth = "bearer"
      if (fnSnapshot.auth === "bearer") {
        const authHdr = req.headers.get("authorization");
        if (!authHdr || !authHdr.toLowerCase().startsWith("bearer ")) {
          return new Response(
            JSON.stringify({
              error: {
                code: "UNAUTHORIZED",
                message:
                  "Unauthorized: Missing or invalid Bearer authentication token",
                request_id: requestId,
              },
            }),
            {
              status: 401,
              headers: {
                "content-type": "application/json",
                "www-authenticate": 'Bearer realm="RailFog"',
                "x-request-id": requestId,
                "request-id": requestId,
              },
            },
          );
        }
      }

      // spec: contracts/objects.contract.md#OBJ-4, PLAT-4 — Load real artifact code bytes
      let artifactCode = artifactCache.get(fnSnapshot.artifactId);
      if (
        (!artifactCode || artifactCode.byteLength === 0) &&
        options.controlPlaneUrl
      ) {
        try {
          const baseUrl = options.controlPlaneUrl.replace(/\/+$/, "");
          const artUrl = `${baseUrl}/v1/artifacts/${
            encodeURIComponent(fnSnapshot.artifactId)
          }`;
          const artRes = await fetch(artUrl);
          if (artRes.status === 200) {
            artifactCode = new Uint8Array(await artRes.arrayBuffer());
            artifactCache.set(fnSnapshot.artifactId, artifactCode);
          }
        } catch {
          // Fallback to empty if fetch fails
        }
      }

      // spec: contracts/platform.contract.md#PLAT-4, PLAT-16 — Build deployment artifact descriptor
      const artifact: Artifact = {
        id: fnSnapshot.artifactId,
        integrity: fnSnapshot.artifactId,
        entrypoint: "index.ts",
        code: artifactCode ?? new Uint8Array(),
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
      invocationHeaders["x-railfog-project"] = resolvedProjectId;
      invocationHeaders["x-railfog-function"] = winningRoute.function;
      invocationHeaders["x-railfog-revision"] = fnSnapshot.revisionId;
      invocationHeaders["x-railfog-org"] = options.orgId ?? "default-org";

      // spec: contracts/functions.contract.md#FN-5 — Request body size limit (10MB default, reject with 413 PAYLOAD_TOO_LARGE)
      const maxRequestBodyBytes = 10 * 1024 * 1024;
      const contentLengthHeader = req.headers.get("content-length");
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength) && contentLength > maxRequestBodyBytes) {
          return createErrorResponse(
            413,
            "PAYLOAD_TOO_LARGE",
            `Request body exceeds maximum allowed size of ${maxRequestBodyBytes} bytes`,
            requestId,
          );
        }
      }

      // spec: contracts/functions.contract.md#FN-1 — Request body extraction
      let bodyBytes: Uint8Array | undefined;
      if (req.body) {
        bodyBytes = new Uint8Array(await req.arrayBuffer());
        if (bodyBytes.byteLength > maxRequestBodyBytes) {
          return createErrorResponse(
            413,
            "PAYLOAD_TOO_LARGE",
            `Request body exceeds maximum allowed size of ${maxRequestBodyBytes} bytes`,
            requestId,
          );
        }
      }

      // spec: contracts/platform.contract.md#PLAT-4, FN-6, FN-8 — Fresh InvocationRequest container
      const routedUrl = new URL(req.url);
      routedUrl.pathname = lookupPath;

      const invocation: InvocationRequest = {
        requestId,
        method: req.method,
        url: routedUrl.toString(),
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

      recordLogEntry({
        timestamp: new Date().toISOString(),
        level: result.statusCode >= 500
          ? "error"
          : result.statusCode >= 400
          ? "warn"
          : "info",
        project: resolvedProjectId,
        function: winningRoute.function,
        revision: fnSnapshot.revisionId,
        request_id: requestId,
        duration_ms: result.wallClockMs,
        message:
          `${req.method} ${lookupPath} -> ${result.statusCode} (${result.wallClockMs}ms)`,
      });

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
      recordLogEntry({
        timestamp: new Date().toISOString(),
        level: "error",
        project: options.projectId,
        function: "runtime",
        revision: "system",
        request_id: requestId,
        message: `INTERNAL: ${message}`,
      });
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
      for (const timer of cronTimers.values()) {
        clearInterval(timer);
      }
      cronTimers.clear();
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
      for (const timer of cronTimers.values()) {
        clearInterval(timer);
      }
      cronTimers.clear();
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
