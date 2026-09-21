import { join } from "@std/path";
import { parse } from "@std/toml";
import {
  formatStartupBanner,
  type LocalServer,
  normalizeRoutes,
  type RailfogConfig,
  startLocalServer,
} from "../runtime/dev-server/local-server.ts";
import {
  checkProject,
  type CheckResult,
  normalizeFunctions,
  runCheck,
  type ValidationIssue,
} from "./check.ts";
import {
  deployCommand,
  type DeployCommandOptions,
  type DeployCommandResult,
} from "./deploy.ts";
import { type AddOptions, type AddResult, runAdd } from "./add.ts";
import {
  initCommand,
  type InitOptions,
  type InitResult,
  type InteractiveInitOptions,
  runInit,
  runInteractiveInit,
} from "./init.ts";
import {
  rollbackCommand,
  type RollbackCommandOptions,
  type RollbackCommandResult,
} from "./rollback.ts";
import {
  undeployCommand,
  type UndeployCommandOptions,
  type UndeployCommandResult,
} from "./undeploy.ts";
import {
  exportCommand,
  type ExportCommandOptions,
  importCommand,
  type ImportCommandOptions,
} from "./state.ts";
import {
  runSecrets,
  type SecretCliOptions,
  type SecretListEntry,
} from "./secrets.ts";
import {
  formatLogEntry,
  type LogEntry,
  type LogsCliOptions,
  runLogs,
} from "./logs.ts";
import { formatUsageReport, runUsage, type UsageCliOptions } from "./usage.ts";
import { runLogin, runLogout, runWhoami, systemOpenBrowser } from "./login.ts";
import { CLI_VERSION } from "./version.ts";
import {
  runUpgrade,
  type UpgradeOptions,
  type UpgradeResult,
} from "./upgrade.ts";
import type { PricingRates } from "../packages/metrics/cost-calculator.ts";
import {
  colors,
  glyphs,
  renderBrandHeader,
  renderCard,
  renderErrorCard,
  renderModernTable,
  renderStatusBar,
  renderTree,
} from "./ui.ts";

export {
  checkProject,
  CLI_VERSION,
  colors,
  deployCommand,
  exportCommand,
  formatLogEntry,
  formatUsageReport,
  glyphs,
  importCommand,
  initCommand,
  renderBrandHeader,
  renderCard,
  renderErrorCard,
  renderModernTable,
  rollbackCommand,
  runAdd,
  runCheck,
  runInit,
  runInteractiveInit,
  undeployCommand,
  runLogin,
  runLogout,
  runLogs,
  runSecrets,
  runUpgrade,
  runUsage,
  runWhoami,
};
export type {
  AddOptions,
  AddResult,
  CheckResult,
  DeployCommandOptions,
  DeployCommandResult,
  ExportCommandOptions,
  ImportCommandOptions,
  InitOptions,
  InitResult,
  InteractiveInitOptions,
  LogEntry,
  LogsCliOptions,
  RollbackCommandOptions,
  RollbackCommandResult,
  SecretCliOptions,
  SecretListEntry,
  UndeployCommandOptions,
  UndeployCommandResult,
  UpgradeOptions,
  UpgradeResult,
  UsageCliOptions,
  ValidationIssue,
};

export type { LocalServer, RailfogConfig };

// spec: docs/contracts/platform.contract.md#PLAT-19 — starter configuration scaffold
export const STARTER_CONFIG = `name = "railfog-app"

[functions.api]
entry = "functions/api.ts"

[[routes]]
pattern = "/api/*"
function = "api"
`;

// spec: docs/contracts/functions.contract.md#FN-1 — default exported fetch handler
export const STARTER_FUNCTION = `export default async function handler(
  _req: Request,
  _ctx?: unknown,
): Promise<Response> {
  await Promise.resolve();
  return new Response("Hello from RailFog!");
}
`;

function printInitHelp(): void {
  console.log(`RailFog CLI - Initialize project

Usage:
  rail init [directory] [options]

Arguments:
  [directory]          Target directory to initialize (default: current directory)

Options:
  --template <name>    Template to use: minimal (default) or worked-example
  --name <name>        Project name (default: derived from directory name)
  --force              Overwrite files in non-empty directory
  -h, --help           Show help for init command`);
}

