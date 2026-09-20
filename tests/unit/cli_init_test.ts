// spec: contracts/platform.contract.md#PLAT-18 — Project resource hierarchy & naming
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: CLI scaffolding & project templates
// spec: contracts/platform.contract.md#PLAT-3 — Deployment pipeline static validation of scaffolded projects
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & deploy-time permission declarations
// spec: contracts/functions.contract.md#FN-1 — Function definition & starter HTTP handler
// spec: contracts/functions.contract.md#FN-2 — Trigger declarations (HTTP, Queue, Schedule)
// spec: contracts/objects.contract.md#OBJ-2 — Object binding permissions in worked-example template
// spec: contracts/queues.contract.md#Q-2 — Queue binding permissions & message handling in worked-example
// spec: contracts/kv.contract.md#KV-2 — KV binding permissions & deduplication in worked-example
// spec: contracts/worked-example.md — Canonical upload pipeline reference implementation
// spec: tasks/milestone-0.5-developer-experience/T-0503-cli-init-scaffold.md

import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { join, resolve } from "@std/path";
import { parse as parseToml } from "@std/toml";

import {
  type InitResult,
  PROJECT_NAME_REGEX,
  runInit,
} from "../../cli/init.ts";

import { initCommand } from "../../cli/main.ts";
import { checkProject } from "../../cli/check.ts";

// ============================================================================
// Group 1: Default Minimal Template Scaffolding (AC1, AC2, PLAT-18, FN-1)
// ============================================================================

