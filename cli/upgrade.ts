// spec: docs/contracts/platform.contract.md#PLAT-19 — Repository structure & CLI distribution
// spec: tasks/milestone-0.8-developer-experience-ux/T-0814-cli-self-upgrade-mechanism.md
// cli/upgrade.ts — RailFog CLI self-upgrade engine and version checking

import { CLI_VERSION } from "./version.ts";
import { createSpinner } from "./spinner.ts";
import { runInstaller } from "../scripts/install.ts";

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

  const url = `https://raw.githubusercontent.com/${repo}/${ref}/cli/version.ts`;

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
    `https://raw.githubusercontent.com/${repo}/${ref}/deno.json`;
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
 * Prints styled completion box.
 */
function printUpgradeBox(installedPath: string, targetVersion: string): void {
  const lines = [
    "RailFog CLI upgraded successfully!",
    "",
    `Target:    ${targetVersion}`,
    `Location:  ${installedPath}`,
    "",
    "Run 'rail --version' or 'rail --help' to verify.",
  ];

  let maxLen = 40;
  for (const line of lines) {
    if (line.length > maxLen) {
      maxLen = line.length;
    }
  }
  const innerWidth = maxLen + 4;
  const top = "┌" + "─".repeat(innerWidth) + "┐";
  const bottom = "└" + "─".repeat(innerWidth) + "┘";

  console.log("");
  console.log(top);
  for (const line of lines) {
    const padded = "  " + line;
    const padRight = " ".repeat(Math.max(0, innerWidth - padded.length));
    console.log("│" + padded + padRight + "│");
  }
  console.log(bottom);
  console.log("");
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
      const upToDate = targetVersion === currentVersion;
      if (upToDate) {
        console.log(`RailFog CLI is already up to date (${currentVersion}).`);
      } else {
        console.log(
          `An update is available: ${currentVersion} -> ${targetVersion}. Run 'rail update' to upgrade.`,
        );
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

  // spec: PLAT-19, T-0814 AC 3 — Skip upgrade if already on target version and force is false
  if (
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

  if (!options?.force && targetRef === "main") {
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

  // spec: PLAT-19, T-0814 AC 4, 5 — Execute installer with progress spinner
  const spinner = createSpinner();
  spinner.start(`Upgrading RailFog CLI (${currentVersion} -> ${targetRef})...`);

  const res = await runInstaller({
    root: options?.root,
    compile: options?.compile,
    force: true,
    ref: targetRef,
    repo: options?.repo ?? "MoustafaAt1a/railfog",
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

  spinner.succeed(`RailFog CLI upgraded successfully to ${targetRef}`);
  printUpgradeBox(res.installedPath, targetRef);

  return {
    ok: true,
    upToDate: false,
    currentVersion,
    targetVersion: targetRef,
    installedPath: res.installedPath,
    message: "RailFog CLI upgraded successfully.",
  };
}
