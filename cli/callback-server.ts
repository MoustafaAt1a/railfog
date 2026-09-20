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
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background-color: #f8fafc;
      color: #0f172a;
    }
    .container {
      max-width: 440px;
      padding: 2.5rem;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
      text-align: center;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      color: #059669;
      margin-top: 0;
      margin-bottom: 0.75rem;
    }
    p {
      font-size: 0.95rem;
      color: #475569;
      margin: 0;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authentication Successful</h1>
    <p>You can now close this tab and return to your terminal.</p>
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
