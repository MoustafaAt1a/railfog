import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { matchesRoutePattern, runSimulate } from "../../cli/simulate.ts";

Deno.test("Simulate (Unit): matchesRoutePattern correctly evaluates patterns", () => {
  // Exact match
  assertEquals(matchesRoutePattern("/health", "/health"), true);
  assertEquals(matchesRoutePattern("/health", "/health/check"), false);
  assertEquals(matchesRoutePattern("/health", "/other"), false);

  // Wildcard slash match (/api/*)
  assertEquals(matchesRoutePattern("/api/*", "/api"), true);
  assertEquals(matchesRoutePattern("/api/*", "/api/"), true);
  assertEquals(matchesRoutePattern("/api/*", "/api/users"), true);
  assertEquals(matchesRoutePattern("/api/*", "/api/v1/orders/123"), true);
  assertEquals(matchesRoutePattern("/api/*", "/apix"), false);
  assertEquals(matchesRoutePattern("/api/*", "/other"), false);

  // Trailing asterisk (/files*)
  assertEquals(matchesRoutePattern("/files*", "/files"), true);
  assertEquals(matchesRoutePattern("/files*", "/files/download"), true);
  assertEquals(matchesRoutePattern("/files*", "/filesxyz"), true);
  assertEquals(matchesRoutePattern("/files*", "/other"), false);
});

Deno.test("Simulate (Unit): runSimulate selects most specific route per PLAT-11", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-sim-specificity-" });
  try {
    const tomlContent = `
name = "routing-app"

[functions.generic]
entry = "functions/generic.ts"

[functions.checkout]
entry = "functions/checkout.ts"
memory = 256
timeout = 10000

[functions.checkout.permissions]
kv = ["orders_kv"]
network = ["api.stripe.com"]

[[routes]]
pattern = "/api/*"
function = "generic"

[[routes]]
pattern = "/api/checkout"
function = "checkout"
`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);
    await Deno.mkdir(join(tempDir, "functions"), { recursive: true });
    await Deno.writeTextFile(join(tempDir, "functions", "generic.ts"), "export default {};");
    await Deno.writeTextFile(join(tempDir, "functions", "checkout.ts"), "export default {};");

    // Test specific path /api/checkout -> should resolve to checkout function due to higher PLAT-11 score
    const simCheckout = await runSimulate("/api/checkout", { cwd: tempDir, method: "POST" });
    assertEquals(simCheckout.functionName, "checkout");
    assertEquals(simCheckout.matchedPattern, "/api/checkout");
    assertEquals(simCheckout.method, "POST");
    assertEquals(simCheckout.entrypoint, "functions/checkout.ts");
    assertEquals(simCheckout.permissions.kv, ["orders_kv"]);
    assertEquals(simCheckout.permissions.network, ["api.stripe.com"]);
    assert(simCheckout.specificityScore > 0);

    // Test wildcard path /api/other -> should resolve to generic function
    const simGeneric = await runSimulate("/api/other", { cwd: tempDir });
    assertEquals(simGeneric.functionName, "generic");
    assertEquals(simGeneric.matchedPattern, "/api/*");
    assertEquals(simGeneric.method, "GET");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("Simulate (Unit): runSimulate throws informative error for unmatched path", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-sim-unmatched-" });
  try {
    const tomlContent = `
name = "unmatched-app"

[functions.api]
entry = "functions/api.ts"

[[routes]]
pattern = "/api/*"
function = "api"
`;
    await Deno.writeTextFile(join(tempDir, "railfog.toml"), tomlContent);

    await assertRejects(
      async () => {
        await runSimulate("/unmatched", { cwd: tempDir });
      },
      Error,
      'No route matches path "/unmatched"',
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("Simulate (Unit): runSimulate throws when railfog.toml is missing", async () => {
  const emptyDir = await Deno.makeTempDir({ prefix: "railfog-sim-missing-" });
  try {
    await assertRejects(
      async () => {
        await runSimulate("/api", { cwd: emptyDir });
      },
      Error,
      "railfog.toml not found",
    );
  } finally {
    await Deno.remove(emptyDir, { recursive: true }).catch(() => {});
  }
});
