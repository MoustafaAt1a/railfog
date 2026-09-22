// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & CLI entrypoint
// spec: docs/CONSTITUTION.md — SOLID + OOP at module boundaries, Data-Oriented Design in hot paths
// cli/main.ts — RailFog unified CLI orchestrator and command dispatcher

import { join, resolve } from "@std/path";
import { parse } from "@std/toml";
import type { PricingRates } from "../packages/metrics/cost-calculator.ts";
import {
  formatStartupBanner,
  type LocalServer,
  normalizeRoutes,
  type RailfogConfig,
  startLocalServer,
} from "../runtime/dev-server/local-server.ts";
import {
  addCommand,
  type AddOptions,
  type AddResult,
  printAddHelp,
  runAdd,
} from "./add.ts";
import {
  checkCommand,
  checkProject,
  type CheckResult,
  normalizeFunctions,
  printCheckHelp,
  runCheck,
  type ValidationIssue,
} from "./check.ts";
import {
  compareCommand,
  printCompareHelp,
} from "./compare.ts";
import {
  completionsCommand,
  generateBashCompletion,
  generateCompletions,
  generateFishCompletion,
  generatePowerShellCompletion,
  generateZshCompletion,
  printCompletionsHelp,
  runCompletions,
  type SupportedShell,
} from "./completions.ts";
import {
  deployCommand,
  type DeployCommandOptions,
  type DeployCommandResult,
  type DeployOptions,
  type DeploySummary,
  printDeployHelp,
  runDeploy,
} from "./deploy.ts";
import {
  devCommand,
  type DevOptions,
  printDevHelp,
  runDev,
} from "./dev.ts";
import {
  doctorCommand,
  type DoctorOptions,
  type DoctorResult,
  printDoctorHelp,
  runDoctor,
} from "./doctor.ts";
import {
  initCommand,
  type InitOptions,
  type InitResult,
  type InteractiveInitOptions,
  printInitHelp,
  runInit,
  runInteractiveInit,
  STARTER_CONFIG,
  STARTER_FUNCTION,
} from "./init.ts";
import {
  loginCommand,
  type LoginOptions,
  type LoginResult,
  logoutCommand,
  printLoginHelp,
  printLogoutHelp,
  printWhoamiHelp,
  runLogin,
  runLogout,
  runWhoami,
  systemOpenBrowser,
  whoamiCommand,
} from "./login.ts";
import {
  formatLogEntry,
  type LogEntry,
  logsCommand,
  type LogsCliOptions,
  printLogsHelp,
  runLogs,
} from "./logs.ts";
import {
  printRollbackHelp,
  rollbackCommand,
  type RollbackCommandOptions,
  type RollbackCommandResult,
  runRollback,
} from "./rollback.ts";
import {
  printSecretsHelp,
  runSecrets,
  type SecretCliOptions,
  type SecretListEntry,
  secretsCommand,
} from "./secrets.ts";
import {
  printSimulateHelp,
  runSimulate,
  simulateCommand,
  type SimulateOptions,
} from "./simulate.ts";
import {
  createSignalSpinner,
  createSpinner,
  createTrackSpinner,
  createWheelSpinner,
  SPINNER_STYLES,
} from "./spinner.ts";
import {
  exportCommand,
  type ExportCommandOptions,
  importCommand,
  type ImportCommandOptions,
  printExportHelp,
  printImportHelp,
} from "./state.ts";
import {
  printStatusHelp,
  statusCommand,
  type StatusOptions,
} from "./status.ts";
import {
  animateSignalLantern,
  animateSteamTrain,
  colors,
  glyphs,
  renderBoardingPass,
  renderBrandHeader,
  renderCard,
  renderCompetitiveMatrix,
  renderDepartureBoard,
  renderErrorCard,
  renderFreightExpressCard,
  renderModernTable,
  renderProgressBar,
  renderReleaseTrainCard,
  renderRouteSimulatorCard,
  renderStationSignalBoard,
  renderStatusBar,
  renderTrainLogo,
  renderTree,
  wrapText,
} from "./ui.ts";
import {
  printUndeployHelp,
  runUndeploy,
  undeployCommand,
  type UndeployCommandOptions,
  type UndeployCommandResult,
} from "./undeploy.ts";
import {
  printUninstallHelp,
  runUninstall,
  uninstallCommand,
  type UninstallResult,
} from "./uninstall.ts";
import {
  printUpgradeHelp,
  runUpgrade,
  upgradeCommand,
  type UpgradeOptions,
  type UpgradeResult,
} from "./upgrade.ts";
import {
  formatUsageReport,
  printUsageHelp,
  runUsage,
  type UsageCliOptions,
  usageCommand,
} from "./usage.ts";
import { CLI_VERSION } from "./version.ts";

export {
  addCommand,
  animateSignalLantern,
  animateSteamTrain,
  checkCommand,
  checkProject,
  CLI_VERSION,
  colors,
  compareCommand,
  completionsCommand,
  createSignalSpinner,
  createSpinner,
  createTrackSpinner,
  createWheelSpinner,
  deployCommand,
  devCommand,
  doctorCommand,
  exportCommand,
  formatLogEntry,
  formatStartupBanner,
  formatUsageReport,
  generateBashCompletion,
  generateCompletions,
  generateFishCompletion,
  generatePowerShellCompletion,
  generateZshCompletion,
  glyphs,
  importCommand,
  initCommand,
  loginCommand,
  logoutCommand,
  logsCommand,
  normalizeFunctions,
  normalizeRoutes,
  printAddHelp,
  printCheckHelp,
  printCompareHelp,
  printCompletionsHelp,
  printDeployHelp,
  printDevHelp,
  printDoctorHelp,
  printExportHelp,
  printImportHelp,
  printInitHelp,
  printLoginHelp,
  printLogoutHelp,
  printLogsHelp,
  printRollbackHelp,
  printSecretsHelp,
  printSimulateHelp,
  printStatusHelp,
  printUndeployHelp,
  printUninstallHelp,
  printUpgradeHelp,
  printUsageHelp,
  printWhoamiHelp,
  renderBoardingPass,
  renderBrandHeader,
  renderCard,
  renderCompetitiveMatrix,
  renderDepartureBoard,
  renderErrorCard,
  renderFreightExpressCard,
  renderModernTable,
  renderProgressBar,
  renderReleaseTrainCard,
  renderRouteSimulatorCard,
  renderStationSignalBoard,
  renderStatusBar,
  renderTrainLogo,
  renderTree,
  rollbackCommand,
  runAdd,
  runCheck,
  runCompletions,
  runDeploy,
  runDev,
  runDoctor,
  runInit,
  runInteractiveInit,
  runLogin,
  runLogout,
  runLogs,
  runRollback,
  runSecrets,
  runSimulate,
  runUndeploy,
  runUninstall,
  runUpgrade,
  runUsage,
  runWhoami,
  secretsCommand,
  simulateCommand,
  SPINNER_STYLES,
  STARTER_CONFIG,
  STARTER_FUNCTION,
  startLocalServer,
  statusCommand,
  systemOpenBrowser,
  undeployCommand,
  uninstallCommand,
  upgradeCommand,
  usageCommand,
  whoamiCommand,
  wrapText,
};

