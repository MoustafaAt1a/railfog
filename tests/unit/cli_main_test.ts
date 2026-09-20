import { assert, assertEquals, assertExists, assertMatch } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { parse } from "@std/toml";
import * as cliMain from "../../cli/main.ts";

const cliMainPath = fromFileUrl(new URL("../../cli/main.ts", import.meta.url));

async function runCli(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-net",
      cliMainPath,
      ...args,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

// =============================================================================
// Unit Tests
// =============================================================================

Deno.test(
  "Unit: starter railfog.toml scaffold content is valid TOML and parses into { name, functions, routes }",
  () => {
    const exports = cliMain as Record<string, unknown>;
    let starterToml = exports.STARTER_CONFIG ??
      exports.STARTER_RAILFOG_TOML ??
      exports.starterConfig;
    if (typeof exports.getStarterConfig === "function") {
      starterToml = (exports.getStarterConfig as () => string)();
    }

    assertExists(
      starterToml,
      "cli/main.ts must export STARTER_CONFIG (or STARTER_RAILFOG_TOML) string",
    );
    assertEquals(
      typeof starterToml,
      "string",
      "STARTER_CONFIG must be a string",
    );

    const parsed = parse(starterToml as string) as Record<string, unknown>;
    assertExists(parsed.name, "Starter config must have 'name'");
    assertExists(parsed.functions, "Starter config must have 'functions'");
    assertExists(parsed.routes, "Starter config must have 'routes'");
  },
);

// =============================================================================
// Integration Tests
// =============================================================================

Deno.test(
  "Integration: AC1 - rail init creates valid railfog.toml and functions/api.ts, deno check passes",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-init-test-" });
    try {
      const res = await runCli(["init"], tempDir);
      assertEquals(
        res.code,
        0,
        `rail init should exit 0. Output: ${res.stdout}\n${res.stderr}`,
      );

      // Verify railfog.toml exists and parses
      const tomlPath = join(tempDir, "railfog.toml");
      const tomlStat = await Deno.stat(tomlPath);
      assert(tomlStat.isFile, "railfog.toml must be a file");

      const tomlContent = await Deno.readTextFile(tomlPath);
      const parsed = parse(tomlContent) as Record<string, unknown>;
      assertExists(parsed.name, "railfog.toml must contain 'name'");
      assertExists(parsed.functions, "railfog.toml must contain 'functions'");
      assertExists(parsed.routes, "railfog.toml must contain 'routes'");

      // Verify functions/api.ts exists
      const funcPath = join(tempDir, "functions", "api.ts");
      const funcStat = await Deno.stat(funcPath);
      assert(funcStat.isFile, "functions/api.ts must be a file");

      // Run deno check functions/api.ts
      const checkCmd = new Deno.Command(Deno.execPath(), {
        args: ["check", "functions/api.ts"],
        cwd: tempDir,
        stdout: "piped",
        stderr: "piped",
      });
      const checkRes = await checkCmd.output();
      const checkErr = new TextDecoder().decode(checkRes.stderr);
      assertEquals(
        checkRes.code,
        0,
        `deno check functions/api.ts must succeed. Stderr: ${checkErr}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: AC2 - rail status prints loaded functions and routes from railfog.toml",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-status-test-" });
    try {
      const tomlContent = `
name = "test-status-app"

[functions.users]
entry = "functions/users.ts"

[functions.api]
entry = "functions/api.ts"

[[routes]]
pattern = "/api/users"
function = "users"

[[routes]]
pattern = "/api/*"
function = "api"
`;
      await Deno.writeTextFile(
        join(tempDir, "railfog.toml"),
        tomlContent.trim(),
      );

      const res = await runCli(["status"], tempDir);
      assertEquals(
        res.code,
        0,
        `rail status should exit 0. Output: ${res.stdout}\n${res.stderr}`,
      );

      assert(
        res.stdout.includes("/api/users"),
        `stdout should contain route '/api/users'. Actual:\n${res.stdout}`,
      );
      assert(
        res.stdout.includes("/api/*"),
        `stdout should contain route '/api/*'. Actual:\n${res.stdout}`,
      );
      assert(
        res.stdout.includes("users"),
        `stdout should contain target function 'users'. Actual:\n${res.stdout}`,
      );
      assert(
        res.stdout.includes("api"),
        `stdout should contain target function 'api'. Actual:\n${res.stdout}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: rail init followed by rail status in a temp directory",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-e2e-test-" });
    try {
      const initRes = await runCli(["init"], tempDir);
      assertEquals(
        initRes.code,
        0,
        `rail init should exit 0. Output: ${initRes.stdout}\n${initRes.stderr}`,
      );

      const statusRes = await runCli(["status"], tempDir);
      assertEquals(
        statusRes.code,
        0,
        `rail status should exit 0. Output: ${statusRes.stdout}\n${statusRes.stderr}`,
      );
      assert(
        statusRes.stdout.includes("api"),
        `status output should mention 'api'. Actual:\n${statusRes.stdout}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: rail dev in empty directory exits non-zero and reports missing railfog.toml",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-dev-missing-" });
    try {
      const res = await runCli(["dev"], tempDir);
      assertEquals(
        res.code,
        1,
        `rail dev should exit 1 when missing railfog.toml. Output: ${res.stdout}\n${res.stderr}`,
      );

      const combinedOutput = res.stdout + "\n" + res.stderr;
      assertMatch(
        combinedOutput,
        /railfog\.toml not found/i,
        `rail dev should indicate missing railfog.toml. Actual output:\n${combinedOutput}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: rail dev starts local dev server and serves initialized application",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-dev-start-" });
    let server: cliMain.LocalServer | null = null;
    try {
      await cliMain.initCommand(tempDir);
      server = await cliMain.devCommand(tempDir, 0);
      const port = server.port;
      assert(port > 0, `Expected server port to be > 0, got: ${port}`);

      const res = await fetch(`http://localhost:${port}/api/hello`);
      assertEquals(res.status, 200);
      const body = await res.text();
      assertEquals(body, "Hello from RailFog!");

      const reqId = res.headers.get("x-request-id") ??
        res.headers.get("request-id");
      assert(reqId !== null, "Response must carry request-id header");
    } finally {
      if (server) {
        await server.close();
      }
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: rail status in empty directory handles missing railfog.toml",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-missing-test-" });
    try {
      const res = await runCli(["status"], tempDir);
      const combined = res.stdout + "\n" + res.stderr;
      const failedWithNonZero = res.code !== 0;
      const reportedMissingToml =
        /railfog\.toml.*not found|no.*railfog\.toml|could not find.*railfog\.toml/i
          .test(combined);

      assert(
        failedWithNonZero || reportedMissingToml,
        `rail status without railfog.toml must exit non-zero or clearly report missing config. Code: ${res.code}, Output:\n${combined}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);

Deno.test(
  "Integration: unknown subcommand beyond init/status/dev/deploy is rejected",
  async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "railfog-unknown-cmd-" });
    try {
      const res = await runCli(["nonexistent-subcommand"], tempDir);
      const combined = res.stdout + "\n" + res.stderr;
      const failedOrReported = res.code !== 0 ||
        /unknown.*command|unsupported|not supported/i.test(combined);
      assert(
        failedOrReported,
        `rail nonexistent-subcommand should exit non-zero or report unknown/unsupported command. Code: ${res.code}, Output:\n${combined}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
);
