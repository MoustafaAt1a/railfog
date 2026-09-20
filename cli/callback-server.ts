// spec: contracts/platform.contract.md#PLAT-1 — Ephemeral loopback callback server for CLI authentication
// spec: contracts/platform.contract.md#PLAT-12 — Error taxonomy (TIMEOUT code on callback deadline)
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage in logs, headers, and responses
// spec: contracts/platform.contract.md#PLAT-19 — Resource lifecycle and deterministic idempotent teardown

/** Default callback server timeout in milliseconds (120 seconds). */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Loopback IPv4 address preventing IPv6 / hosts-file resolution ambiguities. */
const LOOPBACK_HOSTNAME = "127.0.0.1";

/** Expected callback route path. */
const CALLBACK_PATH = "/callback";

/** Self-contained HTML response rendered upon successful authentication. */
const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>RailFog — Authentication Successful</title>
  <style>
    :root {
      --ink: #0B2340;
      --paper: #F7F9FA;
      --canvas: #EBF0F3;
      --line: #C9D3DB;
      --steel: #6C8194;
      --slate: #3D5266;
      --lamp: #0FB88E;
      --lamp-tint: #C6F0E0;
      --lamp-deep: #0A6B50;
      --font-sans: Archivo, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-sans);
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background-color: var(--canvas);
      color: var(--ink);
    }
    .card {
      width: 100%;
      max-width: 440px;
      padding: 32px;
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 2px;
      text-align: center;
    }
    .signal {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      background: var(--lamp-tint);
      border-radius: 2px;
      margin-bottom: 16px;
    }
    .lamp-dot {
      width: 12px;
      height: 12px;
      background: var(--lamp);
      border-radius: 2px;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--ink);
      margin-bottom: 8px;
    }
    p {
      font-size: 0.95rem;
      color: var(--slate);
      line-height: 1.5;
    }
    .hint {
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--line);
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: var(--steel);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="signal"><div class="lamp-dot"></div></div>
    <h1>Authentication Successful</h1>
    <p>Your identity has been verified. You may close this window and return to your terminal.</p>
    <div class="hint">Signal: Clear &bull; Session Active</div>
  </div>
</body>
</html>`;

export interface CallbackServerOptions {
  timeoutMs?: number;
  state?: string;
}

export interface CallbackServerSession {
  port: number;
  callbackUrl: string;
  state: string;
  waitForToken(): Promise<{ token: string; orgId?: string }>;
  close(): Promise<void>;
}

export function startCallbackServer(
  options?: CallbackServerOptions,
): Promise<CallbackServerSession> {
  // spec: contracts/platform.contract.md#PLAT-1 — Cryptographically random 128-bit state nonce
  const state = options?.state ?? crypto.randomUUID();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let settled = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let shutdownPromise: Promise<void> | null = null;

  let resolveToken!: (value: { token: string; orgId?: string }) => void;
  let rejectToken!: (reason?: unknown) => void;

  const tokenPromise = new Promise<{ token: string; orgId?: string }>(
    (resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    },
  );

  // Prevent unhandled rejection errors if waitForToken() is never explicitly awaited
  tokenPromise.catch(() => {});

  // spec: contracts/platform.contract.md#PLAT-19 — Idempotent teardown and resource release
  const close = async (): Promise<void> => {
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    if (!settled) {
      settled = true;
      rejectToken(new Error("Callback server closed before token received"));
    }
    if (!shutdownPromise) {
      shutdownPromise = server.shutdown();
    }
    await shutdownPromise;
  };

  // spec: contracts/platform.contract.md#PLAT-12 — Reject with TIMEOUT error when deadline expires
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timeoutTimer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      if (!shutdownPromise) {
        shutdownPromise = server.shutdown();
      }
      await shutdownPromise;
      const timeoutErr = new Error(
        "TIMEOUT: Callback server timed out waiting for token",
      );
      (timeoutErr as { code?: string }).code = "TIMEOUT";
      rejectToken(timeoutErr);
    }, timeoutMs);
  }

  // spec: contracts/platform.contract.md#PLAT-1 — Bind loopback to port 0 for OS-assigned ephemeral port
  // spec: contracts/platform.contract.md#PLAT-15 — Zero console logging
  const server = Deno.serve(
    {
      hostname: LOOPBACK_HOSTNAME,
      port: 0,
      onListen: () => {},
    },
    (req: Request): Response => {
      try {
        const url = new URL(req.url);

        // Routing check: reject any unhandled endpoint
        if (url.pathname !== CALLBACK_PATH) {
          return new Response("Not Found", {
            status: 404,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "referrer-policy": "no-referrer",
              "cache-control": "no-store, private",
            },
          });
        }

        // Method check: only GET is permitted for callback retrieval
        if (req.method !== "GET") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "referrer-policy": "no-referrer",
              "cache-control": "no-store, private",
            },
          });
        }

        // spec: contracts/platform.contract.md#PLAT-15 — Query extraction with zero reflection
        const reqState = url.searchParams.get("state");
        const token = url.searchParams.get("token");

        // Probe resilience: reject mismatched state or missing credentials without closing server
        if (!reqState || !token || reqState !== state) {
          return new Response(
            "Bad Request: invalid or missing state/token parameters.",
            {
              status: 400,
              headers: {
                "content-type": "text/plain; charset=utf-8",
                "referrer-policy": "no-referrer",
                "cache-control": "no-store, private",
              },
            },
          );
        }

        // spec: contracts/platform.contract.md#PLAT-19 — Single-use listener termination on first valid callback
        if (timeoutTimer !== undefined) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        settled = true;

        const orgId = url.searchParams.get("orgId") ??
          url.searchParams.get("org_id") ??
          undefined;

        resolveToken({
          token,
          ...(orgId ? { orgId } : {}),
        });

        // Trigger immediate listener shutdown so subsequent requests fail
        if (!shutdownPromise) {
          shutdownPromise = server.shutdown();
        }

        return new Response(SUCCESS_HTML, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "referrer-policy": "no-referrer",
            "cache-control": "no-store, private",
          },
        });
      } catch {
        return new Response("Bad Request", {
          status: 400,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "referrer-policy": "no-referrer",
            "cache-control": "no-store, private",
          },
        });
      }
    },
  );

  const port = (server.addr as Deno.NetAddr).port;
  const callbackUrl = `http://${LOOPBACK_HOSTNAME}:${port}${CALLBACK_PATH}`;

  const session: CallbackServerSession = {
    port,
    callbackUrl,
    state,
    waitForToken(): Promise<{ token: string; orgId?: string }> {
      return tokenPromise;
    },
    close,
  };

  return Promise.resolve(session);
}
