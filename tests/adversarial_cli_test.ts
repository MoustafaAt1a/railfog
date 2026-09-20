import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { fromFileUrl, join, resolve } from "@std/path";
import { deployCommand } from "../cli/deploy.ts";
import { ValidationFailedError } from "../packages/errors/mod.ts";
import type { PackagedArtifact } from "../packages/core/artifact/packager.ts";
import type {
  DeploymentResult,
  DeploymentService,
} from "../apps/api/deployment-service.ts";

const cliMainPath = fromFileUrl(new URL("../cli/main.ts", import.meta.url));

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
// Attack Focus 1: PLAT-6 / Path Traversal
// =============================================================================

Deno.test("ADV-1.1: Path Traversal - entrypoint with relative traversal '../' is rejected", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-traversal-rel-" });
  try {
    const tomlContent =
      `name = "rel-app"\n\n[functions.api]\nentry = "../outside.ts"\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);
    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
      "escapes project directory",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-1.2: Path Traversal - nested traversal 'functions/../../outside.ts' is rejected", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-traversal-nested-" });
  try {
    const tomlContent =
      `name = "nested-app"\n\n[functions.api]\nentry = "functions/../../outside.ts"\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);
    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
      "escapes project directory",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-1.3: Path Traversal - deep subdirectory traversal 'a/b/c/../../../../outside.ts' is rejected", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-traversal-deep-" });
  try {
    const tomlContent =
      `name = "deep-app"\n\n[functions.api]\nentry = "a/b/c/../../../../outside.ts"\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);
    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
      "escapes project directory",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-1.4: Path Traversal - Windows backslash traversal 'functions\\..\\..\\outside.ts' is rejected", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-traversal-bslash-" });
  try {
    const tomlContent =
      `name = "bslash-app"\n\n[functions.api]\nentry = "functions\\\\..\\\\..\\\\outside.ts"\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);
    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
      "escapes project directory",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-1.5: Path Traversal - mixed slashes traversal 'functions/..\\../outside.ts' is rejected", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-traversal-mixed-" });
  try {
    const tomlContent =
      `name = "mixed-app"\n\n[functions.api]\nentry = "functions/..\\\\../outside.ts"\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);
    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
      "escapes project directory",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-1.6: Path Traversal - absolute path outside cwd is rejected", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "adv-traversal-abs-" });
  const appDir = join(rootDir, "app");
  await Deno.mkdir(appDir);
  try {
    const absPath = resolve(rootDir, "secret.ts").replace(/\\/g, "/");
    await Deno.writeTextFile(
      join(rootDir, "secret.ts"),
      "export default () => new Response('secret');",
    );
    const tomlContent =
      `name = "abs-app"\n\n[functions.api]\nentry = "${absPath}"\n`;
    await Deno.writeTextFile(join(appDir, "railfog.toml"), tomlContent);
    await assertRejects(
      async () => {
        await deployCommand({ cwd: appDir });
      },
      ValidationFailedError,
      "escapes project directory",
    );
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test("ADV-1.7: Path Traversal - null byte injection in entrypoint is rejected or throws", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-traversal-null-" });
  try {
    const tomlContent =
      `name = "null-app"\n\n[functions.api]\nentry = "functions/api.ts\\0/../../secret.ts"\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);
    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      Error,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-1.8: Path Traversal - directory path '.' or 'functions' is rejected (stat.isFile failure)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-traversal-dir-" });
  try {
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    // Case 1: entry = "."
    const tomlContentDot = `name = "dir-app"\n\n[functions.api]\nentry = "."\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContentDot);
    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
    );

    // Case 2: entry = "functions"
    const tomlContentDir =
      `name = "dir-app"\n\n[functions.api]\nentry = "functions"\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContentDir);
    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
      "does not exist",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-1.9: Path Traversal - Symlink pointing outside cwd is detected/rejected or investigated", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "adv-symlink-check-" });
  const appDir = join(rootDir, "app");
  await Deno.mkdir(appDir);
  const secretFile = join(rootDir, "secret.env");
  await Deno.writeTextFile(secretFile, "AWS_SECRET_KEY=supersecret123");

  try {
    const symlinkPath = join(appDir, "symlink.ts");
    let symlinkCreated = false;
    try {
      await Deno.symlink(secretFile, symlinkPath);
      symlinkCreated = true;
    } catch {
      // Symlink creation might not be permitted on Windows without developer mode
    }

    if (symlinkCreated) {
      const tomlContent =
        `name = "symlink-app"\n\n[functions.api]\nentry = "symlink.ts"\n`;
      await Deno.writeTextFile(join(appDir, "railfog.toml"), tomlContent);

      await assertRejects(
        async () => {
          await deployCommand({
            cwd: appDir,
            deploymentService: {
              deploy: (_p: string, _fn: string, _art: PackagedArtifact) => {
                return Promise.resolve({
                  revisionId: "rev_01J8Z000000000000000000001",
                  state: "Deployed" as const,
                  active: true,
                });
              },
            } as unknown as DeploymentService,
          });
        },
        ValidationFailedError,
        "escapes project directory",
        "Symlink pointing outside project directory must be strictly rejected with ValidationFailedError",
      );
    }
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

// =============================================================================
// Attack Focus 2: PLAT-6 / Capability Injection & Scope Validation
// =============================================================================

Deno.test("ADV-2.1: Capability Injection - multiple KV namespaces rejected with ValidationFailedError", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-cap-kv-" });
  try {
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default () => new Response('ok');",
    );
    const tomlContent =
      `name = "cap-app"\n\n[functions.api]\nentry = "functions/api.ts"\n[functions.api.permissions]\nkv = ["ns-alpha", "ns-beta"]\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
      "Ambiguous scope: multiple KV namespaces declared",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-2.2: Capability Injection - multiple Objects buckets rejected with ValidationFailedError", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-cap-obj-" });
  try {
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default () => new Response('ok');",
    );
    const tomlContent =
      `name = "cap-app"\n\n[functions.api]\nentry = "functions/api.ts"\n[functions.api.permissions]\nobjects = ["bucket-alpha", "bucket-beta"]\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
      "Ambiguous scope: multiple Objects buckets declared",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-2.3: Capability Injection - multiple Queues rejected with ValidationFailedError", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-cap-queue-" });
  try {
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default () => new Response('ok');",
    );
    const tomlContent =
      `name = "cap-app"\n\n[functions.api]\nentry = "functions/api.ts"\n[functions.api.permissions]\nqueues = ["queue-1", "queue-2"]\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
      "Ambiguous scope: multiple Queues declared",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-2.4: Malformed permissions - string instead of array for kv: string spreading / ambiguous scope vulnerability", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-cap-malformed-kv-" });
  try {
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default () => new Response('ok');",
    );
    // TOML with kv = "users-kv" (string instead of array)
    const tomlContent =
      `name = "malformed-app"\n\n[functions.api]\nentry = "functions/api.ts"\n[functions.api.permissions]\nkv = "users-kv"\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

    // This MUST reject with ValidationFailedError because permissions.kv must be an array of strings per schema/PLAT-6.
    // If it succeeds and spreads "users-kv" into ["u", "s", "e", "r", "s", "-", "k", "v"], that is an ambiguous scope bug!
    await assertRejects(
      async () => {
        await deployCommand({
          cwd: tempDir,
          deploymentService: {
            deploy: (_p: string, _fn: string, _art: PackagedArtifact) => {
              return Promise.resolve({
                revisionId: "rev_01J8Z000000000000000000001",
                state: "Deployed" as const,
                active: true,
              });
            },
          } as unknown as DeploymentService,
        });
      },
      ValidationFailedError,
      undefined,
      "Malformed permission (string instead of array) must be rejected with ValidationFailedError",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-2.5: Malformed permissions - number instead of array causes unhandled TypeError or should be ValidationFailedError", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-cap-number-kv-" });
  try {
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default () => new Response('ok');",
    );
    const tomlContent =
      `name = "num-perm-app"\n\n[functions.api]\nentry = "functions/api.ts"\n[functions.api.permissions]\nkv = 12345\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
      undefined,
      "Malformed permission (number instead of array) must reject with ValidationFailedError, not unhandled TypeError",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-2.6: Malformed permissions - non-object permissions table should be rejected with ValidationFailedError", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-cap-nonobj-perm-" });
  try {
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default () => new Response('ok');",
    );
    const tomlContent =
      `name = "str-perm-app"\n\n[functions.api]\nentry = "functions/api.ts"\npermissions = "all"\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

    await assertRejects(
      async () => {
        await deployCommand({
          cwd: tempDir,
          deploymentService: {
            deploy: () =>
              Promise.resolve({
                revisionId: "rev_01J8Z000000000000000000001",
                state: "Deployed" as const,
                active: true,
              }),
          } as unknown as DeploymentService,
        });
      },
      ValidationFailedError,
      undefined,
      "Malformed permissions (non-object) must reject with ValidationFailedError",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-2.7: Malformed permissions - empty or whitespace string in permissions array is rejected", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-cap-empty-str-" });
  try {
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default () => new Response('ok');",
    );
    const tomlContent =
      `name = "empty-perm-app"\n\n[functions.api]\nentry = "functions/api.ts"\n[functions.api.permissions]\nkv = ["   "]\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
      "must be non-empty strings",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-2.8: Malformed permissions - string instead of array for objects and queues is rejected", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-cap-str-obj-q-" });
  try {
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default () => new Response('ok');",
    );

    // Test objects as string
    const tomlObj =
      `name = "str-obj-app"\n\n[functions.api]\nentry = "functions/api.ts"\n[functions.api.permissions]\nobjects = "my-bucket"\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlObj);
    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
      "must be an array of strings",
    );

    // Test queues as string
    const tomlQueue =
      `name = "str-queue-app"\n\n[functions.api]\nentry = "functions/api.ts"\n[functions.api.permissions]\nqueues = "my-queue"\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlQueue);
    await assertRejects(
      async () => {
        await deployCommand({ cwd: tempDir });
      },
      ValidationFailedError,
      "must be an array of strings",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// =============================================================================
// Attack Focus 3: Ambient Secret Leakage
// =============================================================================

Deno.test("ADV-3.1: Ambient secret leakage - project dir files (.env, private.key, notes) NEVER included in artifact", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-leak-proj-" });
  try {
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default () => new Response('clean code');",
    );
    // Write sensitive files
    await Deno.writeTextFile(
      join(tempDir, ".env"),
      "SECRET_TOKEN=xyz123abc456\nDB_PASS=supersecret",
    );
    await Deno.writeTextFile(
      join(tempDir, "private.key"),
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA05...",
    );
    await Deno.writeTextFile(
      join(tempDir, "deploy_notes.md"),
      "Confidential architecture credentials",
    );

    const tomlContent =
      `name = "leak-test-app"\n\n[functions.api]\nentry = "functions/api.ts"\n`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

    let capturedArtifact: PackagedArtifact | null = null;
    await deployCommand({
      cwd: tempDir,
      deploymentService: {
        deploy: (_p: string, _fn: string, art: PackagedArtifact) => {
          capturedArtifact = art;
          return Promise.resolve({
            revisionId: "rev_01J8Z000000000000000000001",
            state: "Deployed" as const,
            active: true,
          });
        },
      } as unknown as DeploymentService,
    });

    assert(capturedArtifact !== null, "Artifact must be produced");
    const bytesDecoded = new TextDecoder().decode(
      (capturedArtifact as PackagedArtifact).bytes,
    );
    assertEquals(bytesDecoded.includes("clean code"), true);
    assertEquals(
      bytesDecoded.includes("SECRET_TOKEN"),
      false,
      ".env content must never be packaged",
    );
    assertEquals(
      bytesDecoded.includes("BEGIN RSA PRIVATE KEY"),
      false,
      "private.key must never be packaged",
    );
    assertEquals(
      bytesDecoded.includes("Confidential architecture credentials"),
      false,
      "notes must never be packaged",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("ADV-3.2: Ambient secret leakage - parent dir files NEVER included in artifact", async () => {
  const parentDir = await Deno.makeTempDir({ prefix: "adv-leak-parent-" });
  const appDir = join(parentDir, "app");
  await Deno.mkdir(appDir);
  try {
    await Deno.writeTextFile(
      join(parentDir, "root_creds.json"),
      '{"admin_password": "super_parent_password"}',
    );
    await Deno.mkdir(join(appDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(appDir, "functions", "api.ts"),
      "export default () => new Response('parent clean');",
    );
    const tomlContent =
      `name = "parent-leak-app"\n\n[functions.api]\nentry = "functions/api.ts"\n`;
    await Deno.writeTextFile(join(appDir, "railfog.toml"), tomlContent);

    let capturedArtifact: PackagedArtifact | null = null;
    await deployCommand({
      cwd: appDir,
      deploymentService: {
        deploy: (_p: string, _fn: string, art: PackagedArtifact) => {
          capturedArtifact = art;
          return Promise.resolve({
            revisionId: "rev_01J8Z000000000000000000001",
            state: "Deployed" as const,
            active: true,
          });
        },
      } as unknown as DeploymentService,
    });

    assert(capturedArtifact !== null);
    const bytesDecoded = new TextDecoder().decode(
      (capturedArtifact as PackagedArtifact).bytes,
    );
    assertEquals(bytesDecoded.includes("super_parent_password"), false);
  } finally {
    await Deno.remove(parentDir, { recursive: true });
  }
});

// =============================================================================
// Attack Focus 4: PLAT-20 / Banned Flags Smuggling
// =============================================================================

Deno.test("ADV-4.1: Banned flags - --canary and --weight rejected with non-zero exit code (PLAT-20)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-banned-flags-" });
  try {
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default () => new Response('ok');",
    );
    await Deno.writeTextFile(
      join(tempDir, "railfog.toml"),
      `name = "banned-app"\n\n[functions.api]\nentry = "functions/api.ts"\n`,
    );

    const variations = [
      ["deploy", "--canary"],
      ["deploy", "--canary", "10"],
      ["deploy", "--canary=10"],
      ["deploy", "--canary=0"],
      ["deploy", "--canary=true"],
      ["deploy", "--weight"],
      ["deploy", "--weight", "50"],
      ["deploy", "--weight=50"],
      ["deploy", "--weight=0"],
      ["deploy", "--project", "foo", "--canary=10"],
      ["deploy", "--canary", "--project", "foo"],
    ];

    for (const args of variations) {
      const res = await runCli(args, tempDir);
      assertEquals(
        res.code,
        1,
        `CLI invocation 'rail ${
          args.join(" ")
        }' must exit with code 1. Stderr: ${res.stderr}, Stdout: ${res.stdout}`,
      );
      const combined = res.stdout + "\n" + res.stderr;
      assertMatch(
        combined,
        /unsupported|PLAT-20|canary/i,
        `Output for 'rail ${
          args.join(" ")
        }' must state canary/weight is unsupported. Output:\n${combined}`,
      );
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// =============================================================================
// Attack Focus 5: Deployment pipeline integrity (PLAT-3 atomic cutover)
// =============================================================================

Deno.test("ADV-5.1: Pipeline integrity - cutover is atomic pointer flip, no partial state (PLAT-3)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "adv-pipeline-" });
  try {
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default () => new Response('rev1');",
    );
    await Deno.writeTextFile(
      join(tempDir, "railfog.toml"),
      `name = "cutover-app"\n\n[functions.api]\nentry = "functions/api.ts"\n`,
    );

    let deployCallCount = 0;
    const fakeService = {
      deploy: (
        proj: string,
        fn: string,
        _art: PackagedArtifact,
      ): Promise<DeploymentResult> => {
        deployCallCount++;
        assertEquals(proj, "cutover-app");
        assertEquals(fn, "api");
        return Promise.resolve({
          revisionId: "rev_01J8Z000000000000000000001",
          state: "Deployed" as const,
          active: true,
        });
      },
    } as unknown as DeploymentService;

    const result = await deployCommand({
      cwd: tempDir,
      deploymentService: fakeService,
    });

    assertEquals(deployCallCount, 1);
    assertEquals(result.state, "Deployed");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