Deno.test("AC1 & AC2: runInit scaffolds default minimal template with railfog.toml, functions/api.ts, deno.json, and .gitignore", async () => {
  // spec: tasks/milestone-0.5-developer-experience/T-0503-cli-init-scaffold.md#AC1
  // spec: contracts/platform.contract.md#PLAT-19 — Project scaffold layout
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_init_test_minimal_",
  });

  try {
    const result: InitResult = await runInit({ directory: tempDir });

    assertExists(result.targetDir, "InitResult must include targetDir");
    assertEquals(resolve(result.targetDir), resolve(tempDir));
    assertExists(result.filesCreated, "InitResult must list filesCreated");

    // 1. Verify railfog.toml exists, parses as valid TOML, and conforms to schema (PLAT-18, FN-1, PLAT-6)
    const tomlPath = join(tempDir, "railfog.toml");
    const tomlStat = await Deno.stat(tomlPath);
    assertEquals(tomlStat.isFile, true);

    const tomlRaw = await Deno.readTextFile(tomlPath);
    const parsedToml = parseToml(tomlRaw) as Record<string, unknown>;
    assertExists(parsedToml.name, "railfog.toml must declare 'name'");
    assertEquals(typeof parsedToml.name, "string");
    assert((parsedToml.name as string).trim().length > 0);

    const functions = parsedToml.functions as Record<
      string,
      { entry?: string; permissions?: Record<string, unknown> }
    >;
    assertExists(functions, "railfog.toml must declare 'functions' table");
    assertExists(functions.api, "railfog.toml must declare '[functions.api]'");
    assertEquals(functions.api.entry, "functions/api.ts");

    const routes = parsedToml.routes as Array<
      { pattern?: string; function?: string }
    >;
    assertExists(routes, "railfog.toml must declare '[[routes]]'");
    assert(routes.length >= 1, "Must contain at least one route");
    assertEquals(routes[0].function, "api");
    assertExists(routes[0].pattern);

    // 2. Verify functions/api.ts exists and exports a default fetch handler (FN-1)
    const apiPath = join(tempDir, "functions", "api.ts");
    const apiStat = await Deno.stat(apiPath);
    assertEquals(apiStat.isFile, true);

    const apiContent = await Deno.readTextFile(apiPath);
    assert(
      apiContent.includes("export default") &&
        (apiContent.includes("function") || apiContent.includes("handler")),
      "functions/api.ts must export a default handler function per FN-1",
    );

    // 3. Verify deno.json exists, parses as valid JSON, and specifies recommended tasks & SDK import
    const denoJsonPath = join(tempDir, "deno.json");
    const denoJsonStat = await Deno.stat(denoJsonPath);
    assertEquals(denoJsonStat.isFile, true);

    const denoJson = JSON.parse(await Deno.readTextFile(denoJsonPath)) as {
      tasks?: Record<string, string>;
      imports?: Record<string, string>;
    };
    assertExists(denoJson.tasks, "deno.json must define tasks");
    assertExists(denoJson.tasks.dev, "deno.json tasks must include 'dev'");
    assertExists(denoJson.tasks.test, "deno.json tasks must include 'test'");
    assertExists(denoJson.tasks.check, "deno.json tasks must include 'check'");
    assertExists(denoJson.tasks.lint, "deno.json tasks must include 'lint'");
    assertExists(denoJson.imports, "deno.json must define imports");
    assertExists(
      denoJson.imports["@railfog/sdk"],
      "deno.json imports must map '@railfog/sdk'",
    );

    // 4. Verify .gitignore exists and ignores .railfog/, build dist, and sqlite databases
    const gitignorePath = join(tempDir, ".gitignore");
    const gitignoreStat = await Deno.stat(gitignorePath);
    assertEquals(gitignoreStat.isFile, true);

    const gitignoreContent = await Deno.readTextFile(gitignorePath);
    assert(
      gitignoreContent.includes(".railfog"),
      ".gitignore must exclude .railfog/",
    );
    assert(
      gitignoreContent.includes("sqlite") || gitignoreContent.includes(".db"),
      ".gitignore must exclude sqlite database files",
    );

    // 5. Verify created files list
    const createdNormalized = (result.filesCreated as string[]).map((
      f: string,
    ) => f.replace(/\\/g, "/"));
    assert(createdNormalized.some((f: string) => f.endsWith("railfog.toml")));
    assert(
      createdNormalized.some((f: string) => f.endsWith("functions/api.ts")),
    );
    assert(createdNormalized.some((f: string) => f.endsWith("deno.json")));
    assert(createdNormalized.some((f: string) => f.endsWith(".gitignore")));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("AC2 & PLAT-18: Custom projectName is correctly set in generated railfog.toml", async () => {
  // spec: contracts/platform.contract.md#PLAT-18 — Project resource naming
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_init_test_custom_name_",
  });

  try {
    await runInit({
      directory: tempDir,
      projectName: "my-custom-microservice",
    });

    const tomlPath = join(tempDir, "railfog.toml");
    const tomlRaw = await Deno.readTextFile(tomlPath);
    const parsed = parseToml(tomlRaw) as { name?: string };

    assertEquals(parsed.name, "my-custom-microservice");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("PLAT-18: Omitting projectName derives a valid project name from the target directory", async () => {
  // spec: contracts/platform.contract.md#PLAT-18 — Project name fallback
  const parentDir = await Deno.makeTempDir({ prefix: "railfog_init_parent_" });
  const targetDir = join(parentDir, "billing-service");

  try {
    await runInit({ directory: targetDir });

    const tomlRaw = await Deno.readTextFile(join(targetDir, "railfog.toml"));
    const parsed = parseToml(tomlRaw) as { name?: string };

    assertExists(parsed.name);
    assert(
      parsed.name === "billing-service" || parsed.name === "railfog-app",
      `Project name '${parsed.name}' must be derived or default to valid identifier`,
    );
  } finally {
    await Deno.remove(parentDir, { recursive: true });
  }
});

// ============================================================================
// Group 2: Validation Compatibility & Integration (AC5, PLAT-3)
// ============================================================================

Deno.test("AC5 (PLAT-3): Freshly scaffolded minimal project immediately passes static validation via checkProject", async () => {
  // spec: tasks/milestone-0.5-developer-experience/T-0503-cli-init-scaffold.md#AC5
  // spec: contracts/platform.contract.md#PLAT-3 — Static deployment pipeline validation
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_init_test_check_minimal_",
  });

  try {
    await runInit({ directory: tempDir, projectName: "valid-scaffold-app" });

    const checkResult = await checkProject(tempDir);
    assertEquals(
      checkResult.valid,
      true,
      "Scaffolded project must pass checkProject",
    );
    assertEquals(
      checkResult.errors.length,
      0,
      "Scaffolded project must produce zero validation errors",
    );
    assertExists(checkResult.routeSummary);
    assert(checkResult.routeSummary.length >= 1);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Integration: Freshly scaffolded functions/api.ts passes deno check", async () => {
  // spec: tasks/milestone-0.5-developer-experience/T-0503-cli-init-scaffold.md#Tests-required
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_init_test_denocheck_",
  });

  try {
    await runInit({ directory: tempDir });
    const apiPath = join(tempDir, "functions", "api.ts");

    const command = new Deno.Command(Deno.execPath(), {
      args: ["check", "--quiet", apiPath],
      cwd: tempDir,
      stdout: "piped",
      stderr: "piped",
    });

    const output = await command.output();
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(
      output.code,
      0,
      `deno check on functions/api.ts failed: ${stderr}`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Group 3: Worked-Example Template Scaffolding (AC3, contracts/worked-example.md)
// ============================================================================

Deno.test("AC3 (worked-example): runInit with template='worked-example' generates canonical upload pipeline files and matching railfog.toml", async () => {
  // spec: contracts/worked-example.md — Canonical end-to-end flow
  // spec: tasks/milestone-0.5-developer-experience/T-0503-cli-init-scaffold.md#AC3
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_init_test_worked_example_",
  });

  try {
    const result = await runInit({
      directory: tempDir,
      template: "worked-example",
      projectName: "upload-demo",
    });

    const createdNormalized = (result.filesCreated as string[]).map((
      f: string,
    ) => f.replace(/\\/g, "/"));
    assert(createdNormalized.some((f: string) => f.endsWith("railfog.toml")));
    assert(
      createdNormalized.some((f: string) => f.endsWith("functions/api.ts")),
    );
    assert(
      createdNormalized.some((f: string) =>
        f.endsWith("functions/processor.ts")
      ),
    );
    assert(createdNormalized.some((f: string) => f.endsWith("deno.json")));
    assert(createdNormalized.some((f: string) => f.endsWith(".gitignore")));

    // 1. Verify railfog.toml matches worked-example.md specification verbatim
    const tomlRaw = await Deno.readTextFile(join(tempDir, "railfog.toml"));
    const parsed = parseToml(tomlRaw) as {
      name?: string;
      functions?: Record<
        string,
        {
          entry?: string;
          triggers?: { queue?: string };
          permissions?: {
            objects?: string[];
            queues?: string[];
            kv?: string[];
          };
        }
      >;
      routes?: Array<{ pattern?: string; function?: string }>;
    };

    assertEquals(parsed.name, "upload-demo");

    // functions.api
    assertExists(parsed.functions?.api, "Must define functions.api");
    assertEquals(parsed.functions.api.entry, "functions/api.ts");
    assertEquals(parsed.functions.api.permissions?.objects, ["app:uploads"]);
    assertEquals(parsed.functions.api.permissions?.queues, ["app:jobs"]);

    // functions.processor
    assertExists(
      parsed.functions?.processor,
      "Must define functions.processor",
    );
    assertEquals(parsed.functions.processor.entry, "functions/processor.ts");
    assertEquals(parsed.functions.processor.triggers?.queue, "app:jobs");
    assertEquals(parsed.functions.processor.permissions?.objects, [
      "app:uploads",
    ]);
    assertEquals(parsed.functions.processor.permissions?.kv, ["app:files"]);

    // routes
    assertExists(parsed.routes, "Must define routes");
    const uploadRoute = parsed.routes.find((r) =>
      r.function === "api" && r.pattern === "/upload"
    );
    assertExists(
      uploadRoute,
      "Must route /upload to api function per worked-example.md",
    );

    // 2. Verify functions/api.ts implements presigning and queue dispatch (OBJ-2, Q-2)
    const apiCode = await Deno.readTextFile(
      join(tempDir, "functions", "api.ts"),
    );
    assert(
      apiCode.includes("presign") || apiCode.includes("objects"),
      "functions/api.ts must utilize objects presigning per worked-example flow",
    );
    assert(
      apiCode.includes("queues") || apiCode.includes("send"),
      "functions/api.ts must enqueue message per worked-example flow",
    );

    // 3. Verify functions/processor.ts implements queue processing and KV deduplication (Q-4, KV-2)
    const processorCode = await Deno.readTextFile(
      join(tempDir, "functions", "processor.ts"),
    );
    assert(
      processorCode.includes("kv") &&
        (processorCode.includes("processed") || processorCode.includes("ttl")),
      "functions/processor.ts must implement KV deduplication per Q-4",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("AC3 & AC5: Scaffolded worked-example project passes checkProject static validation", async () => {
  // spec: tasks/milestone-0.5-developer-experience/T-0503-cli-init-scaffold.md#AC5
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_init_test_check_worked_example_",
  });

  try {
    await runInit({
      directory: tempDir,
      template: "worked-example",
      projectName: "upload-demo",
    });

    const checkResult = await checkProject(tempDir);
    assertEquals(
      checkResult.valid,
      true,
      "Worked-example template must pass checkProject",
    );
    assertEquals(
      checkResult.errors.length,
      0,
      "Worked-example template must produce zero errors",
    );
    assertExists(checkResult.routeSummary);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Integration: Scaffolded worked-example functions pass deno check", async () => {
  // spec: tasks/milestone-0.5-developer-experience/T-0503-cli-init-scaffold.md#Tests-required
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_init_test_denocheck_we_",
  });

  try {
    await runInit({
      directory: tempDir,
      template: "worked-example",
      projectName: "upload-demo",
    });

    const apiPath = join(tempDir, "functions", "api.ts");
    const processorPath = join(tempDir, "functions", "processor.ts");

    const apiCheck = new Deno.Command(Deno.execPath(), {
      args: ["check", "--quiet", apiPath],
      cwd: tempDir,
      stdout: "piped",
      stderr: "piped",
    });
    const apiOutput = await apiCheck.output();
    assertEquals(
      apiOutput.code,
      0,
      `deno check on worked-example api.ts failed: ${
        new TextDecoder().decode(apiOutput.stderr)
      }`,
    );

    const processorCheck = new Deno.Command(Deno.execPath(), {
      args: ["check", "--quiet", processorPath],
      cwd: tempDir,
      stdout: "piped",
      stderr: "piped",
    });
    const processorOutput = await processorCheck.output();
    assertEquals(
      processorOutput.code,
      0,
      `deno check on worked-example processor.ts failed: ${
        new TextDecoder().decode(processorOutput.stderr)
      }`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Group 4: Collision Detection & Overwrite Safety (AC4)
// ============================================================================

Deno.test("AC4: runInit rejects when target directory is non-empty and does not modify existing files", async () => {
  // spec: tasks/milestone-0.5-developer-experience/T-0503-cli-init-scaffold.md#AC4
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_init_test_collision_",
  });

  try {
    const existingFilePath = join(tempDir, "important_user_data.txt");
    const originalContent =
      "Original user document that must not be deleted or modified.";
    await Deno.writeTextFile(existingFilePath, originalContent);

    // Attempting to runInit without force: true must reject
    await assertRejects(
      async () => {
        await runInit({ directory: tempDir });
      },
      Error,
    );

    // Verify existing file is completely intact
    const afterContent = await Deno.readTextFile(existingFilePath);
    assertEquals(afterContent, originalContent);

    // Verify railfog.toml was NOT created
    let tomlExists = false;
    try {
      await Deno.stat(join(tempDir, "railfog.toml"));
      tomlExists = true;
    } catch {
      tomlExists = false;
    }
    assertEquals(
      tomlExists,
      false,
      "railfog.toml must not be created upon collision abort",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("AC4: runInit with force=true succeeds in non-empty directory and scaffolds template", async () => {
  // spec: tasks/milestone-0.5-developer-experience/T-0503-cli-init-scaffold.md#AC4
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_init_test_force_",
  });

  try {
    const preExistingFile = join(tempDir, "notes.txt");
    await Deno.writeTextFile(preExistingFile, "scratch notes");

    // With force: true, scaffolding proceeds
    const result = await runInit({ directory: tempDir, force: true });
    assertExists(result.filesCreated);

    const tomlStat = await Deno.stat(join(tempDir, "railfog.toml"));
    assertEquals(tomlStat.isFile, true);

    const apiStat = await Deno.stat(join(tempDir, "functions", "api.ts"));
    assertEquals(apiStat.isFile, true);

    // Pre-existing file is retained or ignored
    const notesStat = await Deno.stat(preExistingFile);
    assertEquals(notesStat.isFile, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Group 5: Directory Auto-Creation (PLAT-19)
// ============================================================================

Deno.test("PLAT-19: runInit recursively creates non-existent destination directories", async () => {
  // spec: contracts/platform.contract.md#PLAT-19 — Nested target path creation
  const parentDir = await Deno.makeTempDir({
    prefix: "railfog_init_nested_parent_",
  });
  const deepTargetDir = join(
    parentDir,
    "deep",
    "nested",
    "new-railfog-project",
  );

  try {
    const result = await runInit({ directory: deepTargetDir });

    assertEquals(resolve(result.targetDir), resolve(deepTargetDir));

    const tomlStat = await Deno.stat(join(deepTargetDir, "railfog.toml"));
    assertEquals(tomlStat.isFile, true);

    const checkResult = await checkProject(deepTargetDir);
    assertEquals(checkResult.valid, true);
  } finally {
    await Deno.remove(parentDir, { recursive: true });
  }
});

// ============================================================================
// Group 6: Adversarial Security Tests (T-0503 Checklist)
// ============================================================================

Deno.test("Adversarial: runInit rejects TOML injection and special characters in projectName", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog_init_injection_" });

  const maliciousProjectNames = [
    'injected"\n\n[functions.backdoor]\nentry = "functions/api.ts"\n#',
    'app"\n[attacker]\nhacked = true\n#',
    "app\nmalicious = true",
    "app\r\nevil = 1",
    'app" [evil]',
    "app # comment",
    "app = 123",
    "app; rm -rf",
    "-app",
    ".app",
    "",
    "   ",
    "app with spaces",
  ];

  try {
    for (const badName of maliciousProjectNames) {
      await assertRejects(
        async () => {
          await runInit({
            directory: tempDir,
            projectName: badName,
            force: true,
          });
        },
        Error,
        undefined,
        `Must reject malicious/invalid project name '${badName}'`,
      );
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Adversarial: PROJECT_NAME_REGEX strictly permits only safe alphanumeric identifiers", () => {
  assert(PROJECT_NAME_REGEX.test("my-app"));
  assert(PROJECT_NAME_REGEX.test("railfog_service_01"));
  assert(PROJECT_NAME_REGEX.test("v1.0.0"));
  assert(PROJECT_NAME_REGEX.test("App123"));

  // Reject malicious tokens
  assertEquals(PROJECT_NAME_REGEX.test('app"'), false);
  assertEquals(PROJECT_NAME_REGEX.test("app\n"), false);
  assertEquals(PROJECT_NAME_REGEX.test("app\r"), false);
  assertEquals(PROJECT_NAME_REGEX.test("app [table]"), false);
  assertEquals(PROJECT_NAME_REGEX.test("app#comment"), false);
  assertEquals(PROJECT_NAME_REGEX.test("app=1"), false);
  assertEquals(PROJECT_NAME_REGEX.test("-app"), false);
  assertEquals(PROJECT_NAME_REGEX.test(".app"), false);
  assertEquals(PROJECT_NAME_REGEX.test("app name"), false);
  assertEquals(PROJECT_NAME_REGEX.test(""), false);
});

Deno.test("Adversarial: runInit rejects if target path is an existing file (not a directory)", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_init_file_target_",
  });
  const existingFile = join(tempDir, "existing_file.txt");
  await Deno.writeTextFile(existingFile, "I am a file, not a directory");

  try {
    await assertRejects(
      async () => {
        await runInit({ directory: existingFile });
      },
      Error,
      "exists and is not a directory",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Adversarial: initCommand defaults to force=false and does not overwrite existing directory files", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_initcommand_safe_",
  });
  const secretFile = join(tempDir, "precious_data.json");
  await Deno.writeTextFile(secretFile, '{"critical": "secret"}');

  try {
    // Calling initCommand with default force=false must reject
    await assertRejects(
      async () => {
        await initCommand(tempDir);
      },
      Error,
      "is not empty",
    );

    // Verify existing file is untouched
    const content = await Deno.readTextFile(secretFile);
    assertEquals(content, '{"critical": "secret"}');
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Adversarial (PLAT-6): Generated templates enforce strictly scoped permission boundaries", async () => {
  const tempDirMinimal = await Deno.makeTempDir({
    prefix: "railfog_perm_minimal_",
  });
  const tempDirWorked = await Deno.makeTempDir({
    prefix: "railfog_perm_worked_",
  });

  try {
    // 1. Scaffold minimal template
    await runInit({ directory: tempDirMinimal, template: "minimal" });
    const checkMin = await checkProject(tempDirMinimal);
    assertEquals(
      checkMin.valid,
      true,
      "Minimal template must pass checkProject",
    );
    assertEquals(checkMin.errors.length, 0);

    const minToml = parseToml(
      await Deno.readTextFile(join(tempDirMinimal, "railfog.toml")),
    ) as Record<string, unknown>;
    const minFn = (minToml.functions as Record<
      string,
      { permissions?: Record<string, unknown> }
    >).api;
    assertExists(minFn.permissions);
    // Only declared permissions: exactly one KV namespace and one external network domain
    assertEquals(minFn.permissions.kv, ["app:data"]);
    assertEquals(minFn.permissions.network, ["api.example.com"]);
    assertEquals(minFn.permissions.objects, undefined);
    assertEquals(minFn.permissions.queues, undefined);

    // 2. Scaffold worked-example template
    await runInit({ directory: tempDirWorked, template: "worked-example" });
    const checkWorked = await checkProject(tempDirWorked);
    assertEquals(
      checkWorked.valid,
      true,
      "Worked-example template must pass checkProject",
    );
    assertEquals(checkWorked.errors.length, 0);

    const workedToml = parseToml(
      await Deno.readTextFile(join(tempDirWorked, "railfog.toml")),
    ) as Record<string, unknown>;
    const fns = workedToml.functions as Record<
      string,
      { permissions?: Record<string, unknown> }
    >;
    // api function: exactly 1 bucket and 1 queue
    assertEquals(fns.api.permissions?.objects, ["app:uploads"]);
    assertEquals(fns.api.permissions?.queues, ["app:jobs"]);
    assertEquals(fns.api.permissions?.kv, undefined);
    // processor function: exactly 1 bucket and 1 KV namespace
    assertEquals(fns.processor.permissions?.objects, ["app:uploads"]);
    assertEquals(fns.processor.permissions?.kv, ["app:files"]);
    assertEquals(fns.processor.permissions?.queues, undefined);
  } finally {
    await Deno.remove(tempDirMinimal, { recursive: true });
    await Deno.remove(tempDirWorked, { recursive: true });
  }
});
