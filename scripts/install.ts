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
  dryRun?: boolean;
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
    dryRun: false,
    root: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
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

// ============================================================================
// Display Helpers — JetBrains Darcula Design System
// ============================================================================

const ANSI_STRIP =
  // deno-lint-ignore no-control-regex
  /\x1b\[[0-9;?]*[a-zA-Z]/g;

function createStyles() {
  const noColor = Boolean(Deno.env.get("NO_COLOR") || Deno.env.get("CI"));
  return {
    noColor,
    bold: (t: string) => noColor ? t : `\x1b[1m${t}\x1b[22m`,
    dim: (t: string) => noColor ? t : `\x1b[2m${t}\x1b[22m`,
    green: (t: string) => noColor ? t : `\x1b[32m${t}\x1b[39m`,
    red: (t: string) => noColor ? t : `\x1b[31m${t}\x1b[39m`,
    cyan: (t: string) => noColor ? t : `\x1b[36m${t}\x1b[39m`,
    yellow: (t: string) => noColor ? t : `\x1b[33m${t}\x1b[39m`,
    gray: (t: string) => noColor ? t : `\x1b[90m${t}\x1b[39m`,
    amber: (t: string) =>
      noColor ? t : `\x1b[38;2;229;168;75m${t}\x1b[39m`,
    brand: (t: string) =>
      noColor ? t : `\x1b[38;2;152;118;170m${t}\x1b[39m`,
    emerald: (t: string) =>
      noColor ? t : `\x1b[38;2;98;151;85m${t}\x1b[39m`,
    bdr: (t: string) =>
      noColor ? t : `\x1b[38;2;85;85;85m${t}\x1b[39m`,
    ok: (msg: string) =>
      noColor ? `[+] ${msg}` : `\x1b[32m[+]\x1b[39m ${msg}`,
    fail: (msg: string) =>
      noColor ? `[-] ${msg}` : `\x1b[31m[-]\x1b[39m ${msg}`,
    info: (msg: string) =>
      noColor ? `[i] ${msg}` : `\x1b[36m[i]\x1b[39m ${msg}`,
    warn: (msg: string) =>
      noColor
        ? `[!] ${msg}`
        : `\x1b[38;2;229;168;75m[!]\x1b[39m ${msg}`,
  };
}

function visLen(text: string): number {
  return text.replace(ANSI_STRIP, "").length;
}

/**
 * Renders the RailFog pixel-art train locomotive (inline, no imports).
 * Matches cli/ui.ts renderTrainLogo output exactly.
 */
function renderTrainLogo(s: ReturnType<typeof createStyles>): string[] {
  if (s.noColor) {
    return [
      "       ┌──────┐",
      "         ████",
      "   ┌──────────────┐",
      "   │████  ██  ████│",
      "   │██████████████│",
      "   │██████████████│",
      "   │██  ██  ██  ██│",
      "   │██  ██  ██  ██│",
      "  ══════════════════",
    ];
  }
  const g = s.gray;
  const w = (t: string) => s.bold(t);
  return [
    `       ${g("┌──────┐")}`,
    `         ${w("████")}`,
    `   ${g("┌──────────────┐")}`,
    `   ${g("│")}${"████"}  ${w("██")}  ${"████"}${g("│")}`,
    `   ${g("│")}${"██████████████"}${g("│")}`,
    `   ${g("│")}${"██████████████"}${g("│")}`,
    `   ${g("│")}${s.gray("██  ██  ██  ██")}${g("│")}`,
    `   ${g("│")}${s.gray("██  ██  ██  ██")}${g("│")}`,
    `  ${s.gray("══════════════════")}`,
  ];
}

/**
 * Renders a mini railway progress track for a single step.
 *
 *   [1/3] ━━━━━━━━━━► Detecting platform ............... done
 */
function renderStepProgress(
  step: number,
  total: number,
  label: string,
  status: "ok" | "fail" | "skip",
  s: ReturnType<typeof createStyles>,
): string {
  const idx = `[${step}/${total}]`;
  const dots = ".".repeat(Math.max(1, 38 - label.length));
  const result = status === "ok"
    ? s.green("done")
    : status === "fail"
    ? s.red("fail")
    : s.gray("skip");
  return `  ${s.cyan(idx)} ${s.dim("━━━━━━━━►")} ${label} ${s.dim(dots)} ${result}`;
}

/**
 * Renders a bordered card with title in renderCard style.
 */
function renderInstallerCard(
  title: string,
  lines: string[],
  s: ReturnType<typeof createStyles>,
): string {
  let maxLen = 40;
  for (const l of lines) {
    const w = visLen(l);
    if (w > maxLen) maxLen = w;
  }
  const innerWidth = maxLen + 4;
  const titleText = ` ${title} `;
  const titleDashes = "─".repeat(
    Math.max(0, innerWidth - titleText.length - 3),
  );

  const out: string[] = [];
  out.push(s.bdr("┌──") + s.bold(titleText) + s.bdr(titleDashes + "┐"));
  out.push(s.bdr("│") + " ".repeat(innerWidth) + s.bdr("│"));

  for (const line of lines) {
    const pad = " ".repeat(Math.max(0, innerWidth - visLen(line) - 2));
    out.push(s.bdr("│") + "  " + line + pad + s.bdr("│"));
  }

  out.push(s.bdr("│") + " ".repeat(innerWidth) + s.bdr("│"));
  out.push(s.bdr("└" + "─".repeat(innerWidth) + "┘"));
  return out.join("\n");
}

/**
 * Prints styled help message matching cli/ui.ts JetBrains Darcula design system.
 */
function printHelp(): void {
  const s = createStyles();

  const logo = renderTrainLogo(s);
  console.log("");
  for (const l of logo) console.log("  " + l);
  console.log("");
  console.log(`  ${s.bold(s.brand("RailFog"))} ${s.bold(s.cyan("CLI Installer"))}`);
  console.log(`  ${s.dim("Trigger -> Function -> {KV, Objects, Queues}")}`);
  console.log("");
  console.log(`  ${s.bold("Usage:")}`);
  console.log(`    deno run -A scripts/install.ts ${s.dim("[options]")}`);
  console.log(`    deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts ${s.dim("[options]")}`);
  console.log("");
  console.log(`  ${s.bold("Options:")}`);
  console.log(`    ${s.bold("-r")}, ${s.bold("--root")} ${s.dim("<dir>")}      Installation root directory`);
  console.log(`                          ${s.gray("(default: $DENO_INSTALL_ROOT, $RAILFOG_INSTALL_DIR, or ~/.deno)")}`);
  console.log(`    ${s.bold("-c")}, ${s.bold("--compile")}         Compile standalone executable instead of Deno script shim`);
  console.log(`    ${s.bold("-f")}, ${s.bold("--force")}           Force overwrite existing installation`);
  console.log(`    ${s.bold("-l")}, ${s.bold("--local")}           Install from local repository instead of GitHub`);
  console.log(`        ${s.bold("--dry-run")}         Preview installation plan without modifying disk`);
  console.log(`        ${s.bold("--ref")} ${s.dim("<ref>")}       Git ref/tag/branch to install ${s.gray("(default: main)")}`);
  console.log(`        ${s.bold("--commit")} ${s.dim("<sha>")}    Exact git commit SHA to install ${s.gray("(bypasses CDN caches)")}`);
  console.log(`        ${s.bold("--repo")} ${s.dim("<repo>")}     GitHub repository ${s.gray("(default: MoustafaAt1a/railfog)")}`);
  console.log(`    ${s.bold("-h")}, ${s.bold("--help")}            Show this help information`);
  console.log("");
  console.log(`  ${s.bdr("─".repeat(60))}`);
  console.log(`    ${s.info(`Run ${s.bold("rail --help")} after installation for CLI commands.`)}`);
  console.log(`  ${s.bdr("─".repeat(60))}`);
  console.log("");
}

/**
 * Detects the user's current shell for completion hints.
 */
function detectShell(): string | null {
  const shell = Deno.env.get("SHELL") ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("bash")) return "bash";
  if (shell.includes("fish")) return "fish";
  if (Deno.build.os === "windows") return "powershell";
  const psModulePath = Deno.env.get("PSModulePath");
  if (psModulePath) return "powershell";
  return null;
}

