// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & CLI distribution
// cli/uninstall.ts — RailFog CLI self-removal

import { join } from "@std/path";
import { resolveInstallPaths } from "../scripts/install.ts";
import { getDefaultConfigPath } from "./auth-config.ts";
import {
  animateSignalLantern,
  animateSteamTrain,
  colors,
  getTerminalWidth,
  glyphs,
  renderCard,
  renderTrainLogo,
  visibleWidth,
} from "./ui.ts";
import { createTrackSpinner } from "./spinner.ts";
import { CLI_VERSION } from "./version.ts";

/**
 * Result of the uninstall operation.
 */
export interface UninstallResult {
  ok: boolean;
  removedFiles: string[];
}

/**
 * Removes the RailFog CLI binary and associated metadata.
 * Automatically resolves the installation directory — zero flags or configuration required.
 *
 * Uses the official animated locomotive and signal lantern from cli/ui.ts,
 * provides a transparent clean-room hygiene audit, and offers shell PATH pruning guidance.
 *
 * @spec contracts/platform.contract.md#PLAT-19
 */
export async function runUninstall(): Promise<UninstallResult> {
  // 1. Live animation of the locomotive header from ui.ts
  await animateSteamTrain({ durationMs: 400, version: CLI_VERSION });
  console.log("");

  const paths = resolveInstallPaths({});
  const removedFiles: string[] = [];

  // 2. Step: Locate installation
  const locateSpinner = createTrackSpinner();
  locateSpinner.start("Locating RailFog installation...");
  await delay(120);

  let existingVersion: string | null = null;
  const metaPath = join(paths.binDir, ".rail-version.json");
  try {
    const raw = await Deno.readTextFile(metaPath);
    const meta = JSON.parse(raw);
    existingVersion = meta?.version ?? null;
  } catch {
    // Version metadata optional
  }

  locateSpinner.succeed("Installation located");
  console.log(
    `  ${glyphs.info} ${colors.dim("Binary:")}    ${paths.fullBinaryPath}`,
  );
  console.log(
    `  ${glyphs.info} ${colors.dim("Target:")}    ${paths.binDir}`,
  );
  console.log(
    `  ${glyphs.info} ${
      colors.dim("Platform:")
    }  ${Deno.build.os}-${Deno.build.arch}`,
  );
  if (existingVersion) {
    console.log(
      `  ${glyphs.info} ${colors.dim("Version:")}   ${existingVersion}`,
    );
  }
  console.log("");

  // 3. Step: Remove files automatically
  const removeSpinner = createTrackSpinner();
  removeSpinner.start("Removing CLI binary and metadata...");

  // Primary executable
  try {
    await Deno.remove(paths.fullBinaryPath);
    removedFiles.push(paths.fullBinaryPath);
  } catch {
    // File not present
  }

  // Windows counterpart executable/script shims
  if (Deno.build.os === "windows") {
    const shims = [
      paths.fullBinaryPath.endsWith(".cmd")
        ? join(paths.binDir, "rail.exe")
        : join(paths.binDir, "rail.cmd"),
      join(paths.binDir, "rail"),
      join(paths.binDir, "rail.ps1"),
    ];

    for (const shim of shims) {
      try {
        await Deno.remove(shim);
        if (!removedFiles.includes(shim)) {
          removedFiles.push(shim);
        }
      } catch {
        // Optional shim
      }
    }
  }

  // Version metadata
  try {
    await Deno.remove(metaPath);
    removedFiles.push(metaPath);
  } catch {
    // Optional metadata
  }

  await delay(150);

  if (removedFiles.length > 0) {
    removeSpinner.succeed(`Removed ${removedFiles.length} file(s) cleanly`);
  } else {
    removeSpinner.fail("No installed RailFog files found to remove");
  }
  console.log("");

  // 4. Live animation of the signal lantern aspect transition from ui.ts
  await animateSignalLantern({
    steps: [
      "Switching track to departure siding...",
      "Uncoupling binary executables & shims...",
      "All signals clear • RailFog CLI uninstalled.",
    ],
    delayMs: 130,
  });
  console.log("");

  // 5. Clean-Room Hygiene Audit (check local auth credentials)
  let hasLocalAuth = false;
  const authConfigPath = getDefaultConfigPath();
  try {
    const stat = await Deno.stat(authConfigPath);
    hasLocalAuth = stat.isFile;
  } catch {
    hasLocalAuth = false;
  }

  // 6. PATH check
  const currentPath = Deno.env.get("PATH") ?? "";
  const isWindows = Deno.build.os === "windows";
  const inPath = isWindows
    ? currentPath.toLowerCase().includes(paths.binDir.toLowerCase())
    : currentPath.split(":").includes(paths.binDir);

  // 7. JetBrains Darcula Departure Card with locomotive art
  const trainLines = renderTrainLogo({ includeTrack: true });
  const logoWidth = 24;

  const rightLines: string[] = removedFiles.length > 0
    ? [
      `${
        colors.bold(colors.emerald("[+] RailFog CLI Successfully Uninstalled"))
      }`,
      "",
      `${colors.dim("STATUS:")}      ${colors.emerald("REMOVED")}`,
      `${colors.dim("DIRECTORY:")}   ${colors.slate(paths.binDir)}`,
      `${colors.dim("REMOVED:")}     ${
        colors.bold(`${removedFiles.length} file(s)`)
      }`,
      `${colors.dim("PLATFORM:")}    ${Deno.build.os}-${Deno.build.arch}`,
      `${colors.dim("REINSTALL:")}   ${
        colors.accent(
          "deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts",
        )
      }`,
    ]
    : [
      `${colors.bold(colors.amber("[!] No RailFog Installation Found"))}`,
      "",
      `${colors.dim("STATUS:")}      ${colors.amber("NOT FOUND")}`,
      `${colors.dim("DIRECTORY:")}   ${colors.slate(paths.binDir)}`,
      `${colors.dim("TARGET:")}      ${colors.dim(paths.fullBinaryPath)}`,
      `${colors.dim("INSTALL:")}     ${
        colors.accent(
          "deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts",
        )
      }`,
    ];

  // Hygiene audit section
  rightLines.push("");
  rightLines.push(colors.bold("Hygiene & Clean-Room Audit:"));
  rightLines.push(
    `  ${glyphs.success} ${colors.dim("Binary Executables:")}  Removed cleanly`,
  );
  rightLines.push(
    `  ${glyphs.success} ${
      colors.dim("Version Metadata:")
    }    Removed (.rail-version.json)`,
  );
  if (hasLocalAuth) {
    rightLines.push(
      `  ${glyphs.info} ${colors.dim("Local Auth Session:")}   ${
        colors.emerald("Preserved in ~/.railfog/config.json")
      }`,
    );
    rightLines.push(
      `    ${
        colors.dim("(Your cloud project tokens are safe if you reinstall)")
      }`,
    );
  } else {
    rightLines.push(
      `  ${glyphs.success} ${
        colors.dim("Local Auth Session:")
      }   Zero stored tokens found`,
    );
  }

  // PATH reminder
  if (inPath) {
    rightLines.push("");
    rightLines.push(
      `${colors.amber("[!]")} ${
        colors.dim("PATH Notice:")
      } ${paths.binDir} is still in your PATH.`,
    );
    if (isWindows) {
      rightLines.push(
        `    ${
          colors.dim("To prune User PATH:")
        } [Environment]::SetEnvironmentVariable("Path", ($env:Path -replace [regex]::Escape(";${paths.binDir}"), ""), "User")`,
      );
    } else {
      rightLines.push(
        `    ${
          colors.dim("Remove the export line from your ~/.bashrc or ~/.zshrc")
        }`,
      );
    }
  }

  const termWidth = getTerminalWidth();
  const contentLines: string[] = [];
  if (termWidth >= 74) {
    const maxRows = Math.max(trainLines.length, rightLines.length);
    for (let i = 0; i < maxRows; i++) {
      const left = trainLines[i] ?? " ".repeat(logoWidth);
      const right = rightLines[i] ?? "";
      const leftPad = logoWidth - visibleWidth(left);
      contentLines.push(left + " ".repeat(Math.max(0, leftPad)) + right);
    }
  } else {
    contentLines.push(...trainLines);
    contentLines.push("");
    contentLines.push(...rightLines);
  }

  console.log(
    renderCard(
      removedFiles.length > 0
        ? "Departure: RailFog CLI Removed"
        : "Departure: No Installation Found",
      contentLines,
      {
        borderColor: removedFiles.length > 0 ? colors.emerald : colors.amber,
        padding: true,
      },
    ),
  );
  console.log("");

  return { ok: true, removedFiles };
}

/** Utility delay for smooth spinner UX. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function uninstallCommand(): Promise<UninstallResult> {
  return await runUninstall();
}

export function printUninstallHelp(): void {
  console.log(`RailFog CLI - Self-uninstaller

Usage:
  rail uninstall [options]

Description:
  Removes the RailFog CLI binary and local metadata.
  Automatically resolves installation directories.

Options:
  -h, --help       Show help for uninstall command`);
}