export type {
  AddOptions,
  AddResult,
  CheckResult,
  DeployCommandOptions,
  DeployCommandResult,
  DeployOptions,
  DeploySummary,
  DevOptions,
  DoctorOptions,
  DoctorResult,
  ExportCommandOptions,
  ImportCommandOptions,
  InitOptions,
  InitResult,
  InteractiveInitOptions,
  LocalServer,
  LogEntry,
  LoginOptions,
  LoginResult,
  LogsCliOptions,
  PricingRates,
  RailfogConfig,
  RollbackCommandOptions,
  RollbackCommandResult,
  SecretCliOptions,
  SecretListEntry,
  SimulateOptions,
  StatusOptions,
  SupportedShell,
  UndeployCommandOptions,
  UndeployCommandResult,
  UninstallResult,
  UpgradeOptions,
  UpgradeResult,
  UsageCliOptions,
  ValidationIssue,
};

function printGeneralHelp(): void {
  console.log(renderBrandHeader(CLI_VERSION));
  console.log(`
${colors.bold("Usage:")}
  rail <command> [options]

${colors.bold(colors.accent("== [Project & Build] =="))}
  init      Initialize a new RailFog project in the current directory
  dev       Start the local development server with hot-reload
  deploy    Deploy functions and configuration to the Control Plane
  undeploy  Safely undeploy and remove a project from the cloud
  status    Show status of functions and routes in railfog.toml
  check     Validate railfog.toml configuration and route patterns
  simulate  Simulate edge route dispatch & capability matrix (alias: sim)
  doctor    Inspect platform health, track signals & V8 isolate benchmark
  compare   Display architectural comparison vs AWS Lambda & Cloudflare
  add       Add a dependency or primitive to deno.json

${colors.bold(colors.accent("== [Security & Identity] =="))}
  login     Authenticate your session via browser or API token
  logout    Log out and remove local credentials
  whoami    Display currently authenticated organization and key
  secrets   Manage encrypted project secrets (set, list, delete)

${colors.bold(colors.accent("== [Services & Observability] =="))}
  logs      Stream and filter structured runtime logs
  rollback  Rollback a function to a previous revision instantly
  usage     Display resource consumption and itemized cost breakdown
  cost      Alias for usage subcommand
  export    Export project state to a disaster recovery archive
  import    Import and restore project state from a disaster recovery archive

${colors.bold(colors.accent("== [System & Maintenance] =="))}
  upgrade      Upgrade the RailFog CLI to the latest version
  update       Alias for upgrade subcommand
  sync         Sync CLI with the latest git updates (alias for update)
  uninstall    Remove the RailFog CLI binary and metadata
  completions  Generate shell auto-completion scripts (pwsh, bash, zsh, fish)

${colors.bold("Options:")}
  -v, --version  Show CLI version
  -h, --help     Show help information

${
    colors.amber(colors.bold("[Tip]"))
  } Run 'rail <command> --help' for detailed documentation on any command.`);
}

/**
 * Calculates the Levenshtein edit distance between two strings.
 * Minimalist dynamic programming: O(m * n) time, O(min(m, n)) space.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const m = a.length;
  const n = b.length;
  const prevRow = new Array<number>(n + 1);
  const currRow = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prevRow[j] = j;

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1,
        currRow[j - 1] + 1,
        prevRow[j - 1] + cost,
      );
    }
    for (let j = 0; j <= n; j++) {
      prevRow[j] = currRow[j];
    }
  }

  return prevRow[n];
}

const KNOWN_COMMANDS = [
  "init",
  "dev",
  "deploy",
  "status",
  "check",
  "doctor",
  "simulate",
  "sim",
  "compare",
  "add",
  "login",
  "logout",
  "whoami",
  "logs",
  "secrets",
  "rollback",
  "undeploy",
  "usage",
  "cost",
  "export",
  "import",
  "upgrade",
  "update",
  "sync",
  "uninstall",
  "completions",
  "completion",
];

export function findClosestCommand(cmd: string): string | null {
  let closest: string | null = null;
  let minDistance = 3;

  for (const known of KNOWN_COMMANDS) {
    const dist = levenshtein(cmd.toLowerCase(), known);
    if (dist < minDistance) {
      minDistance = dist;
      closest = known;
    }
  }
  return closest;
}

/**
 * Prompts the user to select an action in the interactive Project Launcher.
 * Supports smooth Arrow Up/Down navigation and Enter/number selection.
 */
