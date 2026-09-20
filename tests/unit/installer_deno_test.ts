// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & CLI distribution
// spec: tasks/milestone-0.8-developer-experience-ux/T-0813-deno-cli-installer.md
// tests/unit/installer_deno_test.ts

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { fromFileUrl, join, resolve } from "@std/path";
import {
  type InstallerOptions,
  parseInstallerArgs,
  resolveInstallPaths,
  runInstaller,
} from "../../scripts/install.ts";

// =============================================================================
// 1. parseInstallerArgs
// spec: PLAT-19, T-0813 AC 1 & 2
// =============================================================================

Deno.test(
  "parseInstallerArgs: preserves default values when no flags are supplied",
  () => {
    const opts = parseInstallerArgs([]);
    assertEquals(opts.ref, "main", "Default ref must be 'main'");
    assertEquals(
      opts.repo,
      "MoustafaAt1a/railfog",
      "Default repo must be 'MoustafaAt1a/railfog'",
    );
    assertFalse(opts.compile, "compile should default to false / falsy");
    assertFalse(opts.force, "force should default to false / falsy");
    assertFalse(opts.local, "local should default to false / falsy");
    assertFalse(opts.help, "help should default to false / falsy");
    assertEquals(opts.root, undefined, "root should default to undefined");
  },
);

Deno.test(
  "parseInstallerArgs: parses long-form flags correctly",
  () => {
    const args = [
      "--root",
      "/opt/railfog-custom",
      "--compile",
      "--force",
      "--local",
      "--ref",
      "v0.8.0",
      "--repo",
      "custom-org/custom-repo",
      "--help",
    ];
    const opts = parseInstallerArgs(args);

    assertEquals(opts.root, "/opt/railfog-custom");
    assertEquals(opts.compile, true);
    assertEquals(opts.force, true);
    assertEquals(opts.local, true);
    assertEquals(opts.ref, "v0.8.0");
    assertEquals(opts.repo, "custom-org/custom-repo");
    assertEquals(opts.help, true);
  },
);

Deno.test(
  "parseInstallerArgs: parses short-form flags correctly",
  () => {
    const args = [
      "-r",
      "/short/install/path",
      "-c",
      "-f",
      "-l",
      "-h",
    ];
    const opts = parseInstallerArgs(args);

    assertEquals(opts.root, "/short/install/path");
    assertEquals(opts.compile, true);
    assertEquals(opts.force, true);
    assertEquals(opts.local, true);
    assertEquals(opts.help, true);
    // Preserves defaults for unprovided string options
    assertEquals(opts.ref, "main");
    assertEquals(opts.repo, "MoustafaAt1a/railfog");
  },
);

Deno.test(
  "parseInstallerArgs: parses key=value argument syntax",
  () => {
    const args = [
      "--root=/var/tools/railfog",
      "--ref=release-1.0",
      "--repo=myuser/myfork",
    ];
    const opts = parseInstallerArgs(args);

    assertEquals(opts.root, "/var/tools/railfog");
    assertEquals(opts.ref, "release-1.0");
    assertEquals(opts.repo, "myuser/myfork");
    assertFalse(opts.compile);
    assertFalse(opts.force);
  },
);

// =============================================================================
// 2. resolveInstallPaths
// spec: PLAT-19, T-0813 AC 1, 2, 3
// =============================================================================

Deno.test(
  "resolveInstallPaths: resolves installDir and binDir using explicit options.root",
  () => {
    const customRoot = resolve("/custom/install/dir");
    const paths = resolveInstallPaths({ root: customRoot });

    assertEquals(
      paths.installDir,
      customRoot,
      "installDir must equal explicit root",
    );
    assertEquals(
      paths.binDir,
      join(customRoot, "bin"),
      "binDir must be located at <root>/bin",
    );
    assertEquals(
      paths.fullBinaryPath,
      join(paths.binDir, paths.binaryName),
      "fullBinaryPath must be <binDir>/<binaryName>",
    );
  },
);

Deno.test(
  "resolveInstallPaths: resolves installDir and binDir using DENO_INSTALL_ROOT environment variable",
  () => {
    const origDenoInstallRoot = Deno.env.get("DENO_INSTALL_ROOT");
    const fakeEnvRoot = resolve("/env/deno/install/root");

    try {
      Deno.env.set("DENO_INSTALL_ROOT", fakeEnvRoot);
      const paths = resolveInstallPaths({});

      assertEquals(
        paths.installDir,
        fakeEnvRoot,
        "installDir must match DENO_INSTALL_ROOT when options.root is unset",
      );
      assertEquals(
        paths.binDir,
        join(fakeEnvRoot, "bin"),
        "binDir must be located at $DENO_INSTALL_ROOT/bin",
      );
      assertEquals(
        paths.fullBinaryPath,
        join(paths.binDir, paths.binaryName),
      );
    } finally {
      if (origDenoInstallRoot !== undefined) {
        Deno.env.set("DENO_INSTALL_ROOT", origDenoInstallRoot);
      } else {
        Deno.env.delete("DENO_INSTALL_ROOT");
      }
    }
  },
);

