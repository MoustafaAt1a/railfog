/**
 * Lightweight worker bootstrap runner executed inside isolated Deno subprocesses.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-4: Isolation, defense in depth
 * - docs/contracts/functions.contract.md#FN-4: RailFogContext structure
 * - docs/contracts/functions.contract.md#FN-5: Resource limits
 * - docs/contracts/functions.contract.md#FN-6: Isolation & warm-reuse rule (reuse within same {project, function, revision})
 * - docs/adr/0001-isolation-provider-invocation-protocol.md: ADR-0001 (stdio JSON-RPC IPC)
 */

import { decodeBase64, encodeBase64 } from "@std/encoding/base64";

// Redirect untrusted customer console output to stderr so stdout is reserved for IPC messages
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

// Capture real stdout write internally for IPC before redirecting (PLAT-4, ADR-0001)
const realStdoutWrite = Deno.stdout.write.bind(Deno.stdout);

// Redirect Deno.stdout to stderr for untrusted customer code to prevent IPC response frame spoofing
Deno.stdout.write = (p: Uint8Array) => Deno.stderr.write(p);
Deno.stdout.writeSync = (p: Uint8Array) => Deno.stderr.writeSync(p);

// Keep-alive timer ensures Deno event loop does not exit prematurely when customer code awaits hanging promises
setInterval(() => {}, 60_000);

export interface WorkerInvokeMessage {
  type: "invoke";
  id: string;
  codeBase64: string;
  invocation: {
    requestId: string;
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    bodyBase64?: string;
  };
  limits: {
    cpuMs: number;
    timeoutMs: number;
    memoryMb: number;
  };
  meta: {
    orgId?: string;
    project: string;
    function: string;
    revision: string;
  };
}

export interface WorkerSuccessResponse {
  id: string;
  statusCode: number;
  headers: Record<string, string>;
  bodyBase64: string;
  cpuTimeMs: number;
  wallClockMs: number;
}

export interface WorkerErrorResponse {
  id: string;
  error: {
    code: string;
    message: string;
    name?: string;
  };
}

// In-memory module cache for warm reuse strictly within the same {project, function, revision} per FN-6
type HandlerFn = (req: Request, ctx: unknown) => Promise<Response>;
const moduleCache = new Map<string, { handler: HandlerFn }>();

async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) yield trimmed;
      }
    }
    const remaining = buffer.trim();
    if (remaining) yield remaining;
  } finally {
    reader.releaseLock();
  }
}

async function emitStdout(
  msg: WorkerSuccessResponse | WorkerErrorResponse,
): Promise<void> {
  const line = JSON.stringify(msg) + "\n";
  const bytes = new TextEncoder().encode(line);
  await realStdoutWrite(bytes);
}

// Read and process invocation messages sequentially from stdin
for await (const line of readLines(Deno.stdin.readable)) {
  let msg: WorkerInvokeMessage;
  try {
    msg = JSON.parse(line) as WorkerInvokeMessage;
  } catch (err) {
    await emitStdout({
      id: "unknown",
      error: {
        code: "INTERNAL",
        message: `Failed to parse stdin IPC message: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    });
    continue;
  }

  try {
    // 1. Resolve or import module from base64 code (FN-6, PLAT-7)
    const cacheKey = JSON.stringify([
      msg.meta.orgId ?? "",
      msg.meta.project,
      msg.meta.function,
      msg.meta.revision,
    ]);

    let cached = moduleCache.get(cacheKey);
    if (!cached) {
      let mod: { default?: unknown };
      try {
        mod = await import(`data:text/typescript;base64,${msg.codeBase64}`);
      } catch {
        mod = await import(
          `data:application/javascript;base64,${msg.codeBase64}`
        );
      }

      if (!mod || typeof mod.default !== "function") {
        throw new Error(
          "Function module must export a default handler function",
        );
      }

      cached = { handler: mod.default as HandlerFn };
      moduleCache.set(cacheKey, cached);
    }

    // 2. Re-inject fresh RailFogContext per invocation (FN-4, FN-6)
    const deadline = Date.now() + (msg.limits.timeoutMs ?? 30000);
    const ctx = {
      requestId: msg.invocation.requestId,
      project: msg.meta.project,
      function: msg.meta.function,
      revision: msg.meta.revision,
      deadline,
      timeRemaining(): number {
        return Math.max(0, deadline - Date.now());
      },
      kv: {},
      objects: {},
      queues: {},
      env: {
        get(_key: string): string | undefined {
          return undefined;
        },
      },
    };

    // 3. Build Request
    const requestMethod = msg.invocation.method ?? "GET";
    const requestUrl = msg.invocation.url ?? "https://example.com/api";
    const hasBody = msg.invocation.bodyBase64 !== undefined &&
      msg.invocation.bodyBase64.length > 0 &&
      requestMethod !== "GET" &&
      requestMethod !== "HEAD";
    const bodyBytes = hasBody
      ? decodeBase64(msg.invocation.bodyBase64!)
      : undefined;

    const req = new Request(requestUrl, {
      method: requestMethod,
      headers: msg.invocation.headers,
      body: bodyBytes ? (bodyBytes as unknown as BodyInit) : undefined,
    });

    // 4. Measure execution time and invoke handler
    const startWallClock = performance.now();
    const response = await cached.handler(req, ctx);
    const wallClockMs = Math.max(
      0,
      Math.round(performance.now() - startWallClock),
    );
    const cpuTimeMs = Math.min(
      wallClockMs,
      msg.limits.cpuMs > 0 ? msg.limits.cpuMs : wallClockMs,
    );

    // 5. Extract response headers and body
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((val, key) => {
      responseHeaders[key] = val;
    });

    const bodyBuffer = await response.arrayBuffer();
    const bodyBase64 = encodeBase64(new Uint8Array(bodyBuffer));

    await emitStdout({
      id: msg.id,
      statusCode: response.status,
      headers: responseHeaders,
      bodyBase64,
      cpuTimeMs,
      wallClockMs,
    });
  } catch (err) {
    await emitStdout({
      id: msg.id,
      error: {
        code: "INTERNAL",
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      },
    });
  }
}
