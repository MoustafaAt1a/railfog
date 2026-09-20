// spec: contracts/platform.contract.md#PLAT-1 — Ephemeral loopback callback server for CLI authentication
// spec: contracts/platform.contract.md#PLAT-6 — Caller identity resolution
// spec: contracts/platform.contract.md#PLAT-12 — Error taxonomy (TIMEOUT code on callback deadline)
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage in errors/logs
// spec: contracts/platform.contract.md#PLAT-17 — Local development parity
// spec: contracts/platform.contract.md#PLAT-19 — Resource lifecycle and deterministic teardown
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0757-cli-login-workflow.md
// spec: tasks/milestone-0.8-developer-experience-ux/T-0803-zero-copy-cli-login.md

import { clearCliConfig, loadCliConfig, saveCliConfig } from "./auth-config.ts";
import {
  type CallbackServerSession,
  startCallbackServer,
} from "./callback-server.ts";

export interface LoginOptions {
  controlUrl?: string;
  token?: string; // Non-interactive fallback
  manual?: boolean; // Skip browser callback server and prompt on stdin
  configPath?: string;
  stdinReader?: () => Promise<string>;
  openBrowser?: (url: string) => Promise<boolean>;
  callbackTimeoutMs?: number;
}

export interface LoginResult {
  ok: boolean;
  orgId: string;
}

export const PRODUCTION_CONTROL_URL =
  "https://railfog-control-production.up.railway.app";
export const DEFAULT_CONTROL_URL = PRODUCTION_CONTROL_URL;

/**
 * Sanitizes a message to prevent leaking sensitive credentials in terminal logs.
 * spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage
 */
function sanitizeError(msg: string, secret?: string): string {
  if (!secret) return msg;
  return msg.replaceAll(secret, "[REDACTED]");
}

/**
 * Launches the user's default desktop web browser to the specified URL.
 */
