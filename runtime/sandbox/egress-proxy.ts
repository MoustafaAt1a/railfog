// spec: contracts/platform.contract.md#PLAT-5 — Network policy: allowlist + mandatory IP block (SSRF-safe)
// spec: contracts/platform.contract.md#PLAT-12 — Error model: HTTPS + JSON with machine-readable codes
// spec: contracts/functions.contract.md#FN-5 — Resource limits: network.connections default 6 concurrent
// spec: contracts/functions.contract.md#FN-6 — Bindings and lifecycle cleaned up per invocation

import http from "node:http";
import https from "node:https";
import {
  PermissionDeniedError,
  RateLimitedError,
  toErrorResponseBody,
  UnavailableError,
} from "../../packages/errors/mod.ts";
import { EgressIpBlocker, type IpBlockResult } from "./egress-ip-blocker.ts";

// spec: contracts/functions.contract.md#FN-5 — Network connection concurrency ceiling
const DEFAULT_MAX_CONCURRENT_CONNECTIONS = 6;

// spec: contracts/platform.contract.md#PLAT-12 — Standard HTTP error status codes
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
const HTTP_STATUS_BAD_GATEWAY = 502;

// spec: contracts/platform.contract.md#PLAT-9, PLAT-12 — Retry-After duration in seconds on rate limit
const RETRY_AFTER_SECONDS = "1";

// spec: contracts/platform.contract.md#PLAT-5 — Internal header carrying the tenant invocation context
const INVOCATION_ID_HEADER = "x-railfog-invocation-id";

// Maximum header size read from incoming client sockets (64 KB)
const MAX_HEADER_BUFFER_SIZE = 65536;

export interface EgressProxyOptions {
  port?: number;
  blocker?: EgressIpBlocker;
}

export interface InvocationNetworkContext {
  invocationId: string;
  allowlist: string[];
  maxConcurrentConnections?: number;
}

export interface EgressProxy {
  port: number;
  registerInvocation(ctx: InvocationNetworkContext): void;
  unregisterInvocation(invocationId: string): void;
  handleRequest(req: Request, invocationId: string): Promise<Response>;
  close(): Promise<void>;
}

interface ParsedAllowlistEntry {
  host: string;
  port?: string;
}

/**
 * Parses an allowlist entry into normalized host and optional port components.
 * Handles IPv6 bracketed literals ([::1]:port) and standard host:port combinations.
 */
function parseAllowlistEntry(entry: string): ParsedAllowlistEntry {
  const trimmed = entry.trim();
  const ipv6BracketMatch = trimmed.match(/^\[([a-fA-F0-9:]+)\](?::(\d+))?$/);
  if (ipv6BracketMatch) {
    return {
      host: ipv6BracketMatch[1].toLowerCase(),
      port: ipv6BracketMatch[2],
    };
  }

  const lastColon = trimmed.lastIndexOf(":");
  if (
    lastColon !== -1 && !trimmed.includes("]") &&
    trimmed.indexOf(":") === lastColon
  ) {
    const hostPart = trimmed.slice(0, lastColon).toLowerCase();
    const portPart = trimmed.slice(lastColon + 1);
    if (/^\d+$/.test(portPart)) {
      return { host: hostPart, port: portPart };
    }
  }

  return { host: trimmed.toLowerCase(), port: undefined };
}

/**
 * Removes surrounding brackets from IPv6 host strings.
 */
function normalizeHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1).toLowerCase();
  }
  return hostname.toLowerCase();
}

/**
 * Derives the effective destination port based on explicit URL port or default scheme port.
 */
function getEffectivePort(url: URL): string {
  if (url.port) {
    return url.port;
  }
  if (url.protocol === "http:") {
    return "80";
  }
  if (url.protocol === "https:") {
    return "443";
  }
  return "";
}

/**
 * Evaluates Layer 1 allowlist matching for given host and port components.
 * Supports exact hostnames and wildcard subdomains (*.example.com), case-insensitively.
 */
