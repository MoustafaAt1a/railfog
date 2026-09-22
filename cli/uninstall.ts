// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & CLI distribution
// cli/uninstall.ts — RailFog CLI self-removal

import { join } from "@std/path";
import { resolveInstallPaths } from "../scripts/install.ts";
import { colors, glyphs, renderCard } from "./ui.ts";

/**
 * Result of the uninstall operation.
 */
export interface UninstallResult {
  ok: boolean;
  removedFiles: string[];
}

/**
 * Removes the RailFog CLI binary and associated metadata.
 * Automatically resolves the installation directory — no options needed.
 *
 * @spec contracts/platform.contract.md#PLAT-19
 */
export async function runUninstall(): Promise<UninstallResult> {
  const paths = resolveInstallPaths({});
  const removedFiles: string[] = [];

  // Remove primary binary
  try {
    await Deno.remove(paths.fullBinaryPath);
    console.log(`  ${glyphs.success} Removed ${paths.fullBinaryPath}`);
    removedFiles.push(paths.fullBinaryPath);
  } catch {
    console.log(
      `  ${glyphs.info} Binary not found at ${paths.fullBinaryPath}`,
    );
  }

  // On Windows, remove the counterpart shim (rail.exe vs rail.cmd)
  if (Deno.build.os === "windows") {
    const altName = paths.fullBinaryPath.endsWith(".cmd")
      ? join(paths.binDir, "rail.exe")
      : join(paths.binDir, "rail.cmd");
    try {
      await Deno.remove(altName);
      console.log(`  ${glyphs.success} Removed ${altName}`);
      removedFiles.push(altName);
    } catch {
      // May not exist
    }
  }

  // Remove version metadata
  const metaPath = join(paths.binDir, ".rail-version.json");
  try {
    await Deno.remove(metaPath);
    console.log(`  ${glyphs.success} Removed .rail-version.json`);
    removedFiles.push(metaPath);
  } catch {
    // May not exist
  }

  // Summary
  console.log("");
  if (removedFiles.length > 0) {
    console.log(
      renderCard("RailFog CLI", [
        `${glyphs.success} ${colors.bold("Uninstalled cleanly.")}`,
        "",
        `${colors.dim("Removed:")}  ${removedFiles.length} file(s)`,
        "",
        `To reinstall, run:`,
        `  ${colors.bold("deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts")}`,
      ], { borderColor: colors.border }),
    );
  } else {
    console.log(
      `  ${glyphs.info} No RailFog CLI installation found to remove.`,
    );
  }
  console.log("");

  return { ok: true, removedFiles };
}
