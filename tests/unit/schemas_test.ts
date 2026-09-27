// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: schemas/railfog.schema.json
// spec: contracts/platform.contract.md#PLAT-3 — Deployment pipeline validation against schema
// spec: contracts/platform.contract.md#PLAT-18 — Resource naming and hierarchy

import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { parse } from "@std/toml";
import { STARTER_CONFIG } from "../../cli/main.ts";

Deno.test("Schema: schemas/railfog.schema.json exists, is valid JSON Schema Draft-07, and defines required fields", async () => {
  const schemaPath = join(Deno.cwd(), "schemas", "railfog.schema.json");
  const schemaContent = await Deno.readTextFile(schemaPath);
  const schema = JSON.parse(schemaContent);

  assertExists(schema.$schema);
  assertEquals(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assertEquals(schema.type, "object");
  assert(Array.isArray(schema.required));
  assert(schema.required.includes("name"));
  assert(schema.required.includes("functions"));
  assert(schema.required.includes("routes"));

  // Verify properties
  assertExists(schema.properties.name);
  assertExists(schema.properties.functions);
  assertExists(schema.properties.routes);
  assertExists(schema.properties.kv);
});

Deno.test("Schema: STARTER_CONFIG matches the defined schema properties", () => {
  const parsed = parse(STARTER_CONFIG) as Record<string, unknown>;
  assert(typeof parsed.name === "string" && parsed.name.length > 0);
  assert(typeof parsed.functions === "object" && parsed.functions !== null);
  assert(Array.isArray(parsed.routes) && parsed.routes.length > 0);
});

Deno.test("T-0913: Schema defines permissive aliases (state, data, signal) with strict type arrays", async () => {
  const schemaPath = join(Deno.cwd(), "schemas", "railfog.schema.json");
  const schemaContent = await Deno.readTextFile(schemaPath);
  const schema = JSON.parse(schemaContent);
  const permissions =
    schema.properties.functions.additionalProperties.properties.permissions;

  assertExists(
    permissions.properties.state,
    "Schema must define permissions.state",
  );
  assertEquals(permissions.properties.state.type, "array");
  assertEquals(permissions.properties.state.items.type, "string");

  assertExists(
    permissions.properties.data,
    "Schema must define permissions.data",
  );
  assertEquals(permissions.properties.data.type, "array");
  assertEquals(permissions.properties.data.items.type, "string");

  assertExists(
    permissions.properties.signal,
    "Schema must define permissions.signal",
  );
  assertEquals(permissions.properties.signal.type, "array");
  assertEquals(permissions.properties.signal.items.type, "string");

  assertEquals(
    permissions.additionalProperties,
    false,
    "permissions must disallow unknown keys",
  );
});

Deno.test("T-0913 / Security: Schema enforces mutual exclusivity across capability aliases (PLAT-6)", async () => {
  const schemaPath = join(Deno.cwd(), "schemas", "railfog.schema.json");
  const schemaContent = await Deno.readTextFile(schemaPath);
  const schema = JSON.parse(schemaContent);
  const permissions =
    schema.properties.functions.additionalProperties.properties.permissions;

  assertExists(
    permissions.allOf,
    "permissions must define allOf mutual exclusivity constraints",
  );
  assert(Array.isArray(permissions.allOf), "allOf must be an array");

  const rules = permissions.allOf as Array<{ not?: { required?: string[] } }>;
  const notRequiredPairs = rules
    .filter((r) => r.not && Array.isArray(r.not.required))
    .map((r) => r.not!.required!.slice().sort().join(","));

  assert(
    notRequiredPairs.includes(["kv", "state"].sort().join(",")),
    "allOf must contain { not: { required: ['kv', 'state'] } }",
  );
  assert(
    notRequiredPairs.includes(["data", "objects"].sort().join(",")),
    "allOf must contain { not: { required: ['objects', 'data'] } }",
  );
  assert(
    notRequiredPairs.includes(["queues", "signal"].sort().join(",")),
    "allOf must contain { not: { required: ['queues', 'signal'] } }",
  );
});