function matchesAllowlistHostPort(
  targetHost: string,
  targetPort: string,
  entry: string,
): boolean {
  const { host: entryHost, port: entryPort } = parseAllowlistEntry(entry);
  const normalizedTargetHost = normalizeHostname(targetHost);

  if (entryPort !== undefined && entryPort !== targetPort) {
    return false;
  }

  if (entryHost.startsWith("*.")) {
    const suffix = entryHost.slice(2);
    return normalizedTargetHost.endsWith(`.${suffix}`) &&
      normalizedTargetHost.length > suffix.length + 1;
  }

  return normalizedTargetHost === entryHost;
}

/**
 * Evaluates Layer 1 allowlist matching for a URL per PLAT-5.
 */
function matchesAllowlistEntry(targetUrl: URL, entry: string): boolean {
  const effectivePort = getEffectivePort(targetUrl);
  return matchesAllowlistHostPort(targetUrl.hostname, effectivePort, entry);
}

/**
 * Serializes a RailFog error into a standardized JSON HTTP Response.
 */
function createErrorResponse(
  err: PermissionDeniedError | RateLimitedError | UnavailableError,
  status: number,
  retryAfter?: string,
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (retryAfter !== undefined) {
    headers["retry-after"] = retryAfter;
  }
  return new Response(JSON.stringify(toErrorResponseBody(err)), {
    status,
    headers,
  });
}

/**
 * Writes a raw HTTP response over a TCP connection with PLAT-12 structured JSON body.
 */
async function writeRawHttpResponse(
  conn: Deno.TcpConn,
  status: number,
  statusText: string,
  body: string,
  extraHeaders?: Record<string, string>,
): Promise<void> {
  const bodyBytes = new TextEncoder().encode(body);
  let head =
    `HTTP/1.1 ${status} ${statusText}\r\ncontent-type: application/json\r\ncontent-length: ${bodyBytes.length}\r\nconnection: close\r\n`;
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      head += `${k}: ${v}\r\n`;
    }
  }
  head += "\r\n";
  const headBytes = new TextEncoder().encode(head);
  const combined = new Uint8Array(headBytes.length + bodyBytes.length);
  combined.set(headBytes, 0);
  combined.set(bodyBytes, headBytes.length);
  await conn.write(combined);
}

/**
 * Reads HTTP request headers from a TCP connection up to MAX_HEADER_BUFFER_SIZE.
 */
async function readHttpHeaders(conn: Deno.TcpConn): Promise<
  {
    headerText: string;
    leftoverBytes: Uint8Array;
  } | null
> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  const buf = new Uint8Array(4096);
  const decoder = new TextDecoder();

  while (totalLength < MAX_HEADER_BUFFER_SIZE) {
    const n = await conn.read(buf);
    if (n === null) {
      break;
    }
    const chunk = buf.subarray(0, n);
    chunks.push(chunk);
    totalLength += n;

    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.length;
    }

    const headerEndIndex = findHeaderEnd(combined);
    if (headerEndIndex !== -1) {
      const headerBytes = combined.subarray(0, headerEndIndex);
      const leftoverBytes = combined.subarray(headerEndIndex + 4);
      return {
        headerText: decoder.decode(headerBytes),
        leftoverBytes,
      };
    }
  }
  return null;
}

/**
 * Searches for \r\n\r\n delimiter in a byte array.
 */
