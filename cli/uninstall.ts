// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & CLI distribution
// cli/uninstall.ts — RailFog CLI self-removal

import { join } from "@std/path";
import { resolveInstallPaths } from "../scripts/install.ts";
import {
  colors,
  getTerminalWidth,
  glyphs,
  renderBrandHeader,
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
 * Visual layout and typography faithfully match the JetBrains Darcula CLI design system.
 *
 * @spec contracts/platform.contract.md#PLAT-19
 */
export async function runUninstall(): Promise<UninstallResult> {
  // Branded locomotive header
  console.log(renderBrandHeader(CLI_VERSION));
  console.log("");

  const paths = resolveInstallPaths({});
  const removedFiles: string[] = [];

  // Step 1: Locate installation
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
    `  ${glyphs.info} ${colors.dim("Platform:")}  ${Deno.build.os}-${Deno.build.arch}`,
  );
  if (existingVersion) {
    console.log(
      `  ${glyphs.info} ${colors.dim("Version:")}   ${existingVersion}`,
    );
  }
  console.log("");

  // Step 2: Remove files automatically
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

  // Step 3: JetBrains Darcula Departure Card with locomotive art
  const trainLines = renderTrainLogo({ includeTrack: true });
  const logoWidth = 24;

  const rightLines: string[] = removedFiles.length > 0
    ? [
      `${colors.bold(colors.emerald("[+] RailFog CLI Successfully Uninstalled"))}`,
      "",
      `${colors.dim("STATUS:")}      ${colors.emerald("REMOVED")}`,
      `${colors.dim("DIRECTORY:")}   ${colors.slate(paths.binDir)}`,
      `${colors.dim("REMOVED:")}     ${colors.bold(`${removedFiles.length} file(s)`)}`,
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

  const termWidth = getTerminalWidth();
  const contentLines: string[] = [];
  if (termWidth >= 70) {
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
