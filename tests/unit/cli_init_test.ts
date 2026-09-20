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
// spec: tasks/milestone-0.8-developer-experience-ux/T-0806-interactive-project-scaffolding.md

import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join, resolve } from "@std/path";
import { parse as parseToml } from "@std/toml";

import {
  type InitOptions,
  type InitResult,
  type InteractiveInitOptions,
  PROJECT_NAME_REGEX,
  runInit,
  runInteractiveInit,
} from "../../cli/init.ts";

import type { Choice, WriterSync } from "../../cli/prompt.ts";
import { initCommand } from "../../cli/main.ts";
import { checkProject } from "../../cli/check.ts";

export type { InitOptions, InteractiveInitOptions, WriterSync };

/**
 * Mock in-memory synchronous writer capturing stream output for terminal/non-terminal testing.
 */
class MockTerminalStream implements WriterSync {
  private chunks: Uint8Array[] = [];
  public terminal: boolean;

  constructor(isTerminal = true) {
    this.terminal = isTerminal;
  }

  isTerminal(): boolean {
    return this.terminal;
  }

  writeSync(p: Uint8Array): number {
    this.chunks.push(new Uint8Array(p));
    return p.length;
  }

  get text(): string {
    const decoder = new TextDecoder();
    return this.chunks.map((c) => decoder.decode(c)).join("");
  }

  clear(): void {
    this.chunks = [];
  }
}

// deno-lint-ignore no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[a-zA-Z]/g;
function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, "");
}

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

// ============================================================================
// Group 7: Interactive Prompt Flow (T-0806 AC1, PLAT-18, PLAT-19)
// ============================================================================

