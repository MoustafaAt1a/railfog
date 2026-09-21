/**
 * Local development server for RailFog (`rail dev`).
 *
 * Spec references:
 * - FN-8: Request lifecycle (route -> cached permissions -> isolate -> fresh ctx -> handler -> response + request_id)
 * - FN-6: Isolation & warm-reuse rule (separate context and scoped bindings per invocation)
 * - FN-4: Context structure
 * - PLAT-2: Everything is Trigger -> Function
 * - PLAT-11: Routing specificity algorithm
 * - PLAT-12: Error model (exhaustive codes, HTTPS + JSON, request_id in body & header)
 * - PLAT-14: ULID format for request_id
 * - PLAT-16: Provider abstraction
 * - PLAT-17: Local/production parity (zero cloud account, real SQLite & local filesystem providers)
 * - PLAT-19: Repository structure
 * - docs/contracts/worked-example.md: Canonical end-to-end /upload flow
 * - tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md
 */

import { isAbsolute, join, relative, toFileUrl } from "@std/path";
import { parse } from "@std/toml";
import { normalizeFunctions } from "../../cli/check.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";
import {
  InternalError,
  RailFogError,
  type RailFogErrorCode,
  ResourceNotFoundError,
  toErrorResponseBody,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import {
  type ResolvedBindings,
  resolvePermissions,
} from "../../packages/policy/permission-resolver.ts";
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type { QueueProvider } from "../../primitives/queues/queue-provider.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { SQLiteQueueProvider } from "../../providers/queues/sqlite-queue-provider.ts";
import {
  buildContext,
  type EnvBinding,
  type LoadedFunctionMeta,
  type RailFogContext,
} from "../loader/context-builder.ts";
import {
  matchRoute,
  type RouteConfig,
  specificityScore,
} from "../router/route-matcher.ts";
import { handleDashboardRequest } from "./dashboard.ts";
import { ProjectWatcher } from "./watcher.ts";

function isColorSupported(): boolean {
  try {
    const noColor = Deno.env.get("NO_COLOR");
    if (noColor !== undefined && noColor !== "") return false;
    const ci = Deno.env.get("CI");
    if (ci !== undefined && ci !== "" && ci !== "0" && ci !== "false") {
      return false;
    }
    return typeof Deno.stdout.isTerminal === "function" &&
      Deno.stdout.isTerminal();
  } catch {
    return false;
  }
}

export interface RequestLogLineInfo {
  requestId: string;
  method: string;
  pathname: string;
  status: number;
  durationMs: number;
}

// spec: docs/contracts/platform.contract.md#PLAT-14 — ULID request_id format
export function formatRequestLine(info: RequestLogLineInfo): string {
  const isColor = isColorSupported();
  if (!isColor) {
    return `[${info.requestId}] ${info.method} ${info.pathname} ${info.status} ${
      Math.round(info.durationMs)
    }ms`;
  }

  let methodColored = info.method;
  switch (info.method.toUpperCase()) {
    case "GET":
      methodColored = `\x1b[36m${info.method}\x1b[0m`;
      break;
    case "POST":
      methodColored = `\x1b[32m${info.method}\x1b[0m`;
      break;
    case "PUT":
    case "PATCH":
      methodColored = `\x1b[33m${info.method}\x1b[0m`;
      break;
    case "DELETE":
      methodColored = `\x1b[31m${info.method}\x1b[0m`;
      break;
  }

  let statusColored = `${info.status}`;
  if (info.status >= 200 && info.status < 300) {
    statusColored = `\x1b[32m${info.status}\x1b[0m`;
  } else if (info.status >= 300 && info.status < 400) {
    statusColored = `\x1b[36m${info.status}\x1b[0m`;
  } else if (info.status >= 400 && info.status < 500) {
    statusColored = `\x1b[33m${info.status}\x1b[0m`;
  } else if (info.status >= 500) {
    statusColored = `\x1b[31m${info.status}\x1b[0m`;
  }

  return `\x1b[2m[${info.requestId}]\x1b[0m ${methodColored} ${info.pathname} ${statusColored} \x1b[2m${
    Math.round(info.durationMs)
  }ms\x1b[0m`;
}

/**
 * Normalizes functions, permissions, and routes across both TOML schemas.
 */
export function normalizeProjectConfig(config: RailfogConfig): RailfogConfig {
  const normalized = { ...config };
  if (normalized.functions) {
    const fns = normalizeFunctions(normalized.functions);
    const projectEnv = config.env;
    const projectSecrets = Array.isArray(config.secrets)
      ? (config.secrets as string[])
      : [];
    const knownEnvKeys = [
      ...(projectEnv ? Object.keys(projectEnv) : []),
      ...projectSecrets,
    ];

    for (const fn of Object.values(fns)) {
      const anyFn = fn as Record<string, unknown>;
      if (!anyFn.permissions && anyFn.capabilities) {
        if (Array.isArray(anyFn.capabilities)) {
          const caps = anyFn.capabilities as unknown[];
          const synth: Record<string, string[]> = {};
          let hasEnvCap = false;
          for (const c of caps) {
            if (typeof c !== "string") continue;
            const lower = c.toLowerCase().trim();
            if (lower.startsWith("kv") || lower === "kv") {
              synth.kv = synth.kv ?? ["default"];
            } else if (
              lower.startsWith("object") || lower.startsWith("s3") ||
              lower === "objects"
            ) {
              synth.objects = synth.objects ?? ["default"];
            } else if (lower.startsWith("queue") || lower === "queues") {
              synth.queues = synth.queues ?? ["default"];
            } else if (
              lower === "env" || lower === "secrets" ||
              lower.startsWith("env:") || lower.startsWith("secret:") ||
              lower.startsWith("secrets:")
            ) {
              hasEnvCap = true;
              if (lower.includes(":")) {
                const sec = c.slice(c.indexOf(":") + 1).trim();
                if (sec) {
                  synth.secrets = synth.secrets ?? [];
                  if (!synth.secrets.includes(sec)) synth.secrets.push(sec);
                }
              }
            }
          }
          if (hasEnvCap) {
            synth.secrets = synth.secrets ?? [];
            for (const k of knownEnvKeys) {
              if (!synth.secrets.includes(k)) synth.secrets.push(k);
            }
          }
          anyFn.permissions = synth;
        } else if (
          typeof anyFn.capabilities === "object" &&
          anyFn.capabilities !== null && !Array.isArray(anyFn.capabilities)
        ) {
          anyFn.permissions = anyFn.capabilities;
        }
      }
    }
    normalized.functions = fns as unknown as Record<string, FunctionConfig>;
  }
  return normalized;
}

/**
 * Normalizes routes from top-level routes array and per-function routes/route declarations.
 */
export function normalizeRoutes(config: RailfogConfig): RouteConfig[] {
  const result: RouteConfig[] = [];
  if (Array.isArray(config.routes)) {
    for (const r of config.routes) {
      if (r && r.pattern && r.function) {
        result.push({ pattern: r.pattern, function: r.function });
      }
    }
  }
  if (config.functions) {
    const fns = normalizeFunctions(config.functions);
    for (const [fnName, fnConfig] of Object.entries(fns)) {
      const anyFn = fnConfig as Record<string, unknown>;
      if (Array.isArray(anyFn.routes)) {
        for (const p of anyFn.routes) {
          if (typeof p === "string") {
            result.push({ pattern: p, function: fnName });
          } else if (typeof p === "object" && p !== null) {
            const r = p as Record<string, unknown>;
            if (typeof r.pattern === "string") {
              result.push({
                pattern: r.pattern,
                function: (r.function as string) ?? fnName,
              });
            }
          }
        }
      } else if (typeof anyFn.routes === "string") {
        result.push({ pattern: anyFn.routes, function: fnName });
      }
      if (typeof anyFn.route === "string") {
        result.push({ pattern: anyFn.route, function: fnName });
      }
    }
  }
  return result;
}

// spec: docs/contracts/platform.contract.md#PLAT-11 — Specificity algorithm
// spec: docs/contracts/platform.contract.md#PLAT-17 — Local SQLite and LocalFS providers
// spec: tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md AC2
export function formatStartupBanner(
  config: RailfogConfig,
  port: number,
  options?: LocalServerOptions,
): string {
  const host = options?.host ?? "localhost";
  const lines: string[] = [
    "================================================================================",
    ` [RailFog Dev Server]  http://${host}:${port}`,
    ` Dashboard on http://${host}:${port}/__railfog`,
    "================================================================================",
    "",
    "Local providers (PLAT-17 parity):",
    "  |-- KV & Queues: SQLite",
    "  \\-- Objects:     LocalFS",
    "",
    "Routes:",
  ];

  const routes = normalizeRoutes(config);
  if (routes.length === 0) {
    lines.push("  (no routes configured)");
  } else {
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      const isLast = i === routes.length - 1;
      const branch = isLast ? "\\-- " : "|-- ";
      const score = specificityScore(route.pattern);
      lines.push(
        `  ${branch}${route.pattern.padEnd(20)} -> ${
          route.function.padEnd(16)
        } (score: ${score})`,
      );
    }
  }

  lines.push("");
  lines.push(
    "--------------------------------------------------------------------------------",
  );
  lines.push(
    "Ready for requests. [b] browser  [d] dashboard  [c] clear  [q] quit",
  );
  lines.push(
    "================================================================================",
  );

  return lines.join("\n");
}