// spec: contracts/platform.contract.md#PLAT-19 — Project dependency management
export async function addCommand(
  packageOrPrimitive: string,
  cwd: string = Deno.cwd(),
): Promise<AddResult> {
  const result = await runAdd({ packageOrPrimitive, cwd });
  console.log(`${glyphs.success} Added ${result.addedImport} to deno.json`);
  return result;
}

function printAddHelp(): void {
  console.log(`RailFog CLI - Add dependency or primitive

Usage:
  rail add <package> [options]

Arguments:
  <package>    Package or primitive to add (supported: sdk)

Options:
  -h, --help   Show help for add command`);
}

export async function statusCommand(cwd: string = Deno.cwd()): Promise<void> {
  const tomlPath = join(cwd, "railfog.toml");
  let content: string;
  try {
    content = await Deno.readTextFile(tomlPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.error(
        renderErrorCard({
          code: "CONFIG_NOT_FOUND",
          message: "Error: railfog.toml not found in current directory.",
          location: tomlPath,
          solution: "Run 'rail init' to scaffold a new RailFog application here.",
          docs: "https://railfog.dev/docs/getting-started",
        }),
      );
      Deno.exit(1);
    }
    throw err;
  }

  const parsed = parse(content) as Record<string, unknown>;
  const appName = typeof parsed.name === "string" ? parsed.name : "(unnamed)";
  const functions = normalizeFunctions(parsed.functions);
  const routes = normalizeRoutes(parsed as unknown as RailfogConfig);

  const fnEntries = Object.entries(functions);
  const fnNodes = fnEntries.map(([name, fnConfig]) => {
    const entry = (fnConfig?.entry as string) ??
      (fnConfig?.entrypoint as string) ?? "(no entry)";
    return {
      label: name,
      value: entry,
    };
  });

  const routeNodes = routes.map((r) => ({
    label: r.pattern ?? "",
    value: r.function ?? "",
  }));

  const tree = renderTree(
    `${appName} (${cwd})`,
    [
      {
        label: "Functions:",
        children: fnNodes.length > 0
          ? fnNodes
          : [{ label: "(no functions declared)" }],
      },
      {
        label: "Routes:",
        children: routeNodes.length > 0
          ? routeNodes
          : [{ label: "(no routes configured)" }],
      },
      {
        label: "Backing Services:",
        children: [
          { label: "KV & Queues: SQLite" },
          { label: "Objects:     LocalFS" },
        ],
      },
    ],
  );

  console.log(tree);
  console.log();
  console.log(
    renderStatusBar([
      { label: "Project", value: appName },
      { label: "Functions", value: String(fnEntries.length) },
      { label: "Routes", value: String(routes.length) },
      { label: "Status", value: "Ready" },
    ]),
  );
}

function printDevHelp(): void {
  console.log(`RailFog CLI - Local development server

Usage:
  rail dev [options]

Options:
  --port <number>    HTTP port to listen on (default: 8000)
  --host <string>    Host interface to bind to (default: localhost)
  --no-watch         Disable file watching and automatic hot reload
  -h, --help         Show help for dev command`);
}

// spec: docs/contracts/platform.contract.md#PLAT-17, tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md
export async function devCommand(
  cwd: string = Deno.cwd(),
  port?: number,
  options?: { host?: string; watch?: boolean },
): Promise<LocalServer> {
  const tomlPath = join(cwd, "railfog.toml");
  let content: string;
  try {
    content = await Deno.readTextFile(tomlPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.error(
        renderErrorCard({
          code: "CONFIG_NOT_FOUND",
          message: "Error: railfog.toml not found in current directory.",
          location: tomlPath,
          solution: "Run 'rail init' to scaffold a new RailFog application here.",
          docs: "https://railfog.dev/docs/dev-server",
        }),
      );
      Deno.exit(1);
    }
    throw err;
  }

  const parsed = parse(content) as unknown as RailfogConfig;
  const server = await startLocalServer(parsed, port, {
    cwd,
    host: options?.host,
    watch: options?.watch ?? true,
  });
  return server;
}

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
  upgrade   Upgrade the RailFog CLI to the latest version
  update    Alias for upgrade subcommand
  sync      Sync CLI with the latest git updates (alias for update)

${colors.bold("Options:")}
  -v, --version  Show CLI version
  -h, --help     Show help information

${colors.amber(colors.bold("[Tip]"))} Run 'rail <command> --help' for detailed documentation on any command.`);
}

function printLoginHelp(): void {
  console.log(`RailFog CLI - Login

Usage:
  rail login [options]