function findHeaderEnd(buf: Uint8Array): number {
  for (let i = 0; i <= buf.length - 4; i++) {
    if (
      buf[i] === 13 &&
      buf[i + 1] === 10 &&
      buf[i + 2] === 13 &&
      buf[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Extracts invocation ID from query parameters in a request target URI.
 */
function extractInvocationFromTarget(target: string): string | null {
  const queryIndex = target.indexOf("?");
  if (queryIndex === -1) {
    return null;
  }
  const searchParams = new URLSearchParams(target.slice(queryIndex));
  return searchParams.get("invocationId");
}

/**
 * Sanitizes headers for upstream forwarding, stripping proxy-hop and internal metadata headers.
 */
function sanitizeForwardHeaders(
  sourceHeaders: Headers,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of sourceHeaders.entries()) {
    const lower = key.toLowerCase();
    // spec: contracts/platform.contract.md#PLAT-5 — Never leak internal invocation ID upstream
    if (lower === INVOCATION_ID_HEADER) {
      continue;
    }
    // Hop-by-hop headers per RFC 7230 §6.1
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "keep-alive" ||
      lower === "proxy-authenticate" ||
      lower === "proxy-authorization" ||
      lower === "te" ||
      lower === "trailer" ||
      lower === "transfer-encoding" ||
      lower === "upgrade"
    ) {
      continue;
    }
    headers[key] = value;
  }
  return headers;
}

/**
 * Dispatches an HTTP request upstream connecting directly to the validated IP address.
 * Preserves the Host header and SNI servername to prevent DNS rebinding attacks (PLAT-5).
 */
export async function dispatchUpstream(
  req: Request,
  validatedIp: string,
  targetUrl: URL,
): Promise<Response> {
  return await new Promise((resolve, reject) => {
    const isHttps = targetUrl.protocol === "https:";
    const client = isHttps ? https : http;
    const port = targetUrl.port ? Number(targetUrl.port) : (isHttps ? 443 : 80);

    const forwardHeaders = sanitizeForwardHeaders(req.headers);
    forwardHeaders["host"] = targetUrl.host;

    const options: https.RequestOptions = {
      host: validatedIp,
      port,
      method: req.method,
      path: targetUrl.pathname + targetUrl.search,
      headers: forwardHeaders,
      servername: isHttps ? targetUrl.hostname : undefined,
    };

    const upstreamReq = client.request(options, (upstreamRes) => {
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v !== undefined) {
          if (Array.isArray(v)) {
            for (const item of v) {
              resHeaders.append(k, item);
            }
          } else {
            resHeaders.set(k, v);
          }
        }
      }

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamRes.on(
            "data",
            (chunk: Uint8Array) => controller.enqueue(chunk),
          );
          upstreamRes.on("end", () => controller.close());
          upstreamRes.on("error", (err) => controller.error(err));
        },
      });

      resolve(
        new Response(stream, {
          status: upstreamRes.statusCode ?? 200,
          statusText: upstreamRes.statusMessage ?? "OK",
          headers: resHeaders,
        }),
      );
    });

    upstreamReq.on("error", reject);

    if (req.body && req.method !== "GET" && req.method !== "HEAD") {
      const reader = req.body.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            upstreamReq.write(value);
          }
        } finally {
          upstreamReq.end();
        }
      })().catch(reject);
    } else {
      upstreamReq.end();
    }
  });
}

/**
 * HTTP egress proxy enforcing dual-layer defense-in-depth network policies and concurrency limits.
 * Supports both HTTP forward proxying and HTTPS CONNECT tunneling over a single local TCP port.
 *
 * Spec references:
 * - contracts/platform.contract.md#PLAT-5: Two independent security layers (allowlist + connect-time IP block).
 * - contracts/platform.contract.md#PLAT-12: Error responses use machine-readable error codes.
 * - contracts/functions.contract.md#FN-5: Max 6 concurrent outbound network connections per invocation.
 * - contracts/functions.contract.md#FN-6: Per-invocation network context lifecycle.
 */
export class EgressProxy implements EgressProxy {
  public port: number;
  private readonly blocker: EgressIpBlocker;
  private readonly listener: Deno.TcpListener;
  private readonly invocations = new Map<string, InvocationNetworkContext>();
  private readonly activeConnections = new Map<string, number>();
  private readonly openSockets = new Set<Deno.TcpConn>();
  private closed = false;

  constructor(options?: EgressProxyOptions) {
    this.blocker = options?.blocker ?? new EgressIpBlocker();

    // spec: tasks/milestone-0.3-security/T-0304-egress-proxy.md — Proxy binds to 127.0.0.1
    this.listener = Deno.listen({
      port: options?.port ?? 0,
      hostname: "127.0.0.1",
    });

    const addr = this.listener.addr as Deno.NetAddr;
    this.port = addr.port;

    this.acceptLoop();
  }

  private async acceptLoop(): Promise<void> {
    while (!this.closed) {
      try {
        const conn = await this.listener.accept();
        this.handleConnection(conn).catch(() => {});
      } catch (_err) {
        if (this.closed) {
          break;
        }
      }
    }
  }

