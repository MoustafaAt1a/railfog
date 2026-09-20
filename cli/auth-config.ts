// spec: contracts/platform.contract.md#PLAT-1 — CLI interaction
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & caller identity resolution
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage in errors/logs
// spec: contracts/platform.contract.md#PLAT-17 — Local development parity
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0757-cli-login-workflow.md

import { dirname, join } from "@std/path";

export interface CliAuthConfig {
  token?: string;
  controlUrl?: string;
  orgId?: string;
  projectId?: string;
  keyName?: string;
}

/**
 * Returns the canonical path to the RailFog user configuration file.
 * Defaults to ~/.railfog/config.json (or %USERPROFILE%\.railfog\config.json).
 */
export function getDefaultConfigPath(): string {
  const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || ".";
  return join(home, ".railfog", "config.json");
}

/**
 * Loads and parses stored CLI authentication credentials.
 */
export async function loadCliConfig(
  configPath?: string,
): Promise<CliAuthConfig | null> {
  const path = configPath ?? getDefaultConfigPath();
  try {
    const text = await Deno.readTextFile(path);
    if (!text || text.trim().length === 0) {
      return null;
    }
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as CliAuthConfig;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persists CLI authentication credentials with secure permissions.
 */
export async function saveCliConfig(
  config: CliAuthConfig,
  configPath?: string,
): Promise<void> {
  const path = configPath ?? getDefaultConfigPath();
  const dir = dirname(path);
  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  const payload = JSON.stringify(config, null, 2);
  await Deno.writeTextFile(path, payload);

  // Restrict permissions to owner only on POSIX systems (PLAT-15)
  if (Deno.build.os !== "windows") {
    try {
      await Deno.chmod(path, 0o600);
    } catch {
      // Non-fatal if chmod fails on certain filesystems
    }
  }
}

/**
 * Removes the stored CLI credentials on logout.
 */
export async function clearCliConfig(configPath?: string): Promise<void> {
  const path = configPath ?? getDefaultConfigPath();
  try {
    await Deno.remove(path);
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Resolves the active API token using the following precedence:
 * 1. Explicit option passed via flag (--token <key>)
 * 2. Environment variable RAILFOG_API_KEY
 * 3. Persisted token in ~/.railfog/config.json
 */
export async function resolveCliToken(
  options?: { token?: string },
  configPath?: string,
): Promise<string | undefined> {
  if (options?.token && options.token.trim().length > 0) {
    return options.token.trim();
  }

  const envKey = Deno.env.get("RAILFOG_API_KEY");
  if (envKey && envKey.trim().length > 0) {
    return envKey.trim();
  }

  const config = await loadCliConfig(configPath);
  if (config?.token && config.token.trim().length > 0) {
    return config.token.trim();
  }

  return undefined;
}

/**
 * Returns HTTP Authorization header dictionary if a token is resolved.
 */
export async function resolveAuthHeader(
  options?: { token?: string },
  configPath?: string,
): Promise<Record<string, string>> {
  const token = await resolveCliToken(options, configPath);
  if (token) {
    return { authorization: `Bearer ${token}` };
  }
  return {};
}
