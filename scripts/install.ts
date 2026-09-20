// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & CLI distribution
// spec: tasks/milestone-0.8-developer-experience-ux/T-0813-deno-cli-installer.md
// scripts/install.ts — Universal cross-platform Deno CLI installer for RailFog

import { fromFileUrl, join, resolve } from "@std/path";

/**
 * Options configuring CLI installer behavior.
 *
 * @spec contracts/platform.contract.md#PLAT-19
 */
export interface InstallerOptions {
  root?: string;
  compile?: boolean;
  force?: boolean;
  ref?: string;
  repo?: string;
  local?: boolean;
  help?: boolean;
}

/**
 * Parses command-line arguments into structured InstallerOptions.
 *
 * @spec contracts/platform.contract.md#PLAT-19 — Universal CLI installer argument parsing
 */
export function parseInstallerArgs(args: string[]): InstallerOptions {
  const options: InstallerOptions = {
    ref: "main",
    repo: "MoustafaAt1a/railfog",
    compile: false,
    force: false,
    local: false,
    help: false,
    root: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--compile" || arg === "-c") {
      options.compile = true;
    } else if (arg === "--force" || arg === "-f") {
      options.force = true;
    } else if (arg === "--local" || arg === "-l") {
      options.local = true;
    } else if (arg === "--root" || arg === "-r") {
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options.root = args[++i];
      }
    } else if (arg.startsWith("--root=") || arg.startsWith("-r=")) {
      const idx = arg.indexOf("=");
      options.root = arg.slice(idx + 1);
    } else if (arg === "--ref") {
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options.ref = args[++i];
      }
    } else if (arg.startsWith("--ref=")) {
      options.ref = arg.slice("--ref=".length);
    } else if (arg === "--repo") {
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options.repo = args[++i];
      }
    } else if (arg.startsWith("--repo=")) {
      options.repo = arg.slice("--repo=".length);
    }
  }

  return options;
}

/**
 * Resolves destination installation directory, bin directory, and executable path.
 *
 * Priority order for installDir:
 * 1. options.root
 * 2. DENO_INSTALL_ROOT env var
 * 3. RAILFOG_INSTALL_DIR env var
 * 4. ~/.deno (resolved via HOME or USERPROFILE)
 *
 * @spec contracts/platform.contract.md#PLAT-19 — Path resolution and fallback hierarchy
 */
export function resolveInstallPaths(options: InstallerOptions): {
  installDir: string;
  binDir: string;
  binaryName: string;
  fullBinaryPath: string;
} {
  // spec: contracts/platform.contract.md#PLAT-19 — Installation root priority
  let installDir: string;
  if (options.root) {
    installDir = options.root;
  } else if (Deno.env.get("DENO_INSTALL_ROOT")) {
    installDir = Deno.env.get("DENO_INSTALL_ROOT")!;
  } else if (Deno.env.get("RAILFOG_INSTALL_DIR")) {
    installDir = Deno.env.get("RAILFOG_INSTALL_DIR")!;
  } else {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
    installDir = join(home, ".deno");
  }

  const binDir = join(installDir, "bin");
  const isWindows = Deno.build.os === "windows";
  const binaryName = options.compile
    ? (isWindows ? "rail.exe" : "rail")
    : (isWindows ? "rail.cmd" : "rail");
  const fullBinaryPath = join(binDir, binaryName);

  return {
    installDir,
    binDir,
    binaryName,
    fullBinaryPath,
  };
}

/**
 * Executes the Deno global installer for RailFog CLI.
 *
 * Handles both remote repository installations (downloading isolated deno.json)
 * and local directory installations.
 *
 * @spec contracts/platform.contract.md#PLAT-19 — Universal Deno CLI installer execution
 */
