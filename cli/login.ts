// spec: contracts/platform.contract.md#PLAT-1 — CLI interaction
// spec: contracts/platform.contract.md#PLAT-6 — Caller identity resolution
// spec: contracts/platform.contract.md#PLAT-12 — Error codes
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage in errors/logs
// spec: contracts/platform.contract.md#PLAT-17 — Local development parity
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0757-cli-login-workflow.md

import {
  clearCliConfig,
  loadCliConfig,
  saveCliConfig,
} from "./auth-config.ts";

export interface LoginOptions {
  controlUrl?: string;
  token?: string; // Non-interactive fallback
  configPath?: string;
  stdinReader?: () => Promise<string>;
  openBrowser?: (url: string) => Promise<boolean>;
}

export interface LoginResult {
  ok: boolean;
  orgId: string;
}

const DEFAULT_CONTROL_URL = "http://localhost:8081";

/**
 * Launches the user's default desktop web browser to the specified URL.
 */
async function systemOpenBrowser(url: string): Promise<boolean> {
  try {
    let cmd: string;
    let args: string[];

    if (Deno.build.os === "windows") {
      cmd = "cmd";
      args = ["/c", "start", "", url];
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
 * Executes the interactive or automated login command.
 */
export async function runLogin(options?: LoginOptions): Promise<LoginResult> {
  const controlUrl = (
    options?.controlUrl ||
    Deno.env.get("RAILFOG_CONTROL_PLANE_URL") ||
    Deno.env.get("RAILFOG_CONTROL_URL") ||
    DEFAULT_CONTROL_URL
  ).replace(/\/+$/, "");

  let rawToken = options?.token?.trim();

  // Interactive flow
  if (!rawToken) {
    const loginUrl = `${controlUrl}/login`;
    console.log(`\nOpening login page in your browser:`);
    console.log(`  \x1b[36m${loginUrl}\x1b[0m\n`);
    console.log(`If your browser did not open automatically, visit the URL above.`);
    console.log(`Copy your API key from the page and paste it below.\n`);

    const openFn = options?.openBrowser ?? systemOpenBrowser;
    await openFn(loginUrl);

    // Prompt user for input
    const stdinFn = options?.stdinReader ?? defaultStdinReader;
    Deno.stdout.writeSync(new TextEncoder().encode("Paste your API key: "));
    const input = await stdinFn();
    rawToken = input.trim();
  }

  if (!rawToken || rawToken.length === 0) {
    console.error("\x1b[31mError: No API key provided.\x1b[0m");
    return { ok: false, orgId: "" };
  }

  // Verify token with control plane
  try {
    const verifyUrl = `${controlUrl}/v1/auth/verify`;
    const res = await fetch(verifyUrl, {
      headers: {
        authorization: `Bearer ${rawToken}`,
        accept: "application/json",
      },
    });

    if (!res.ok) {
      console.error(`\x1b[31m✗ Authentication failed: Invalid or revoked API key (status ${res.status}).\x1b[0m`);
      return { ok: false, orgId: "" };
    }

    const data = await res.json();
    const orgId = data.identity?.orgId || "default-org";

    // Persist credentials
    await saveCliConfig(
      {
        token: rawToken,
        controlUrl,
        orgId,
        projectId: data.identity?.projectId,
      },
      options?.configPath,
    );

    console.log(`\n\x1b[32m✓ Successfully authenticated as ${orgId}!\x1b[0m`);
    console.log(`Credentials saved to ~/.railfog/config.json\n`);

    return { ok: true, orgId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m✗ Connection error: ${msg}\x1b[0m`);
    return { ok: false, orgId: "" };
  }
}

/**
 * Removes stored local credentials on logout.
 */
export async function runLogout(options?: { configPath?: string }): Promise<void> {
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
    console.log("Not logged in. Run '\x1b[36mrail login\x1b[0m' to authenticate.");
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
      console.log("\x1b[33mWarning: Stored token is invalid or expired. Run 'rail login' again.\x1b[0m");
      return { authenticated: false };
    }

    const data = await res.json();
    const orgId = data.identity?.orgId || config.orgId || "default-org";
    const callerId = data.identity?.callerId || "cli-user";

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
