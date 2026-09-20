// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & CLI distribution
// spec: tasks/milestone-0.8-developer-experience-ux/T-0814-cli-self-upgrade-mechanism.md
// tests/unit/cli_upgrade_test.ts

import {
  assert,
  assertEquals,
  assertFalse,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { CLI_VERSION } from "../../cli/version.ts";
import {
  checkLatestCommit,
  checkLatestVersion,
  getInstalledMetadata,
  isValidRef,
  isValidRepo,
  isValidVersion,
  runUpgrade,
  type UpgradeOptions,
  type UpgradeResult,
} from "../../cli/upgrade.ts";

const cliMainPath = fromFileUrl(new URL("../../cli/main.ts", import.meta.url));

/**
 * Helper to run the RailFog CLI via subprocess.
 */
async function runCli(
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      cliMainPath,
      ...args,
    ],
    cwd: cwd ?? Deno.cwd(),
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

/**
 * Helper to execute an installed binary cross-platform.
 */
async function executeInstalledBinary(
  binaryPath: string,
  args: string[] = ["--help"],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const isWindows = Deno.build.os === "windows";
  const cmd = isWindows && binaryPath.endsWith(".cmd")
    ? new Deno.Command("cmd.exe", {
      args: ["/c", binaryPath, ...args],
      stdout: "piped",
      stderr: "piped",
    })
    : new Deno.Command(binaryPath, {
      args,
      stdout: "piped",
      stderr: "piped",
    });

  const output = await cmd.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

// =============================================================================
// 1. CLI_VERSION export
// spec: PLAT-19, T-0814 AC 1
// =============================================================================

Deno.test(
  "CLI_VERSION: exports a non-empty string",
  () => {
    assertEquals(
      typeof CLI_VERSION,
      "string",
      "CLI_VERSION must be exported as a string from cli/version.ts",
    );
    assert(
      CLI_VERSION.length > 0,
      "CLI_VERSION must not be empty",
    );
  },
);

Deno.test(
  "CLI_VERSION: matches semantic versioning format (/^\\d+\\.\\d+\\.\\d+/)",
  () => {
    // spec: PLAT-19, T-0814 AC 1 — SemVer compliance
    assertMatch(
      CLI_VERSION,
      /^\d+\.\d+\.\d+/,
      "CLI_VERSION must match semantic versioning format /^\\d+\\.\\d+\\.\\d+/",
    );
  },
);

Deno.test(
  "CLI_VERSION: matches current milestone version line (0.8.x)",
  () => {
    assertStringIncludes(
      CLI_VERSION,
      "0.8.",
      "CLI_VERSION should match the 0.8.x milestone series",
    );
  },
);

// =============================================================================
// 2. --version and -v CLI flag validation
// spec: PLAT-19, T-0814 AC 1
// =============================================================================

Deno.test(
  "CLI flag --version: outputs current version and exits with code 0",
  async () => {
    const res = await runCli(["--version"]);
    assertEquals(
      res.code,
      0,
      `'rail --version' must exit with code 0. Stderr: ${res.stderr}`,
    );
    assertStringIncludes(
      res.stdout,
      `rail ${CLI_VERSION}`,
      `'rail --version' stdout must include 'rail ${CLI_VERSION}'. Stdout: ${res.stdout}`,
    );
  },
);

Deno.test(
  "CLI flag -v: outputs current version and exits with code 0",
  async () => {
    const res = await runCli(["-v"]);
    assertEquals(
      res.code,
      0,
      `'rail -v' must exit with code 0. Stderr: ${res.stderr}`,
    );
    assertStringIncludes(
      res.stdout,
      `rail ${CLI_VERSION}`,
      `'rail -v' stdout must include 'rail ${CLI_VERSION}'. Stdout: ${res.stdout}`,
    );
  },
);

// =============================================================================
// 3. checkLatestVersion
// spec: PLAT-19, T-0814 AC 2, AC 3
// =============================================================================

Deno.test(
  "checkLatestVersion: resolves latest version string from GitHub raw repository or mock fetch",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = ((input: string | URL | Request) => {
        const urlStr = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;

        if (urlStr.endsWith("deno.json")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ version: "0.8.1" }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }
        return Promise.resolve(
          new Response(
            'export const CLI_VERSION = "0.8.1";\n',
            { status: 200, headers: { "content-type": "text/plain" } },
          ),
        );
      }) as typeof fetch;

      const latest = await checkLatestVersion({
        repo: "MoustafaAt1a/railfog",
        ref: "main",
      });

      assertEquals(
        latest,
        "0.8.1",
        "checkLatestVersion should return resolved version '0.8.1'",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "checkLatestVersion: uses default repo and ref when options are omitted",
  async () => {
    const originalFetch = globalThis.fetch;
    let fetchedUrl = "";
    try {
      globalThis.fetch = ((input: string | URL | Request) => {
        fetchedUrl = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;

        return Promise.resolve(
          new Response(
            'export const CLI_VERSION = "0.8.0";\n',
            { status: 200, headers: { "content-type": "text/plain" } },
          ),
        );
      }) as typeof fetch;

      const latest = await checkLatestVersion();
      assert(
        fetchedUrl.includes("MoustafaAt1a/railfog"),
        `Fetched URL should reference default repo MoustafaAt1a/railfog. Got: ${fetchedUrl}`,
      );
      assert(
        fetchedUrl.includes("main"),
        `Fetched URL should reference default ref 'main'. Got: ${fetchedUrl}`,
      );
      assertEquals(latest, "0.8.0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "checkLatestVersion: error handling when remote cannot be reached (network failure)",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (() => {
        return Promise.reject(
          new TypeError("Failed to fetch: Network unreachable"),
        );
      }) as typeof fetch;

      await assertRejects(
        async () => {
          await checkLatestVersion({
            repo: "MoustafaAt1a/railfog",
            ref: "main",
          });
        },
        Error,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "checkLatestVersion: error handling when ref does not exist (404 Not Found)",
  async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (() => {
        return Promise.resolve(
          new Response("404: Not Found", {
            status: 404,
            statusText: "Not Found",
          }),
        );
      }) as typeof fetch;

      await assertRejects(
        async () => {
          await checkLatestVersion({
            repo: "MoustafaAt1a/railfog",
            ref: "non-existent-ref-00000",
          });
        },
        Error,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

// =============================================================================
// 4. runUpgrade
// spec: PLAT-19, T-0814 AC 2, 3, 4, 5
// =============================================================================

Deno.test(
  "runUpgrade: checkOnly asserts upToDate boolean without modifying disk files or installing binaries",
  async () => {
    const tempRoot = await Deno.makeTempDir({ prefix: "railfog-upg-check-" });
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = (() => {
        return Promise.resolve(
          new Response(
            `export const CLI_VERSION = "${CLI_VERSION}";\n`,
            { status: 200, headers: { "content-type": "text/plain" } },
          ),
        );
      }) as typeof fetch;

      const result: UpgradeResult = await runUpgrade({
        checkOnly: true,
        root: tempRoot,
      });

      assertEquals(result.ok, true, "checkOnly mode must return ok: true");
      assertEquals(
        typeof result.upToDate,
        "boolean",
        "result.upToDate must be a boolean",
      );
      assertEquals(
        result.currentVersion,
        CLI_VERSION,
        "currentVersion must match CLI_VERSION",
      );
      assertEquals(
        result.targetVersion,
        CLI_VERSION,
        "targetVersion must match resolved remote version",
      );

      // Verify no binary files were installed in tempRoot
      const binDir = join(tempRoot, "bin");
      let binDirExists = false;
      try {
        await Deno.stat(binDir);
        binDirExists = true;
      } catch {
        binDirExists = false;
      }

      if (binDirExists) {
        const files: string[] = [];
        for await (const entry of Deno.readDir(binDir)) {
          files.push(entry.name);
        }
        assertEquals(
          files.length,
          0,
          `No files should be written to binDir during checkOnly, found: ${
            files.join(", ")
          }`,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
      try {
        await Deno.remove(tempRoot, { recursive: true });
      } catch {
        // Best-effort cleanup
      }
    }
  },
);

Deno.test(
  "runUpgrade: already up to date when target version equals currentVersion and force is not set",
  async () => {
    const tempRoot = await Deno.makeTempDir({
      prefix: "railfog-upg-uptodate-",
    });

    try {
      const result: UpgradeResult = await runUpgrade({
        version: CLI_VERSION,
        force: false,
        root: tempRoot,
      });

      assertEquals(
        result.ok,
        true,
        "Already up-to-date should return ok: true",
      );
      assertEquals(
        result.upToDate,
        true,
        "result.upToDate must be true when target version matches currentVersion",
      );
      assertEquals(result.currentVersion, CLI_VERSION);
      assertEquals(result.targetVersion, CLI_VERSION);

      // Asserts no binary was installed in tempRoot
      const binDir = join(tempRoot, "bin");
      let binExists = false;
      try {
        await Deno.stat(binDir);
        binExists = true;
      } catch {
        binExists = false;
      }
      assertFalse(
        binExists,
        "No bin directory should be created when already up to date without force",
      );
    } finally {
      try {
        await Deno.remove(tempRoot, { recursive: true });
      } catch {
        // Best-effort cleanup
      }
    }
  },
);

Deno.test(
  "runUpgrade: upgrade execution with { root: tempRoot, force: true, version: 'main' } installs and verifies binary",
  async () => {
    const tempRoot = await Deno.makeTempDir({ prefix: "railfog-upg-exec-" });

    try {
      const options: UpgradeOptions = {
        root: tempRoot,
        force: true,
        version: "main",
      };
      const result: UpgradeResult = await runUpgrade(options);

      assertEquals(
        result.ok,
        true,
        `runUpgrade must succeed. Message: ${result.message}`,
      );

      // Identify the installed binary in tempRoot/bin
      const isWindows = Deno.build.os === "windows";
      const candidatePaths = isWindows
        ? [join(tempRoot, "bin", "rail.cmd"), join(tempRoot, "bin", "rail.exe")]
        : [join(tempRoot, "bin", "rail")];

      let installedBinary: string | undefined;
      for (const candidate of candidatePaths) {
        try {
          const stat = await Deno.stat(candidate);
          if (stat.isFile) {
            installedBinary = candidate;
            break;
          }
        } catch {
          // Check next candidate
        }
      }

      assert(
        installedBinary !== undefined,
        `Installed binary must exist in ${
          join(tempRoot, "bin")
        }. Checked candidates: ${candidatePaths.join(", ")}`,
      );

      // Verify execution: <tempRoot>/bin/rail --help succeeds with exit code 0
      const verifyRes = await executeInstalledBinary(installedBinary, [
        "--help",
      ]);
      assertEquals(
        verifyRes.code,
        0,
        `Executing installed binary --help must succeed with code 0. Stderr: ${verifyRes.stderr}, Stdout: ${verifyRes.stdout}`,
      );
      assertStringIncludes(
        verifyRes.stdout,
        "RailFog CLI",
        "Executing installed binary --help stdout must contain 'RailFog CLI'",
      );
    } finally {
      try {
        await Deno.remove(tempRoot, { recursive: true });
      } catch {
        // Best-effort cleanup
      }
    }
  },
);

// =============================================================================
// 5. CLI command aliases: upgrade and update
// spec: PLAT-19, T-0814 AC 2, 3, 4, 5
// =============================================================================

Deno.test(
  "CLI command dispatch: 'rail upgrade' and 'rail update' subcommands are supported in cli/main.ts",
  async () => {
    const upgradeHelp = await runCli(["upgrade", "--help"]);
    assertEquals(
      upgradeHelp.code,
      0,
      `'rail upgrade --help' must exit 0. Stderr: ${upgradeHelp.stderr}`,
    );
    assertMatch(
      upgradeHelp.stdout.toLowerCase(),
      /upgrade|update/,
      "'rail upgrade --help' output should describe upgrade/update functionality",
    );

    const updateHelp = await runCli(["update", "--help"]);
    assertEquals(
      updateHelp.code,
      0,
      `'rail update --help' must exit 0. Stderr: ${updateHelp.stderr}`,
    );
    assertMatch(
      updateHelp.stdout.toLowerCase(),
      /upgrade|update/,
      "'rail update --help' output should describe upgrade/update functionality",
    );
  },
);

Deno.test(
  "CLI command dispatch: 'rail update --check' executes check-only mode without errors",
  async () => {
    const res = await runCli(["update", "--check"]);
    assertEquals(
      res.code,
      0,
      `'rail update --check' must exit with code 0. Stderr: ${res.stderr}`,
    );
    assert(
      res.stdout.length > 0,
      "'rail update --check' should produce informative output",
    );
  },
);

Deno.test(
  "CLI command dispatch: 'rail upgrade --version <ver> --check' is not hijacked by top-level version flag",
  async () => {
    const res = await runCli(["upgrade", "--version", "0.8.0", "--check"]);
    assertEquals(
      res.code,
      0,
      `'rail upgrade --version 0.8.0 --check' must exit 0. Stderr: ${res.stderr}`,
    );
    // Should output upgrade status, NOT bare 'rail 0.8.0'
    assertStringIncludes(
      res.stdout,
      "RailFog CLI is already up to date",
      `Expected check message, got: ${res.stdout}`,
    );
  },
);

Deno.test(
  "runUpgrade: local sync installs from local repository into root and bypasses version equality check",
  async () => {
    const tempRoot = await Deno.makeTempDir({
      prefix: "railfog-upgrade-local-",
    });
    try {
      const result = await runUpgrade({
        root: tempRoot,
        local: true,
      });

      assertEquals(
        result.ok,
        true,
        `Local upgrade should succeed: ${result.message}`,
      );
      assertEquals(result.targetVersion, "local");
      assert(
        result.installedPath !== undefined,
        "installedPath should be returned",
      );

      const isWindows = Deno.build.os === "windows";
      const expectedBinary = join(
        tempRoot,
        "bin",
        isWindows ? "rail.cmd" : "rail",
      );
      assertEquals(result.installedPath, expectedBinary);

      const execResult = await executeInstalledBinary(result.installedPath, [
        "--version",
      ]);
      assertEquals(
        execResult.code,
        0,
        `Installed binary should run: ${execResult.stderr}`,
      );
      assertStringIncludes(execResult.stdout, `rail ${CLI_VERSION}`);
    } finally {
      try {
        await Deno.remove(tempRoot, { recursive: true });
      } catch {
        // cleanup
      }
    }
  },
);

Deno.test(
  "CLI command dispatch: 'rail update --help' documents -l, --local flag",
  async () => {
    const res = await runCli(["update", "--help"]);
    assertEquals(res.code, 0);
    assertStringIncludes(res.stdout, "-l, --local");
    assertStringIncludes(res.stdout, "local repository");
  },
);

// =============================================================================
// 6. Security Adversarial Tests (PLAT-15, PLAT-19)
// =============================================================================

Deno.test(
  "Security: isValidRepo rejects path traversal and malformed repository names",
  () => {
    assert(isValidRepo("MoustafaAt1a/railfog"));
    assert(isValidRepo("owner-name/repo_123.test"));
    assertFalse(isValidRepo("../malicious/repo"));
    assertFalse(isValidRepo("owner/repo/subpath"));
    assertFalse(isValidRepo("owner//repo"));
    assertFalse(isValidRepo(""));
    assertFalse(isValidRepo("owner\\repo"));
  },
);

Deno.test(
  "Security: isValidRef rejects path traversal and forbidden characters",
  () => {
    assert(isValidRef("main"));
    assert(isValidRef("v0.8.0"));
    assert(isValidRef("feature/branch-1"));
    assertFalse(isValidRef("../../../etc/passwd"));
    assertFalse(isValidRef("branch/../main"));
    assertFalse(isValidRef("branch//name"));
    assertFalse(isValidRef("branch name with spaces"));
    assertFalse(isValidRef(""));
  },
);

Deno.test(
  "Security: isValidVersion validates strict SemVer format",
  () => {
    assert(isValidVersion("0.8.0"));
    assert(isValidVersion("v0.8.0"));
    assert(isValidVersion("1.0.0-rc.1"));
    assertFalse(isValidVersion("../0.8.0"));
    assertFalse(isValidVersion("not-a-version"));
    assertFalse(isValidVersion(""));
  },
);

Deno.test(
  "Security: checkLatestVersion rejects traversal ref attempt",
  async () => {
    await assertRejects(
      () =>
        checkLatestVersion({
          repo: "MoustafaAt1a/railfog",
          ref: "../../../attacker/repo/main",
        }),
      Error,
      "Invalid git ref format",
    );
  },
);

Deno.test(
  "Security: runUpgrade rejects traversal and invalid inputs",
  async () => {
    const resRef = await runUpgrade({
      ref: "../../../attacker/repo/main",
      checkOnly: true,
    });
    assertEquals(resRef.ok, false);
    assertStringIncludes(resRef.message ?? "", "Invalid git ref format");

    const resRepo = await runUpgrade({
      repo: "attacker/evil/repo",
      checkOnly: true,
    });
    assertEquals(resRepo.ok, false);
    assertStringIncludes(resRepo.message ?? "", "Invalid repository format");

    const resVer = await runUpgrade({
      version: "evil-script.sh",
      checkOnly: true,
    });
    assertEquals(resVer.ok, false);
    assertStringIncludes(resVer.message ?? "", "Invalid version format");
  },
);

Deno.test(
  "Security: runInstaller handles directories with spaces in root path without breaking execution",
  async () => {
    const parentTemp = await Deno.makeTempDir({ prefix: "railfog-test-" });
    const spaceRoot = join(parentTemp, "path with spaces");
    await Deno.mkdir(spaceRoot, { recursive: true });

    try {
      const result = await runUpgrade({
        root: spaceRoot,
        force: true,
        version: "main",
      });

      assertEquals(
        result.ok,
        true,
        `Upgrade in path with spaces should succeed: ${result.message}`,
      );
      assert(result.installedPath !== undefined);
      assertStringIncludes(result.installedPath, "path with spaces");
    } finally {
      try {
        await Deno.remove(parentTemp, { recursive: true });
      } catch {
        // cleanup
      }
    }
  },
);

// =============================================================================
// 7. Git Sync and Rail Sync Alias Tests
// =============================================================================

Deno.test(
  "CLI command dispatch: 'rail sync --help' documents sync subcommand",
  async () => {
    const res = await runCli(["sync", "--help"]);
    assertEquals(res.code, 0, `'rail sync --help' must exit 0: ${res.stderr}`);
    assertStringIncludes(
      res.stdout,
      "rail sync",
      `Expected 'rail sync' in help stdout, got: ${res.stdout}`,
    );
  },
);

Deno.test(
  "Git Sync: checkLatestCommit resolves commit SHA or handles network gracefully",
  async () => {
    const commit = await checkLatestCommit({
      repo: "MoustafaAt1a/railfog",
      ref: "main",
    });
    // If online, commit is 40-character hex string; if offline, it returns undefined
    if (commit !== undefined) {
      assertEquals(typeof commit, "string");
      assertMatch(commit, /^[a-f0-9]{40}$/);
    }
  },
);

Deno.test(
  "Git Sync: runUpgrade writes .rail-version.json metadata during execution",
  async () => {
    const tempRoot = await Deno.makeTempDir({ prefix: "railfog-sync-meta-" });
    try {
      const result = await runUpgrade({
        root: tempRoot,
        local: true,
      });
      assertEquals(result.ok, true);

      const meta = getInstalledMetadata(tempRoot);
      assert(
        meta !== undefined,
        ".rail-version.json must be written to bin directory",
      );
      assertEquals(meta.version, "0.8.0");
    } finally {
      try {
        await Deno.remove(tempRoot, { recursive: true });
      } catch {
        // cleanup
      }
    }
  },
);