export async function runInstaller(options: InstallerOptions): Promise<{
  ok: boolean;
  installedPath: string;
  output: string;
}> {
  if (options.root && /[&|;`$><]/.test(options.root)) {
    return {
      ok: false,
      installedPath: "",
      output: `Invalid root directory path: contains forbidden shell characters`,
    };
  }

  const paths = resolveInstallPaths(options);
  const isLocal = Boolean(options.local);
  let tempDir: string | undefined;

  try {
    let configPath: string;
    let target: string;

    if (!isLocal) {
      // spec: contracts/platform.contract.md#PLAT-19, PLAT-15 — Remote GitHub config validation
      const ref = options.ref || "main";
      const repo = options.repo || "MoustafaAt1a/railfog";

      if (
        !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo) ||
        repo.includes("..") ||
        repo.includes("//")
      ) {
        return {
          ok: false,
          installedPath: "",
          output: `Invalid repository format: "${repo}"`,
        };
      }

      if (
        !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(ref) ||
        ref.includes("..") ||
        ref.includes("//")
      ) {
        return {
          ok: false,
          installedPath: "",
          output: `Invalid git ref format: "${ref}"`,
        };
      }

      const denoJsonUrl =
        `https://raw.githubusercontent.com/${repo}/${ref}/deno.json`;

      let response: Response;
      try {
        response = await fetch(denoJsonUrl, {
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        return {
          ok: false,
          installedPath: "",
          output: `Failed to fetch repository config: ${
            (err as Error).message
          }`,
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          installedPath: "",
          output: `Failed to resolve repository config (${response.status})`,
        };
      }

      const denoJsonContent = await response.text();
      tempDir = await Deno.makeTempDir({ prefix: "railfog-install-" });
      configPath = join(tempDir, "deno.json");
      await Deno.writeTextFile(configPath, denoJsonContent);
      target = `https://raw.githubusercontent.com/${repo}/${ref}/cli/main.ts`;
    } else {
      // spec: contracts/platform.contract.md#PLAT-19 — Local repository resolution
      let localRootDir = import.meta.url.startsWith("file:")
        ? resolve(fromFileUrl(import.meta.url), "../..")
        : Deno.cwd();

      try {
        await Deno.stat(join(localRootDir, "deno.json"));
      } catch {
        localRootDir = Deno.cwd();
      }

      configPath = join(localRootDir, "deno.json");
      target = join(localRootDir, "cli", "main.ts");
    }

    // spec: contracts/platform.contract.md#PLAT-19 — Subprocess execution via Deno.execPath
    const args = ["install", "-g", "-A", "--no-lock"];
    if (options.force) {
      args.push("-f", "-r");
    }
    if (options.compile) {
      args.push("--compile");
    }
    args.push("--config", configPath);
    const effectiveRoot = options.root ??
      (!Deno.env.get("DENO_INSTALL_ROOT")
        ? Deno.env.get("RAILFOG_INSTALL_DIR")
        : undefined);
    if (effectiveRoot) {
      args.push("--root", effectiveRoot);
    }
    args.push("-n", "rail", target);

    const cmd = new Deno.Command(Deno.execPath(), {
      args,
      stdout: "piped",
      stderr: "piped",
    });

    const proc = await cmd.output();
    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);

    if (proc.code !== 0) {
      return {
        ok: false,
        installedPath: "",
        output: stderr + stdout,
      };
    }

    // spec: contracts/platform.contract.md#PLAT-19, T-0813 AC 5 — Post-installation verification
    try {
      const verifyCmd =
        Deno.build.os === "windows" && paths.fullBinaryPath.endsWith(".cmd")
          ? new Deno.Command("cmd.exe", {
            args: ["/c", paths.fullBinaryPath, "--help"],
            stdout: "piped",
            stderr: "piped",
          })
          : new Deno.Command(paths.fullBinaryPath, {
            args: ["--help"],
            stdout: "piped",
            stderr: "piped",
          });

      const verifyProc = await verifyCmd.output();
      const verifyStdout = new TextDecoder().decode(verifyProc.stdout);
      const verifyStderr = new TextDecoder().decode(verifyProc.stderr);

      if (verifyProc.code !== 0 || !verifyStdout.includes("RailFog CLI")) {
        return {
          ok: false,
          installedPath: paths.fullBinaryPath,
          output:
            `Installation completed, but verification failed (exit code ${verifyProc.code}):\n${verifyStderr}\n${verifyStdout}`,
        };
      }
    } catch (verifyErr) {
      return {
        ok: false,
        installedPath: paths.fullBinaryPath,
        output:
          `Installation completed, but verification command threw an error: ${
            (verifyErr as Error).message
          }`,
      };
    }

    return {
      ok: true,
      installedPath: paths.fullBinaryPath,
      output: stdout || stderr,
    };
  } finally {
    // spec: contracts/platform.contract.md#PLAT-19 — Guaranteed tempDir cleanup in finally block
    if (tempDir) {
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Cleanup best-effort
      }
    }
  }
}

/**
 * Prints styled help message.
 */
function printHelp(): void {
  console.log(`RailFog CLI Installer

Usage:
  deno run -A scripts/install.ts [options]
  deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts [options]

Options:
  -r, --root <dir>      Installation root directory (default: $DENO_INSTALL_ROOT, $RAILFOG_INSTALL_DIR, or ~/.deno)
  -c, --compile         Compile standalone executable instead of Deno script shim
  -f, --force           Force overwrite existing installation
  -l, --local           Install from local repository instead of GitHub
      --ref <ref>       Git ref/tag/branch to install (default: main)
      --repo <repo>     GitHub repository (default: MoustafaAt1a/railfog)
  -h, --help            Show help information
`);
}

/**
 * Prints styled completion box and PATH instructions.
 */
function printSuccessBox(binaryPath: string, binDir: string): void {
  const currentPath = Deno.env.get("PATH") ?? "";
  const isWindows = Deno.build.os === "windows";
  const inPath = isWindows
    ? currentPath.toLowerCase().includes(binDir.toLowerCase())
    : currentPath.split(":").includes(binDir);

  const lines = [
    "RailFog CLI installed successfully!",
    "",
    `Executable: ${binaryPath}`,
  ];

  if (!inPath) {
    lines.push("");
    lines.push(`Notice: ${binDir} is not in your PATH.`);
    if (isWindows) {
      lines.push("Add it to your User PATH using PowerShell:");
      lines.push(
        `  [Environment]::SetEnvironmentVariable("Path", $env:Path + ";${binDir}", "User")`,
      );
    } else {
      lines.push(
        "Add the following to your shell profile (~/.bashrc or ~/.zshrc):",
      );
      lines.push(`  export PATH="${binDir}:$PATH"`);
    }
  }

  lines.push("");
  lines.push("Run 'rail --help' or 'rail login' to get started!");

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

// spec: contracts/platform.contract.md#PLAT-19 — Main CLI entrypoint
if (import.meta.main) {
  const options = parseInstallerArgs(Deno.args);

  if (options.help) {
    printHelp();
    Deno.exit(0);
  }

  const paths = resolveInstallPaths(options);
  console.log("=== Installing RailFog CLI (rail) ===");
  if (options.local) {
    console.log("Source: Local repository");
  } else {
    console.log(
      `Source: https://github.com/${
        options.repo ?? "MoustafaAt1a/railfog"
      } (ref: ${options.ref ?? "main"})`,
    );
  }
  console.log(`Target: ${paths.binDir}`);

  const result = await runInstaller(options);
  if (!result.ok) {
    console.error(`\nError installing RailFog CLI:\n${result.output}`);
    Deno.exit(1);
  }

  printSuccessBox(paths.fullBinaryPath, paths.binDir);
}