Deno.test("AC1 (T-0806): runInteractiveInit prompts for directory, project name, and template selection via selectPrompt", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_interactive_",
  });
  const targetDir = join(tempParent, "custom-interactive-app");

  try {
    const promptsAsked: Array<{ message: string; defaultValue?: string }> = [];
    const promptReader = (
      message: string,
      defaultValue?: string,
    ): Promise<string> => {
      promptsAsked.push({ message, defaultValue });
      const lower = message.toLowerCase();
      if (
        lower.includes("directory") || lower.includes("path") ||
        lower.includes("where")
      ) {
        return Promise.resolve(targetDir);
      }
      if (lower.includes("name")) {
        return Promise.resolve("custom-interactive-app");
      }
      return Promise.resolve(defaultValue ?? "");
    };

    let selectorCalled = false;
    let presentedChoices: Choice<"minimal" | "worked-example">[] = [];
    const templateSelector = (
      choices: Choice<"minimal" | "worked-example">[],
    ): Promise<"minimal" | "worked-example"> => {
      selectorCalled = true;
      presentedChoices = choices;
      return Promise.resolve("minimal");
    };

    const writer = new MockTerminalStream(true);

    const result = await runInteractiveInit({
      interactive: true,
      promptReader,
      templateSelector,
      outputWriter: writer,
    });

    assertExists(result);
    assertEquals(resolve(result.targetDir), resolve(targetDir));
    assertEquals(
      selectorCalled,
      true,
      "templateSelector must be called to choose starter template",
    );
    assert(
      promptsAsked.length >= 1,
      "promptReader must be called for interactive input",
    );
    assert(
      presentedChoices.some((c) => c.value === "minimal"),
      "Template choices must include 'minimal'",
    );
    assert(
      presentedChoices.some((c) => c.value === "worked-example"),
      "Template choices must include 'worked-example'",
    );

    // Verify scaffolded project files
    const tomlStat = await Deno.stat(join(targetDir, "railfog.toml"));
    assertEquals(tomlStat.isFile, true);
    const tomlRaw = await Deno.readTextFile(join(targetDir, "railfog.toml"));
    const parsed = parseToml(tomlRaw) as { name?: string };
    assertEquals(parsed.name, "custom-interactive-app");
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

Deno.test("AC1 (T-0806): runInteractiveInit accepts default values when empty input is provided to promptReader", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_defaults_",
  });
  const targetDir = join(tempParent, "default-target-app");

  try {
    const promptReader = (
      _message: string,
      defaultValue?: string,
    ): Promise<string> => {
      return Promise.resolve(defaultValue ?? "");
    };

    const templateSelector = (
      choices: Choice<"minimal" | "worked-example">[],
    ): Promise<"minimal" | "worked-example"> => {
      return Promise.resolve(choices[0].value);
    };

    const writer = new MockTerminalStream(true);

    const result = await runInteractiveInit({
      directory: targetDir,
      interactive: true,
      promptReader,
      templateSelector,
      outputWriter: writer,
    });

    assertExists(result);
    assertEquals(resolve(result.targetDir), resolve(targetDir));

    const tomlRaw = await Deno.readTextFile(join(targetDir, "railfog.toml"));
    const parsed = parseToml(tomlRaw) as { name?: string };
    assertExists(parsed.name);
    assert(
      PROJECT_NAME_REGEX.test(parsed.name),
      "Derived/default project name must be valid identifier per PLAT-18",
    );
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

Deno.test("AC1 & PLAT-18 (T-0806): runInteractiveInit validates project name from prompt and rejects invalid identifiers", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_invalid_prompt_",
  });
  const targetDir = join(tempParent, "invalid-name-app");

  try {
    const promptReader = (
      message: string,
      _defaultValue?: string,
    ): Promise<string> => {
      const lower = message.toLowerCase();
      if (lower.includes("directory") || lower.includes("path")) {
        return Promise.resolve(targetDir);
      }
      return Promise.resolve("invalid project name! @#$");
    };

    const templateSelector = (): Promise<"minimal" | "worked-example"> =>
      Promise.resolve("minimal");

    await assertRejects(
      async () => {
        await runInteractiveInit({
          interactive: true,
          promptReader,
          templateSelector,
        });
      },
      Error,
      "Invalid project name",
    );
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

// ============================================================================
// Group 8: Template Scaffolding via Interactive Selection (AC2, PLAT-18, PLAT-19, worked-example.md)
// ============================================================================

Deno.test("AC2 (T-0806): runInteractiveInit scaffolds minimal template and generates valid railfog.toml and deno.json passing checkProject", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_scaffold_min_",
  });
  const targetDir = join(tempParent, "interactive-minimal");

  try {
    const promptReader = (
      message: string,
      defaultValue?: string,
    ): Promise<string> => {
      const lower = message.toLowerCase();
      if (lower.includes("directory") || lower.includes("path")) {
        return Promise.resolve(targetDir);
      }
      return Promise.resolve(defaultValue ?? "interactive-minimal");
    };

    const templateSelector = (): Promise<"minimal" | "worked-example"> =>
      Promise.resolve("minimal");

    const writer = new MockTerminalStream(true);
    const result = await runInteractiveInit({
      interactive: true,
      promptReader,
      templateSelector,
      outputWriter: writer,
    });

    assertExists(result);
    // 1. Verify railfog.toml
    const tomlRaw = await Deno.readTextFile(join(targetDir, "railfog.toml"));
    const parsed = parseToml(tomlRaw) as {
      name?: string;
      functions?: Record<
        string,
        { entry?: string; permissions?: Record<string, unknown> }
      >;
      routes?: Array<{ pattern?: string; function?: string }>;
    };
    assertEquals(parsed.name, "interactive-minimal");
    assertExists(parsed.functions?.api);
    assertEquals(parsed.functions.api.entry, "functions/api.ts");
    assertExists(parsed.routes);
    assertEquals(parsed.routes[0].function, "api");

    // 2. Verify functions/api.ts
    const apiCode = await Deno.readTextFile(
      join(targetDir, "functions", "api.ts"),
    );
    assert(
      apiCode.includes("export default"),
      "functions/api.ts must export default fetch handler per FN-1",
    );

    // 3. Verify deno.json
    const denoJson = JSON.parse(
      await Deno.readTextFile(join(targetDir, "deno.json")),
    );
    assertExists(denoJson.tasks?.dev, "deno.json tasks must include 'dev'");
    assertExists(
      denoJson.imports?.["@railfog/sdk"],
      "deno.json must import '@railfog/sdk'",
    );

    // 4. Verify checkProject passes cleanly
    const check = await checkProject(targetDir);
    assertEquals(
      check.valid,
      true,
      "Scaffolded minimal project must pass checkProject validation",
    );
    assertEquals(check.errors.length, 0);
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

Deno.test("AC2 (T-0806): runInteractiveInit scaffolds worked-example template with OBJ-2, Q-2, Q-4, KV-2 files and passes checkProject", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_scaffold_we_",
  });
  const targetDir = join(tempParent, "interactive-worked-example");

  try {
    const promptReader = (
      message: string,
      defaultValue?: string,
    ): Promise<string> => {
      const lower = message.toLowerCase();
      if (lower.includes("directory") || lower.includes("path")) {
        return Promise.resolve(targetDir);
      }
      return Promise.resolve(defaultValue ?? "interactive-worked-example");
    };

    const templateSelector = (): Promise<"minimal" | "worked-example"> =>
      Promise.resolve("worked-example");

    const writer = new MockTerminalStream(true);
    const result = await runInteractiveInit({
      interactive: true,
      promptReader,
      templateSelector,
      outputWriter: writer,
    });

    assertExists(result);
    // 1. Verify railfog.toml structure per worked-example.md
    const tomlRaw = await Deno.readTextFile(join(targetDir, "railfog.toml"));
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

    assertEquals(parsed.name, "interactive-worked-example");
    assertExists(parsed.functions?.api, "Must declare functions.api");
    assertEquals(parsed.functions.api.entry, "functions/api.ts");
    assertEquals(parsed.functions.api.permissions?.objects, ["app:uploads"]);
    assertEquals(parsed.functions.api.permissions?.queues, ["app:jobs"]);

    assertExists(
      parsed.functions?.processor,
      "Must declare functions.processor",
    );
    assertEquals(parsed.functions.processor.entry, "functions/processor.ts");
    assertEquals(parsed.functions.processor.triggers?.queue, "app:jobs");
    assertEquals(parsed.functions.processor.permissions?.objects, [
      "app:uploads",
    ]);
    assertEquals(parsed.functions.processor.permissions?.kv, ["app:files"]);

    const uploadRoute = parsed.routes?.find((r) =>
      r.function === "api" && r.pattern === "/upload"
    );
    assertExists(uploadRoute, "Must route /upload to api function");

    // 2. Verify functions/api.ts and functions/processor.ts content
    const apiCode = await Deno.readTextFile(
      join(targetDir, "functions", "api.ts"),
    );
    assert(
      apiCode.includes("presign"),
      "Worked-example api.ts must implement objects presign per OBJ-2",
    );
    assert(
      apiCode.includes("send"),
      "Worked-example api.ts must send message to queue per Q-2",
    );

    const procCode = await Deno.readTextFile(
      join(targetDir, "functions", "processor.ts"),
    );
    assert(
      procCode.includes("kv.get") && procCode.includes("kv.set"),
      "Worked-example processor.ts must use KV per KV-2/Q-4",
    );

    // 3. Verify checkProject passes cleanly
    const check = await checkProject(targetDir);
    assertEquals(
      check.valid,
      true,
      "Scaffolded worked-example project must pass checkProject validation",
    );
    assertEquals(check.errors.length, 0);
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

Deno.test("AC2 (T-0806): templateSelector choices present both 'minimal' and 'worked-example' with informative descriptions", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_choices_",
  });
  const targetDir = join(tempParent, "choices-app");

  try {
    let capturedChoices: Choice<"minimal" | "worked-example">[] = [];
    const templateSelector = (
      choices: Choice<"minimal" | "worked-example">[],
    ): Promise<"minimal" | "worked-example"> => {
      capturedChoices = choices;
      return Promise.resolve("minimal");
    };

    await runInteractiveInit({
      directory: targetDir,
      interactive: true,
      promptReader: (_msg, def) => Promise.resolve(def ?? ""),
      templateSelector,
    });

    assertEquals(
      capturedChoices.length >= 2,
      true,
      "Must present at least 2 starter template choices",
    );
    const minChoice = capturedChoices.find((c) => c.value === "minimal");
    assertExists(minChoice, "Choices must include 'minimal'");
    assertExists(minChoice.label, "Minimal choice must have a label");

    const weChoice = capturedChoices.find((c) => c.value === "worked-example");
    assertExists(weChoice, "Choices must include 'worked-example'");
    assertExists(weChoice.label, "Worked-example choice must have a label");
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

// ============================================================================
// Group 9: Completion Summary Box Rendering (AC4, T-0806)
// ============================================================================

Deno.test("AC4 (T-0806): runInteractiveInit renders completion summary box with created files, deno.json tasks, and next steps", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_summary_box_",
  });
  const targetDir = join(tempParent, "summary-box-app");

  try {
    const writer = new MockTerminalStream(true);

    await runInteractiveInit({
      directory: targetDir,
      projectName: "summary-box-app",
      template: "minimal",
      interactive: true,
      promptReader: (_msg, def) => Promise.resolve(def ?? ""),
      templateSelector: () => Promise.resolve("minimal"),
      outputWriter: writer,
    });

    const outputText = stripAnsi(writer.text);

    // 1. Verify created files listed in summary box
    assertStringIncludes(outputText, "railfog.toml");
    assertStringIncludes(outputText, "deno.json");
    assertStringIncludes(outputText, ".gitignore");
    assert(
      outputText.includes("functions/api.ts") || outputText.includes("api.ts"),
    );

    // 2. Verify next steps and instructions
    assertStringIncludes(outputText, "rail dev");
    assertStringIncludes(outputText, "rail deploy");

    // 3. Verify box / summary structure
    assert(
      outputText.includes("─") || outputText.includes("-") ||
        outputText.includes("┌") || outputText.includes("+"),
      "Summary output must contain box or border formatting per AC4",
    );
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

Deno.test("AC4 (T-0806): completion summary box correctly formats 'cd <dir>' next step when target is not current directory", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_cd_step_",
  });
  const dirName = "nested-microservice";
  const targetDir = join(tempParent, dirName);

  try {
    const writer = new MockTerminalStream(true);

    await runInteractiveInit({
      directory: targetDir,
      projectName: dirName,
      template: "minimal",
      interactive: true,
      promptReader: (_msg, def) => Promise.resolve(def ?? ""),
      templateSelector: () => Promise.resolve("minimal"),
      outputWriter: writer,
    });

    const outputText = stripAnsi(writer.text);

    // When target directory is not cwd, summary must include 'cd <dir>' navigation command in next steps
    assert(
      outputText.includes(`cd ${dirName}`) ||
        outputText.includes(`cd ${targetDir}`),
      `Summary box must include 'cd ${dirName}' navigation command in next steps`,
    );
    assertStringIncludes(outputText, "rail dev");
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

Deno.test("AC4 (T-0806): completion summary box displays rail dev and rail deploy next step commands for worked-example", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_we_summary_",
  });
  const targetDir = join(tempParent, "upload-service");

  try {
    const writer = new MockTerminalStream(true);

    await runInteractiveInit({
      directory: targetDir,
      projectName: "upload-service",
      template: "worked-example",
      interactive: true,
      promptReader: (_msg, def) => Promise.resolve(def ?? ""),
      templateSelector: () => Promise.resolve("worked-example"),
      outputWriter: writer,
    });

    const outputText = stripAnsi(writer.text);

    // Must list worked-example specific created files
    assert(
      outputText.includes("processor.ts"),
      "Summary box must list functions/processor.ts for worked-example",
    );
    assert(
      outputText.includes("api.ts"),
      "Summary box must list functions/api.ts",
    );
    assertStringIncludes(outputText, "rail dev");
    assertStringIncludes(outputText, "rail deploy");
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

// ============================================================================
// Group 10: Backward Compatibility & Headless Non-Interactive Execution (AC3, T-0806)
// ============================================================================

Deno.test("AC3 (T-0806): runInteractiveInit runs non-interactively without prompting when directory and template are explicitly provided", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_headless_",
  });
  const targetDir = join(tempParent, "headless-app");

  try {
    let promptReaderCalled = false;
    const promptReader = (): Promise<string> => {
      promptReaderCalled = true;
      return Promise.resolve("should-not-be-called");
    };

    let templateSelectorCalled = false;
    const templateSelector = (): Promise<"minimal" | "worked-example"> => {
      templateSelectorCalled = true;
      return Promise.resolve("worked-example");
    };

    const writer = new MockTerminalStream(true);

    // When positional/explicit flags are passed (e.g. rail init headless-app --template worked-example)
    const result = await runInteractiveInit({
      directory: targetDir,
      projectName: "headless-app",
      template: "worked-example",
      promptReader,
      templateSelector,
      outputWriter: writer,
    });

    assertExists(result);
    assertEquals(resolve(result.targetDir), resolve(targetDir));
    assertEquals(
      promptReaderCalled,
      false,
      "promptReader must NOT be invoked when arguments are explicitly provided",
    );
    assertEquals(
      templateSelectorCalled,
      false,
      "templateSelector must NOT be invoked when template is explicitly provided",
    );

    // Check that worked-example files were created non-interactively
    const tomlRaw = await Deno.readTextFile(join(targetDir, "railfog.toml"));
    assertStringIncludes(tomlRaw, "upload");
    assertStringIncludes(tomlRaw, "processor");
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

Deno.test("AC3 (T-0806): runInteractiveInit with interactive=false bypasses promptReader and templateSelector completely", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_noninteractive_",
  });
  const targetDir = join(tempParent, "noninteractive-app");

  try {
    let promptReaderCalled = false;
    const promptReader = (): Promise<string> => {
      promptReaderCalled = true;
      return Promise.reject(new Error("promptReader called unexpectedly"));
    };

    let templateSelectorCalled = false;
    const templateSelector = (): Promise<"minimal" | "worked-example"> => {
      templateSelectorCalled = true;
      return Promise.reject(new Error("templateSelector called unexpectedly"));
    };

    const result = await runInteractiveInit({
      directory: targetDir,
      interactive: false,
      promptReader,
      templateSelector,
    });

    assertExists(result);
    assertEquals(promptReaderCalled, false);
    assertEquals(templateSelectorCalled, false);

    const tomlStat = await Deno.stat(join(targetDir, "railfog.toml"));
    assertEquals(tomlStat.isFile, true);
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

Deno.test("AC3 (T-0806): runInit preserves exact existing signature and non-interactive behavior", async () => {
  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_init_legacy_compat_",
  });

  try {
    // Existing runInit must continue to work with original InitOptions without prompting
    const result = await runInit({
      directory: tempDir,
      projectName: "legacy-compat",
      template: "minimal",
    });

    assertEquals(resolve(result.targetDir), resolve(tempDir));
    assert(result.filesCreated.length >= 4);

    const check = await checkProject(tempDir);
    assertEquals(check.valid, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Group 11: Non-Terminal Fallback & Stdin Safety (T-0806 Assumptions)
// ============================================================================

Deno.test("Assumption (T-0806): runInteractiveInit defaults cleanly to non-interactive mode when stdin is non-terminal", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_non_terminal_",
  });
  const targetDir = join(tempParent, "non-terminal-app");

  try {
    let promptReaderCalled = false;
    const promptReader = (): Promise<string> => {
      promptReaderCalled = true;
      return Promise.reject(
        new Error("Should not prompt in non-terminal mode"),
      );
    };

    // Simulated non-terminal output writer
    const nonTerminalWriter = new MockTerminalStream(false);

    const result = await runInteractiveInit({
      directory: targetDir,
      outputWriter: nonTerminalWriter,
      promptReader,
      // interactive not specified; should detect non-terminal and default to non-interactive
    });

    assertExists(result);
    assertEquals(
      promptReaderCalled,
      false,
      "Must not prompt when environment is non-terminal",
    );

    const tomlStat = await Deno.stat(join(targetDir, "railfog.toml"));
    assertEquals(tomlStat.isFile, true);
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

Deno.test("Assumption (T-0806): non-terminal runInteractiveInit does not hang and creates valid minimal project", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_non_hang_",
  });
  const targetDir = join(tempParent, "clean-batch-app");

  try {
    const nonTerminalWriter = new MockTerminalStream(false);

    const result = await runInteractiveInit({
      directory: targetDir,
      outputWriter: nonTerminalWriter,
      interactive: false,
    });

    assertExists(result);
    assertEquals(resolve(result.targetDir), resolve(targetDir));

    const check = await checkProject(targetDir);
    assertEquals(
      check.valid,
      true,
      "Scaffolded project from non-terminal run must pass static validation",
    );
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

// ============================================================================
// Group 12: Adversarial & Collision Safety in Interactive Scaffolding (PLAT-18, PLAT-19)
// ============================================================================

Deno.test("Adversarial (PLAT-18 & T-0806): interactive prompt rejects path traversal and TOML injection in project name", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempParent = await Deno.makeTempDir({
    prefix: "railfog_init_adv_prompt_",
  });
  const targetDir = join(tempParent, "safe-app");

  try {
    const promptReader = (
      message: string,
      _defaultValue?: string,
    ): Promise<string> => {
      const lower = message.toLowerCase();
      if (lower.includes("directory") || lower.includes("path")) {
        return Promise.resolve(targetDir);
      }
      // TOML injection attempt in project name
      return Promise.resolve(
        'injected"\n[functions.backdoor]\nentry="evil.ts"\n#',
      );
    };

    const templateSelector = (): Promise<"minimal" | "worked-example"> =>
      Promise.resolve("minimal");

    await assertRejects(
      async () => {
        await runInteractiveInit({
          interactive: true,
          promptReader,
          templateSelector,
        });
      },
      Error,
      "Invalid project name",
    );
  } finally {
    await Deno.remove(tempParent, { recursive: true });
  }
});

Deno.test("Adversarial (T-0806): interactive scaffolding detects non-empty directory collision and aborts without modifying files unless forced", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_init_adv_collision_",
  });
  const existingSecretFile = join(tempDir, "existing-data.txt");
  const originalSecret = "Do not overwrite me!";
  await Deno.writeTextFile(existingSecretFile, originalSecret);

  try {
    const promptReader = (
      message: string,
      defaultValue?: string,
    ): Promise<string> => {
      const lower = message.toLowerCase();
      if (lower.includes("directory") || lower.includes("path")) {
        return Promise.resolve(tempDir);
      }
      return Promise.resolve(defaultValue ?? "collision-app");
    };

    const templateSelector = (): Promise<"minimal" | "worked-example"> =>
      Promise.resolve("minimal");

    // Attempting interactive init into non-empty directory without force=true must reject
    await assertRejects(
      async () => {
        await runInteractiveInit({
          interactive: true,
          promptReader,
          templateSelector,
          force: false,
        });
      },
      Error,
      "not empty",
    );

    // Verify existing file is untouched
    const fileContent = await Deno.readTextFile(existingSecretFile);
    assertEquals(fileContent, originalSecret);

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
      "railfog.toml must not be created on collision",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Adversarial (T-0806): interactive scaffolding with force=true overwrites existing non-empty directory", async () => {
  assert(
    typeof runInteractiveInit === "function",
    "runInteractiveInit must be implemented and exported from cli/init.ts per T-0806",
  );

  const tempDir = await Deno.makeTempDir({
    prefix: "railfog_init_force_overwrite_",
  });
  const existingFile = join(tempDir, "existing.txt");
  await Deno.writeTextFile(existingFile, "pre-existing text");

  try {
    const promptReader = (
      message: string,
      defaultValue?: string,
    ): Promise<string> => {
      const lower = message.toLowerCase();
      if (lower.includes("directory") || lower.includes("path")) {
        return Promise.resolve(tempDir);
      }
      return Promise.resolve(defaultValue ?? "forced-app");
    };

    const templateSelector = (): Promise<"minimal" | "worked-example"> =>
      Promise.resolve("minimal");

    const result = await runInteractiveInit({
      interactive: true,
      promptReader,
      templateSelector,
      force: true,
    });

    assertExists(result);
    assertEquals(resolve(result.targetDir), resolve(tempDir));

    const tomlStat = await Deno.stat(join(tempDir, "railfog.toml"));
    assertEquals(tomlStat.isFile, true);

    const existingStat = await Deno.stat(existingFile);
    assertEquals(existingStat.isFile, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
