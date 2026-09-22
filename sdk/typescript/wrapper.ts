// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: sdk/typescript
// spec: contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
// spec: contracts/functions.contract.md#FN-4 — RailFogContext structure and capability bindings
// spec: contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm
// spec: contracts/platform.contract.md#PLAT-12 — Error model and canonical error responses
// spec: contracts/platform.contract.md#PLAT-15 — Capability-scoped secret access via c.env

import type {
  ConsumerOptions,
  ContextLogger,
  CookieOptions,
  FunctionHandler,
  QueueConsumerHandler,
  QueueMessage,
  RailFogContext,
  SchemaValidator,
  StandardSchemaV1,
} from "./types.ts";
import {
  type RailFogErrorCode,
  ResourceNotFoundError,
  toErrorResponseBody,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import { normalizeError } from "./client.ts";
import { withIdempotency } from "./helpers.ts";

/**
 * Stream writer interface for chunked and streaming HTTP responses.
 */
export interface StreamWriter {
  write(chunk: Uint8Array | string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Server-Sent Events (SSE) event shape.
 */
export interface SseEvent {
  data: unknown;
  event?: string;
  id?: string;
  retry?: number;
}

/**
 * Server-Sent Events (SSE) writer interface.
 */
export interface SseWriter {
  send(event: SseEvent): Promise<void>;
  close(): Promise<void>;
}

/**
 * Augmented context provided to ergonomic function handlers.
 * Extends RailFogContext with convenient request accessors and response builders.
 *
 * @spec contracts/functions.contract.md#FN-4 — RailFogContext structure and capability bindings
 * @spec contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
 */
export interface HandlerContext extends RailFogContext {
  req: Request;
  url: URL;
  query: Record<string, string | undefined>;
  params?: Record<string, string | undefined>;
  log: ContextLogger;
  cookies: Readonly<Record<string, string>>;
  cookie(name: string): string | undefined;
  setCookie(name: string, value: string, options?: CookieOptions): void;
  clearCookie(name: string, options?: CookieOptions): void;
  header(name: string): string | null;
  body<T = unknown>(validator?: SchemaValidator<T>): Promise<T>;
  json(data: unknown, status?: number): Response;
  text(str: string, status?: number): Response;
  html(htmlStr: string, status?: number): Response;
  redirect(location: string, status?: number): Response;
  notFound(message?: string): never;
  badRequest(message?: string): never;
  fail(error: unknown): never;
  stream(
    fn: (writer: StreamWriter) => Promise<void> | void,
    options?: { status?: number; headers?: HeadersInit },
  ): Response;
  sse(
    fn: (sse: SseWriter) => Promise<void> | void,
    options?: { status?: number; headers?: HeadersInit },
  ): Response;
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
  const railFogError = normalizeError(err, defaultRequestId);
  const requestId = railFogError.requestId ?? defaultRequestId;
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

    const parsedUrl = new URL(req.url, "http://railfog.internal");
    const queryParams: Record<string, string | undefined> = {};
    for (const [k, v] of parsedUrl.searchParams.entries()) {
      queryParams[k] = v;
    }

    const logPrefix = `[${ctx.requestId}][${ctx.function}]`;
    const formatLog = (msg: string, meta?: unknown): string => {
      if (meta === undefined) return `${logPrefix} ${msg}`;
      try {
        return `${logPrefix} ${msg} ${
          typeof meta === "object" && meta !== null
            ? JSON.stringify(meta)
            : String(meta)
        }`;
      } catch {
        return `${logPrefix} ${msg} [unserializable metadata]`;
      }
    };

    const log: ContextLogger = {
      debug: (msg, meta) => console.debug(formatLog(msg, meta)),
      info: (msg, meta) => console.info(formatLog(msg, meta)),
      warn: (msg, meta) => console.warn(formatLog(msg, meta)),
      error: (msg, meta) => console.error(formatLog(msg, meta)),
    };

    const outgoingCookies: string[] = [];
    const cookieHeader = req.headers.get("cookie");
    const parsedCookies: Record<string, string> = {};
    if (cookieHeader) {
      const parts = cookieHeader.split(";");
      for (const part of parts) {
        const eqIdx = part.indexOf("=");
        if (eqIdx !== -1) {
          const name = part.slice(0, eqIdx).trim();
          const val = part.slice(eqIdx + 1).trim();
          if (name) {
            try {
              parsedCookies[name] = decodeURIComponent(val);
            } catch {
              parsedCookies[name] = val;
            }
          }
        }
      }
    }

    // spec: contracts/functions.contract.md#FN-4 — Capability and context injection
    const c: HandlerContext = {
      ...ctx,
      timeRemaining: () => ctx.timeRemaining(),
      req,
      url: parsedUrl,
      query: queryParams,
      log,
      cookies: parsedCookies,
      cookie(name: string): string | undefined {
        return parsedCookies[name];
      },
      header(name: string): string | null {
        return req.headers.get(name);
      },
      setCookie(name: string, value: string, options?: CookieOptions): void {
        let cookieStr = `${encodeURIComponent(name)}=${
          encodeURIComponent(value)
        }`;
        if (options?.maxAge !== undefined) {
          cookieStr += `; Max-Age=${Math.floor(options.maxAge)}`;
        }
        if (options?.expires) {
          cookieStr += `; Expires=${options.expires.toUTCString()}`;
        }
        if (options?.domain) {
          cookieStr += `; Domain=${options.domain}`;
        }
        cookieStr += `; Path=${options?.path ?? "/"}`;
        if (options?.secure) {
          cookieStr += `; Secure`;
        }
        if (options?.httpOnly) {
          cookieStr += `; HttpOnly`;
        }
        if (options?.sameSite) {
          const s = options.sameSite.charAt(0).toUpperCase() +
            options.sameSite.slice(1).toLowerCase();
          cookieStr += `; SameSite=${s}`;
        }
        outgoingCookies.push(cookieStr);
      },
      clearCookie(name: string, options?: CookieOptions): void {
        this.setCookie(name, "", {
          ...options,
          maxAge: 0,
          expires: new Date(0),
        });
      },
      async body<T = unknown>(validator?: SchemaValidator<T>): Promise<T> {
        if (!bodyParsed) {
          try {
            parsedBody = await req.json();
          } catch (err) {
            throw new ValidationFailedError(
              `Malformed JSON request body: ${
                err instanceof Error ? err.message : String(err)
              }`,
              ctx.requestId,
            );
          }
          bodyParsed = true;
        }

        if (!validator) {
          return parsedBody as T;
        }

        // 1. Standard Schema specification (~standard)
        if (
          typeof validator === "object" &&
          validator !== null &&
          "~standard" in validator
        ) {
          const standardSchema = validator as StandardSchemaV1<unknown, T>;
          const result = await standardSchema["~standard"].validate(parsedBody);
          if (result.issues) {
            const formatted = result.issues
              .map((issue) => {
                const pathStr = issue.path
                  ? issue.path
                    .map((p) =>
                      typeof p === "object" && p !== null
                        ? String((p as { key: PropertyKey }).key)
                        : String(p)
                    )
                    .join(".")
                  : "";
                return pathStr ? `${pathStr}: ${issue.message}` : issue.message;
              })
              .join("; ");
            throw new ValidationFailedError(
              `Validation failed: ${formatted}`,
              ctx.requestId,
            );
          }
          return result.value;
        }

        // 2. safeParse / safeParseAsync duck-typing (Zod / Valibot)
        if (typeof validator === "object" && validator !== null) {
          const obj = validator as Record<string, unknown>;
          if (typeof obj.safeParseAsync === "function") {
            const res =
              await (obj.safeParseAsync as (data: unknown) => Promise<{
                success: boolean;
                data?: T;
                error?: unknown;
              }>)(parsedBody);
            if (!res.success) {
              const errObj = res.error as { message?: string } | undefined;
              const msg = errObj?.message
                ? String(errObj.message)
                : String(res.error);
              throw new ValidationFailedError(
                `Validation failed: ${msg}`,
                ctx.requestId,
              );
            }
            return res.data as T;
          }
          if (typeof obj.safeParse === "function") {
            const res = (obj.safeParse as (data: unknown) => {
              success: boolean;
              data?: T;
              error?: unknown;
            })(parsedBody);
            if (!res.success) {
              const errObj = res.error as { message?: string } | undefined;
              const msg = errObj?.message
                ? String(errObj.message)
                : String(res.error);
              throw new ValidationFailedError(
                `Validation failed: ${msg}`,
                ctx.requestId,
              );
            }
            return res.data as T;
          }
        }

        // 3. Custom validator function / type assertion
        if (typeof validator === "function") {
          try {
            return await validator(parsedBody);
          } catch (err) {
            throw new ValidationFailedError(
              `Validation failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
              ctx.requestId,
            );
          }
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
      html(htmlStr: string, status = 200): Response {
        return new Response(htmlStr, {
          status,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
      redirect(location: string, status = 302): Response {
        return new Response(null, {
          status,
          headers: { location },
        });
      },
      notFound(message = "Resource not found"): never {
        throw new ResourceNotFoundError(message, ctx.requestId);
      },
      badRequest(message = "Validation failed"): never {
        throw new ValidationFailedError(message, ctx.requestId);
      },
      fail(error: unknown): never {
        throw normalizeError(error, ctx.requestId);
      },
      stream(
        fn: (writer: StreamWriter) => Promise<void> | void,
        options?: { status?: number; headers?: HeadersInit },
      ): Response {
        const transform = new TransformStream<Uint8Array, Uint8Array>();
        const sink = transform.writable.getWriter();
        const encoder = new TextEncoder();

        const writer: StreamWriter = {
          async write(chunk: Uint8Array | string) {
            const bytes = typeof chunk === "string"
              ? encoder.encode(chunk)
              : chunk;
            await sink.write(bytes);
          },
          async close() {
            try {
              await sink.close();
            } catch {
              // ignore if already closed
            }
          },
        };

        (async () => {
          try {
            await fn(writer);
          } catch (err) {
            const isAbort = (err as Error)?.name === "AbortError";
            if (!isAbort) {
              console.error("Stream producer error:", err);
            }
            try {
              await sink.abort(err);
            } catch {
              // ignore
            }
            return;
          }
          try {
            await sink.close();
          } catch {
            // already closed
          }
        })();

        const headers = new Headers(options?.headers);
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/octet-stream");
        }
        return new Response(transform.readable, {
          status: options?.status ?? 200,
          headers,
        });
      },
      sse(
        fn: (sse: SseWriter) => Promise<void> | void,
        options?: { status?: number; headers?: HeadersInit },
      ): Response {
        const transform = new TransformStream<Uint8Array, Uint8Array>();
        const sink = transform.writable.getWriter();
        const encoder = new TextEncoder();

        const sseWriter: SseWriter = {
          async send(event: SseEvent) {
            let payload = "";
            if (event.id !== undefined) payload += `id: ${event.id}\n`;
            if (event.event !== undefined) payload += `event: ${event.event}\n`;
            if (event.retry !== undefined) payload += `retry: ${event.retry}\n`;
            const dataStr = event.data === undefined
              ? ""
              : typeof event.data === "string"
              ? event.data
              : JSON.stringify(event.data);
            for (const line of dataStr.split(/\r?\n/)) {
              payload += `data: ${line}\n`;
            }
            payload += "\n";
            await sink.write(encoder.encode(payload));
          },
          async close() {
            try {
              await sink.close();
            } catch {
              // ignore if already closed
            }
          },
        };

        (async () => {
          try {
            await fn(sseWriter);
          } catch (err) {
            const isAbort = (err as Error)?.name === "AbortError";
            if (!isAbort) {
              console.error("SSE producer error:", err);
            }
            try {
              await sink.abort(err);
            } catch {
              // ignore
            }
            return;
          }
          try {
            await sink.close();
          } catch {
            // already closed
          }
        })();

        const headers = new Headers(options?.headers);
        headers.set("content-type", "text/event-stream");
        headers.set("cache-control", "no-cache");
        headers.set("connection", "keep-alive");

        return new Response(transform.readable, {
          status: options?.status ?? 200,
          headers,
        });
      },
    };

    try {
      const result = await fn(c);
      let finalResponse: Response;
      // spec: contracts/functions.contract.md#FN-1 — Verbatim Web API Response passthrough
      if (result instanceof Response) {
        finalResponse = result;
      } else if (result === undefined) {
        // Empty/void returns yield 204 No Content
        finalResponse = new Response(null, { status: 204 });
      } else {
        // spec: contracts/functions.contract.md#FN-1 — Auto-serialize plain returned values to JSON
        finalResponse = Response.json(result, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (outgoingCookies.length > 0) {
        for (const cookieHeader of outgoingCookies) {
          finalResponse.headers.append("set-cookie", cookieHeader);
        }
      }

      return finalResponse;
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
    const pathname = c.url.pathname;
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

/**
 * Creates an ergonomic QueueConsumerHandler with optional automatic idempotency deduplication.
 *
 * @spec contracts/functions.contract.md#FN-2 — Queue trigger entrypoint
 * @spec contracts/queues.contract.md#Q-1 — At-least-once delivery
 * @spec contracts/queues.contract.md#Q-4 — Idempotency deduplication with mandatory TTL
 */
export function consumer<T = unknown>(
  fn: (message: QueueMessage<T>, ctx: RailFogContext) => Promise<void> | void,
  options?: ConsumerOptions,
): QueueConsumerHandler<T> {
  return async (
    message: QueueMessage<T>,
    ctx: RailFogContext,
  ): Promise<void> => {
    if (options?.idempotent) {
      const key = options.dedupeKey
        ? options.dedupeKey(message as QueueMessage)
        : ["railfog_dedupe", message.id];
      await withIdempotency(
        ctx.kv,
        key,
        () => fn(message, ctx),
        { ttlSeconds: options.ttlSeconds },
      );
    } else {
      await fn(message, ctx);
    }
  };
}

/**
 * Middleware function executed before route handlers in a router instance.
 */
export type RouterMiddleware = (
  c: HandlerContext,
  next: () => Promise<Response>,
) => Promise<Response>;

/**
 * Fluent micro-router instance with method chaining, middleware support,
 * and direct callability as a standard FunctionHandler.
 *
 * @spec contracts/platform.contract.md#PLAT-11 — Specificity matching
 * @spec contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
 */
export interface RouterInstance {
  (req: Request, ctx: RailFogContext): Promise<Response>;
  use(middleware: RouterMiddleware): RouterInstance;
  get(pattern: string, handler: HandlerFn): RouterInstance;
  post(pattern: string, handler: HandlerFn): RouterInstance;
  put(pattern: string, handler: HandlerFn): RouterInstance;
  patch(pattern: string, handler: HandlerFn): RouterInstance;
  delete(pattern: string, handler: HandlerFn): RouterInstance;
  all(pattern: string, handler: HandlerFn): RouterInstance;
  routes(): ApiRouteMap;
}

/**
 * Creates a fluent micro-router instance that can be directly exported as a FunctionHandler.
 *
 * @spec contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm
 * @spec contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
 */
export function router(): RouterInstance {
  const routeMap: ApiRouteMap = {};
  const middlewares: RouterMiddleware[] = [];
  let cachedHandler: FunctionHandler | null = null;

  function buildHandler(): FunctionHandler {
    if (cachedHandler) return cachedHandler;

    const baseApi = api(routeMap);
    if (middlewares.length === 0) {
      cachedHandler = baseApi;
      return cachedHandler;
    }

    cachedHandler = async (
      req: Request,
      ctx: RailFogContext,
    ): Promise<Response> => {
      const runner = handle(async (c: HandlerContext): Promise<Response> => {
        let index = 0;
        const next = async (): Promise<Response> => {
          if (index < middlewares.length) {
            const currentMw = middlewares[index++];
            return await currentMw(c, next);
          }
          return await baseApi(c.req, ctx);
        };
        return await next();
      });
      return await runner(req, ctx);
    };

    return cachedHandler;
  }

  const instance = ((req: Request, ctx: RailFogContext) => {
    return buildHandler()(req, ctx);
  }) as RouterInstance;

  instance.use = (mw: RouterMiddleware) => {
    middlewares.push(mw);
    cachedHandler = null;
    return instance;
  };
  instance.get = (pattern: string, handler: HandlerFn) => {
    routeMap[`GET ${pattern}`] = handler;
    cachedHandler = null;
    return instance;
  };
  instance.post = (pattern: string, handler: HandlerFn) => {
    routeMap[`POST ${pattern}`] = handler;
    cachedHandler = null;
    return instance;
  };
  instance.put = (pattern: string, handler: HandlerFn) => {
    routeMap[`PUT ${pattern}`] = handler;
    cachedHandler = null;
    return instance;
  };
  instance.patch = (pattern: string, handler: HandlerFn) => {
    routeMap[`PATCH ${pattern}`] = handler;
    cachedHandler = null;
    return instance;
  };
  instance.delete = (pattern: string, handler: HandlerFn) => {
    routeMap[`DELETE ${pattern}`] = handler;
    cachedHandler = null;
    return instance;
  };
  instance.all = (pattern: string, handler: HandlerFn) => {
    routeMap[`* ${pattern}`] = handler;
    cachedHandler = null;
    return instance;
  };
  instance.routes = () => ({ ...routeMap });

  return instance;
}