export interface LocalServerOptions {
  cwd?: string;
  host?: string;
  orgId?: string;
  projectId?: string;
  providers?: {
    kv?: KVProvider;
    objects?: ObjectProvider;
    queues?: QueueProvider;
  };
  watch?: boolean;
  debounceMs?: number;
  signal?: AbortSignal;
  onReload?: (path: string) => void;
  logRequests?: boolean;
}

export interface LocalServer {
  port: number;
  close(): Promise<void>;
}

export interface RailfogConfig {
  name: string;
  env?: Record<string, string>;
  secrets?: string[] | Record<string, string>;
  functions?: Record<string, {
    entry?: string;
    triggers?: { queue?: string; schedule?: string };
    permissions?: {
      kv?: string[];
      objects?: string[];
      queues?: string[];
      network?: string[];
      secrets?: string[];
    };
    timeout_ms?: number;
    timeoutMs?: number;
  }>;
  routes?: Array<{
    pattern: string;
    function: string;
  }>;
}

export type FunctionConfig = NonNullable<RailfogConfig["functions"]>[string];

const DEFAULT_PORT = 8000;
const DEFAULT_ORG_ID = "local-org";
const DEFAULT_REVISION = "local-dev";

// spec: docs/contracts/platform.contract.md#PLAT-12 — HTTP status mapping for PLAT-12 error taxonomy
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
 * Starts the local development HTTP server implementing the complete FN-8 lifecycle.
 * Spec-anchor: docs/contracts/functions.contract.md FN-8
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-17
 * Spec-anchor: tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md
 */