async function promptActionSelection(
  appName: string,
  cwd: string,
): Promise<string> {
  const actions = [
    {
      key: "1",
      tag: "[DEV]",
      cmd: "dev",
      desc: "Depart local station (Start dev server with hot-reload)",
    },
    {
      key: "2",
      tag: "[STATUS]",
      cmd: "status",
      desc: "Check route schedule (Inspect functions & routes)",
    },
    {
      key: "3",
      tag: "[CHECK]",
      cmd: "check",
      desc: "Inspect track & signal (Validate railfog.toml schema)",
    },
    {
      key: "4",
      tag: "[DEPLOY]",
      cmd: "deploy",
      desc: "Board express to cloud (Deploy revision to Edge)",
    },
    {
      key: "5",
      tag: "[LOGS]",
      cmd: "logs",
      desc: "Stream runtime logs (Follow execution traffic)",
    },
    {
      key: "6",
      tag: "[DOCTOR]",
      cmd: "doctor",
      desc: "Inspect station signals & V8 isolate health",
    },
    {
      key: "7",
      tag: "[SIMULATE]",
      cmd: "simulate",
      desc: "Simulate edge route dispatch & capabilities",
    },
    {
      key: "8",
      tag: "[COMPARE]",
      cmd: "compare",
      desc: "Architectural comparison vs AWS Lambda & Cloudflare",
    },
    {
      key: "0",
      tag: "[HELP]",
      cmd: "help",
      desc: "Station handbook (Display full CLI command manual)",
    },
  ];

  // Try raw interactive arrow-key navigation if both stdin and stdout are interactive TTYs
  if (
    typeof Deno.stdin.setRaw === "function" &&
    typeof Deno.stdin.isTerminal === "function" &&
    Deno.stdin.isTerminal() &&
    typeof Deno.stdout.isTerminal === "function" &&
    Deno.stdout.isTerminal() &&
    !Deno.env.get("CI")
  ) {
    let selectedIndex = 0;

    const renderLines = () => {
      const cardLines = [
        `Active Project: ${colors.bold(colors.accent(appName))}`,
        `Location:       ${cwd}`,
        "",
        ...actions.map((a, i) => {
          const isSel = i === selectedIndex;
          const ptr = isSel ? colors.accent("-->") : "   ";
          const keyBadge = colors.accent(`[${a.key}]`);
          const tagBadge = isSel
            ? colors.bold(colors.white(a.tag))
            : colors.slate(a.tag);
          const cmdText = isSel
            ? colors.bold(colors.accent(a.cmd.padEnd(8)))
            : colors.bold(a.cmd.padEnd(8));
          const descText = isSel ? a.desc : colors.dim(a.desc);
          return `${ptr} ${keyBadge} ${tagBadge} ${cmdText} ${descText}`;
        }),
      ];
      return renderCard("RailFog Station Launcher", cardLines);
    };

    let lineCount = 0;
    const draw = (initial = false) => {
      if (!initial && lineCount > 0) {
        Deno.stdout.writeSync(new TextEncoder().encode(`\x1b[${lineCount}A\r`));
      }
      const menu = renderLines();
      const promptLine = `  ${
        colors.dim(
          "Use [Up/Down] arrows or type [0-8], then press [Enter] (default: dev):",
        )
      }\x1b[K\n`;
      const fullText = menu + "\n" + promptLine;
      Deno.stdout.writeSync(new TextEncoder().encode(fullText));
      lineCount = fullText.split("\n").length - 1;
    };

    try {
      Deno.stdin.setRaw(true);
      draw(true);
      const buf = new Uint8Array(8);

      while (true) {
        const n = await Deno.stdin.read(buf);
        if (n === null || n === 0) break;

        // Ctrl+C (3)
        if (buf[0] === 3) {
          Deno.stdin.setRaw(false);
          Deno.exit(0);
        }
        // Enter: 13 (\r) or 10 (\n)
        if (buf[0] === 13 || buf[0] === 10) {
          Deno.stdin.setRaw(false);
          return actions[selectedIndex].key;
        }
        // Arrow Up: \x1b[A (27, 91, 65)
        if (buf[0] === 27 && buf[1] === 91 && buf[2] === 65) {
          selectedIndex = (selectedIndex - 1 + actions.length) % actions.length;
          draw();
        }
        // Arrow Down: \x1b[B (27, 91, 66)
        if (buf[0] === 27 && buf[1] === 91 && buf[2] === 66) {
          selectedIndex = (selectedIndex + 1) % actions.length;
          draw();
        }
        // Direct number keys
        const char = String.fromCharCode(buf[0]);
        const match = actions.find((a) => a.key === char);
        if (match) {
          Deno.stdin.setRaw(false);
          return match.key;
        }
        // 'q' or 'Q' to quit
        if (char === "q" || char === "Q") {
          Deno.stdin.setRaw(false);
          Deno.exit(0);
        }
      }
    } catch {
      // Fallback to normal prompt if raw mode throws
    } finally {
      try {
        Deno.stdin.setRaw(false);
      } catch {
        // ignore
      }
    }
  }

  // Fallback prompt for non-raw interactive terminals
  console.log(
    renderCard(
      "RailFog Station Launcher",
      [
        `Active Project: ${colors.bold(colors.accent(appName))}`,
        `Location:       ${cwd}`,
        "",
        ...actions.map((a) =>
          `  ${colors.accent(`[${a.key}]`)} ${colors.slate(a.tag)} ${
            colors.bold(a.cmd.padEnd(8))
          } ${a.desc}`
        ),
      ],
    ),
  );
  const choice = prompt("Select an action [0-8] (default: 1 dev):");
  return choice?.trim().toLowerCase() ?? "";
}

/**
 * Main command dispatcher for the RailFog CLI.
 *
 * @spec contracts/platform.contract.md#PLAT-19
 */
