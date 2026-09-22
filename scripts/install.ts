// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & CLI distribution
// spec: tasks/milestone-0.8-developer-experience-ux/T-0813-deno-cli-installer.md
// scripts/install.ts — Universal cross-platform Deno CLI installer for RailFog

// deno-lint-ignore no-import-prefix
import { fromFileUrl, join, resolve } from "jsr:@std/path@0.224.0";

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
  commit?: string;
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
    } else if (arg === "--commit") {
      if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
        options.commit = args[++i];
      }
    } else if (arg.startsWith("--commit=")) {
      options.commit = arg.slice("--commit=".length);
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
 * Resolves the genuine Deno executable path.
 * When rail is executed as a standalone compiled binary, Deno.execPath()
 * points to rail(.exe). To spawn `deno install`, we locate the genuine deno executable.
 */
export function resolveDenoExecutable(): string {
  const currentExec = Deno.execPath();
  const currentBase = currentExec.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (currentBase === "deno" || currentBase === "deno.exe") {
    return currentExec;
  }
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
  if (home) {
    const isWindows = Deno.build.os === "windows";
    const denoInHome = join(
      home,
      ".deno",
      "bin",
      isWindows ? "deno.exe" : "deno",
    );
    try {
      if (Deno.statSync(denoInHome).isFile) {
        return denoInHome;
      }
    } catch {
      // Continue search
    }
  }
  return "deno";
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
      output:
        `Invalid root directory path: contains forbidden shell characters`,
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
      const downloadRef = options.commit || ref;

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
        !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(downloadRef) ||
        downloadRef.includes("..") ||
        downloadRef.includes("//")
      ) {
        return {
          ok: false,
          installedPath: "",
          output: `Invalid git ref format: "${downloadRef}"`,
        };
      }

      const denoJsonUrl =
        `https://raw.githubusercontent.com/${repo}/${downloadRef}/deno.json`;

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
      target =
        `https://raw.githubusercontent.com/${repo}/${downloadRef}/cli/main.ts`;
    } else {
      // spec: contracts/platform.contract.md#PLAT-19 — Local repository resolution
      let localRootDir = import.meta.url.startsWith("file:")
        ? resolve(fromFileUrl(import.meta.url), "../..")
        : Deno.cwd();

      let found = false;
      let dir = localRootDir;
      for (let i = 0; i < 5; i++) {
        try {
          const statDeno = await Deno.stat(join(dir, "deno.json"));
          const statCli = await Deno.stat(join(dir, "cli", "main.ts"));
          if (statDeno.isFile && statCli.isFile) {
            localRootDir = dir;
            found = true;
            break;
          }
        } catch {
          // continue upwards
        }
        const parent = resolve(dir, "..");
        if (parent === dir) break;
        dir = parent;
      }

      if (!found) {
        dir = Deno.cwd();
        for (let i = 0; i < 5; i++) {
          try {
            const statDeno = await Deno.stat(join(dir, "deno.json"));
            const statCli = await Deno.stat(join(dir, "cli", "main.ts"));
            if (statDeno.isFile && statCli.isFile) {
              localRootDir = dir;
              found = true;
              break;
            }
          } catch {
            // continue upwards
          }
          const parent = resolve(dir, "..");
          if (parent === dir) break;
          dir = parent;
        }
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

    const cmd = new Deno.Command(resolveDenoExecutable(), {
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

    // On Windows, if installing as script shim (rail.cmd), remove any shadowing rail.exe
    if (!options.compile && Deno.build.os === "windows") {
      const exePath = join(paths.binDir, "rail.exe");
      try {
        await Deno.remove(exePath);
      } catch {
        // Best effort: may not exist or may be locked
      }
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

    // Record installation version and git commit metadata
    try {
      const meta = {
        version: "0.8.0",
        ref: options.ref ?? "main",
        commit: options.commit,
        installedAt: new Date().toISOString(),
      };
      await Deno.writeTextFile(
        join(paths.binDir, ".rail-version.json"),
        JSON.stringify(meta, null, 2),
      );
    } catch {
      // Best-effort metadata recording
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
 * Prints styled help message matching cli/ui.ts JetBrains Darcula design system.
 */
function printHelp(): void {
  const noColor = Boolean(
    Deno.env.get("NO_COLOR") || Deno.env.get("CI"),
  );
  const bold = (t: string) => noColor ? t : `\x1b[1m${t}\x1b[22m`;
  const dim = (t: string) => noColor ? t : `\x1b[2m${t}\x1b[22m`;
  const cyan = (t: string) => noColor ? t : `\x1b[36m${t}\x1b[39m`;
  const gray = (t: string) => noColor ? t : `\x1b[90m${t}\x1b[39m`;
  const bdr = (t: string) => noColor ? t : `\x1b[38;2;85;85;85m${t}\x1b[39m`;

  console.log("");
  console.log(bold(cyan("RailFog CLI Installer")));
  console.log(dim("Trigger -> Function -> {KV, Objects, Queues}"));
  console.log("");
  console.log(`${bold("Usage:")}`);
  console.log(`  deno run -A scripts/install.ts ${dim("[options]")}`);
  console.log(`  deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts ${dim("[options]")}`);
  console.log("");
  console.log(`${bold("Options:")}`);
  console.log(`  ${bold("-r")}, ${bold("--root")} ${dim("<dir>")}      Installation root directory`);
  console.log(`                        ${gray("(default: $DENO_INSTALL_ROOT, $RAILFOG_INSTALL_DIR, or ~/.deno)")}`);
  console.log(`  ${bold("-c")}, ${bold("--compile")}         Compile standalone executable instead of Deno script shim`);
  console.log(`  ${bold("-f")}, ${bold("--force")}           Force overwrite existing installation`);
  console.log(`  ${bold("-l")}, ${bold("--local")}           Install from local repository instead of GitHub`);
  console.log(`      ${bold("--ref")} ${dim("<ref>")}       Git ref/tag/branch to install ${gray("(default: main)")}`);
  console.log(`      ${bold("--commit")} ${dim("<sha>")}    Exact git commit SHA to install ${gray("(bypasses CDN caches)")}`);
  console.log(`      ${bold("--repo")} ${dim("<repo>")}     GitHub repository ${gray("(default: MoustafaAt1a/railfog)")}`);
  console.log(`  ${bold("-h")}, ${bold("--help")}            Show this help information`);
  console.log("");
  console.log(bdr("─".repeat(60)));
  console.log(`  ${cyan("[i]")} Run ${bold("rail --help")} after installation for CLI commands.`);
  console.log(bdr("─".repeat(60)));
  console.log("");
}

/**
 * Prints styled completion card matching cli/ui.ts JetBrains Darcula design.
 * Uses Unicode box-drawing, [+]/[!] indicators, and NO_COLOR compliance.
 */
function printSuccessBox(binaryPath: string, binDir: string): void {
  const noColor = Boolean(
    Deno.env.get("NO_COLOR") || Deno.env.get("CI"),
  );
  const bold = (t: string) => noColor ? t : `\x1b[1m${t}\x1b[22m`;
  const dim = (t: string) => noColor ? t : `\x1b[2m${t}\x1b[22m`;
  const green = (t: string) => noColor ? t : `\x1b[32m${t}\x1b[39m`;
  const cyan = (t: string) => noColor ? t : `\x1b[36m${t}\x1b[39m`;
  const amber = (t: string) =>
    noColor ? t : `\x1b[38;2;229;168;75m${t}\x1b[39m`;
  const bdr = (t: string) =>
    noColor ? t : `\x1b[38;2;85;85;85m${t}\x1b[39m`;

  const currentPath = Deno.env.get("PATH") ?? "";
  const isWindows = Deno.build.os === "windows";
  const inPath = isWindows
    ? currentPath.toLowerCase().includes(binDir.toLowerCase())
    : currentPath.split(":").includes(binDir);

  // Build content lines
  const contentLines: string[] = [
    `${green("[+]")} Installation complete`,
    "",
    `${dim("Executable:")}  ${binaryPath}`,
  ];

  if (!inPath) {
    contentLines.push("");
    contentLines.push(`${amber("[!]")} ${binDir} is not in your PATH.`);
    if (isWindows) {
      contentLines.push(
        `    Add it to your User PATH using PowerShell:`,
      );
      contentLines.push(
        `    ${bold(`[Environment]::SetEnvironmentVariable("Path", $env:Path + ";${binDir}", "User")`)}`,
      );
    } else {
      contentLines.push(
        "    Add the following to your shell profile (~/.bashrc or ~/.zshrc):",
      );
      contentLines.push(
        `    ${bold(`export PATH="${binDir}:$PATH"`)}`,
      );
    }
  }

  contentLines.push("");
  contentLines.push(
    `Run ${bold("rail --help")} or ${bold("rail login")} to get started!`,
  );

  // Measure max visible width
  let maxLen = 40;
  for (const line of contentLines) {
    const stripped = line.replace(
      // deno-lint-ignore no-control-regex
      /\x1b\[[0-9;?]*[a-zA-Z]/g,
      "",
    );
    if (stripped.length > maxLen) {
      maxLen = stripped.length;
    }
  }
  const innerWidth = maxLen + 4;
  const hBar = "─".repeat(innerWidth);

  // Card title
  const titleText = " RailFog CLI ";
  const titleDashes = "─".repeat(
    Math.max(0, innerWidth - titleText.length - 3),
  );

  console.log("");
  console.log(
    bdr("┌──") + bold(titleText) + bdr(titleDashes + "┐"),
  );
  console.log(bdr("│") + " ".repeat(innerWidth) + bdr("│"));

  for (const line of contentLines) {
    const stripped = line.replace(
      // deno-lint-ignore no-control-regex
      /\x1b\[[0-9;?]*[a-zA-Z]/g,
      "",
    );
    const padRight = " ".repeat(
      Math.max(0, innerWidth - stripped.length - 2),
    );
    console.log(bdr("│") + "  " + line + padRight + bdr("│"));
  }

  console.log(bdr("│") + " ".repeat(innerWidth) + bdr("│"));
  console.log(bdr("└" + hBar + "┘"));
  console.log("");
}

// spec: contracts/platform.contract.md#PLAT-19 — Main CLI entrypoint
if (import.meta.main) {
  const options = parseInstallerArgs(Deno.args);

  if (options.help) {
    printHelp();
    Deno.exit(0);
  }

  const noColor = Boolean(
    Deno.env.get("NO_COLOR") || Deno.env.get("CI"),
  );
  const bold = (t: string) => noColor ? t : `\x1b[1m${t}\x1b[22m`;
  const dim = (t: string) => noColor ? t : `\x1b[2m${t}\x1b[22m`;
  const cyan = (t: string) => noColor ? t : `\x1b[36m${t}\x1b[39m`;
  const red = (t: string) => noColor ? t : `\x1b[31m${t}\x1b[39m`;

  const paths = resolveInstallPaths(options);

  console.log("");
  console.log(bold(cyan("RailFog CLI Installer")));
  console.log(dim("Trigger -> Function -> {KV, Objects, Queues}"));
  console.log("");

  if (options.local) {
    console.log(`${cyan("[i]")} Source:  Local repository`);
  } else {
    console.log(
      `${cyan("[i]")} Source:  https://github.com/${
        options.repo ?? "MoustafaAt1a/railfog"
      } ${dim(`(ref: ${options.ref ?? "main"})`)}`,
    );
  }
  console.log(`${cyan("[i]")} Target:  ${paths.binDir}`);
  console.log("");

  const result = await runInstaller(options);
  if (!result.ok) {
    console.error(`\n${red("[-]")} ${bold("Installation failed:")}`);
    console.error(`    ${result.output}`);
    Deno.exit(1);
  }

  printSuccessBox(paths.fullBinaryPath, paths.binDir);
}
