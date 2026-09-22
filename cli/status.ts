// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & CLI subcommands
// cli/status.ts — Station Departure Board and project topology viewer

import { join, resolve } from "@std/path";
import { parse } from "@std/toml";
import type { RailfogConfig } from "../runtime/dev-server/local-server.ts";
import { normalizeRoutes } from "../runtime/dev-server/local-server.ts";
import { normalizeFunctions } from "./check.ts";
import {
  renderDepartureBoard,
  renderErrorCard,
  renderStatusBar,
  renderTree,
} from "./ui.ts";

export interface StatusOptions {
  cwd?: string;
  json?: boolean;
}

export function printStatusHelp(): void {
  console.log(`RailFog CLI - Status & Station Departure Board

Usage:
  rail status [options]

Options:
  -C, --dir <path>   Target project directory (alias: --project-dir, --cwd, default: current directory)
  --json             Output status report as structured JSON
  -h, --help         Show help for status command`);
}

/**
 * Renders the Station Departure Board and function hierarchy tree for an active project.
 *
 * @spec contracts/platform.contract.md#PLAT-19
 */
export async function statusCommand(
  cwd: string = Deno.cwd(),
  options?: StatusOptions,
): Promise<void> {
  const targetDir = resolve(options?.cwd ?? cwd);
  const tomlPath = join(targetDir, "railfog.toml");
  let content: string;

  try {
    content = await Deno.readTextFile(tomlPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.error(
        renderErrorCard({
          code: "CONFIG_NOT_FOUND",
          message: "Error: railfog.toml not found in project directory.",
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

  const departureItems = routes.map((r, idx) => {
    const fnName = r.function ?? "(unmapped)";
    const fnConfig = functions[fnName];
    const target = (fnConfig?.entry as string) ??
      (fnConfig?.entrypoint as string) ?? "(inline)";
    return {
      track: idx + 1,
      platform: "HTTP",
      route: r.pattern ?? "/*",
      functionName: fnName,
      target,
      status: "READY",
    };
  });

  if (options?.json) {
    console.log(
      JSON.stringify(
        {
          project: appName,
          directory: targetDir,
          functions: Object.keys(functions),
          routes: departureItems,
          status: "Ready",
        },
        null,
        2,
      ),
    );
    return;
  }

  const tree = renderTree(
    `${appName} (${targetDir})`,
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

  console.log(renderDepartureBoard(appName, departureItems));
  console.log();
  console.log(tree);
  console.log();
  console.log(
    renderStatusBar([
      { label: "Project", value: appName },
      { label: "Tracks", value: String(departureItems.length) },
      { label: "Functions", value: String(fnEntries.length) },
      { label: "Routes", value: String(routes.length) },
      { label: "Status", value: "Ready" },
    ]),
  );
}