Options:
  --control-url <url>    Control Plane API URL (default: RAILFOG_CONTROL_URL or https://railfog-control-production.up.railway.app)
  --token <key>          Directly provide API key (non-interactive / CI)
  --manual               Skip browser callback server and prompt on stdin
  -h, --help             Show help for login command`);
}

function printCheckHelp(): void {
  console.log(`RailFog CLI - Check configuration

Usage:
  rail check [path] [options]

Arguments:
  [path]         Directory or railfog.toml file path to validate (default: current directory)

Options:
  -h, --help     Show help for check command`);
}

function printDeployHelp(): void {
  console.log(`RailFog CLI - Deploy

Usage:
  rail deploy [options]

Options:
  --control-url <url>    Control Plane API URL (default: RAILFOG_CONTROL_PLANE_URL or https://railfog-control-production.up.railway.app)
  --project <name>       Override project name declared in railfog.toml
  -e, --env <name>       Target deployment environment (default: production)
  -h, --help             Show help for deploy command`);
}

function printRollbackHelp(): void {
  console.log(`RailFog CLI - Rollback

Usage:
  rail rollback <functionName> --to <revisionId> [options]

Options:
  --to <revisionId>      The target revision ID to rollback to (required)
  --control-url <url>    Control Plane API URL (default: RAILFOG_CONTROL_PLANE_URL or https://railfog-control-production.up.railway.app)
  --project <name>       Override project name declared in railfog.toml
  -h, --help             Show help for rollback command`);
}

function printExportHelp(): void {
  console.log(`RailFog CLI - Export project state

Usage:
  rail export [options]

Options:
  --out <path>           Output backup archive JSON file path (default: <backup_id>.json)
  --project <name>       Override project name declared in railfog.toml
  --org <id>             Organization ID (default: default)
  --control-url <url>    Control Plane API URL (default: RAILFOG_CONTROL_PLANE_URL or https://railfog-control-production.up.railway.app)
  -h, --help             Show help for export command`);
}

function printImportHelp(): void {
  console.log(`RailFog CLI - Import project state

Usage:
  rail import --in <file> [options]

Options:
  --in <path>            Input backup archive JSON file path (required)
  --project <name>       Target project name (defaults to railfog.toml or archive)
  --org <id>             Target organization ID
  --overwrite-kv         Overwrite existing KV keys in target project
  --control-url <url>    Control Plane API URL (default: RAILFOG_CONTROL_PLANE_URL or https://railfog-control-production.up.railway.app)
  -h, --help             Show help for import command`);
}

function printSecretsHelp(): void {
  console.log(`RailFog CLI - Secrets management

Usage:
  rail secrets <subcommand> [arguments] [options]

Subcommands:
  set <KEY> [VALUE] [--file <path>]   Set or update an encrypted secret
  list                                List stored secret keys
  delete <KEY>                        Delete an encrypted secret

Options:
  --file <path>                       Read secret value from file (for multiline secrets)
  -h, --help                          Show help for secrets command`);
}

function printLogsHelp(): void {
  console.log(`RailFog CLI - Logs viewer and streamer

Usage:
  rail logs [options]

Options:
  --function <name>      Filter logs by function name
  --level <level>        Minimum log level: debug, info, warn, error
  --limit <number>       Maximum number of log entries to display (default: 50)
  --format <format>      Output format: pretty (default) or json
  -f, --follow           Tail/follow logs in real-time
  -h, --help             Show help for logs command`);
}

function printUsageHelp(): void {
  console.log(`RailFog CLI - Usage and cost reporting

Usage:
  rail usage [options]
  rail cost [options]

Options:
  --format <pretty|json>   Output format: pretty (default) or json
  --project-dir <path>     Project root directory (default: current directory)
  --project <name>         Project ID or name override
  --source <path|json>     Custom usage source JSON string or file path
  --rates <json>           Custom pricing rates JSON override
  -h, --help               Show help for usage command`);
}

function printUpgradeHelp(): void {
  console.log(`RailFog CLI - Self-upgrade mechanism

Usage:
  rail upgrade [options]
  rail update [options]
  rail sync [options]

Options:
  --check               Check for newer versions without installing
  -f, --force           Force reinstallation even if already up to date
  -l, --local           Sync directly from local repository sources
  --version <version>   Upgrade to a specific semantic version
  --ref <ref>           Upgrade to a specific git branch or tag (default: main)
  --compile             Compile into a standalone native binary
  -h, --help            Show help for upgrade command`);
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
  let prevRow = new Array<number>(n + 1);
  let currRow = new Array<number>(n + 1);

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
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }

  return prevRow[n];
}

const KNOWN_COMMANDS = [
  "init",
  "dev",
  "deploy",
  "status",
  "check",
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
        if (arg === "--force") {
          force = true;
        } else if (arg === "--template" && args[i + 1]) {
          template = args[i + 1] as "minimal" | "worked-example";
          i++;
        } else if (arg.startsWith("--template=")) {
          template = arg.slice("--template=".length) as
            | "minimal"
            | "worked-example";
        } else if (arg === "--name" && args[i + 1]) {
          projectName = args[i + 1];
          i++;
        } else if (arg.startsWith("--name=")) {
          projectName = arg.slice("--name=".length);
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
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printAddHelp();
          return;
        }
        if (!arg.startsWith("-") && !pkg) {
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
        await addCommand(pkg, Deno.cwd());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        Deno.exit(1);
      }
      break;
    }
    case "status":
      await statusCommand();
      break;
    case "check": {
      let targetPath: string | undefined;
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printCheckHelp();
          return;
        }
        if (!arg.startsWith("-") && !targetPath) {
          targetPath = arg;
        }
      }
      const exitCode = await runCheck(targetPath ?? Deno.cwd());
      if (exitCode !== 0) {
        Deno.exit(exitCode);
      }
      break;
    }
    case "dev": {
      let port: number | undefined;
      let host: string | undefined;
      let watch = true;
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          printDevHelp();
          return;
        }
        if (arg === "--port" && args[i + 1]) {
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
        }
      }
      const server = await devCommand(Deno.cwd(), port, { host, watch });

      // Interactive terminal shortcuts (Wrangler / Railway parity)
      if (
        typeof Deno.stdin.isTerminal === "function" && Deno.stdin.isTerminal()
      ) {
        try {
          Deno.stdin.setRaw(true);
          const buf = new Uint8Array(16);
          while (true) {
            const n = await Deno.stdin.read(buf);
            if (n === null || n === 0) break;
            const char = new TextDecoder().decode(buf.subarray(0, n));
            // Ctrl+C (\x03) or 'q' / 'Q'
            if (char === "\x03" || char === "q" || char === "Q") {
              try {
                Deno.stdin.setRaw(false);
              } catch {
                // ignore
              }
              await server.close();
              console.log("\nDev server stopped.");
              Deno.exit(0);
            }
            // 'b' / 'B': open in browser
            if (char === "b" || char === "B") {
              const url = `http://${host ?? "localhost"}:${server.port}`;
              console.log(`\nOpening ${url} in browser...`);
              await systemOpenBrowser(url);
            }
            // 'd' / 'D': open dashboard in browser
            if (char === "d" || char === "D") {
              const url = `http://${
                host ?? "localhost"
              }:${server.port}/__railfog`;
              console.log(`\nOpening dashboard ${url} in browser...`);
              await systemOpenBrowser(url);
            }
            // 'c' / 'C': clear console and reprint banner
            if (char === "c" || char === "C") {
              console.clear();
              try {
                const tomlPath = join(Deno.cwd(), "railfog.toml");
                const tomlContent = await Deno.readTextFile(tomlPath);
                const cfg = parse(tomlContent) as unknown as RailfogConfig;
                console.log(
                  formatStartupBanner(cfg, server.port, { host, watch }),
                );
              } catch {
                // ignore
              }
            }
          }
        } catch {
          // If raw mode cannot be set or stdin ends, remain alive
        } finally {
          try {
            Deno.stdin.setRaw(false);
          } catch {
            // ignore
          }
        }
      }
      break;
    }
    case "deploy": {
      let controlPlaneUrl: string | undefined;
      let project: string | undefined;
      let token: string | undefined;
      let env: string | undefined;

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
        if (arg === "--control-url" && args[i + 1]) {
          controlPlaneUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlPlaneUrl = arg.slice("--control-url=".length);
        } else if (arg === "--project" && args[i + 1]) {
          project = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          project = arg.slice("--project=".length);
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
        }
      }

      try {
        await deployCommand({
          cwd: Deno.cwd(),
          controlPlaneUrl,
          project,
          token,
          env,
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
        } else if (arg === "--control-url" && args[i + 1]) {
          controlPlaneUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlPlaneUrl = arg.slice("--control-url=".length);
        } else if (arg === "--project" && args[i + 1]) {
          project = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          project = arg.slice("--project=".length);
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
          cwd: Deno.cwd(),
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

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-h" || arg === "--help") {
          console.log(`Usage: rail undeploy [--project <project>] [options]`);
          return;
        }
        if (arg === "--project" && args[i + 1]) {
          project = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          project = arg.slice("--project=".length);
        } else if (arg === "--control-plane-url" && args[i + 1]) {
          controlPlaneUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-plane-url=")) {
          controlPlaneUrl = arg.slice("--control-plane-url=".length);
        }
      }

      try {
        await undeployCommand({
          cwd: Deno.cwd(),
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
        } else if (arg === "--project" && args[i + 1]) {
          project = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          project = arg.slice("--project=".length);
        } else if (arg === "--org" && args[i + 1]) {
          org = args[i + 1];
          i++;
        } else if (arg.startsWith("--org=")) {
          org = arg.slice("--org=".length);
        } else if (arg === "--control-url" && args[i + 1]) {
          controlPlaneUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlPlaneUrl = arg.slice("--control-url=".length);
        }
      }

      try {
        await exportCommand({
          cwd: Deno.cwd(),
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
        } else if (arg === "--project" && args[i + 1]) {
          project = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          project = arg.slice("--project=".length);
        } else if (arg === "--org" && args[i + 1]) {
          org = args[i + 1];
          i++;
        } else if (arg.startsWith("--org=")) {
          org = arg.slice("--org=".length);
        } else if (arg === "--overwrite-kv") {
          overwriteKv = true;
        } else if (arg === "--control-url" && args[i + 1]) {
          controlPlaneUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlPlaneUrl = arg.slice("--control-url=".length);
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
          cwd: Deno.cwd(),
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
        } else if (arg === "--project-dir" && subArgs[i + 1]) {
          projectDir = subArgs[i + 1];
          i++;
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

      const exitCode = await runSecrets({
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
        } else if (arg === "--project-dir" && args[i + 1]) {
          projectDir = args[i + 1];
          i++;
        } else if (arg.startsWith("--project-dir=")) {
          projectDir = arg.slice("--project-dir=".length);
        } else if ((arg === "--project" || arg === "-p") && args[i + 1]) {
          project = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          project = arg.slice("--project=".length);
        } else if (arg === "--control-url" && args[i + 1]) {
          controlPlaneUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlPlaneUrl = arg.slice("--control-url=".length);
        }
      }

      const exitCode = await runLogs({
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
        if (arg === "--format" && args[i + 1]) {
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
        } else if (arg === "--project-dir" && args[i + 1]) {
          projectDir = args[i + 1];
          i++;
        } else if (arg.startsWith("--project-dir=")) {
          projectDir = arg.slice("--project-dir=".length);
        } else if (arg === "--project" && args[i + 1]) {
          projectId = args[i + 1];
          i++;
        } else if (arg.startsWith("--project=")) {
          projectId = arg.slice("--project=".length);
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

      const exitCode = await runUsage({
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
        if (arg === "--control-url" && args[i + 1]) {
          controlUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlUrl = arg.slice("--control-url=".length);
        } else if (arg === "--token" && args[i + 1]) {
          token = args[i + 1];
          i++;
        } else if (arg.startsWith("--token=")) {
          token = arg.slice("--token=".length);
        } else if (arg === "--manual") {
          manual = true;
        }
      }

      const res = await runLogin({ controlUrl, token, manual });
      if (!res.ok) {
        Deno.exit(1);
      }
      break;
    }
    case "logout": {
      await runLogout();
      break;
    }
    case "whoami": {
      let controlUrl: string | undefined;
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--control-url" && args[i + 1]) {
          controlUrl = args[i + 1];
          i++;
        } else if (arg.startsWith("--control-url=")) {
          controlUrl = arg.slice("--control-url=".length);
        }
      }
      const res = await runWhoami({ controlUrl });
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
      const res = await runUpgrade({
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
    default:
      if (!command) {
        printGeneralHelp();
        return;
      } else {
        const suggestion = findClosestCommand(command);
        console.error(
          renderErrorCard({
            code: "UNKNOWN_COMMAND",
            message: `Error: Unknown command "${command}". Available commands: init, add, status, check, dev, deploy, undeploy, rollback, export, import, secrets, logs, usage, cost, login, logout, whoami, upgrade, update, sync`,
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
