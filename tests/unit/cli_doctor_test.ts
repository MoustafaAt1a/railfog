import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { runDoctor } from "../../cli/doctor.ts";

Deno.test("Doctor (Unit): runDoctor reports healthy status for valid project", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-doctor-valid-" });
  try {
    const tomlContent = `
name = "doctor-test-app"

[functions.api]
entry = "functions/api.ts"
memory = 128
timeout = 5000

[functions.api.permissions]
kv = ["cache"]
network = ["api.github.com"]

[[routes]]
pattern = "/api/*"
function = "api"
`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default { fetch: () => new Response('ok') };",
    );

    const result = await runDoctor({ cwd: tempDir });
    assertEquals(result.healthy, true, "Valid project should be healthy");
    assertEquals(result.report.projectName, "doctor-test-app");
    assert(result.isolateBootMs < 10, "Isolate boot benchmark should be fast");
    assertEquals(result.report.signals.length, 5, "Should have 5 track signals");

    // Verify all 5 signals are active
    for (const signal of result.report.signals) {
      assertEquals(signal.status, "active", `Signal ${signal.name} should be active`);
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("Doctor (Unit): runDoctor executes with compare flag enabled", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-doctor-compare-" });
  try {
    const tomlContent = `
name = "compare-app"

[functions.api]
entry = "functions/api.ts"

[[routes]]
pattern = "/"
function = "api"
`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default { fetch: () => new Response('ok') };",
    );

    const result = await runDoctor({ cwd: tempDir, compare: true });
    assertEquals(result.healthy, true);
    assertEquals(result.report.projectName, "compare-app");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("Doctor (Unit): runDoctor catches SSRF network violations (PLAT-5)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-doctor-ssrf-" });
  try {
    const tomlContent = `
name = "ssrf-app"

[functions.api]
entry = "functions/api.ts"

[functions.api.permissions]
network = ["169.254.169.254"]

[[routes]]
pattern = "/"
function = "api"
`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(
      join(tempDir, "functions", "api.ts"),
      "export default { fetch: () => new Response('ok') };",
    );

    const result = await runDoctor({ cwd: tempDir });
    assertEquals(result.healthy, false, "SSRF violations should mark doctor as unhealthy");
    const ssrfSignal = result.report.signals.find((s) => s.id === 3);
    assertExists(ssrfSignal);
    assertEquals(ssrfSignal.status, "error");
    assertStringIncludes(ssrfSignal.statusText, "SSRF RISK");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("Doctor (Unit): runDoctor warns on route shadowing (PLAT-11)", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-doctor-shadow-" });
  try {
    const tomlContent = `
name = "shadow-app"

[functions.api1]
entry = "functions/api1.ts"

[functions.api2]
entry = "functions/api2.ts"

[[routes]]
pattern = "/api/*"
function = "api1"

[[routes]]
pattern = "/api/*"
function = "api2"
`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(join(tempDir, "functions", "api1.ts"), "export default {};");
    await Deno.writeTextFile(join(tempDir, "functions", "api2.ts"), "export default {};");

    const result = await runDoctor({ cwd: tempDir });
    const routeSignal = result.report.signals.find((s) => s.id === 5);
    assertExists(routeSignal);
    assertEquals(routeSignal.status, "warn");
    assertStringIncludes(routeSignal.statusText, "SHADOW WARNING");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});
