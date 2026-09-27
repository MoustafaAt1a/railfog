// spec: contracts/concepts.contract.md#CONCEPT-1 — Four Fundamental Concepts
// spec: contracts/concepts.contract.md#CONCEPT-2 — Two-Layer Taxonomy
// spec: contracts/platform.contract.md#PLAT-2 — Core Architecture Reduction
// spec: contracts/platform.contract.md#PLAT-6 — Capability Injection
// spec: docs/adr/template.md — Architecture Decision Record Template
// spec: tasks/milestone-0.9.1-unified-four-primitives/T-0912-adr-unified-four-primitives.md

import { assert } from "@std/assert";
import { join } from "@std/path";

Deno.test("T-0912 / ADR-0005: ADR-0005 file exists and satisfies ADR template sections", async () => {
  const adrPath = join(
    Deno.cwd(),
    "docs",
    "adr",
    "ADR-0005-unified-four-primitives.md",
  );
  let content = "";
  try {
    content = await Deno.readTextFile(adrPath);
  } catch (err) {
    assert(
      false,
      `docs/adr/ADR-0005-unified-four-primitives.md must exist on disk: ${err}`,
    );
  }

  // Header and metadata
  assert(
    content.includes("# ADR-0005"),
    "ADR must contain '# ADR-0005' heading",
  );
  assert(
    content.includes("Status: Accepted"),
    "ADR status must be 'Accepted'",
  );
  assert(content.includes("Raised by:"), "ADR must define 'Raised by:'");

  // Required sections from docs/adr/template.md
  const requiredSections = [
    "## Context",
    "## Decision",
    "## Alternatives considered",
    "## Consequences",
    "## Spec references",
  ];

  for (const sec of requiredSections) {
    assert(
      content.includes(sec),
      `ADR must contain section '${sec}' per docs/adr/template.md`,
    );
  }

  // Content requirements per T-0912 acceptance criteria
  assert(
    content.includes("Compute") && content.includes("State") &&
      content.includes("Data") && content.includes("Signal"),
    "Decision must establish the four concepts: Compute, State, Data, Signal",
  );

  assert(
    content.includes("AbortSignal") && content.includes("req.signal"),
    "ADR must resolve AbortSignal vs Signal naming collision",
  );

  assert(
    content.includes("non-breaking") || content.includes("additive"),
    "ADR must explicitly protect existing APIs as additive / non-breaking",
  );

  assert(
    content.includes("CONCEPT-1"),
    "Spec references must cite CONCEPT-1..8",
  );
});
