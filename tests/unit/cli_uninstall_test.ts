// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & CLI distribution
// tests/unit/cli_uninstall_test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { runUninstall } from "../../cli/uninstall.ts";

const cliMainPath = fromFileUrl(new URL("../../cli/main.ts", import.meta.url));

/**
 * Helper to run the RailFog CLI via subprocess.
 */
async function runCli(
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-all",
      cliMainPath,
      ...args,
    ],
    env,
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

Deno.test("cli_uninstall: cleanly removes installed binary and metadata in custom directory", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-uninstall-test-" });
  try {
    const binDir = join(tempDir, "bin");
    await Deno.mkdir(binDir, { recursive: true });

    // Create dummy executable shims
    const isWindows = Deno.build.os === "windows";
    const binaryName = isWindows ? "rail.cmd" : "rail";
    const binaryPath = join(binDir, binaryName);
    await Deno.writeTextFile(binaryPath, "#!/bin/sh\necho 0.8.0\n");

    if (isWindows) {
      await Deno.writeTextFile(join(binDir, "rail.exe"), "dummy exe");
    }

    // Create dummy metadata
    const metaPath = join(binDir, ".rail-version.json");
    await Deno.writeTextFile(
      metaPath,
      JSON.stringify({ version: "0.8.0", installedAt: new Date().toISOString() }),
    );

    // Run uninstall with custom root environment override
    const origInstallDir = Deno.env.get("RAILFOG_INSTALL_DIR");
    try {
      Deno.env.set("RAILFOG_INSTALL_DIR", tempDir);
      const res = await runUninstall();

      assertEquals(res.ok, true);
      assert(res.removedFiles.length >= 2, "Expected at least binary and metadata removed");

      // Verify files removed from disk
      let binaryExists = true;
      try {
        await Deno.stat(binaryPath);
      } catch {
        binaryExists = false;
      }
      assertEquals(binaryExists, false);

      let metaExists = true;
      try {
        await Deno.stat(metaPath);
      } catch {
        metaExists = false;
      }
      assertEquals(metaExists, false);
    } finally {
      if (origInstallDir) {
        Deno.env.set("RAILFOG_INSTALL_DIR", origInstallDir);
      } else {
        Deno.env.delete("RAILFOG_INSTALL_DIR");
      }
    }
  } finally {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Best effort cleanup
    }
  }
});

Deno.test("cli_uninstall: handles non-existent installation gracefully without error", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-uninstall-empty-" });
  try {
    const binDir = join(tempDir, "bin");
    await Deno.mkdir(binDir, { recursive: true });

    const origInstallDir = Deno.env.get("RAILFOG_INSTALL_DIR");
    try {
      Deno.env.set("RAILFOG_INSTALL_DIR", tempDir);
      const res = await runUninstall();

      assertEquals(res.ok, true);
      assertEquals(res.removedFiles.length, 0);
    } finally {
      if (origInstallDir) {
        Deno.env.set("RAILFOG_INSTALL_DIR", origInstallDir);
      } else {
        Deno.env.delete("RAILFOG_INSTALL_DIR");
      }
    }
  } finally {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Best effort cleanup
    }
  }
});

Deno.test("cli_uninstall: CLI entrypoint 'rail uninstall' executes cleanly", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-uninstall-cli-" });
  try {
    const binDir = join(tempDir, "bin");
    await Deno.mkdir(binDir, { recursive: true });

    const { code, stdout } = await runCli(["uninstall"], {
      RAILFOG_INSTALL_DIR: tempDir,
      NO_COLOR: "1",
    });

    assertEquals(code, 0);
    assertStringIncludes(stdout, "RailFog");
    assertStringIncludes(stdout, "Departure");
  } finally {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Best effort cleanup
    }
  }
});
