// spec: contracts/platform.contract.md#PLAT-17 — Local development parity
// spec: tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md
// cli/dev.ts — RailFog local development server with hot reload

import { join, resolve } from "@std/path";
import { parse } from "@std/toml";
import {
  formatStartupBanner,
  type LocalServer,
  type RailfogConfig,
  startLocalServer,
} from "../runtime/dev-server/local-server.ts";
import { systemOpenBrowser } from "./login.ts";
import { renderErrorCard } from "./ui.ts";

export type { LocalServer, RailfogConfig };

export interface DevOptions {
  cwd?: string;
  port?: number;
  host?: string;
  watch?: boolean;
}

export function printDevHelp(): void {
  console.log(`RailFog CLI - Local development server

Usage:
  rail dev [options]

Options:
  -p, --port <number>    HTTP port to listen on (default: 8000)
  --host <string>        Host interface to bind to (default: localhost)
  --dir <path>           Target project directory (default: current directory)
  --no-watch             Disable file watching and automatic hot reload
  -h, --help             Show help for dev command`);
}

/**
 * Starts the local development server instance.
 *
 * @spec contracts/platform.contract.md#PLAT-17
 * @spec tasks/milestone-0.5-developer-experience/T-0508-local-dev-server-reload.md
 */
export async function devCommand(
  cwd: string = Deno.cwd(),
  port?: number,
  options?: { host?: string; watch?: boolean },
): Promise<LocalServer> {
  const targetDir = resolve(cwd);
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
          docs: "https://railfog.dev/docs/dev-server",
        }),
      );
      Deno.exit(1);
    }
    throw err;
  }

  const parsed = parse(content) as unknown as RailfogConfig;
  const server = await startLocalServer(parsed, port, {
    cwd: targetDir,
    host: options?.host,
    watch: options?.watch ?? true,
  });
  return server;
}

/**
 * Runs the interactive local dev server process with keyboard shortcuts.
 */
export async function runDev(options?: DevOptions): Promise<void> {
  const cwd = resolve(options?.cwd ?? Deno.cwd());
  const host = options?.host;
  const watch = options?.watch ?? true;
  const port = options?.port;

  const server = await devCommand(cwd, port, { host, watch });

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

        // Ctrl+C (\x03) or 'q' / 'Q': stop server
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
          const url = `http://${host ?? "localhost"}:${server.port}/__railfog`;
          console.log(`\nOpening dashboard ${url} in browser...`);
          await systemOpenBrowser(url);
        }

        // 'c' / 'C': clear console and reprint banner
        if (char === "c" || char === "C") {
          console.clear();
          try {
            const tomlPath = join(cwd, "railfog.toml");
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
}