Deno.test(
  "resolveInstallPaths: explicit options.root takes precedence over DENO_INSTALL_ROOT",
  () => {
    const origDenoInstallRoot = Deno.env.get("DENO_INSTALL_ROOT");
    const fakeEnvRoot = resolve("/env/deno/install/root");
    const explicitRoot = resolve("/explicit/override/root");

    try {
      Deno.env.set("DENO_INSTALL_ROOT", fakeEnvRoot);
      const paths = resolveInstallPaths({ root: explicitRoot });

      assertEquals(
        paths.installDir,
        explicitRoot,
        "Explicit options.root must override DENO_INSTALL_ROOT",
      );
      assertEquals(paths.binDir, join(explicitRoot, "bin"));
    } finally {
      if (origDenoInstallRoot !== undefined) {
        Deno.env.set("DENO_INSTALL_ROOT", origDenoInstallRoot);
      } else {
        Deno.env.delete("DENO_INSTALL_ROOT");
      }
    }
  },
);

Deno.test(
  "resolveInstallPaths: resolves installDir and binDir using RAILFOG_INSTALL_DIR environment variable",
  () => {
    const origDenoInstallRoot = Deno.env.get("DENO_INSTALL_ROOT");
    const origRailfogInstallDir = Deno.env.get("RAILFOG_INSTALL_DIR");
    const fakeEnvRoot = resolve("/env/railfog/install/dir");

    try {
      Deno.env.delete("DENO_INSTALL_ROOT");
      Deno.env.set("RAILFOG_INSTALL_DIR", fakeEnvRoot);
      const paths = resolveInstallPaths({});

      assertEquals(
        paths.installDir,
        fakeEnvRoot,
        "installDir must match RAILFOG_INSTALL_DIR when root and DENO_INSTALL_ROOT are unset",
      );
      assertEquals(
        paths.binDir,
        join(fakeEnvRoot, "bin"),
        "binDir must be located at $RAILFOG_INSTALL_DIR/bin",
      );
      assertEquals(
        paths.fullBinaryPath,
        join(paths.binDir, paths.binaryName),
      );
    } finally {
      if (origDenoInstallRoot !== undefined) {
        Deno.env.set("DENO_INSTALL_ROOT", origDenoInstallRoot);
      }
      if (origRailfogInstallDir !== undefined) {
        Deno.env.set("RAILFOG_INSTALL_DIR", origRailfogInstallDir);
      } else {
        Deno.env.delete("RAILFOG_INSTALL_DIR");
      }
    }
  },
);

Deno.test(
  "resolveInstallPaths: falls back to ~/.deno when root and DENO_INSTALL_ROOT are unset",
  () => {
    const origDenoInstallRoot = Deno.env.get("DENO_INSTALL_ROOT");

    try {
      Deno.env.delete("DENO_INSTALL_ROOT");
      const paths = resolveInstallPaths({});

      const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
      assert(home.length > 0, "Home directory must be resolvable");

      const expectedInstallDir = join(home, ".deno");
      const expectedBinDir = join(expectedInstallDir, "bin");

      assertEquals(
        paths.installDir,
        expectedInstallDir,
        "installDir must fall back to ~/.deno",
      );
      assertEquals(
        paths.binDir,
        expectedBinDir,
        "binDir must fall back to ~/.deno/bin",
      );
      assertEquals(
        paths.fullBinaryPath,
        join(expectedBinDir, paths.binaryName),
      );
    } finally {
      if (origDenoInstallRoot !== undefined) {
        Deno.env.set("DENO_INSTALL_ROOT", origDenoInstallRoot);
      }
    }
  },
);

