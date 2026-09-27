// spec: contracts/concepts.contract.md#CONCEPT-1 — Four Fundamental Concepts
// spec: contracts/concepts.contract.md#CONCEPT-2 — Two-Layer Taxonomy
// spec: contracts/concepts.contract.md#CONCEPT-3 — Four Fundamental Verbs
// spec: contracts/concepts.contract.md#CONCEPT-4 — Composition-First Principle & Primitive Addition Test
// spec: contracts/concepts.contract.md#CONCEPT-5 — Semantic Honesty
// spec: contracts/concepts.contract.md#CONCEPT-6 — Conceptual Capability Scoping
// spec: contracts/concepts.contract.md#CONCEPT-7 — Data by Reference
// spec: contracts/concepts.contract.md#CONCEPT-8 — Anti-Framework Boundary
// spec: tasks/milestone-0.9.1-unified-four-primitives/T-0911-formalize-concepts-contract.md

import { assert } from "@std/assert";
import { join } from "@std/path";

Deno.test("T-0911 / CONCEPT-1..8: concepts.contract.md exists and defines all 8 formal clauses", async () => {
  const contractPath = join(Deno.cwd(), "docs", "contracts", "concepts.contract.md");
  let content = "";
  try {
    content = await Deno.readTextFile(contractPath);
  } catch (err) {
    assert(false, `docs/contracts/concepts.contract.md must exist on disk: ${err}`);
  }

  // Verify all 8 clauses exist as markdown headers
  const requiredClauses = [
    "CONCEPT-1",
    "CONCEPT-2",
    "CONCEPT-3",
    "CONCEPT-4",
    "CONCEPT-5",
    "CONCEPT-6",
    "CONCEPT-7",
    "CONCEPT-8",
  ];

  for (const clause of requiredClauses) {
    assert(
      content.includes(`## ${clause}`),
      `docs/contracts/concepts.contract.md must define clause header '## ${clause}'`,
    );
  }

  // Verify core definitions
  assert(content.includes("Compute"), "CONCEPT-1 must define Compute");
  assert(content.includes("State"), "CONCEPT-1 must define State");
  assert(content.includes("Data"), "CONCEPT-1 must define Data");
  assert(content.includes("Signal"), "CONCEPT-1 must define Signal");

  // Verify mapping in CONCEPT-2
  assert(content.includes("Function"), "CONCEPT-2 must map Compute to Function");
  assert(content.includes("KV"), "CONCEPT-2 must map State to KV");
  assert(content.includes("Object"), "CONCEPT-2 must map Data to Object");
  assert(content.includes("Queue"), "CONCEPT-2 must map Signal to Queue");

  // Verify fundamental verbs in CONCEPT-3
  assert(content.includes("transform"), "CONCEPT-3 must define verb transform");
  assert(content.includes("remember"), "CONCEPT-3 must define verb remember");
  assert(content.includes("persist"), "CONCEPT-3 must define verb persist");
  assert(content.includes("communicate"), "CONCEPT-3 must define verb communicate");
});

Deno.test("T-0911 / Glossary: docs/glossary.md defines Compute, State, Data, Signal as canonical nouns", async () => {
  const glossaryPath = join(Deno.cwd(), "docs", "glossary.md");
  const content = await Deno.readTextFile(glossaryPath);

  // Check developer concept terms in glossary table
  assert(
    content.includes("**Compute**"),
    "docs/glossary.md must define canonical noun '**Compute**'",
  );
  assert(
    content.includes("**State**"),
    "docs/glossary.md must define canonical noun '**State**'",
  );
  assert(
    content.includes("**Data**"),
    "docs/glossary.md must define canonical noun '**Data**'",
  );
  assert(
    content.includes("**Signal**"),
    "docs/glossary.md must define canonical noun '**Signal**'",
  );

  // Check that definitions reference the infrastructure primitives
  assert(
    content.includes("Function") && content.includes("developer-facing concept for execution"),
    "docs/glossary.md Compute definition must map to Function",
  );
  assert(
    content.includes("**KV**") && content.includes("small, addressable, mutable state"),
    "docs/glossary.md State definition must map to KV",
  );
  assert(
    content.includes("**Object**") && content.includes("durable or bulk persistence"),
    "docs/glossary.md Data definition must map to Object",
  );
  assert(
    content.includes("**Queue**") && content.includes("asynchronous communication"),
    "docs/glossary.md Signal definition must map to Queue",
  );
});

Deno.test("T-0911 / Spec-Lock: docs/contracts/platform.contract.md reference to CONCEPT-1 resolves", async () => {
  const platformPath = join(Deno.cwd(), "docs", "contracts", "platform.contract.md");
  const platformContent = await Deno.readTextFile(platformPath);

  assert(
    platformContent.includes("concepts.contract.md") && platformContent.includes("CONCEPT-1"),
    "docs/contracts/platform.contract.md must cite concepts.contract.md CONCEPT-1",
  );
});
