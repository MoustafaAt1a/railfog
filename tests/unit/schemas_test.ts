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