Deno.test(
  "resolveInstallPaths: generates correct binaryName based on Deno.build.os and options.compile",
  () => {
    const isWindows = Deno.build.os === "windows";

    // Scenario A: compile = true (standalone binary)
    const compiledPaths = resolveInstallPaths({
      compile: true,
      root: "/test/bin",
    });
    const expectedCompiledBinary = isWindows ? "rail.exe" : "rail";
    assertEquals(
      compiledPaths.binaryName,
      expectedCompiledBinary,
      `Compiled binary name on ${Deno.build.os} must be ${expectedCompiledBinary}`,
    );
    assertEquals(
      compiledPaths.fullBinaryPath,
      join(compiledPaths.binDir, expectedCompiledBinary),
    );

    // Scenario B: compile = false / undefined (deno runner script shim)
    const runnerPaths = resolveInstallPaths({
      compile: false,
      root: "/test/bin",
    });
    const expectedRunnerBinary = isWindows ? "rail.cmd" : "rail";
    assertEquals(
      runnerPaths.binaryName,
      expectedRunnerBinary,
      `Runner script name on ${Deno.build.os} must be ${expectedRunnerBinary}`,
    );
    assertEquals(
      runnerPaths.fullBinaryPath,
      join(runnerPaths.binDir, expectedRunnerBinary),
    );
  },
);

// =============================================================================
// 3. runInstaller
// spec: PLAT-19, T-0813 AC 1, 2, 4, 5, 6
// =============================================================================

Deno.test(
  "runInstaller: installs CLI into isolated temporary directory, creates executable, and passes --help verification",
  async () => {
    const tempRoot = await Deno.makeTempDir({
      prefix: "railfog-installer-test-",
    });

    try {
      const options: InstallerOptions = {
        root: tempRoot,
        local: true,
        force: true,
      };

      const result = await runInstaller(options);

      assertEquals(
        result.ok,
        true,
        `runInstaller must return ok: true. Output: ${result.output}`,
      );
      assert(
        result.installedPath.length > 0,
        "runInstaller must return installedPath",
      );

      const expectedBinDir = join(tempRoot, "bin");
      assert(
        result.installedPath.startsWith(expectedBinDir),
        `Installed path ${result.installedPath} must be inside ${expectedBinDir}`,
      );

      // Verify the executable file exists on disk
      const fileStat = await Deno.stat(result.installedPath);
      assert(fileStat.isFile, "Installed executable must exist as a file");

      // Verify the installed executable executes with '--help' and exits 0 with 'RailFog CLI'
      const isWindows = Deno.build.os === "windows";
      const cmd = isWindows && result.installedPath.endsWith(".cmd")
        ? new Deno.Command("cmd.exe", {
          args: ["/c", result.installedPath, "--help"],
          stdout: "piped",
          stderr: "piped",
        })
        : new Deno.Command(result.installedPath, {
          args: ["--help"],
          stdout: "piped",
          stderr: "piped",
        });

      const proc = await cmd.output();
      const stdout = new TextDecoder().decode(proc.stdout);
      const stderr = new TextDecoder().decode(proc.stderr);

      assertEquals(
        proc.code,
        0,
        `Installed executable --help must exit with code 0. Stderr: ${stderr}, Stdout: ${stdout}`,
      );
      assertStringIncludes(
        stdout,
        "RailFog CLI",
        "Installed executable --help stdout must contain 'RailFog CLI'",
      );
    } finally {
      try {
        await Deno.remove(tempRoot, { recursive: true });
      } catch {
        // Cleanup best-effort
      }
    }
  },
);

Deno.test(
  "runInstaller: reports error when given an invalid or unresolvable git ref",
  async () => {
    const tempRoot = await Deno.makeTempDir({
      prefix: "railfog-installer-err-",
    });

    try {
      const options: InstallerOptions = {
        root: tempRoot,
        local: false,
        ref: "nonexistent-branch-deadbeef99999",
      };

      const result = await runInstaller(options);
      assertEquals(
        result.ok,
        false,
        "runInstaller must return ok: false for nonexistent ref",
      );
    } finally {
      try {
        await Deno.remove(tempRoot, { recursive: true });
      } catch {
        // Cleanup best-effort
      }
    }
  },
);

// =============================================================================
// 4. deno.json configuration
// spec: PLAT-19, T-0813 AC 4
// =============================================================================

Deno.test(
  "deno.json configuration: defines tasks.install matching PLAT-19 contract",
  async () => {
    const rootDenoJsonPath = resolve(
      fromFileUrl(import.meta.url),
      "../../../deno.json",
    );
    const content = await Deno.readTextFile(rootDenoJsonPath);
    const parsed = JSON.parse(content) as {
      tasks?: Record<string, string>;
    };

    assert(parsed.tasks !== undefined, "deno.json must define a 'tasks' block");
    assertEquals(
      parsed.tasks["install"],
      "deno install -g -A -f --config deno.json -n rail cli/main.ts",
      "deno.json tasks.install must equal 'deno install -g -A -f --config deno.json -n rail cli/main.ts'",
    );
  },
);
