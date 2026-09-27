# Milestone 0.9.1 — Unified Four-Primitives & SDK Specification

Goal: Formalize RailFog's developer-facing conceptual layer (Compute, State, Data, Signal), lock the concepts contract with traceable clause IDs, and align the TypeScript SDK, configuration schema, artifact packaging, CLI tooling, and permission policy without breaking existing Function, KV, Object, and Queue implementations.

## Dependency graph

```
Wave 1 (Contract & ADR Foundation):
  T-0911 (Formalize Concepts Contract)
  T-0912 (ADR-0005 Unified Four Primitives)

Wave 2 (Configuration, Policy & Packaging — depends on T-0911, T-0912):
  T-0913 (Schema Permissive Capability Aliases)
  T-0914 (Policy Permission Resolver Alias Normalization)
  T-0918 (Artifact Packager Capability Normalization)

Wave 3 (CLI Validation & SDK Ergonomics — depends on T-0911, T-0913, T-0914):
  T-0915 (SDK Conceptual Type Aliases)
  T-0916 (SDK Handler Context Conceptual Bindings)
  T-0919 (CLI Check Conceptual Capability Validation)

Wave 4 (CLI Scaffolding, Deploy Scoping & Docs — depends on T-0915, T-0916, T-0918, T-0919):
  T-0920 (CLI Deploy Capability Alias Scoping)
  T-0921 (CLI Init Conceptual Template Scaffolding)
  T-0922 (Docs SDK Overview Conceptual Alignment)

Wave 5 (Milestone Closure & Verification — depends on Waves 1-4):
  T-0917 (Milestone 0.9.1 Composition Verification Suite)
```

## Task Index

- `T-0911`: Formalize Concepts Contract (`docs/contracts/concepts.contract.md` + `docs/glossary.md`)
- `T-0912`: Author ADR-0005 (`docs/adr/ADR-0005-unified-four-primitives.md`)
- `T-0913`: Add Permissive Capability Aliases to Configuration Schema (`schemas/railfog.schema.json`)
- `T-0914`: Normalize Capability Aliases in Permission Resolver (`packages/policy/permission-resolver.ts`)
- `T-0915`: Export Canonical Conceptual Type Aliases in SDK (`sdk/typescript/types.ts`, `sdk/typescript/mod.ts`)
- `T-0916`: Expose Conceptual Bindings on SDK Handler Context (`sdk/typescript/wrapper.ts`)
- `T-0918`: Normalize Capability Aliases in Artifact Packager (`packages/core/artifact/packager.ts`)
- `T-0919`: Validate Conceptual Capability Declarations in CLI Check (`cli/check.ts`)
- `T-0920`: Scope Conceptual Capability Aliases in CLI Deploy (`cli/deploy.ts`)
- `T-0921`: Add Conceptual Primitives to CLI Init Starter Templates (`cli/init.ts`)
- `T-0922`: Align SDK Overview Documentation with Four Primitives (`docs/sdk/overview.md`)
- `T-0917`: Implement Milestone 0.9.1 Composition Verification Suite (`tests/unit/milestone_091_concepts_test.ts`)

## Out of scope for the whole milestone

Rewriting the Deno runtime core, rewriting or replacing existing provider adapters (`primitives/kv`, `primitives/objects`, `primitives/queues`, `primitives/compute`), altering the physical IPC protocol (`apps/runtime`), breaking existing `railfog.toml` configurations, or introducing distributed graph execution engines.