  private async handleConnection(conn: Deno.TcpConn): Promise<void> {
    this.openSockets.add(conn);
    try {
      const parsed = await readHttpHeaders(conn);
      if (!parsed) {
        try {
          conn.close();
        } catch {
          // Ignore
        }
        return;
      }

      const { headerText, leftoverBytes } = parsed;
      const lines = headerText.split("\r\n");
      const requestLine = lines[0];
      const [method, target] = requestLine.split(" ");
      if (!method || !target) {
        try {
          conn.close();
        } catch {
          // Ignore
        }
        return;
      }

      const headers = new Headers();
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const colonIdx = line.indexOf(":");
        if (colonIdx !== -1) {
          headers.append(
            line.slice(0, colonIdx).trim(),
            line.slice(colonIdx + 1).trim(),
          );
        }
      }

      const invocationId = headers.get(INVOCATION_ID_HEADER) ??
        extractInvocationFromTarget(target) ??
        "";

      if (method.toUpperCase() === "CONNECT") {
        await this.handleConnectTunnel(
          conn,
          target,
          invocationId,
          leftoverBytes,
        );
      } else {
        await this.handleHttpForward(
          conn,
          method,
          target,
          headers,
          leftoverBytes,
          invocationId,
        );
      }
    } catch (_err) {
      try {
        const err = new UnavailableError("Bad Gateway: Internal proxy error");
        await writeRawHttpResponse(
          conn,
          HTTP_STATUS_BAD_GATEWAY,
          "Bad Gateway",
          JSON.stringify(toErrorResponseBody(err)),
        );
      } catch {
        // Ignore
      }
      try {
        conn.close();
      } catch {
        // Ignore
      }
    } finally {
      this.openSockets.delete(conn);
    }
  }

  /**
   * Handles HTTPS CONNECT tunneling with Layer 1 allowlist and Layer 2 IP blocking.
   */
  private async handleConnectTunnel(
    conn: Deno.TcpConn,
    target: string,
    invocationId: string,
    leftoverBytes: Uint8Array,
  ): Promise<void> {
    // 1. Invocation registration check
    const ctx = this.invocations.get(invocationId);
    if (!ctx) {
      const err = new PermissionDeniedError(
        "Invocation not registered or context missing",
      );
      await writeRawHttpResponse(
        conn,
        HTTP_STATUS_FORBIDDEN,
        "Forbidden",
        JSON.stringify(toErrorResponseBody(err)),
      );
      try {
        conn.close();
      } catch {
        // Ignore
      }
      return;
    }

    // 2. Concurrency limit check
    const maxConnections = ctx.maxConcurrentConnections ??
      DEFAULT_MAX_CONCURRENT_CONNECTIONS;
    if (this.getActiveConnectionCount(invocationId) >= maxConnections) {
      const err = new RateLimitedError("Outbound connection limit exceeded");
      await writeRawHttpResponse(
        conn,
        HTTP_STATUS_TOO_MANY_REQUESTS,
        "Too Many Requests",
        JSON.stringify(toErrorResponseBody(err)),
        { "retry-after": RETRY_AFTER_SECONDS },
      );
      try {
        conn.close();
      } catch {
        // Ignore
      }
      return;
    }

    // 3. Layer 1: Allowlist check
    if (ctx.allowlist.length === 0) {
      const err = new PermissionDeniedError(
        "Network access not permitted: allowlist is empty",
      );
      await writeRawHttpResponse(
        conn,
        HTTP_STATUS_FORBIDDEN,
        "Forbidden",
        JSON.stringify(toErrorResponseBody(err)),
      );
      try {
        conn.close();
      } catch {
        // Ignore
      }
      return;
    }

    const { host: entryHost, port: entryPort } = parseAllowlistEntry(target);
    const destPort = entryPort ? Number(entryPort) : 443;
    const matchesAllowlist = ctx.allowlist.some((entry) =>
      matchesAllowlistHostPort(entryHost, String(destPort), entry)
    );
    if (!matchesAllowlist) {
      const err = new PermissionDeniedError(
        `Destination ${entryHost} is not permitted by network allowlist`,
      );
      await writeRawHttpResponse(
        conn,
        HTTP_STATUS_FORBIDDEN,
        "Forbidden",
        JSON.stringify(toErrorResponseBody(err)),
      );
      try {
        conn.close();
      } catch {
        // Ignore
      }
      return;
    }

    // 4. Layer 2: IP blocker check
    let blockResult: IpBlockResult;
    try {
      blockResult = await this.blocker.validateDestination(entryHost);
    } catch (dnsErr) {
      const err = new PermissionDeniedError(
        `DNS resolution failed for destination ${entryHost}: ${
          dnsErr instanceof Error ? dnsErr.message : String(dnsErr)
        }`,
      );
      await writeRawHttpResponse(
        conn,
        HTTP_STATUS_FORBIDDEN,
        "Forbidden",
        JSON.stringify(toErrorResponseBody(err)),
      );
      try {
        conn.close();
      } catch {
        // Ignore
      }
      return;
    }

    if (blockResult.blocked) {
      const err = new PermissionDeniedError(
        blockResult.reason ??
          `Destination ${entryHost} is blocked by network policy`,
      );
      await writeRawHttpResponse(
        conn,
        HTTP_STATUS_FORBIDDEN,
        "Forbidden",
        JSON.stringify(toErrorResponseBody(err)),
      );
      try {
        conn.close();
      } catch {
        // Ignore
      }
      return;
    }

    // Re-verify concurrency ceiling before acquiring slot
    if (this.getActiveConnectionCount(invocationId) >= maxConnections) {
      const err = new RateLimitedError("Outbound connection limit exceeded");
      await writeRawHttpResponse(
        conn,
        HTTP_STATUS_TOO_MANY_REQUESTS,
        "Too Many Requests",
        JSON.stringify(toErrorResponseBody(err)),
        { "retry-after": RETRY_AFTER_SECONDS },
      );
      try {
        conn.close();
      } catch {
        // Ignore
      }
      return;
    }

    // 5. Connect upstream directly to validatedIp to prevent DNS rebinding
    this.incrementActiveConnections(invocationId);
    try {
      const upstream = await Deno.connect({
        hostname: blockResult.ip,
        port: destPort,
      });
      this.openSockets.add(upstream);

      await conn.write(
        new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"),
      );
      if (leftoverBytes.length > 0) {
        await upstream.write(leftoverBytes);
      }

      await Promise.all([
        conn.readable.pipeTo(upstream.writable).catch(() => {}),
        upstream.readable.pipeTo(conn.writable).catch(() => {}),
      ]);
    } catch (_err) {
      const err = new UnavailableError(
        "Bad Gateway: Upstream connection failed",
      );
      await writeRawHttpResponse(
        conn,
        HTTP_STATUS_BAD_GATEWAY,
        "Bad Gateway",
        JSON.stringify(toErrorResponseBody(err)),
      );
    } finally {
      this.decrementActiveConnections(invocationId);
      try {
        conn.close();
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Handles forward HTTP requests over the TCP connection.
   */
  private async handleHttpForward(
    conn: Deno.TcpConn,
    method: string,
    target: string,
    headers: Headers,
    leftoverBytes: Uint8Array,
    invocationId: string,
  ): Promise<void> {
    const fullUrl =
      target.startsWith("http://") || target.startsWith("https://")
        ? target
        : `http://${headers.get("host") ?? "127.0.0.1"}${target}`;

    let bodyStream: ReadableStream<Uint8Array> | undefined;
    const contentLengthStr = headers.get("content-length");
    const contentLength = contentLengthStr
      ? parseInt(contentLengthStr, 10)
      : undefined;

    if (method !== "GET" && method !== "HEAD") {
      if (contentLength !== undefined && contentLength === 0) {
        bodyStream = undefined;
      } else {
        let bytesRead = 0;
        let leftoverSent = false;
        const connReader = conn.readable.getReader();

        bodyStream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!leftoverSent) {
              leftoverSent = true;
              if (leftoverBytes.length > 0) {
                const toSend = (contentLength !== undefined &&
                    bytesRead + leftoverBytes.length > contentLength)
                  ? leftoverBytes.subarray(0, contentLength - bytesRead)
                  : leftoverBytes;
                bytesRead += toSend.length;
                controller.enqueue(toSend);
                if (contentLength !== undefined && bytesRead >= contentLength) {
                  controller.close();
                  return;
                }
              }
            }

            if (contentLength !== undefined && bytesRead >= contentLength) {
              controller.close();
              return;
            }

            const { done, value } = await connReader.read();
            if (done) {
              controller.close();
              return;
            }

            let toEnqueue = value;
            if (
              contentLength !== undefined &&
              bytesRead + value.length > contentLength
            ) {
              toEnqueue = value.subarray(0, contentLength - bytesRead);
            }
            bytesRead += toEnqueue.length;
            controller.enqueue(toEnqueue);

            if (contentLength !== undefined && bytesRead >= contentLength) {
              controller.close();
            }
          },
        });
      }
    }

    const reqInit: RequestInit & { duplex?: "half" } = {
      method,
      headers,
    };
    if (bodyStream) {
      reqInit.body = bodyStream;
      reqInit.duplex = "half";
    }

    const webReq = new Request(fullUrl, reqInit as RequestInit);
    const webRes = await this.handleRequest(webReq, invocationId);

    let resHead = `HTTP/1.1 ${webRes.status} ${webRes.statusText || "OK"}\r\n`;
    for (const [k, v] of webRes.headers.entries()) {
      resHead += `${k}: ${v}\r\n`;
    }
    resHead += "connection: close\r\n\r\n";
    await conn.write(new TextEncoder().encode(resHead));

    if (webRes.body) {
      await webRes.body.pipeTo(conn.writable).catch(() => {});
    }
    try {
      conn.close();
    } catch {
      // Ignore
    }
  }

  // spec: contracts/functions.contract.md#FN-6 — Register capability bindings for the invocation
  public registerInvocation(ctx: InvocationNetworkContext): void {
    this.invocations.set(ctx.invocationId, ctx);
    if (!this.activeConnections.has(ctx.invocationId)) {
      this.activeConnections.set(ctx.invocationId, 0);
    }
  }

  // spec: contracts/functions.contract.md#FN-6 — Clean up invocation state to prevent cross-tenant bleeding
  public unregisterInvocation(invocationId: string): void {
    this.invocations.delete(invocationId);
    this.activeConnections.delete(invocationId);
  }

  private getActiveConnectionCount(invocationId: string): number {
    return this.activeConnections.get(invocationId) ?? 0;
  }

  private incrementActiveConnections(invocationId: string): void {
    const current = this.getActiveConnectionCount(invocationId);
    this.activeConnections.set(invocationId, current + 1);
  }

  private decrementActiveConnections(invocationId: string): void {
    const current = this.getActiveConnectionCount(invocationId);
    if (current <= 1) {
      this.activeConnections.set(invocationId, 0);
    } else {
      this.activeConnections.set(invocationId, current - 1);
    }
  }

  /**
   * Processes an outbound request through capability validation, concurrency capping,
   * Layer 1 allowlist matching, Layer 2 connect-time IP blocking, and upstream dispatching.
   */
  public async handleRequest(
    req: Request,
    invocationId: string,
  ): Promise<Response> {
    // 1. Invocation registration check
    // spec: contracts/platform.contract.md#PLAT-6 — Capability injection: unregistered invocation has no permissions
    const ctx = this.invocations.get(invocationId);
    if (!ctx) {
      const err = new PermissionDeniedError(
        "Invocation not registered or context missing",
      );
      return createErrorResponse(err, HTTP_STATUS_FORBIDDEN);
    }

    // 2. Concurrency limit check
    // spec: contracts/functions.contract.md#FN-5 — Cap concurrent outbound connections per invocation
    const maxConnections = ctx.maxConcurrentConnections ??
      DEFAULT_MAX_CONCURRENT_CONNECTIONS;
    if (this.getActiveConnectionCount(invocationId) >= maxConnections) {
      const err = new RateLimitedError("Outbound connection limit exceeded");
      return createErrorResponse(
        err,
        HTTP_STATUS_TOO_MANY_REQUESTS,
        RETRY_AFTER_SECONDS,
      );
    }

    // 3. Layer 1: Network allowlist verification
    // spec: contracts/platform.contract.md#PLAT-5 — Layer 1 allowlist matching against permissions.network
    if (ctx.allowlist.length === 0) {
      const err = new PermissionDeniedError(
        "Network access not permitted: allowlist is empty",
      );
      return createErrorResponse(err, HTTP_STATUS_FORBIDDEN);
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(req.url);
    } catch {
      const err = new PermissionDeniedError(
        `Invalid outbound destination URL: ${req.url}`,
      );
      return createErrorResponse(err, HTTP_STATUS_FORBIDDEN);
    }

    if (
      targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:" &&
      req.method !== "CONNECT"
    ) {
      const err = new PermissionDeniedError(
        `Unsupported protocol scheme: ${targetUrl.protocol}`,
      );
      return createErrorResponse(err, HTTP_STATUS_FORBIDDEN);
    }

    const matchesAllowlist = ctx.allowlist.some((entry) =>
      matchesAllowlistEntry(targetUrl, entry)
    );
    if (!matchesAllowlist) {
      const err = new PermissionDeniedError(
        `Destination ${targetUrl.hostname} is not permitted by network allowlist`,
      );
      return createErrorResponse(err, HTTP_STATUS_FORBIDDEN);
    }

    // 4. Layer 2: Mandatory connect-time IP blocking (SSRF defense)
    // spec: contracts/platform.contract.md#PLAT-5 — Connect-time IP blocking immune to DNS rebinding
    const destinationHost = normalizeHostname(targetUrl.hostname);
    let blockResult: IpBlockResult;
    try {
      blockResult = await this.blocker.validateDestination(destinationHost);
    } catch (dnsErr) {
      const err = new PermissionDeniedError(
        `DNS resolution failed for destination ${destinationHost}: ${
          dnsErr instanceof Error ? dnsErr.message : String(dnsErr)
        }`,
      );
      return createErrorResponse(err, HTTP_STATUS_FORBIDDEN);
    }

    if (blockResult.blocked) {
      const err = new PermissionDeniedError(
        blockResult.reason ??
          `Destination ${destinationHost} is blocked by network policy`,
      );
      return createErrorResponse(err, HTTP_STATUS_FORBIDDEN);
    }

    // Re-verify concurrency ceiling before acquiring connection slot under burst concurrency
    // spec: contracts/functions.contract.md#FN-5 — Hard kill connection ceiling
    if (this.getActiveConnectionCount(invocationId) >= maxConnections) {
      const err = new RateLimitedError("Outbound connection limit exceeded");
      return createErrorResponse(
        err,
        HTTP_STATUS_TOO_MANY_REQUESTS,
        RETRY_AFTER_SECONDS,
      );
    }

    // Handle CONNECT method if invoked programmatically via handleRequest
    if (req.method === "CONNECT") {
      return new Response(null, {
        status: 200,
        statusText: "Connection Established",
      });
    }

    // 5. Upstream dispatch directly to validated IP (immune to DNS rebinding)
    // spec: contracts/functions.contract.md#FN-5 — Connection counter decremented in finally
    this.incrementActiveConnections(invocationId);
    try {
      return await dispatchUpstream(req, blockResult.ip, targetUrl);
    } catch (_err) {
      const err = new UnavailableError(
        "Bad Gateway: Upstream connection failed",
      );
      return createErrorResponse(err, HTTP_STATUS_BAD_GATEWAY);
    } finally {
      this.decrementActiveConnections(invocationId);
    }
  }

  // spec: tasks/milestone-0.3-security/T-0304-egress-proxy.md — Clean shutdown
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const sock of this.openSockets) {
      try {
        sock.close();
      } catch {
        // Ignore
      }
    }
    this.openSockets.clear();
    try {
      this.listener.close();
    } catch {
      // Ignore
    }
    await Promise.resolve();
  }
}