export async function main(args: string[] = Deno.args): Promise<void> {
  // spec: PLAT-19, T-0814 AC 1 — Top-level --version and -v flag handling
  if (
    args[0] === "--version" ||
    args[0] === "-v" ||
    args[0] === "version"
  ) {
    console.log(`rail ${CLI_VERSION}`);
    return;
  }

  const command = args[0];

  if (command === "-h" || command === "--help") {
    printGeneralHelp();
    return;
  }

  switch (command) {
    case "init": {
      let hasPositionalDir = false;
      let directory: string | undefined;
      let projectName: string | undefined;
      let template: "minimal" | "worked-example" | undefined;
      let force = false;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printInitHelp();
          return;
        }
        if (arg === "-f" || arg === "--force") {
          force = true;
        } else if (arg === "--template" && args[i + 1]) {
          template = args[i + 1] as "minimal" | "worked-example";
          i++;
        } else if (arg.startsWith("--template=")) {
          template = arg.slice("--template=".length) as
            | "minimal"
            | "worked-example";
        } else if ((arg === "--name" || arg === "-n" || arg === "--project" || arg === "-p") && args[i + 1]) {
          projectName = args[i + 1];
          i++;
        } else if (arg.startsWith("--name=")) {
          projectName = arg.slice("--name=".length);
        } else if (arg.startsWith("--project=")) {
          projectName = arg.slice("--project=".length);
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          directory = args[i + 1];
          hasPositionalDir = true;
          i++;
        } else if (arg.startsWith("--dir=")) {
          directory = arg.slice("--dir=".length);
          hasPositionalDir = true;
        } else if (arg.startsWith("--cwd=")) {
          directory = arg.slice("--cwd=".length);
          hasPositionalDir = true;
        } else if (arg.startsWith("--project-dir=")) {
          directory = arg.slice("--project-dir=".length);
          hasPositionalDir = true;
        } else if (!arg.startsWith("-")) {
          directory = arg;
          hasPositionalDir = true;
        }
      }

      try {
        if (hasPositionalDir) {
          await runInit({
            directory: directory!,
            projectName,
            template,
            force,
          });
          console.log("Initialized RailFog project.");
        } else {
          await runInteractiveInit({ projectName, template, force });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        Deno.exit(1);
      }
      break;
    }

    case "add": {
      let pkg: string | undefined;
      let cwd = Deno.cwd();

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printAddHelp();
          return;
        }
        if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          cwd = resolve(args[i + 1]);
          i++;
        } else if (arg.startsWith("--dir=")) {
          cwd = resolve(arg.slice("--dir=".length));
        } else if (arg.startsWith("--cwd=")) {
          cwd = resolve(arg.slice("--cwd=".length));
        } else if (arg.startsWith("--project-dir=")) {
          cwd = resolve(arg.slice("--project-dir=".length));
        } else if (!arg.startsWith("-") && !pkg) {
          pkg = arg;
        }
      }

      if (!pkg) {
        console.error(
          "Error: Missing package argument. Supported additions: sdk",
        );
        Deno.exit(1);
      }

      try {
        await addCommand(pkg, cwd);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        Deno.exit(1);
      }
      break;
    }

    case "status": {
      let cwd = Deno.cwd();
      let json = false;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printStatusHelp();
          return;
        }
        if (arg === "--json" || arg === "--format=json") {
          json = true;
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          cwd = resolve(args[i + 1]);
          i++;
        } else if (arg.startsWith("--dir=")) {
          cwd = resolve(arg.slice("--dir=".length));
        } else if (arg.startsWith("--cwd=")) {
          cwd = resolve(arg.slice("--cwd=".length));
        } else if (arg.startsWith("--project-dir=")) {
          cwd = resolve(arg.slice("--project-dir=".length));
        } else if (!arg.startsWith("-")) {
          cwd = resolve(arg);
        }
      }

      await statusCommand(cwd, { json });
      break;
    }

    case "check": {
      let targetPath: string | undefined;
      let json = false;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printCheckHelp();
          return;
        }
        if (arg === "--json" || arg === "--format=json") {
          json = true;
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          targetPath = args[i + 1];
          i++;
        } else if (arg.startsWith("--dir=")) {
          targetPath = arg.slice("--dir=".length);
        } else if (arg.startsWith("--cwd=")) {
          targetPath = arg.slice("--cwd=".length);
        } else if (arg.startsWith("--project-dir=")) {
          targetPath = arg.slice("--project-dir=".length);
        } else if (!arg.startsWith("-") && !targetPath) {
          targetPath = arg;
        }
      }

      const exitCode = await runCheck(targetPath ?? Deno.cwd(), { json });
      if (exitCode !== 0) {
        Deno.exit(exitCode);
      }
      break;
    }

    case "doctor": {
      let compare = false;
      let targetPath: string | undefined;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printDoctorHelp();
          return;
        }
        if (arg === "-c" || arg === "--compare") {
          compare = true;
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          targetPath = args[i + 1];
          i++;
        } else if (arg.startsWith("--dir=")) {
          targetPath = arg.slice("--dir=".length);
        } else if (arg.startsWith("--cwd=")) {
          targetPath = arg.slice("--cwd=".length);
        } else if (arg.startsWith("--project-dir=")) {
          targetPath = arg.slice("--project-dir=".length);
        } else if (!arg.startsWith("-") && !targetPath) {
          targetPath = arg;
        }
      }

      const res = await doctorCommand({ cwd: targetPath ?? Deno.cwd(), compare });
      if (!res.healthy) {
        Deno.exit(1);
      }
      break;
    }

    case "simulate":
    case "sim": {
      let method: string | undefined;
      let targetPath: string | undefined;
      let targetDir: string | undefined;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printSimulateHelp();
          return;
        }
        if (arg === "-m" || arg === "--method") {
          method = args[i + 1];
          i++;
        } else if (arg.startsWith("--method=")) {
          method = arg.slice("--method=".length);
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          targetDir = args[i + 1];
          i++;
        } else if (arg.startsWith("--dir=")) {
          targetDir = arg.slice("--dir=".length);
        } else if (arg.startsWith("--cwd=")) {
          targetDir = arg.slice("--cwd=".length);
        } else if (arg.startsWith("--project-dir=")) {
          targetDir = arg.slice("--project-dir=".length);
        } else if (!arg.startsWith("-") && !targetPath) {
          targetPath = arg;
        }
      }

      if (!targetPath) {
        targetPath = "/";
      }

      try {
        await simulateCommand(targetPath, { cwd: targetDir ?? Deno.cwd(), method });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        Deno.exit(1);
      }
      break;
    }

    case "compare": {
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printCompareHelp();
          return;
        }
      }
      compareCommand();
      break;
    }

    case "dev": {
      let port: number | undefined;
      let host: string | undefined;
      let watch = true;
      let cwd = Deno.cwd();

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printDevHelp();
          return;
        }
        if ((arg === "-p" || arg === "--port") && args[i + 1]) {
          port = parseInt(args[i + 1], 10);
          i++;
        } else if (arg.startsWith("--port=")) {
          port = parseInt(arg.slice("--port=".length), 10);
        } else if (arg === "--host" && args[i + 1]) {
          host = args[i + 1];
          i++;
        } else if (arg.startsWith("--host=")) {
          host = arg.slice("--host=".length);
        } else if (arg === "--no-watch") {
          watch = false;
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          cwd = resolve(args[i + 1]);
          i++;
        } else if (arg.startsWith("--dir=")) {
          cwd = resolve(arg.slice("--dir=".length));
        } else if (arg.startsWith("--cwd=")) {
          cwd = resolve(arg.slice("--cwd=".length));
        } else if (arg.startsWith("--project-dir=")) {
          cwd = resolve(arg.slice("--project-dir=".length));
        }
      }

      await runDev({ cwd, port, host, watch });
      break;
    }

    case "deploy": {
      let controlPlaneUrl: string | undefined;
      let project: string | undefined;
      let token: string | undefined;
      let env: string | undefined;
      let cwd = Deno.cwd();
      let json = false;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printDeployHelp();
          return;
        }
        // spec: docs/contracts/platform.contract.md#PLAT-3, PLAT-20 — Banned patterns: canary & traffic splitting
        if (
          arg === "--canary" || arg.startsWith("--canary=") ||
          arg === "--weight" || arg.startsWith("--weight=")
        ) {
          console.error(
            "Error: Canary deployments and traffic splitting are unsupported (PLAT-3, PLAT-20)",
          );
          Deno.exit(1);
        }
        if (arg === "--json" || arg === "--format=json") {
          json = true;
        } else if ((arg === "--control-url" || arg === "--control-plane-url") && args[i + 1]) {
          controlPlaneUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlPlaneUrl = arg.slice("--control-url=".length);
        } else if (arg.startsWith("--control-plane-url=")) {
          controlPlaneUrl = arg.slice("--control-plane-url=".length);
        } else if ((arg === "--project" || arg === "-p" || arg === "--name" || arg === "-n") && args[i + 1]) {
          project = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          project = arg.slice("--project=".length);
        } else if (arg.startsWith("--name=")) {
          project = arg.slice("--name=".length);
        } else if ((arg === "--env" || arg === "-e") && args[i + 1]) {
          env = args[i + 1];
          i++;
        } else if (arg.startsWith("--env=")) {
          env = arg.slice("--env=".length);
        } else if (arg === "--token" && args[i + 1]) {
          token = args[i + 1];
          i++;
        } else if (arg.startsWith("--token=")) {
          token = arg.slice("--token=".length);
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          cwd = resolve(args[i + 1]);
          i++;
        } else if (arg.startsWith("--dir=")) {
          cwd = resolve(arg.slice("--dir=".length));
        } else if (arg.startsWith("--cwd=")) {
          cwd = resolve(arg.slice("--cwd=".length));
        } else if (arg.startsWith("--project-dir=")) {
          cwd = resolve(arg.slice("--project-dir=".length));
        }
      }

      try {
        await deployCommand({
          cwd,
          controlPlaneUrl,
          project,
          token,
          env,
          json,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("railfog.toml not found")) {
          console.error("Error: railfog.toml not found in current directory.");
          Deno.exit(1);
        }
        console.error(`Error: ${message}`);
        Deno.exit(1);
      }
      break;
    }

    case "rollback": {
      let functionName: string | undefined;
      let targetRevisionId: string | undefined;
      let controlPlaneUrl: string | undefined;
      let project: string | undefined;
      let cwd = Deno.cwd();

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printRollbackHelp();
          return;
        }

        if (arg === "--to" && args[i + 1]) {
          targetRevisionId = args[i + 1];
          i++;
        } else if (arg.startsWith("--to=")) {
          targetRevisionId = arg.slice("--to=".length);
        } else if ((arg === "--control-url" || arg === "--control-plane-url") && args[i + 1]) {
          controlPlaneUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlPlaneUrl = arg.slice("--control-url=".length);
        } else if (arg.startsWith("--control-plane-url=")) {
          controlPlaneUrl = arg.slice("--control-plane-url=".length);
        } else if ((arg === "--project" || arg === "-p" || arg === "--name" || arg === "-n") && args[i + 1]) {
          project = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          project = arg.slice("--project=".length);
        } else if (arg.startsWith("--name=")) {
          project = arg.slice("--name=".length);
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          cwd = resolve(args[i + 1]);
          i++;
        } else if (arg.startsWith("--dir=")) {
          cwd = resolve(arg.slice("--dir=".length));
        } else if (arg.startsWith("--cwd=")) {
          cwd = resolve(arg.slice("--cwd=".length));
        } else if (arg.startsWith("--project-dir=")) {
          cwd = resolve(arg.slice("--project-dir=".length));
        } else if (!arg.startsWith("-") && !functionName) {
          functionName = arg;
        }
      }

      if (!functionName) {
        console.error("Error: Missing functionName.");
        Deno.exit(1);
      }
      if (!targetRevisionId) {
        console.error("Error: Missing --to revision flag.");
        Deno.exit(1);
      }

      try {
        await rollbackCommand({
          cwd,
          controlPlaneUrl,
          project,
          functionName,
          targetRevisionId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        Deno.exit(1);
      }
      break;
    }

    case "undeploy": {
      let project: string | undefined;
      let controlPlaneUrl: string | undefined;
      let cwd = Deno.cwd();

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printUndeployHelp();
          return;
        }
        if ((arg === "--project" || arg === "-p" || arg === "--name" || arg === "-n") && args[i + 1]) {
          project = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          project = arg.slice("--project=".length);
        } else if (arg.startsWith("--name=")) {
          project = arg.slice("--name=".length);
        } else if ((arg === "--control-plane-url" || arg === "--control-url") && args[i + 1]) {
          controlPlaneUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-plane-url=")) {
          controlPlaneUrl = arg.slice("--control-plane-url=".length);
        } else if (arg.startsWith("--control-url=")) {
          controlPlaneUrl = arg.slice("--control-url=".length);
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          cwd = resolve(args[i + 1]);
          i++;
        } else if (arg.startsWith("--dir=")) {
          cwd = resolve(arg.slice("--dir=".length));
        } else if (arg.startsWith("--cwd=")) {
          cwd = resolve(arg.slice("--cwd=".length));
        } else if (arg.startsWith("--project-dir=")) {
          cwd = resolve(arg.slice("--project-dir=".length));
        }
      }

      try {
        await undeployCommand({
          cwd,
          controlPlaneUrl,
          project,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        Deno.exit(1);
      }
      break;
    }

    case "export": {
      let outputFile: string | undefined;
      let project: string | undefined;
      let org: string | undefined;
      let controlPlaneUrl: string | undefined;
      let cwd = Deno.cwd();

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printExportHelp();
          return;
        }
        if (arg === "--out" && args[i + 1]) {
          outputFile = args[i + 1];
          i++;
        } else if (arg.startsWith("--out=")) {
          outputFile = arg.slice("--out=".length);
        } else if ((arg === "--project" || arg === "-p" || arg === "--name" || arg === "-n") && args[i + 1]) {
          project = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          project = arg.slice("--project=".length);
        } else if (arg.startsWith("--name=")) {
          project = arg.slice("--name=".length);
        } else if (arg === "--org" && args[i + 1]) {
          org = args[i + 1];
          i++;
        } else if (arg.startsWith("--org=")) {
          org = arg.slice("--org=".length);
        } else if ((arg === "--control-url" || arg === "--control-plane-url") && args[i + 1]) {
          controlPlaneUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlPlaneUrl = arg.slice("--control-url=".length);
        } else if (arg.startsWith("--control-plane-url=")) {
          controlPlaneUrl = arg.slice("--control-plane-url=".length);
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          cwd = resolve(args[i + 1]);
          i++;
        } else if (arg.startsWith("--dir=")) {
          cwd = resolve(arg.slice("--dir=".length));
        } else if (arg.startsWith("--cwd=")) {
          cwd = resolve(arg.slice("--cwd=".length));
        } else if (arg.startsWith("--project-dir=")) {
          cwd = resolve(arg.slice("--project-dir=".length));
        }
      }

      try {
        await exportCommand({
          cwd,
          outputFile,
          project,
          org,
          controlPlaneUrl,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        Deno.exit(1);
      }
      break;
    }

    case "import": {
      let inputFile: string | undefined;
      let project: string | undefined;
      let org: string | undefined;
      let overwriteKv = false;
      let controlPlaneUrl: string | undefined;
      let cwd = Deno.cwd();

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printImportHelp();
          return;
        }
        if (arg === "--in" && args[i + 1]) {
          inputFile = args[i + 1];
          i++;
        } else if (arg.startsWith("--in=")) {
          inputFile = arg.slice("--in=".length);
        } else if ((arg === "--project" || arg === "-p" || arg === "--name" || arg === "-n") && args[i + 1]) {
          project = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          project = arg.slice("--project=".length);
        } else if (arg.startsWith("--name=")) {
          project = arg.slice("--name=".length);
        } else if (arg === "--org" && args[i + 1]) {
          org = args[i + 1];
          i++;
        } else if (arg.startsWith("--org=")) {
          org = arg.slice("--org=".length);
        } else if (arg === "--overwrite-kv") {
          overwriteKv = true;
        } else if ((arg === "--control-url" || arg === "--control-plane-url") && args[i + 1]) {
          controlPlaneUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlPlaneUrl = arg.slice("--control-url=".length);
        } else if (arg.startsWith("--control-plane-url=")) {
          controlPlaneUrl = arg.slice("--control-plane-url=".length);
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          cwd = resolve(args[i + 1]);
          i++;
        } else if (arg.startsWith("--dir=")) {
          cwd = resolve(arg.slice("--dir=".length));
        } else if (arg.startsWith("--cwd=")) {
          cwd = resolve(arg.slice("--cwd=".length));
        } else if (arg.startsWith("--project-dir=")) {
          cwd = resolve(arg.slice("--project-dir=".length));
        } else if (!arg.startsWith("-") && !inputFile) {
          inputFile = arg;
        }
      }

      if (!inputFile) {
        console.error("Error: Missing required input file (--in <file>).");
        Deno.exit(1);
      }

      try {
        await importCommand({
          cwd,
          inputFile,
          targetProject: project,
          targetOrgId: org,
          overwriteKv,
          controlPlaneUrl,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        Deno.exit(1);
      }
      break;
    }

    case "secrets": {
      const sub = args[1];
      if (!sub || sub === "-h" || sub === "--help") {
        printSecretsHelp();
        return;
      }

      let key: string | undefined;
      let value: string | undefined;
      let filePath: string | undefined;
      let projectDir: string | undefined;

      const subArgs = args.slice(2);
      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i];
        if (arg === "-h" || arg === "--help") {
          printSecretsHelp();
          return;
        }
        if (arg === "--file" && subArgs[i + 1]) {
          filePath = subArgs[i + 1];
          i++;
        } else if (arg.startsWith("--file=")) {
          filePath = arg.slice("--file=".length);
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && subArgs[i + 1]) {
          projectDir = subArgs[i + 1];
          i++;
        } else if (arg.startsWith("--dir=")) {
          projectDir = arg.slice("--dir=".length);
        } else if (arg.startsWith("--cwd=")) {
          projectDir = arg.slice("--cwd=".length);
        } else if (arg.startsWith("--project-dir=")) {
          projectDir = arg.slice("--project-dir=".length);
        } else if (!arg.startsWith("-")) {
          if (!key) {
            key = arg;
          } else if (value === undefined) {
            value = arg;
          }
        }
      }

      const exitCode = await secretsCommand({
        subcommand: sub as "set" | "list" | "delete",
        key,
        value,
        filePath,
        projectDir,
      });
      if (exitCode !== 0) {
        Deno.exit(exitCode);
      }
      break;
    }

    case "logs": {
      let functionName: string | undefined;
      let level: "debug" | "info" | "warn" | "error" | undefined;
      let limit: number | undefined;
      let follow = false;
      let format: "pretty" | "json" | undefined;
      let projectDir: string | undefined;
      let project: string | undefined;
      let controlPlaneUrl: string | undefined;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printLogsHelp();
          return;
        }
        if (arg === "-f" || arg === "--follow") {
          follow = true;
        } else if (arg === "--json") {
          format = "json";
        } else if (arg === "--function" && args[i + 1]) {
          functionName = args[i + 1];
          i++;
        } else if (arg.startsWith("--function=")) {
          functionName = arg.slice("--function=".length);
        } else if (arg === "--level" && args[i + 1]) {
          level = args[i + 1] as "debug" | "info" | "warn" | "error";
          i++;
        } else if (arg.startsWith("--level=")) {
          level = arg.slice("--level=".length) as
            | "debug"
            | "info"
            | "warn"
            | "error";
        } else if (arg === "--limit" && args[i + 1]) {
          limit = parseInt(args[i + 1], 10);
          i++;
        } else if (arg.startsWith("--limit=")) {
          limit = parseInt(arg.slice("--limit=".length), 10);
        } else if (arg === "--format" && args[i + 1]) {
          format = args[i + 1] as "pretty" | "json";
          i++;
        } else if (arg.startsWith("--format=")) {
          format = arg.slice("--format=".length) as "pretty" | "json";
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          projectDir = args[i + 1];
          i++;
        } else if (arg.startsWith("--dir=")) {
          projectDir = arg.slice("--dir=".length);
        } else if (arg.startsWith("--cwd=")) {
          projectDir = arg.slice("--cwd=".length);
        } else if (arg.startsWith("--project-dir=")) {
          projectDir = arg.slice("--project-dir=".length);
        } else if ((arg === "--project" || arg === "-p" || arg === "--name" || arg === "-n") && args[i + 1]) {
          project = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          project = arg.slice("--project=".length);
        } else if (arg.startsWith("--name=")) {
          project = arg.slice("--name=".length);
        } else if ((arg === "--control-url" || arg === "--control-plane-url") && args[i + 1]) {
          controlPlaneUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlPlaneUrl = arg.slice("--control-url=".length);
        } else if (arg.startsWith("--control-plane-url=")) {
          controlPlaneUrl = arg.slice("--control-plane-url=".length);
        }
      }

      const exitCode = await logsCommand({
        functionName,
        level,
        limit,
        follow,
        format,
        projectDir,
        project,
        controlPlaneUrl,
      });
      if (exitCode !== 0) {
        Deno.exit(exitCode);
      }
      break;
    }

    case "usage":
    case "cost": {
      let format: "pretty" | "json" | undefined;
      let projectDir: string | undefined;
      let projectId: string | undefined;
      let source: string | undefined;
      let rates: Partial<PricingRates> | undefined;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printUsageHelp();
          return;
        }
        if (arg === "--json") {
          format = "json";
        } else if (arg === "--format" && args[i + 1]) {
          const val = args[i + 1];
          if (val !== "pretty" && val !== "json") {
            console.error(
              `Error [VALIDATION_FAILED]: Invalid format "${val}". Must be "pretty" or "json".`,
            );
            Deno.exit(1);
          }
          format = val;
          i++;
        } else if (arg.startsWith("--format=")) {
          const val = arg.slice("--format=".length);
          if (val !== "pretty" && val !== "json") {
            console.error(
              `Error [VALIDATION_FAILED]: Invalid format "${val}". Must be "pretty" or "json".`,
            );
            Deno.exit(1);
          }
          format = val as "pretty" | "json";
        } else if ((arg === "-C" || arg === "--dir" || arg === "--cwd" || arg === "--project-dir") && args[i + 1]) {
          projectDir = args[i + 1];
          i++;
        } else if (arg.startsWith("--dir=")) {
          projectDir = arg.slice("--dir=".length);
        } else if (arg.startsWith("--cwd=")) {
          projectDir = arg.slice("--cwd=".length);
        } else if (arg.startsWith("--project-dir=")) {
          projectDir = arg.slice("--project-dir=".length);
        } else if ((arg === "--project" || arg === "-p" || arg === "--name" || arg === "-n") && args[i + 1]) {
          projectId = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          projectId = arg.slice("--project=".length);
        } else if (arg.startsWith("--name=")) {
          projectId = arg.slice("--name=".length);
        } else if (arg === "--source" && args[i + 1]) {
          source = args[i + 1];
          i++;
        } else if (arg.startsWith("--source=")) {
          source = arg.slice("--source=".length);
        } else if (arg === "--rates" && args[i + 1]) {
          const ratesStr = args[i + 1];
          i++;
          try {
            rates = JSON.parse(ratesStr);
          } catch {
            console.error(
              `Error [VALIDATION_FAILED]: Invalid rates JSON string: "${ratesStr}"`,
            );
            Deno.exit(1);
          }
        } else if (arg.startsWith("--rates=")) {
          const ratesStr = arg.slice("--rates=".length);
          try {
            rates = JSON.parse(ratesStr);
          } catch {
            console.error(
              `Error [VALIDATION_FAILED]: Invalid rates JSON string: "${ratesStr}"`,
            );
            Deno.exit(1);
          }
        } else if (arg.startsWith("--")) {
          console.error(`Error [VALIDATION_FAILED]: Unknown option "${arg}"`);
          Deno.exit(1);
        } else if (!arg.startsWith("-") && !projectDir) {
          projectDir = arg;
        } else {
          console.error(`Error [VALIDATION_FAILED]: Unknown option "${arg}"`);
          Deno.exit(1);
        }
      }

      const exitCode = await usageCommand({
        format,
        projectDir,
        projectId,
        usageSource: source,
        rates,
      });
      if (exitCode !== 0) {
        Deno.exit(exitCode);
      }
      break;
    }

    case "login": {
      let controlUrl: string | undefined;
      let token: string | undefined;
      let manual = false;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printLoginHelp();
          return;
        }
        if ((arg === "--control-url" || arg === "--control-plane-url") && args[i + 1]) {
          controlUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlUrl = arg.slice("--control-url=".length);
        } else if (arg.startsWith("--control-plane-url=")) {
          controlUrl = arg.slice("--control-plane-url=".length);
        } else if (arg === "--token" && args[i + 1]) {
          token = args[i + 1];
          i++;
        } else if (arg.startsWith("--token=")) {
          token = arg.slice("--token=".length);
        } else if (arg === "--manual") {
          manual = true;
        }
      }

      const res = await loginCommand({ controlUrl, token, manual });
      if (!res.ok) {
        Deno.exit(1);
      }
      break;
    }

    case "logout": {
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printLogoutHelp();
          return;
        }
      }
      await logoutCommand();
      break;
    }

    case "whoami": {
      let controlUrl: string | undefined;
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printWhoamiHelp();
          return;
        }
        if ((arg === "--control-url" || arg === "--control-plane-url") && args[i + 1]) {
          controlUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlUrl = arg.slice("--control-url=".length);
        } else if (arg.startsWith("--control-plane-url=")) {
          controlUrl = arg.slice("--control-plane-url=".length);
        }
      }
      const res = await whoamiCommand({ controlUrl });
      if (!res.authenticated) {
        Deno.exit(1);
      }
      break;
    }

    case "upgrade":
    case "update":
    case "sync": {
      let checkOnly = false;
      let force = false;
      let version: string | undefined;
      let ref: string | undefined;
      let compile = false;
      let local = false;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printUpgradeHelp();
          return;
        }
        if (arg === "--check") {
          checkOnly = true;
        } else if (arg === "-f" || arg === "--force") {
          force = true;
        } else if (arg === "-l" || arg === "--local") {
          local = true;
        } else if (arg === "--compile") {
          compile = true;
        } else if (arg === "--version" && args[i + 1]) {
          version = args[i + 1];
          i++;
        } else if (arg.startsWith("--version=")) {
          version = arg.slice("--version=".length);
        } else if (arg === "--ref" && args[i + 1]) {
          ref = args[i + 1];
          i++;
        } else if (arg.startsWith("--ref=")) {
          ref = arg.slice("--ref=".length);
        }
      }

      // spec: docs/contracts/platform.contract.md#PLAT-19, tasks/milestone-0.8-developer-experience-ux/T-0814-cli-self-upgrade-mechanism.md
      const res = await upgradeCommand({
        checkOnly,
        force,
        version,
        ref,
        compile,
        local,
      });

      if (!res.ok) {
        Deno.exit(1);
      }
      break;
    }

    case "uninstall": {
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printUninstallHelp();
          return;
        }
      }
      await uninstallCommand();
      break;
    }

    case "completions":
    case "completion": {
      let shellArg: string | undefined;
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printCompletionsHelp();
          return;
        }
        if (!arg.startsWith("-") && !shellArg) {
          shellArg = arg;
        }
      }
      const res = completionsCommand(shellArg);
      if (!res.ok) {
        Deno.exit(1);
      }
      break;
    }

    default:
      if (!command) {
        // Interactive Project Launcher: when executed without arguments inside an active project in a TTY terminal
        if (Deno.stdin.isTerminal?.()) {
          const tomlPath = join(Deno.cwd(), "railfog.toml");
          let hasToml = false;
          let appName = "(unnamed)";
          try {
            const stat = await Deno.stat(tomlPath);
            if (stat.isFile) {
              hasToml = true;
              const content = await Deno.readTextFile(tomlPath);
              const parsed = parse(content) as Record<string, unknown>;
              if (typeof parsed.name === "string") {
                appName = parsed.name;
              }
            }
          } catch {
            // Not a project folder
          }

          if (hasToml) {
            const trimmed = await promptActionSelection(appName, Deno.cwd());

            if (trimmed === "1" || trimmed === "dev" || trimmed === "") {
              await devCommand(Deno.cwd());
              return;
            } else if (trimmed === "2" || trimmed === "status") {
              await statusCommand(Deno.cwd());
              return;
            } else if (trimmed === "3" || trimmed === "check") {
              await runCheck(Deno.cwd());
              return;
            } else if (trimmed === "4" || trimmed === "deploy") {
              await main(["deploy"]);
              return;
            } else if (trimmed === "5" || trimmed === "logs") {
              await main(["logs"]);
              return;
            } else if (trimmed === "6" || trimmed === "doctor") {
              await doctorCommand({ cwd: Deno.cwd() });
              return;
            } else if (trimmed === "7" || trimmed === "simulate") {
              await simulateCommand("/", { cwd: Deno.cwd() });
              return;
            } else if (trimmed === "8" || trimmed === "compare") {
              compareCommand();
              return;
            } else if (trimmed === "0" || trimmed === "help") {
              printGeneralHelp();
              return;
            } else if (trimmed === "q" || trimmed === "exit") {
              return;
            } else {
              console.log(
                colors.coral(`Unknown choice "${trimmed}". Exiting.`),
              );
              return;
            }
          }
        }

        printGeneralHelp();
        return;
      } else {
        const suggestion = findClosestCommand(command);
        console.error(
          renderErrorCard({
            code: "UNKNOWN_COMMAND",
            message:
              `Error: Unknown command "${command}". Available commands: init, add, status, check, dev, deploy, undeploy, rollback, export, import, secrets, logs, usage, cost, doctor, simulate, compare, login, logout, whoami, upgrade, update, sync, uninstall, completions`,
            solution: suggestion
              ? `Did you mean "rail ${suggestion}"?\nRun 'rail --help' to see all available commands.`
              : "Run 'rail --help' to browse all available commands and flags.",
          }),
        );
        Deno.exit(1);
      }
  }
}

if (import.meta.main) {
  await main();
}