/**
 * Detects existing rail installation and returns previous version if found.
 */
async function detectExistingVersion(
  binDir: string,
): Promise<string | null> {
  try {
    const metaPath = join(binDir, ".rail-version.json");
    const raw = await Deno.readTextFile(metaPath);
    const meta = JSON.parse(raw);
    return meta?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Computes SHA-256 hex digest of a file for integrity display.
 */
async function computeFileHash(path: string): Promise<string | null> {
  try {
    const data = await Deno.readFile(path);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(hash);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/**
 * Runs preflight diagnostic checks against the installed binary.
 */
async function runPreflight(
  paths: ReturnType<typeof resolveInstallPaths>,
  s: ReturnType<typeof createStyles>,
): Promise<string[]> {
  const checks: string[] = [];
  const dotPad = (label: string, width: number) =>
    label + " " + s.dim(".".repeat(Math.max(1, width - label.length))) + " ";

  // 1. rail --version
  try {
    const cmd = Deno.build.os === "windows" &&
        paths.fullBinaryPath.endsWith(".cmd")
      ? new Deno.Command("cmd.exe", {
        args: ["/c", paths.fullBinaryPath, "--version"],
        stdout: "piped",
        stderr: "piped",
      })
      : new Deno.Command(paths.fullBinaryPath, {
        args: ["--version"],
        stdout: "piped",
        stderr: "piped",
      });
    const proc = await cmd.output();
    const ver = new TextDecoder().decode(proc.stdout).trim();
    const verNum = ver.replace(/^rail\s*/i, "");
    checks.push(
      `${s.ok("")}${dotPad("rail --version", 28)}${s.bold(verNum)}`,
    );
  } catch {
    checks.push(
      `${s.fail("")}${dotPad("rail --version", 28)}${s.red("error")}`,
    );
  }

  // 2. PATH check
  const currentPath = Deno.env.get("PATH") ?? "";
  const inPath = Deno.build.os === "windows"
    ? currentPath.toLowerCase().includes(paths.binDir.toLowerCase())
    : currentPath.split(":").includes(paths.binDir);
  checks.push(
    inPath
      ? `${s.ok("")}${dotPad("PATH", 28)}${s.green("found")}`
      : `${s.warn("")}${dotPad("PATH", 28)}${s.amber("not found")}`,
  );

  // 3. Deno runtime
  const denoVer = Deno.version?.deno ?? "unknown";
  checks.push(
    `${s.ok("")}${dotPad("Deno runtime", 28)}${denoVer}`,
  );

  // 4. Shell completions hint
  const shell = detectShell();
  checks.push(
    shell
      ? `${s.info("")}${dotPad("Shell detected", 28)}${shell} ${s.dim("(run rail completions " + shell + ")")}`
      : `${s.dim("    ")}${dotPad("Shell detected", 28)}${s.dim("none")}`,
  );

  return checks;
}

// ============================================================================
// Main CLI Entrypoint
// ============================================================================

/**
 * Measures round-trip latency to the closest CDN / Control Plane endpoint.
 */
async function measureLatency(url = "https://raw.githubusercontent.com"): Promise<number | null> {
  try {
    const start = performance.now();
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(1200) });
    if (res.status > 0) {
      return Math.round(performance.now() - start);
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Main CLI Entrypoint
// ============================================================================

// spec: contracts/platform.contract.md#PLAT-19 — Main CLI entrypoint
if (import.meta.main) {
  const options = parseInstallerArgs(Deno.args);

  if (options.help) {
    printHelp();
    Deno.exit(0);
  }

  const s = createStyles();
  const paths = resolveInstallPaths(options);

  // -------------------------------------------------------------------------
  // Header with train logo
  // -------------------------------------------------------------------------
  const logo = renderTrainLogo(s);
  console.log("");
  for (const l of logo) console.log("    " + l);
  console.log("");
  console.log(`    ${s.bold(s.brand("RailFog"))} ${s.bold(s.cyan("CLI Installer"))}`);
  console.log(`    ${s.dim("Trigger -> Function -> {KV, Objects, Queues}")}`);
  console.log("");

  // -------------------------------------------------------------------------
  // Detect existing installation for upgrade diff
  // -------------------------------------------------------------------------
  const previousVersion = await detectExistingVersion(paths.binDir);

  // -------------------------------------------------------------------------
  // Step 1/3: Detect platform & network
  // -------------------------------------------------------------------------
  console.log(
    renderStepProgress(1, 3, "Detecting platform & edge station", "ok", s),
  );
  if (options.local) {
    console.log(`         ${s.info("Source:    Local repository")}`);
  } else {
    console.log(
      `         ${s.info(`Source:    https://github.com/${
        options.repo ?? "MoustafaAt1a/railfog"
      } ${s.dim(`(ref: ${options.ref ?? "main"})`)}`)}`,
    );
  }
  console.log(
    `         ${s.info(`Target:    ${paths.binDir}`)}`,
  );
  console.log(
    `         ${s.info(`Platform:  ${Deno.build.os}-${Deno.build.arch}`)}`,
  );

  const latency = options.local ? null : await measureLatency();
  if (latency !== null) {
    console.log(
      `         ${s.info(`Edge Ping: ${latency}ms to Edge CDN ${s.green("(Status: Green)")}`)}`,
    );
  }
  console.log("");

  // -------------------------------------------------------------------------
  // Step 2/3: Download and install (or simulated in --dry-run)
  // -------------------------------------------------------------------------
  if (options.dryRun) {
    console.log(
      renderStepProgress(2, 3, "Installing binary (dry run)", "skip", s),
    );
    console.log(`         ${s.info(s.amber("[DRY RUN] Skipping file writes and environment modifications"))}`);
    console.log("");
  } else {
    const result = await runInstaller(options);
    if (!result.ok) {
      console.log(
        renderStepProgress(2, 3, "Installing binary", "fail", s),
      );
      console.log("");
      console.error(`  ${s.fail(s.bold("Installation failed:"))}`);
      console.error(`    ${result.output}`);
      Deno.exit(1);
    }
    console.log(
      renderStepProgress(2, 3, "Installing binary", "ok", s),
    );
    console.log("");
  }

  // -------------------------------------------------------------------------
  // Step 3/3: Verify installation
  // -------------------------------------------------------------------------
  const preflightResults = options.dryRun
    ? [
      `${s.ok("")}rail --version               ${s.bold("0.8.0 (preview)")}`,
      `${s.ok("")}PATH                         ${s.green("simulated")}`,
      `${s.ok("")}Deno runtime                 ${Deno.version?.deno ?? "unknown"}`,
    ]
    : await runPreflight(paths, s);

  console.log(
    renderStepProgress(3, 3, "Verifying installation", "ok", s),
  );
  console.log("");

  // -------------------------------------------------------------------------
  // SHA-256 integrity
  // -------------------------------------------------------------------------
  const hash = options.dryRun ? null : await computeFileHash(paths.fullBinaryPath);

  // -------------------------------------------------------------------------
  // Build Official Inbound Passenger Ticket
  // -------------------------------------------------------------------------
  const isUpgrade = previousVersion && previousVersion !== "0.8.0";
  const ticketId = `#RF-080-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;

  const cardTitle = options.dryRun
    ? "RailFog Express: Boarding Pass [DRY RUN]"
    : isUpgrade
    ? "RailFog Express: Upgrade Ticket"
    : "RailFog Express: Inbound Passenger Ticket";

  const cardLines: string[] = [];

  // Ticket Header Metadata
  cardLines.push(`${s.bold(s.cyan("TICKET NO:"))}    ${s.bold(ticketId)}`);
  cardLines.push(`${s.dim("ORIGIN:")}       Local Workstation ${s.dim(`(${Deno.build.os}-${Deno.build.arch})`)}`);
  cardLines.push(`${s.dim("DESTINATION:")}  Production Edge Station`);
  cardLines.push(`${s.dim("CLASS:")}        Developer Fast-Track`);

  if (isUpgrade) {
    cardLines.push(`${s.dim("STATUS:")}       ${s.ok(s.bold(`UPGRADED (${previousVersion} -> 0.8.0)`))}`);
  } else if (options.dryRun) {
    cardLines.push(`${s.dim("STATUS:")}       ${s.amber(s.bold("PREVIEW ONLY (No changes applied)"))}`);
  } else {
    cardLines.push(`${s.dim("STATUS:")}       ${s.ok(s.bold("COUPLED & CLEARED FOR RUN"))}`);
  }

  cardLines.push("");
  cardLines.push(`${s.dim("EXECUTABLE:")}   ${paths.fullBinaryPath}`);
  if (hash) {
    const shortHash = `sha256:${hash.slice(0, 16)}...${hash.slice(-8)}`;
    cardLines.push(`${s.dim("INTEGRITY:")}    ${s.gray(shortHash)}`);
  }

  // Preflight diagnostics
  cardLines.push("");
  cardLines.push(s.bold("Preflight Signal Board:"));
  for (const check of preflightResults) {
    cardLines.push(`  ${check}`);
  }

  // PATH warning
  const currentPath = Deno.env.get("PATH") ?? "";
  const inPath = Deno.build.os === "windows"
    ? currentPath.toLowerCase().includes(paths.binDir.toLowerCase())
    : currentPath.split(":").includes(paths.binDir);

  if (!inPath && !options.dryRun) {
    cardLines.push("");
    cardLines.push(
      `${s.warn(`${paths.binDir} is not in your PATH.`)}`,
    );
    if (Deno.build.os === "windows") {
      cardLines.push(
        `    ${s.bold(`[Environment]::SetEnvironmentVariable("Path", $env:Path + ";${paths.binDir}", "User")`)}`,
      );
    } else {
      cardLines.push(
        `    ${s.bold(`export PATH="${paths.binDir}:$PATH"`)}`,
      );
    }
  }

  // Boarding Steps
  cardLines.push("");
  cardLines.push(s.bold("Boarding Instructions:"));
  cardLines.push(
    `  ${s.cyan("1.")}  ${s.bold("rail login")}              ${s.dim("Authenticate with Control Plane")}`,
  );
  cardLines.push(
    `  ${s.cyan("2.")}  ${s.bold("rail init my-app")}        ${s.dim("Scaffold your first 4-primitive train")}`,
  );
  cardLines.push(
    `  ${s.cyan("3.")}  ${s.bold("rail deploy")}             ${s.dim("Dispatch to production edge")}`,
  );

  console.log(renderInstallerCard(cardTitle, cardLines, s));
  console.log("");
}
