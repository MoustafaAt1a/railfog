// spec: contracts/platform.contract.md#PLAT-19 — Repository structure and workspace import map
// spec: tasks/milestone-0.7-repo-consolidation/T-0701-root-configuration-and-workspace-import-map.md

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

// Expected package aliases under @railfog/* per PLAT-19
export const EXPECTED_WORKSPACE_IMPORTS: Record<string, string> = {
  "@railfog/core": "./packages/core/mod.ts",
  "@railfog/config": "./packages/config/mod.ts",
  "@railfog/api": "./packages/api/mod.ts",
  "@railfog/auth": "./packages/auth/mod.ts",
  "@railfog/errors": "./packages/errors/mod.ts",
  "@railfog/logging": "./packages/logging/mod.ts",
  "@railfog/metrics": "./packages/metrics/mod.ts",
  "@railfog/policy": "./packages/policy/mod.ts",
  "@railfog/protocol": "./packages/protocol/mod.ts",
  "@railfog/testing": "./packages/testing/mod.ts",
  "@railfog/primitives/functions": "./primitives/functions/mod.ts",
  "@railfog/primitives/kv": "./primitives/kv/mod.ts",
  "@railfog/primitives/objects": "./primitives/objects/mod.ts",
  "@railfog/primitives/queues": "./primitives/queues/mod.ts",
};

// Expected granular test tasks per T-0701
export const EXPECTED_TEST_TASKS: Record<string, string> = {
  "test":
    "deno test --allow-read --allow-write --allow-net --allow-run --allow-env",
  "test:unit":
    "deno test --allow-read --allow-write --allow-net --allow-run --allow-env tests/unit/",
  "test:integration":
    "deno test --allow-read --allow-write --allow-net --allow-env tests/integration/",
  "test:contract":
    "deno test --allow-read --allow-write --allow-net --allow-run --allow-env tests/contract/",
  "test:security":
    "deno test --allow-read --allow-write --allow-net --allow-run --allow-env tests/security/",
  "test:load":
    "deno test --allow-read --allow-write --allow-net --allow-env tests/load/",
  "test:e2e":
    "deno test --allow-read --allow-write --allow-net --allow-env tests/e2e/",
};

Deno.test("T-0701: compilerOptions enforces strict mode", async () => {
  const rootDenoJsonPath = join(Deno.cwd(), "deno.json");
  const content = await Deno.readTextFile(rootDenoJsonPath);
  const config = JSON.parse(content);

  assert(
    config.compilerOptions,
    "compilerOptions must be defined in deno.json",
  );
  assertEquals(
    config.compilerOptions.strict,
    true,
    "compilerOptions.strict must be true",
  );
  assertEquals(
    config.compilerOptions.noImplicitAny,
    true,
    "compilerOptions.noImplicitAny must be true",
  );
  assertEquals(
    config.compilerOptions.noUnusedLocals,
    false,
    "compilerOptions.noUnusedLocals must be false",
  );
});

Deno.test("T-0701: imports declares all required @railfog/* workspace mappings", async () => {
  const rootDenoJsonPath = join(Deno.cwd(), "deno.json");
  const content = await Deno.readTextFile(rootDenoJsonPath);
  const config = JSON.parse(content);

  assert(config.imports, "imports object must be defined in deno.json");
  for (
    const [alias, expectedTarget] of Object.entries(EXPECTED_WORKSPACE_IMPORTS)
  ) {
    assertEquals(
      config.imports[alias],
      expectedTarget,
      `Import map alias ${alias} must resolve to ${expectedTarget}`,
    );
  }
});

Deno.test("T-0701: tasks defines granular test runners with --allow-env", async () => {
  const rootDenoJsonPath = join(Deno.cwd(), "deno.json");
  const content = await Deno.readTextFile(rootDenoJsonPath);
  const config = JSON.parse(content);

  assert(config.tasks, "tasks object must be defined in deno.json");
  for (
    const [taskName, expectedCommand] of Object.entries(EXPECTED_TEST_TASKS)
  ) {
    assertEquals(
      config.tasks[taskName],
      expectedCommand,
      `Task ${taskName} must match expected command: ${expectedCommand}`,
    );
    assert(
      config.tasks[taskName].includes("--allow-env"),
      `Task ${taskName} command must include the --allow-env flag`,
    );
  }
});

Deno.test("T-0701: workspace import resolution resolves @railfog/errors", async () => {
  // Verifies that Deno runtime resolves @railfog/* import alias to the workspace package
  const errorModule = await import("@railfog/errors");
  assert(
    errorModule !== undefined,
    "@railfog/errors must resolve and import successfully",
  );
  assert(
    errorModule.RailFogError !== undefined,
    "Export RailFogError from @railfog/errors must be accessible",
  );
});
