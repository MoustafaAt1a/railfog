// spec: contracts/platform.contract.md#PLAT-19 — Repository structure
// spec: contracts/platform.contract.md#PLAT-20 — Explicitly out of scope for 1.0.0
// spec: tasks/milestone-0.7-repo-consolidation/T-0710-milestone-07-verification-and-integrity-audit.md

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";

const TOP_LEVEL_REQUIRED = [
  "apps",
  "packages",
  "primitives",
  "providers",
  "runtime",
  "sdk",
  "cli",
  "docs",
  "tests",
  "infra",
];

const REQUIRED_APPS = ["api", "gateway", "runtime", "worker"];

const REQUIRED_PACKAGES = [
  "core",
  "api",
  "auth",
  "config",
  "errors",
  "logging",
  "metrics",
  "policy",
  "protocol",
  "testing",
];

const REQUIRED_PRIMITIVES = ["functions", "kv", "objects", "queues"];

const REQUIRED_PROVIDERS = ["compute", "kv", "objects", "queues"];

const REQUIRED_RUNTIME_MODULES = [
  "api",
  "sandbox",
  "loader",
  "limits",
  "lifecycle",
];

const REQUIRED_TESTS_SUBDIRS = [
  "unit",
  "integration",
  "contract",
  "security",
  "e2e",
];

const PROHIBITED_DIRECTORIES = [
  "k8s",
  "kubernetes",
  "helm",
  "dashboard",
  "ui",
  "frontend",
  "web",
  "mesh",
  "istio",
  "envoy",
  "consul",
  "auth0",
  "cognito",
  "marketplace",
];

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await Deno.stat(path);
    return s.isDirectory;
  } catch {
    return false;
  }
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        if (entry.name !== ".git" && entry.name !== "node_modules") {
          entries.push(...(await collectFiles(full)));
        }
      } else {
        entries.push(full.replace(/\\/g, "/"));
      }
    }
  } catch {
    // Directory unreadable
  }
  return entries;
}

Deno.test("PLAT-19: repository structure conforms to canonical specification", async () => {
  const cwd = Deno.cwd();

  // 1. Verify all top-level directories per PLAT-19
  for (const topDir of TOP_LEVEL_REQUIRED) {
    const p = join(cwd, topDir);
    assert(
      await dirExists(p),
      `Top-level directory '${topDir}' must exist per PLAT-19`,
    );
  }

  // 2. Verify apps/ subdirectories
  for (const app of REQUIRED_APPS) {
    const p = join(cwd, "apps", app);
    assert(
      await dirExists(p),
      `App directory 'apps/${app}' must exist per PLAT-19`,
    );
  }

  // 3. Verify packages/ subdirectories
  for (const pkg of REQUIRED_PACKAGES) {
    const p = join(cwd, "packages", pkg);
    assert(
      await dirExists(p),
      `Package directory 'packages/${pkg}' must exist per PLAT-19`,
    );
  }

  // 4. Verify primitives/ subdirectories (the 4 primitives: functions, kv, objects, queues)
  for (const prim of REQUIRED_PRIMITIVES) {
    const p = join(cwd, "primitives", prim);
    assert(
      await dirExists(p),
      `Primitive directory 'primitives/${prim}' must exist per PLAT-19`,
    );
  }

  // 5. Verify providers/ subdirectories
  for (const prov of REQUIRED_PROVIDERS) {
    const p = join(cwd, "providers", prov);
    assert(
      await dirExists(p),
      `Provider directory 'providers/${prov}' must exist per PLAT-19`,
    );
  }

  // 6. Verify runtime/ subdirectories
  for (const mod of REQUIRED_RUNTIME_MODULES) {
    const p = join(cwd, "runtime", mod);
    assert(
      await dirExists(p),
      `Runtime directory 'runtime/${mod}' must exist per PLAT-19`,
    );
  }

  // 7. Verify tests/ subdirectories
  for (const tSub of REQUIRED_TESTS_SUBDIRS) {
    const p = join(cwd, "tests", tSub);
    assert(
      await dirExists(p),
      `Test directory 'tests/${tSub}' must exist per PLAT-19`,
    );
  }

  // 8. Verify all collocated unit tests were centralized into tests/
  const allFiles = await collectFiles(cwd);
  const rogueTests = allFiles.filter(
    (f) => f.endsWith("_test.ts") && !f.includes("/tests/"),
  );
  assertEquals(
    rogueTests,
    [],
    `All unit tests must be centralized in tests/; found collocated tests: ${
      rogueTests.join(", ")
    }`,
  );
});

Deno.test("PLAT-20: repository contains no prohibited submodules or scope creep", async () => {
  const cwd = Deno.cwd();

  // Verify prohibited top-level and nested scopes do not exist
  for (const banned of PROHIBITED_DIRECTORIES) {
    const topPath = join(cwd, banned);
    assert(
      !(await dirExists(topPath)),
      `Prohibited directory '${banned}' must not exist per PLAT-20`,
    );
    const appsPath = join(cwd, "apps", banned);
    assert(
      !(await dirExists(appsPath)),
      `Prohibited directory 'apps/${banned}' must not exist per PLAT-20`,
    );
  }

  // Verify no fifth primitive exists in primitives/
  const primitivesDir = join(cwd, "primitives");
  const primitiveDirs: string[] = [];
  for await (const entry of Deno.readDir(primitivesDir)) {
    if (entry.isDirectory) {
      primitiveDirs.push(entry.name);
    }
  }
  primitiveDirs.sort();
  assertEquals(
    primitiveDirs,
    ["compute", "functions", "kv", "objects", "queues"].sort(),
    "Primitives directory must contain only canonical primitives per PLAT-19 (functions, kv, objects, queues, compute)",
  );
});

Deno.test("PLAT-19: workspace import map in deno.json covers all packages and primitives", async () => {
  const rootDenoJsonPath = join(Deno.cwd(), "deno.json");
  const content = await Deno.readTextFile(rootDenoJsonPath);
  const config = JSON.parse(content);

  assert(config.imports, "imports object must be defined in deno.json");

  // Verify all 10 packages
  for (const pkg of REQUIRED_PACKAGES) {
    const alias = `@railfog/${pkg}`;
    assert(
      config.imports[alias] !== undefined,
      `Workspace alias ${alias} must be defined in deno.json imports`,
    );
  }

  // Verify all primitives
  for (const prim of REQUIRED_PRIMITIVES) {
    const alias = `@railfog/primitives/${prim}`;
    assert(
      config.imports[alias] !== undefined,
      `Primitive alias ${alias} must be defined in deno.json imports`,
    );
  }
});
