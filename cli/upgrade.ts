// spec: docs/contracts/platform.contract.md#PLAT-19 — Repository structure & CLI distribution
// spec: tasks/milestone-0.8-developer-experience-ux/T-0814-cli-self-upgrade-mechanism.md
// cli/upgrade.ts — RailFog CLI self-upgrade engine and version checking

import { CLI_VERSION } from "./version.ts";
import { createWheelSpinner } from "./spinner.ts";
import { runInstaller } from "../scripts/install.ts";
import { join } from "@std/path";
import { colors, glyphs, renderCard } from "./ui.ts";

/**
 * Configuration options for upgrading the RailFog CLI.
 *
 * @spec docs/contracts/platform.contract.md#PLAT-19
 */
export interface UpgradeOptions {
  version?: string;
  ref?: string;
  force?: boolean;
  checkOnly?: boolean;
  root?: string;
  compile?: boolean;
  repo?: string;
  local?: boolean;
}

/**
 * Result structure returned by runUpgrade.
 *
 * @spec docs/contracts/platform.contract.md#PLAT-19
 */
export interface UpgradeResult {
  ok: boolean;
  upToDate: boolean;
  currentVersion: string;
  targetVersion: string;
  installedPath?: string;
  message?: string;
}

const REPO_REGEX = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const REF_REGEX = /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/;
const VERSION_REGEX =
  /^(?:main|master|v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9_.-]+)?(?:\+[a-zA-Z0-9_.-]+)?)$/;

export function isValidRepo(repo: string): boolean {
  return REPO_REGEX.test(repo) && !repo.includes("..") && !repo.includes("//");
}

export function isValidRef(ref: string): boolean {
  return REF_REGEX.test(ref) && !ref.includes("..") && !ref.includes("//");
}

export function isValidVersion(version: string): boolean {
  return VERSION_REGEX.test(version);
}

/**
 * Resolves the latest version of the RailFog CLI from GitHub.
 *
 * @spec docs/contracts/platform.contract.md#PLAT-19
 */