export async function startLocalServer(
  config: RailfogConfig,
  port?: number,
  options?: LocalServerOptions,
): Promise<LocalServer> {
  const cwd = options?.cwd ?? Deno.cwd();
  const orgId = options?.orgId ?? DEFAULT_ORG_ID;
  const projectId = options?.projectId ?? config.name ?? "local-project";
  const listenPort = port ?? DEFAULT_PORT;
  const host = options?.host;

  // spec: docs/contracts/platform.contract.md#PLAT-16 and #PLAT-17 (Local providers with full API parity)
  const ownsKv = !options?.providers?.kv;
  const ownsQueues = !options?.providers?.queues;
  const kvProvider = options?.providers?.kv ?? new SQLiteKVProvider();
  const objectsProvider = options?.providers?.objects ??
    new LocalFSProvider(join(cwd, ".railfog", "objects"));
  const queuesProvider = options?.providers?.queues ??
    new SQLiteQueueProvider();

  let currentConfig = normalizeProjectConfig(config);
  let routes: RouteConfig[] = normalizeRoutes(currentConfig);

  // spec: docs/contracts/functions.contract.md#FN-8 — Pre-resolve permission snapshot at server startup
  const cachedPermissions = new Map<string, ResolvedBindings>();
  const updateCachedPermissions = (cfg: RailfogConfig) => {
    cachedPermissions.clear();
    for (const [fnName, fnConfig] of Object.entries(cfg.functions ?? {})) {
      const anyFn = fnConfig as Record<string, unknown>;
      let permissions = fnConfig.permissions;
      if (!permissions && anyFn.capabilities) {
        if (Array.isArray(anyFn.capabilities)) {
          const caps = anyFn.capabilities as unknown[];
          const synth: {
            kv?: string[];
            objects?: string[];
            queues?: string[];
          } = {};
          for (const c of caps) {
            if (typeof c !== "string") continue;
            const lower = c.toLowerCase().trim();
            if (lower.startsWith("kv")) synth.kv = ["default"];
            if (lower.startsWith("object") || lower.startsWith("s3")) {
              synth.objects = ["default"];
            }
            if (lower.startsWith("queue")) synth.queues = ["default"];
          }
          permissions = synth;
        } else if (
          typeof anyFn.capabilities === "object" && anyFn.capabilities !== null
        ) {
          permissions = anyFn.capabilities as typeof fnConfig.permissions;
        }
      }
      const declared = {
        kv: permissions?.kv,
        objects: permissions?.objects,
        queues: permissions?.queues,
      };
      const resolved = resolvePermissions(declared, orgId, projectId, {
        kv: kvProvider,
        objects: objectsProvider,
        queues: queuesProvider,
      });
      cachedPermissions.set(fnName, resolved);
    }
  };
  updateCachedPermissions(currentConfig);

  // Hot reload & module caching state
  // spec: docs/contracts/functions.contract.md#FN-1, #FN-3, #FN-6
  let revCounter = 0;
  const loadedModules = new Map<
    string,
    { handler: (req: Request, ctx: RailFogContext) => Promise<Response> }
  >();

  // spec: docs/contracts/functions.contract.md#FN-8 — Per-request hot path handler
  const handler = async (req: Request): Promise<Response> => {
    const startTime = performance.now();
    const url = new URL(req.url);
    let finalRequestId = "";
    let finalStatus = 200;

    const logCompletedRequest = () => {
      if (options?.logRequests ?? true) {
        const durationMs = performance.now() - startTime;
        console.log(formatRequestLine({
          requestId: finalRequestId || "00000000000000000000000000",
          method: req.method,
          pathname: url.pathname,
          status: finalStatus,
          durationMs,
        }));
      }
    };

    // Embedded Local Dev Dashboard (PLAT-17 / PLAT-19)
    if (
      url.pathname === "/__railfog" || url.pathname.startsWith("/__railfog/")
    ) {
      finalRequestId = generateUlid();
      try {
        const dashRes = await handleDashboardRequest(req, url, currentConfig, {
          orgId,
          projectId,
          kvProvider,
          objectsProvider,
          queuesProvider,
          routes,
        });
        finalStatus = dashRes.status;
        logCompletedRequest();
        return dashRes;
      } catch (err) {
        console.error(`[${finalRequestId}] Dashboard error:`, err);
        finalStatus = 500;
        const internalErr = new InternalError(
          err instanceof Error ? err.message : String(err),
          finalRequestId,
        );
        const res = Response.json(toErrorResponseBody(internalErr), {
          status: 500,
          headers: {
            "content-type": "application/json",
            "x-request-id": finalRequestId,
            "request-id": finalRequestId,
          },
        });
        logCompletedRequest();
        return res;
      }
    }

    // spec: docs/contracts/platform.contract.md#PLAT-11 — Route matching with specificity score
    const matchedRoute = matchRoute(routes, url.pathname);
    if (!matchedRoute) {
      // spec: docs/contracts/platform.contract.md#PLAT-12, #PLAT-14 — RESOURCE_NOT_FOUND error shape
      const requestId = generateUlid();
      finalRequestId = requestId;
      finalStatus = 404;
      const notFoundErr = new ResourceNotFoundError(
        `No route matched path: ${url.pathname}`,
        requestId,
      );
      const res = Response.json(toErrorResponseBody(notFoundErr), {
        status: 404,
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
          "request-id": requestId,
        },
      });
      logCompletedRequest();
      return res;
    }

    const fnConfig = currentConfig.functions?.[matchedRoute.function];
    if (!fnConfig) {
      const requestId = generateUlid();
      finalRequestId = requestId;
      finalStatus = 404;
      const notFoundErr = new ResourceNotFoundError(
        `Function '${matchedRoute.function}' not found in configuration`,
        requestId,
      );
      const res = Response.json(toErrorResponseBody(notFoundErr), {
        status: 404,
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
          "request-id": requestId,
        },
      });
      logCompletedRequest();
      return res;
    }

    // spec: docs/contracts/functions.contract.md#FN-8 — Load cached permission snapshot
    let resolvedBindings = cachedPermissions.get(matchedRoute.function);
    if (!resolvedBindings) {
      resolvedBindings = resolvePermissions(
        {
          kv: fnConfig.permissions?.kv,
          objects: fnConfig.permissions?.objects,
          queues: fnConfig.permissions?.queues,
        },
        orgId,
        projectId,
        {
          kv: kvProvider,
          objects: objectsProvider,
          queues: queuesProvider,
        },
      );
      cachedPermissions.set(matchedRoute.function, resolvedBindings);
    }

    // spec: docs/contracts/functions.contract.md#FN-1, #FN-3, #FN-6 — Load function into isolate
    const anyFn = fnConfig as Record<string, unknown>;
    const rawEntry = fnConfig.entry ??
      (anyFn.entrypoint as string | undefined) ??
      `functions/${matchedRoute.function}.ts`;
    let entry = rawEntry;
    let resolvedEntry = isAbsolute(entry) ? entry : join(cwd, entry);

    let statFound = false;
    try {
      if ((await Deno.stat(resolvedEntry)).isFile) {
        statFound = true;
      }
    } catch {
      // not found directly
    }

    if (!statFound && !isAbsolute(entry)) {
      const fallback = join(cwd, "functions", entry);
      try {
        if ((await Deno.stat(fallback)).isFile) {
          resolvedEntry = fallback;
          entry = join("functions", entry);
        }
      } catch {
        // fallback not found either
      }
    }

    let loadedFn = loadedModules.get(resolvedEntry);
    if (!loadedFn) {
      try {
        try {
          await Deno.stat(resolvedEntry);
        } catch {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Function file not found: " + entry,
          );
        }
        const importUrl = toFileUrl(resolvedEntry).href + `?v=${revCounter}`;
        const mod = await import(importUrl);
        if (!mod || typeof mod.default !== "function") {
          throw new ValidationFailedError(
            "VALIDATION_FAILED: Function module must export a default handler function",
          );
        }
        loadedFn = { handler: mod.default };
        loadedModules.set(resolvedEntry, loadedFn);
      } catch (err) {
        const requestId = generateUlid();
        finalRequestId = requestId;
        if (err instanceof RailFogError) {
          finalStatus = statusFromErrorCode(err.code);
          const errorWithId = err.requestId
            ? err
            : Object.assign(err, { requestId });
          const res = Response.json(toErrorResponseBody(errorWithId), {
            status: finalStatus,
            headers: {
              "content-type": "application/json",
              "x-request-id": requestId,
              "request-id": requestId,
            },
          });
          logCompletedRequest();
          return res;
        }
        finalStatus = 500;
        const internalErr = new InternalError(
          err instanceof Error ? err.message : String(err),
          requestId,
        );
        const body = toErrorResponseBody(internalErr);
        if (err instanceof Error) {
          (body.error as Record<string, unknown>).stack = err.stack;
          (body.error as Record<string, unknown>).details = err.message;
        }
        const res = Response.json(body, {
          status: 500,
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
            "request-id": requestId,
          },
        });
        logCompletedRequest();
        return res;
      }
    }

    // spec: docs/contracts/functions.contract.md#FN-4, #FN-6 — Inject fresh context and scoped bindings per invocation
    const fnMeta: LoadedFunctionMeta = {
      project: projectId,
      function: matchedRoute.function,
      revision: DEFAULT_REVISION,
      timeout_ms: fnConfig.timeout_ms ?? fnConfig.timeoutMs,
    };
    const configEnv = currentConfig.env;
    const envBinding: EnvBinding = {
      get(key: string): string | undefined {
        if (configEnv && key in configEnv) {
          return String(configEnv[key]);
        }
        return Deno.env.get(key);
      },
    };
    const ctx = buildContext(fnMeta, resolvedBindings, envBinding);
    finalRequestId = ctx.requestId;

    // spec: docs/contracts/functions.contract.md#FN-8 — Invoke handler and catch errors
    let response: Response;
    try {
      response = await loadedFn.handler(req, ctx);
      finalStatus = response.status;
    } catch (err) {
      if (err instanceof RailFogError) {
        finalStatus = statusFromErrorCode(err.code);
        const errorWithId = err.requestId
          ? err
          : Object.assign(err, { requestId: ctx.requestId });
        const res = Response.json(toErrorResponseBody(errorWithId), {
          status: finalStatus,
          headers: {
            "content-type": "application/json",
            "x-request-id": ctx.requestId,
            "request-id": ctx.requestId,
          },
        });
        logCompletedRequest();
        return res;
      }
      // spec: docs/contracts/platform.contract.md#PLAT-12, AC3 — Actionable stack trace in dev mode
      console.error(`[${ctx.requestId}] Unhandled function error:`, err);
      finalStatus = 500;
      const internalErr = new InternalError(
        err instanceof Error ? err.message : String(err),
        ctx.requestId,
      );
      const body = toErrorResponseBody(internalErr);
      if (err instanceof Error) {
        (body.error as Record<string, unknown>).stack = err.stack;
        (body.error as Record<string, unknown>).details = err.message;
      }
      const res = Response.json(body, {
        status: 500,
        headers: {
          "content-type": "application/json",
          "x-request-id": ctx.requestId,
          "request-id": ctx.requestId,
        },
      });
      logCompletedRequest();
      return res;
    }

    // spec: docs/contracts/functions.contract.md#FN-8, PLAT-12, PLAT-14 — Attach request_id header to response
    try {
      response.headers.set("x-request-id", ctx.requestId);
      response.headers.set("request-id", ctx.requestId);
    } catch {
      const headers = new Headers(response.headers);
      headers.set("x-request-id", ctx.requestId);
      headers.set("request-id", ctx.requestId);
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    logCompletedRequest();
    return response;
  };

  let assignedPort = listenPort;
  const server = Deno.serve(
    {
      port: listenPort,
      ...(host ? { hostname: host } : {}),
      onListen({ port }) {
        assignedPort = port;
      },
    },
    handler,
  );

  if (server.addr && "port" in server.addr) {
    assignedPort = server.addr.port;
  }

  // Startup banner per AC2, PLAT-11, PLAT-17
  const banner = formatStartupBanner(currentConfig, assignedPort, options);
  if (options?.logRequests !== false) {
    console.log(banner);
  }

  // File watcher setup (AC1, AC4, AC5)
  let watcher: ProjectWatcher | null = null;
  const watchEnabled = options?.watch !== false;

  if (watchEnabled) {
    const tomlPath = join(cwd, "railfog.toml");
    const functionsDir = join(cwd, "functions");

    const watchPaths: string[] = [];
    try {
      const stat = await Deno.stat(tomlPath);
      if (stat.isFile) watchPaths.push(tomlPath);
    } catch {
      // toml does not exist yet
    }
    try {
      const stat = await Deno.stat(functionsDir);
      if (stat.isDirectory) watchPaths.push(functionsDir);
    } catch {
      // functions dir does not exist yet
    }
    if (watchPaths.length === 0) {
      try {
        const stat = await Deno.stat(cwd);
        if (stat.isDirectory) watchPaths.push(cwd);
      } catch {
        // cwd not accessible
      }
    }

    if (watchPaths.length > 0) {
      watcher = new ProjectWatcher({
        paths: watchPaths,
        debounceMs: options?.debounceMs ?? 100,
        signal: options?.signal,
      });

      await watcher.start(async (events) => {
        let tomlChanged = false;
        const changedFunctions = new Set<string>();

        for (const event of events) {
          if (
            event.path.endsWith("railfog.toml") ||
            event.path.includes("railfog.toml")
          ) {
            tomlChanged = true;
          }
          if (
            event.path.includes("functions") ||
            event.path.endsWith(".ts") ||
            event.path.endsWith(".js")
          ) {
            changedFunctions.add(event.path);
          }
        }

        if (tomlChanged) {
          try {
            const tomlContent = await Deno.readTextFile(tomlPath);
            currentConfig = normalizeProjectConfig(
              parse(tomlContent) as unknown as RailfogConfig,
            );
            routes = normalizeRoutes(currentConfig);
            updateCachedPermissions(currentConfig);
            console.log("Reloaded railfog.toml");
          } catch (err) {
            console.error("Failed to reload railfog.toml:", err);
          }
        }

        if (changedFunctions.size > 0) {
          revCounter++;
          loadedModules.clear();
          for (const fnPath of changedFunctions) {
            const relPath = relative(cwd, fnPath).replace(/\\/g, "/");
            console.log(`Reloaded ${relPath}`);
            options?.onReload?.(fnPath);
          }
        }
      });
    }
  }

  const localServer: LocalServer = {
    get port(): number {
      return (server.addr as Deno.NetAddr)?.port ?? assignedPort;
    },
    async close(): Promise<void> {
      watcher?.stop();
      await server.shutdown();
      if (
        ownsKv && "close" in kvProvider &&
        typeof (kvProvider as { close?: () => void }).close === "function"
      ) {
        try {
          (kvProvider as { close: () => void }).close();
        } catch {
          // Ignore if already closed
        }
      }
      if (
        ownsQueues && "close" in queuesProvider &&
        typeof (queuesProvider as { close?: () => void }).close === "function"
      ) {
        try {
          (queuesProvider as { close: () => void }).close();
        } catch {
          // Ignore if already closed
        }
      }
    },
  };

  if (options?.signal) {
    options.signal.addEventListener("abort", () => {
      localServer.close();
    }, { once: true });
  }

  return localServer;
}

// spec: contracts/platform.contract.md#PLAT-1 — Container entrypoint fallback
if (import.meta.main) {
  const isProd = Deno.env.get("DENO_ENV") === "production" ||
    !!Deno.env.get("RAILFOG_CONTROL_URL");
  if (isProd) {
    const { startRuntimeServer } = await import(
      "../../apps/runtime/runtime-server.ts"
    );
    const { LocalIsolationProvider } = await import(
      "../sandbox/local-isolation.ts"
    );
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
  } else {
    const port = parseInt(Deno.env.get("PORT") || "8000", 10);
    const host = Deno.env.get("HOST") || "127.0.0.1";
    const config: RailfogConfig = { name: "railfog", routes: [] };
    await startLocalServer(config, port, { host });
  }
}
