// spec: contracts/platform.contract.md#PLAT-19 — Repository structure & dependency management
// spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md

import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join, resolve } from "@std/path";
import { type AddOptions, type AddResult, runAdd } from "../../cli/add.ts";

// ============================================================================
// Group 1: Adding @railfog/sdk to existing deno.json (AC 1, PLAT-19)
// ============================================================================

Deno.test("AC1 (PLAT-19): runAdd injects @railfog/sdk into existing deno.json imports without mutating tasks or other keys", async () => {
  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC1
  // spec: contracts/platform.contract.md#PLAT-19 — Repository structure & dependency management
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_add_test_existing_",
  });

  try {
    const denoJsonPath = join(tempDir, "deno.json");
    const initialConfig = {
      name: "custom-user-project",
      version: "1.2.3",
      tasks: {
        build: "deno run -A build.ts",
        test: "deno test --coverage",
      },
      imports: {
        "@std/assert": "jsr:@std/assert@^1.0.0",
        "@std/path": "jsr:@std/path@^1.0.0",
      },
      compilerOptions: {
        strict: true,
      },
    };

    await Deno.writeTextFile(
      denoJsonPath,
      JSON.stringify(initialConfig, null, 2) + "\n",
    );

    const options: AddOptions = {
      packageOrPrimitive: "sdk",
      cwd: tempDir,
    };
    const result: AddResult = await runAdd(options);

    assertEquals(result.ok, true, "runAdd must report ok: true");
    assertEquals(
      resolve(result.targetFile),
      resolve(denoJsonPath),
      "targetFile must resolve to deno.json in cwd",
    );
    assertEquals(
      result.addedImport,
      "@railfog/sdk",
      "addedImport must be '@railfog/sdk'",
    );
    assertEquals(
      result.createdNewFile,
      false,
      "createdNewFile must be false when deno.json already existed",
    );

    // Read back and parse updated deno.json
    const rawContent = await Deno.readTextFile(denoJsonPath);
    const updated = JSON.parse(rawContent) as {
      name?: string;
      version?: string;
      tasks?: Record<string, string>;
      imports?: Record<string, string>;
      compilerOptions?: Record<string, unknown>;
    };

    // Ensure non-destructive editing: original keys and tasks must remain identical
    assertEquals(updated.name, "custom-user-project");
    assertEquals(updated.version, "1.2.3");
    assertEquals(updated.tasks?.build, "deno run -A build.ts");
    assertEquals(updated.tasks?.test, "deno test --coverage");
    assertEquals(updated.compilerOptions?.strict, true);

    // Ensure existing imports are preserved
    assertEquals(
      updated.imports?.["@std/assert"],
      "jsr:@std/assert@^1.0.0",
    );
    assertEquals(updated.imports?.["@std/path"], "jsr:@std/path@^1.0.0");

    // Ensure @railfog/sdk was injected
    assertExists(
      updated.imports?.["@railfog/sdk"],
      "@railfog/sdk must be present in imports",
    );
    assert(
      (updated.imports?.["@railfog/sdk"] ?? "").includes(
        "sdk/typescript/mod.ts",
      ) ||
        (updated.imports?.["@railfog/sdk"] ?? "").includes("@railfog/sdk"),
      "@railfog/sdk import must point to the SDK module",
    );

    // Verify trailing newline and clean formatting
    assert(rawContent.endsWith("\n"), "deno.json must end with a newline");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("AC1 (PLAT-19): runAdd creates 'imports' table when existing deno.json lacks an imports key", async () => {
  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC1
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_add_test_no_imports_",
  });

  try {
    const denoJsonPath = join(tempDir, "deno.json");
    const initialConfig = {
      name: "bare-project",
      tasks: {
        start: "deno run main.ts",
      },
    };

    await Deno.writeTextFile(
      denoJsonPath,
      JSON.stringify(initialConfig, null, 2) + "\n",
    );

    const result = await runAdd({
      packageOrPrimitive: "sdk",
      cwd: tempDir,
    });

    assertEquals(result.ok, true);
    assertEquals(result.createdNewFile, false);

    const raw = await Deno.readTextFile(denoJsonPath);
    const updated = JSON.parse(raw);

    assertEquals(updated.name, "bare-project");
    assertEquals(updated.tasks?.start, "deno run main.ts");
    assertExists(updated.imports);
    assertExists(updated.imports["@railfog/sdk"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("AC1 (PLAT-19): runAdd does NOT overwrite existing custom tasks in deno.json", async () => {
  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC1
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_add_test_preserve_tasks_",
  });

  try {
    const denoJsonPath = join(tempDir, "deno.json");
    const initialConfig = {
      tasks: {
        dev: "custom-dev-runner",
        check: "custom-check-runner",
        test: "custom-test-runner",
      },
      imports: {},
    };

    await Deno.writeTextFile(
      denoJsonPath,
      JSON.stringify(initialConfig, null, 2) + "\n",
    );

    await runAdd({
      packageOrPrimitive: "sdk",
      cwd: tempDir,
    });

    const updated = JSON.parse(await Deno.readTextFile(denoJsonPath));
    assertEquals(updated.tasks.dev, "custom-dev-runner");
    assertEquals(updated.tasks.check, "custom-check-runner");
    assertEquals(updated.tasks.test, "custom-test-runner");
    assertExists(updated.imports["@railfog/sdk"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Group 2: Creating a new minimal deno.json (AC 2, PLAT-19)
// ============================================================================

Deno.test("AC2 (PLAT-19): runAdd creates new minimal deno.json with standard tasks and @railfog/sdk when none exists", async () => {
  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC2
  // spec: contracts/platform.contract.md#PLAT-19 — Repository structure & starter deno.json
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_add_test_create_new_",
  });

  try {
    const denoJsonPath = join(tempDir, "deno.json");

    // Verify deno.json does not exist before running
    let existsBefore = true;
    try {
      await Deno.stat(denoJsonPath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        existsBefore = false;
      }
    }
    assertEquals(existsBefore, false, "deno.json must not exist initially");

    const result: AddResult = await runAdd({
      packageOrPrimitive: "sdk",
      cwd: tempDir,
    });

    assertEquals(result.ok, true, "runAdd must succeed");
    assertEquals(
      result.createdNewFile,
      true,
      "createdNewFile must be true when no deno.json existed",
    );
    assertEquals(
      resolve(result.targetFile),
      resolve(denoJsonPath),
      "targetFile must point to new deno.json",
    );
    assertEquals(result.addedImport, "@railfog/sdk");

    // Verify file exists on disk
    const stat = await Deno.stat(denoJsonPath);
    assertEquals(stat.isFile, true, "New deno.json must be written to disk");

    const rawContent = await Deno.readTextFile(denoJsonPath);
    const parsed = JSON.parse(rawContent) as {
      tasks?: Record<string, string>;
      imports?: Record<string, string>;
    };

    // Verify standard tasks per AC 2: dev, check, test
    assertExists(parsed.tasks, "New deno.json must have 'tasks' block");
    assertExists(parsed.tasks.dev, "Standard tasks must include 'dev'");
    assertExists(parsed.tasks.check, "Standard tasks must include 'check'");
    assertExists(parsed.tasks.test, "Standard tasks must include 'test'");

    // Verify @railfog/sdk import mapping
    assertExists(parsed.imports, "New deno.json must have 'imports' block");
    assertExists(
      parsed.imports["@railfog/sdk"],
      "New deno.json must map '@railfog/sdk'",
    );
    assert(
      parsed.imports["@railfog/sdk"].includes("sdk/typescript/mod.ts") ||
        parsed.imports["@railfog/sdk"].includes("@railfog/sdk"),
      "@railfog/sdk import must point to SDK module",
    );

    // Verify clean formatting with trailing newline
    assert(rawContent.endsWith("\n"), "File must end with a newline");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Group 3: Idempotent re-execution (AC 3, PLAT-19)
// ============================================================================

Deno.test("AC3 (PLAT-19): runAdd completes idempotently when @railfog/sdk is already mapped", async () => {
  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC3
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_add_test_idempotent_",
  });

  try {
    const denoJsonPath = join(tempDir, "deno.json");
    const canonicalSdkUrl =
      "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/sdk/typescript/mod.ts";

    const initialConfig = {
      tasks: {
        dev: "rail dev",
        check: "rail check",
        test: "deno test -A",
      },
      imports: {
        "@railfog/sdk": canonicalSdkUrl,
        "@std/assert": "jsr:@std/assert@^1.0.0",
      },
    };

    await Deno.writeTextFile(
      denoJsonPath,
      JSON.stringify(initialConfig, null, 2) + "\n",
    );

    const result = await runAdd({
      packageOrPrimitive: "sdk",
      cwd: tempDir,
    });

    assertEquals(result.ok, true, "Must complete successfully");
    assertEquals(
      result.createdNewFile,
      false,
      "createdNewFile must be false on already-configured project",
    );
    assertEquals(result.addedImport, "@railfog/sdk");

    const contentAfter = await Deno.readTextFile(denoJsonPath);
    const parsed = JSON.parse(contentAfter) as {
      imports?: Record<string, string>;
    };

    assertEquals(parsed.imports?.["@railfog/sdk"], canonicalSdkUrl);
    assertEquals(parsed.imports?.["@std/assert"], "jsr:@std/assert@^1.0.0");

    // Verify key count in imports (no duplicate keys)
    const importKeys = Object.keys(parsed.imports ?? {});
    assertEquals(importKeys.length, 2, "Must contain exactly 2 import keys");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("AC3 (PLAT-19): Multiple sequential executions of runAdd produce stable, identical content", async () => {
  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC3
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_add_test_sequential_",
  });

  try {
    const denoJsonPath = join(tempDir, "deno.json");

    // First execution creates the file
    const res1 = await runAdd({
      packageOrPrimitive: "sdk",
      cwd: tempDir,
    });
    assertEquals(res1.ok, true);
    assertEquals(res1.createdNewFile, true);
    const content1 = await Deno.readTextFile(denoJsonPath);

    // Second execution on the created file
    const res2 = await runAdd({
      packageOrPrimitive: "sdk",
      cwd: tempDir,
    });
    assertEquals(res2.ok, true);
    assertEquals(res2.createdNewFile, false);
    const content2 = await Deno.readTextFile(denoJsonPath);

    assertEquals(
      content2,
      content1,
      "Second run must produce identical content to the first run",
    );

    // Third execution verifies continuous stability
    const res3 = await runAdd({
      packageOrPrimitive: "sdk",
      cwd: tempDir,
    });
    assertEquals(res3.ok, true);
    assertEquals(res3.createdNewFile, false);
    const content3 = await Deno.readTextFile(denoJsonPath);

    assertEquals(
      content3,
      content2,
      "Third run must produce identical content to the second run",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("AC3 (PLAT-19): runAdd updates outdated @railfog/sdk URL to canonical version", async () => {
  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC3
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_add_test_update_url_",
  });

  try {
    const denoJsonPath = join(tempDir, "deno.json");
    const outdatedUrl = "https://example.com/outdated/railfog/mod.ts";

    await Deno.writeTextFile(
      denoJsonPath,
      JSON.stringify(
        {
          tasks: { dev: "rail dev" },
          imports: {
            "@railfog/sdk": outdatedUrl,
            "@std/path": "jsr:@std/path@^1.0.0",
          },
        },
        null,
        2,
      ) + "\n",
    );

    const result = await runAdd({
      packageOrPrimitive: "sdk",
      cwd: tempDir,
    });

    assertEquals(result.ok, true);
    assertEquals(result.createdNewFile, false);

    const parsed = JSON.parse(await Deno.readTextFile(denoJsonPath));
    assert(
      parsed.imports["@railfog/sdk"] !== outdatedUrl,
      "@railfog/sdk URL must be updated from outdated value",
    );
    assert(
      parsed.imports["@railfog/sdk"].includes("sdk/typescript/mod.ts") ||
        parsed.imports["@railfog/sdk"].includes("@railfog/sdk"),
      "Updated URL must point to standard SDK module",
    );
    assertEquals(
      parsed.imports["@std/path"],
      "jsr:@std/path@^1.0.0",
      "Other imports must not be affected",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Group 4: Error rejection when adding unknown packages (AC 4)
// ============================================================================

Deno.test("AC4: runAdd rejects unknown package argument with helpful error listing supported additions ('sdk')", async () => {
  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC4
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_add_test_unknown_",
  });

  try {
    const err = await assertRejects(
      async () => {
        await runAdd({
          packageOrPrimitive: "unknown-package",
          cwd: tempDir,
        });
      },
      Error,
    );

    assertStringIncludes(
      err.message.toLowerCase(),
      "sdk",
      "Error message must mention supported additions ('sdk')",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("AC4: runAdd rejects empty or whitespace-only package argument", async () => {
  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC4
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_add_test_empty_arg_",
  });

  try {
    const err = await assertRejects(
      async () => {
        await runAdd({
          packageOrPrimitive: "   ",
          cwd: tempDir,
        });
      },
      Error,
    );

    assertStringIncludes(
      err.message.toLowerCase(),
      "sdk",
      "Error message must list supported additions ('sdk')",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("AC4: runAdd rejects path traversal and malicious package names", async () => {
  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md#AC4
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_add_test_malicious_",
  });

  try {
    const maliciousInputs = [
      "../../etc/passwd",
      "../sdk",
      "sdk/../../malicious",
      "<script>alert(1)</script>",
    ];

    for (const input of maliciousInputs) {
      const err = await assertRejects(
        async () => {
          await runAdd({
            packageOrPrimitive: input,
            cwd: tempDir,
          });
        },
        Error,
      );

      assertStringIncludes(
        err.message.toLowerCase(),
        "sdk",
        `Error for input '${input}' must list supported additions ('sdk')`,
      );
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Group 5: Robustness against malformed deno.json files
// ============================================================================

Deno.test("Robustness: runAdd rejects when deno.json contains malformed JSON without destroying file", async () => {
  // spec: tasks/milestone-0.8-developer-experience-ux/T-0811-project-dependency-add.md
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_add_test_malformed_",
  });

  try {
    const denoJsonPath = join(tempDir, "deno.json");
    const corruptedContent = '{\n  "tasks": {\n    "dev": "rail dev",\n'; // unclosed JSON

    await Deno.writeTextFile(denoJsonPath, corruptedContent);

    await assertRejects(
      async () => {
        await runAdd({
          packageOrPrimitive: "sdk",
          cwd: tempDir,
        });
      },
      Error,
    );

    // Verify corrupted file was not overwritten or destroyed
    const preservedContent = await Deno.readTextFile(denoJsonPath);
    assertEquals(
      preservedContent,
      corruptedContent,
      "Malformed deno.json must be preserved and not overwritten",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