export async function checkLatestVersion(options?: {
  repo?: string;
  ref?: string;
}): Promise<string> {
  const repo = options?.repo ?? "MoustafaAt1a/railfog";
  const ref = options?.ref ?? "main";

  if (!isValidRepo(repo)) {
    throw new Error(`Invalid repository format: "${repo}"`);
  }
  if (!isValidRef(ref)) {
    throw new Error(`Invalid git ref format: "${ref}"`);
  }

  const url =
    `https://raw.githubusercontent.com/${repo}/${ref}/cli/version.ts?_t=${Date.now()}`;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(
      `Failed to check latest version: ${(err as Error).message}`,
    );
  }

  if (response.ok) {
    const content = await response.text();
    const match = content.match(/CLI_VERSION\s*=\s*["']([^"']+)["']/);
    if (match) {
      return match[1];
    }
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // Not JSON
    }
    return "0.8.0";
  }

  // spec: PLAT-19 — Fallback version check via repository deno.json
  const fallbackUrl =
    `https://raw.githubusercontent.com/${repo}/${ref}/deno.json?_t=${Date.now()}`;
  let fallbackRes: Response;
  try {
    fallbackRes = await fetch(fallbackUrl, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(
      `Failed to check latest version from fallback: ${(err as Error).message}`,
    );
  }

  if (!fallbackRes.ok) {
    throw new Error(
      `Failed to resolve remote version from ${repo}@${ref} (HTTP ${response.status})`,
    );
  }

  const fallbackContent = await fallbackRes.text();
  try {
    const json = JSON.parse(fallbackContent);
    if (typeof json.version === "string") {
      return json.version;
    }
  } catch {
    // Not JSON
  }

  const match = fallbackContent.match(/["']version["']\s*:\s*["']([^"']+)["']/);
  if (match) {
    return match[1];
  }

  return "0.8.0";
}

/**
 * Resolves the latest git commit SHA of a given ref via GitHub API.
 * Returns undefined if network is unavailable, offline, or rate-limited.
 */
export async function checkLatestCommit(options?: {
  repo?: string;
  ref?: string;
}): Promise<string | undefined> {
  const repo = options?.repo ?? "MoustafaAt1a/railfog";
  const ref = options?.ref ?? "main";

  if (!isValidRepo(repo) || !isValidRef(ref)) {
    return undefined;
  }

  try {
    const url = `https://api.github.com/repos/${repo}/commits/${ref}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "RailFog-CLI",
        "Accept": "application/vnd.github.v3+json",
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.sha === "string") {
        return data.sha;
      }
    }
  } catch {
    // Non-fatal if offline or rate limited
  }
  return undefined;
}

/**
 * Reads local installation metadata (.rail-version.json).
 */
export function getInstalledMetadata(rootOrBinDir?: string): {
  version?: string;
  ref?: string;
  commit?: string;
  installedAt?: string;
} | undefined {
  try {
    let metaPath: string;
    if (rootOrBinDir) {
      metaPath = rootOrBinDir.endsWith("bin")
        ? join(rootOrBinDir, ".rail-version.json")
        : join(rootOrBinDir, "bin", ".rail-version.json");
    } else {
      const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
      metaPath = join(home, ".deno", "bin", ".rail-version.json");
    }
    const content = Deno.readTextFileSync(metaPath);
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/**
 * Prints styled completion box.
 */
function printUpgradeBox(installedPath: string, targetVersion: string): void {
  const card = renderCard("CLI Upgrade Complete", [
    `${glyphs.success}  RailFog CLI upgraded successfully!`,
    "",
    `   ${colors.dim("Target:")}    ${
      colors.bold(colors.emerald(targetVersion))
    }`,
    `   ${colors.dim("Location:")}  ${colors.slate(installedPath)}`,
    "",
    `   ${
      colors.amber(">> Next:")
    }      Run 'rail --version' or 'rail --help' to verify.`,
  ], {
    borderColor: colors.emerald,
  });

  console.log("\n" + card + "\n");
}

/**
 * Upgrades the local RailFog CLI installation or verifies available updates.
 *
 * @spec docs/contracts/platform.contract.md#PLAT-19
 */
export async function runUpgrade(
  options?: UpgradeOptions,
): Promise<UpgradeResult> {
  const currentVersion = CLI_VERSION;
  const targetRef = options?.version ?? options?.ref ?? "main";

  // spec: PLAT-19, PLAT-15 — Adversarial input validation
  if (options?.repo && !isValidRepo(options.repo)) {
    const message = `Invalid repository format: "${options.repo}"`;
    console.error(message);
    return {
      ok: false,
      upToDate: false,
      currentVersion,
      targetVersion: targetRef,
      message,
    };
  }

  if (options?.version && !isValidVersion(options.version)) {
    const message =
      `Invalid version format: "${options.version}". Must be semantic versioning (e.g. 0.8.0).`;
    console.error(message);
    return {
      ok: false,
      upToDate: false,
      currentVersion,
      targetVersion: options.version,
      message,
    };
  }

  if (options?.ref && !isValidRef(options.ref)) {
    const message = `Invalid git ref format: "${options.ref}"`;
    console.error(message);
    return {
      ok: false,
      upToDate: false,
      currentVersion,
      targetVersion: options.ref,
      message,
    };
  }

  // spec: PLAT-19, T-0814 AC 2 — Check-only mode without disk modifications
  if (options?.checkOnly) {
    try {
      let targetVersion: string;
      if (
        options?.version &&
        options.version !== "main" &&
        options.version !== "master"
      ) {
        targetVersion = options.version.startsWith("v")
          ? options.version.slice(1)
          : options.version;
      } else {
        targetVersion = await checkLatestVersion({
          repo: options?.repo,
          ref: options?.ref ?? targetRef,
        });
      }

      const latestCommit = await checkLatestCommit({
        repo: options?.repo,
        ref: options?.ref ?? targetRef,
      });
      const installedMeta = getInstalledMetadata(options?.root);

      let upToDate = targetVersion === currentVersion;
      if (
        latestCommit && installedMeta?.commit &&
        targetRef === (installedMeta.ref ?? "main")
      ) {
        upToDate = upToDate && (latestCommit === installedMeta.commit);
      }

      if (upToDate) {
        console.log(`RailFog CLI is already up to date (${currentVersion}).`);
      } else {
        if (
          latestCommit && installedMeta?.commit &&
          latestCommit !== installedMeta.commit
        ) {
          console.log(
            `A git update is available: ${
              installedMeta.commit.slice(0, 7)
            } -> ${latestCommit.slice(0, 7)}. Run 'rail update' to upgrade.`,
          );
        } else {
          console.log(
            `An update is available: ${currentVersion} -> ${targetVersion}. Run 'rail update' to upgrade.`,
          );
        }
      }
      return {
        ok: true,
        upToDate,
        currentVersion,
        targetVersion,
      };
    } catch (err) {
      console.error(`Failed to check for updates: ${(err as Error).message}`);
      return {
        ok: false,
        upToDate: false,
        currentVersion,
        targetVersion: targetRef,
        message: (err as Error).message,
      };
    }
  }

  let targetVersion = options?.version ?? targetRef;

  // spec: PLAT-19, T-0814 AC 3 — Skip upgrade if explicit version matches current and force is false
  if (
    !options?.local &&
    options?.version &&
    targetVersion === currentVersion && !options?.force && targetRef !== "main"
  ) {
    const message = `RailFog CLI is already up to date (${currentVersion}).`;
    console.log(message);
    return {
      ok: true,
      upToDate: true,
      currentVersion,
      targetVersion: currentVersion,
      message,
    };
  }

  let resolvedCommit: string | undefined;
  if (!options?.local && !options?.version) {
    resolvedCommit = await checkLatestCommit({
      repo: options?.repo,
      ref: targetRef,
    });
    const installedMeta = getInstalledMetadata(options?.root);

    if (
      !options?.force &&
      resolvedCommit &&
      installedMeta?.commit &&
      resolvedCommit === installedMeta.commit
    ) {
      const message = `RailFog CLI is already up to date (${currentVersion} @ ${
        resolvedCommit.slice(0, 7)
      }).`;
      console.log(message);
      return {
        ok: true,
        upToDate: true,
        currentVersion,
        targetVersion: currentVersion,
        message,
      };
    }

    if (!options?.force && !resolvedCommit && targetRef === "main") {
      try {
        const latest = await checkLatestVersion({
          repo: options?.repo,
          ref: targetRef,
        });
        if (latest === currentVersion) {
          const message =
            `RailFog CLI is already up to date (${currentVersion}).`;
          console.log(message);
          return {
            ok: true,
            upToDate: true,
            currentVersion,
            targetVersion: latest,
            message,
          };
        }
        targetVersion = latest;
      } catch {
        // If version check fails, proceed with installer
      }
    }
  }

  // spec: PLAT-19, T-0814 AC 4, 5 — Execute installer with progress spinner
  const spinner = createWheelSpinner();
  const commitSuffix = resolvedCommit ? ` (${resolvedCommit.slice(0, 7)})` : "";
  spinner.start(
    options?.local
      ? "Syncing RailFog CLI from local repository..."
      : `Upgrading RailFog CLI (${currentVersion} -> ${targetRef}${commitSuffix})...`,
  );

  const res = await runInstaller({
    root: options?.root,
    compile: options?.compile,
    force: true,
    ref: targetRef,
    commit: resolvedCommit,
    repo: options?.repo ?? "MoustafaAt1a/railfog",
    local: options?.local,
  });

  if (!res.ok) {
    spinner.fail(`Failed to upgrade RailFog CLI: ${res.output}`);
    return {
      ok: false,
      upToDate: false,
      currentVersion,
      targetVersion: targetRef,
      message: res.output,
    };
  }

  const successMessage = options?.local
    ? "RailFog CLI synchronized successfully from local repository."
    : `RailFog CLI upgraded successfully to ${targetRef}${commitSuffix}`;
  spinner.succeed(successMessage);
  printUpgradeBox(
    res.installedPath,
    options?.local ? "local" : `${targetRef}${commitSuffix}`,
  );

  return {
    ok: true,
    upToDate: false,
    currentVersion,
    targetVersion: options?.local ? "local" : `${targetRef}${commitSuffix}`,
    installedPath: res.installedPath,
    message: successMessage,
  };
}