export async function systemOpenBrowser(url: string): Promise<boolean> {
  try {
    let cmd: string;
    let args: string[];

    if (Deno.build.os === "windows") {
      // In Windows cmd.exe, '&' is interpreted as a command separator and strips query parameters.
      // powershell Start-Process safely launches the default browser with the full URL intact.
      try {
        const psCommand = new Deno.Command("powershell", {
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Start-Process -FilePath "${url.replaceAll('"', '`"')}"`,
          ],
          stdout: "null",
          stderr: "null",
        });
        const psProcess = psCommand.spawn();
        const psStatus = await psProcess.status;
        if (psStatus.success) {
          return true;
        }
      } catch {
        // Fallback to cmd.exe below
      }

      const escapedUrl = url.replaceAll("&", "^&");
      const cmdCommand = new Deno.Command("cmd", {
        args: ["/c", `start "" ${escapedUrl}`],
        stdout: "null",
        stderr: "null",
      });
      const cmdProcess = cmdCommand.spawn();
      await cmdProcess.status;
      return true;
    } else if (Deno.build.os === "darwin") {
      cmd = "open";
      args = [url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }

    const command = new Deno.Command(cmd, {
      args,
      stdout: "null",
      stderr: "null",
    });
    const process = command.spawn();
    await process.status;
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a single line from standard input.
 */
async function defaultStdinReader(): Promise<string> {
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null || n === 0) {
    return "";
  }
  return new TextDecoder().decode(buf.subarray(0, n));
}

/**
 * Verifies the API token against the control plane and persists credentials on success.
 * spec: contracts/platform.contract.md#PLAT-6 — Caller identity resolution
 * spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage in logs/errors
 */
async function verifyAndSaveToken(
  rawToken: string,
  controlUrl: string,
  configPath?: string,
  fallbackOrgId?: string,
  fallbackKeyName?: string,
): Promise<LoginResult> {
  try {
    const verifyUrl = `${controlUrl}/v1/auth/verify`;
    const res = await fetch(verifyUrl, {
      headers: {
        authorization: `Bearer ${rawToken}`,
        accept: "application/json",
      },
    });

    if (!res.ok) {
      // spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage in errors
      console.error(
        `\x1b[31m✗ Authentication failed: Invalid or revoked API key (status ${res.status}).\x1b[0m`,
      );
      return { ok: false, orgId: "" };
    }

    const data = await res.json();
    const orgId = data.identity?.orgId || fallbackOrgId || "default-org";
    const keyName = data.identity?.callerId || fallbackKeyName || "cli-key";

    // spec: contracts/platform.contract.md#PLAT-15 — Persist credentials with mode 0600 on POSIX
    await saveCliConfig(
      {
        token: rawToken,
        controlUrl,
        orgId,
        projectId: data.identity?.projectId,
        keyName,
      },
      configPath,
    );

    console.log(`\n\x1b[32m✓ Successfully authenticated as ${orgId}!\x1b[0m`);
    console.log(`Credentials saved to ~/.railfog/config.json\n`);

    return { ok: true, orgId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage on network error
    const sanitized = sanitizeError(msg, rawToken);
    console.error(`\x1b[31m✗ Connection error: ${sanitized}\x1b[0m`);
    return { ok: false, orgId: "" };
  }
}

/**
 * Executes the interactive or automated login command.
 * spec: contracts/platform.contract.md#PLAT-1 — Ephemeral loopback callback flow
 * spec: contracts/platform.contract.md#PLAT-19 — Deterministic teardown on all exit paths
 */
export async function runLogin(options?: LoginOptions): Promise<LoginResult> {
  const controlUrl = (
    options?.controlUrl ||
    Deno.env.get("RAILFOG_CONTROL_PLANE_URL") ||
    Deno.env.get("RAILFOG_CONTROL_URL") ||
    DEFAULT_CONTROL_URL
  ).replace(/\/+$/, "");

  let rawToken = options?.token?.trim();
  let session: CallbackServerSession | undefined;

  try {
    // 1. Non-interactive flow: explicit token provided
    if (rawToken && rawToken.length > 0) {
      return await verifyAndSaveToken(
        rawToken,
        controlUrl,
        options?.configPath,
      );
    }

    // 2. Interactive manual flow: explicit --manual flag
    if (options?.manual) {
      const loginUrl = `${controlUrl}/login`;
      console.log(`\nOpening login page in your browser:`);
      console.log(`  \x1b[36m${loginUrl}\x1b[0m\n`);
      console.log(
        `If your browser did not open automatically, visit the URL above.`,
      );
      console.log(`Copy your API key from the page and paste it below.\n`);

      const openFn = options?.openBrowser ?? systemOpenBrowser;
      await openFn(loginUrl);

      const stdinFn = options?.stdinReader ?? defaultStdinReader;
      Deno.stdout.writeSync(new TextEncoder().encode("Paste your API key: "));
      const input = await stdinFn();
      rawToken = input.trim();

      if (!rawToken || rawToken.length === 0) {
        console.error("\x1b[31mError: No API key provided.\x1b[0m");
        return { ok: false, orgId: "" };
      }

      return await verifyAndSaveToken(
        rawToken,
        controlUrl,
        options?.configPath,
      );
    }

    // 3. Interactive zero-copy flow: ephemeral loopback callback server
    // spec: contracts/platform.contract.md#PLAT-1 — Ephemeral loopback listener with state nonce
    session = await startCallbackServer({
      timeoutMs: options?.callbackTimeoutMs ?? 120_000,
    });

    const loginUrl = `${controlUrl}/login?callback=${
      encodeURIComponent(session.callbackUrl)
    }&state=${encodeURIComponent(session.state)}`;

    const openFn = options?.openBrowser ?? systemOpenBrowser;
    const browserOpened = await openFn(loginUrl);

    // Fallback if browser could not be launched (headless environment / SSH)
    if (!browserOpened) {
      // spec: contracts/platform.contract.md#PLAT-19 — Deterministic teardown on browser failure
      await session.close();
      session = undefined;

      console.log(`\nUnable to open browser automatically.`);
      console.log(`Please visit the following URL to authenticate:`);
      console.log(`  \x1b[36m${controlUrl}/login\x1b[0m\n`);
      console.log(`Copy your API key from the page and paste it below.\n`);

      const stdinFn = options?.stdinReader ?? defaultStdinReader;
      Deno.stdout.writeSync(new TextEncoder().encode("Paste your API key: "));
      const input = await stdinFn();
      rawToken = input.trim();

      if (!rawToken || rawToken.length === 0) {
        console.error("\x1b[31mError: No API key provided.\x1b[0m");
        return { ok: false, orgId: "" };
      }

      return await verifyAndSaveToken(
        rawToken,
        controlUrl,
        options?.configPath,
      );
    }

    // Browser opened successfully
    console.log(`\nOpening login page in your browser:`);
    console.log(`  \x1b[36m${loginUrl}\x1b[0m\n`);
    console.log(
      `Waiting for authorization in browser... (Press Ctrl+C to cancel, or run with --manual to paste key)`,
    );

    // Await token from loopback callback server
    let tokenFromCallback: string | undefined;
    let orgIdFromCallback: string | undefined;
    let keyNameFromCallback: string | undefined;

    try {
      const tokenResult = await session.waitForToken();
      tokenFromCallback = tokenResult.token;
      orgIdFromCallback = tokenResult.orgId;
      keyNameFromCallback = tokenResult.keyName;
    } catch (err) {
      // spec: contracts/platform.contract.md#PLAT-12 — Fallback to manual stdin prompt on TIMEOUT
      const errCode = (err as { code?: string })?.code;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errCode === "TIMEOUT" || errMsg.includes("TIMEOUT")) {
        // spec: contracts/platform.contract.md#PLAT-19 — Close session on timeout
        await session.close();
        session = undefined;

        console.log(
          `\nTimed out waiting for browser authorization. Falling back to manual entry...\n`,
        );
        console.log(`Please visit the following URL to authenticate:`);
        console.log(`  \x1b[36m${controlUrl}/login\x1b[0m\n`);
        console.log(`Copy your API key from the page and paste it below.\n`);

        const stdinFn = options?.stdinReader ?? defaultStdinReader;
        Deno.stdout.writeSync(new TextEncoder().encode("Paste your API key: "));
        const input = await stdinFn();
        rawToken = input.trim();

        if (!rawToken || rawToken.length === 0) {
          console.error("\x1b[31mError: No API key provided.\x1b[0m");
          return { ok: false, orgId: "" };
        }

        return await verifyAndSaveToken(
          rawToken,
          controlUrl,
          options?.configPath,
        );
      }

      // Other callback listener error
      await session.close();
      session = undefined;
      const sanitized = sanitizeError(errMsg);
      console.error(`\x1b[31m✗ Authorization error: ${sanitized}\x1b[0m`);
      return { ok: false, orgId: "" };
    }

    // Zero-copy token received: verify and save credentials
    // spec: contracts/platform.contract.md#PLAT-19 — Teardown callback session
    return await verifyAndSaveToken(
      tokenFromCallback,
      controlUrl,
      options?.configPath,
      orgIdFromCallback,
      keyNameFromCallback,
    );
  } finally {
    // spec: contracts/platform.contract.md#PLAT-19 — Ensure listener teardown on all exit paths
    if (session) {
      try {
        await session.close();
      } catch {
        // Idempotent close
      }
    }
  }
}

/**
 * Removes stored local credentials on logout.
 */
export async function runLogout(
  options?: { configPath?: string },
): Promise<void> {
  await clearCliConfig(options?.configPath);
  console.log(`\x1b[32m✓ Successfully logged out of RailFog.\x1b[0m`);
}

/**
 * Displays the current authenticated user and organization.
 */
export async function runWhoami(options?: {
  controlUrl?: string;
  configPath?: string;
}): Promise<{ authenticated: boolean; orgId?: string; callerId?: string }> {
  const config = await loadCliConfig(options?.configPath);
  if (!config?.token) {
    console.log(
      "Not logged in. Run '\x1b[36mrail login\x1b[0m' to authenticate.",
    );
    return { authenticated: false };
  }

  const controlUrl = (
    options?.controlUrl ||
    config.controlUrl ||
    Deno.env.get("RAILFOG_CONTROL_PLANE_URL") ||
    DEFAULT_CONTROL_URL
  ).replace(/\/+$/, "");

  try {
    const res = await fetch(`${controlUrl}/v1/auth/verify`, {
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: "application/json",
      },
    });

    if (!res.ok) {
      console.log(
        "\x1b[33mWarning: Stored token is invalid or expired. Run 'rail login' again.\x1b[0m",
      );
      return { authenticated: false };
    }

    const data = await res.json();
    const orgId = data.identity?.orgId || config.orgId || "default-org";
    const callerId = data.identity?.callerId || config.keyName || "cli-user";

    // Redacted token display per PLAT-15
    const tokenDisplay = config.token.length > 8
      ? `${config.token.slice(0, 4)}...${config.token.slice(-4)}`
      : "[REDACTED]";

    console.log(`Authenticated with RailFog:`);
    console.log(`  Organization: \x1b[32m${orgId}\x1b[0m`);
    console.log(`  Key Name:     ${callerId}`);
    console.log(`  Token:        ${tokenDisplay}`);
    console.log(`  Control URL:  ${controlUrl}`);

    return { authenticated: true, orgId, callerId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error verifying session: ${msg}`);
    return { authenticated: false };
  }
}
