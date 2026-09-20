# Milestone 0.7 — Repo Consolidation, Structure Alignment, and Test Centralization

Goal (roadmap.md & PLAT-19): Consolidate repository structure, establish standardized `@railfog/*` workspace import maps, extract foundational packages (`config`, `api`, `auth`, `testing`), unify primitive definitions (`primitives/functions`), complete provider and runtime boundaries (`providers/compute`, `runtime/api`), centralize scattered unit tests under `tests/unit/`, remove placeholder `.gitkeep` files from populated directories, and establish full workspace structural verification.

## Dependency graph

Computed from each task's actual `Depends on`/`Blocks` fields, grouped into waves for parallel execution:

```
Wave 1 (Configuration & Core Packages):
  T-0701 (Root configuration and workspace import map)   — needs none
  T-0702 (Configuration package extraction)              — needs T-0701
  T-0703 (Shared API contracts and DTOs)                 — needs T-0701
  T-0704 (Authentication and identity context)           — needs T-0701

Wave 2 (Primitives & Execution Boundaries):
  T-0705 (Functions primitive definitions)               — needs T-0701
  T-0706 (Deno compute provider adapter)                 — needs T-0701
  T-0707 (Runtime API execution boundary)                — needs T-0701, T-0703, T-0704, T-0705

Wave 3 (Shared Testing & Reusable Harness):
  T-0708 (Reusable test harness package)                 — needs T-0701, T-0702, T-0703, T-0704,
                                                                   T-0705, T-0706, T-0707

Wave 4 (Test Centralization & Clean Up):
  T-0709 (Centralize unit tests and clean directories)   — needs T-0701, T-0702, T-0703, T-0704,
                                                                   T-0705, T-0706, T-0707, T-0708

Wave 5 (Full Verification & Audit):
  T-0710 (Milestone 0.7 verification & integrity audit)  — needs T-0701, T-0702, T-0703, T-0704,
                                                                   T-0705, T-0706, T-0707, T-0708,
                                                                   T-0709
```

Tasks within a wave have no dependency on each other and can be implemented in parallel. They only depend on tasks from earlier waves.

Each task is sized to one interface, one module, or one behavior — none should produce a diff larger than a few hundred lines including tests.

## Out of scope for the whole milestone

- Modifying contract files under `docs/contracts/` (contracts are spec-locked).
- Adding prohibited features from `PLAT-20` (Kubernetes, multi-region active-active, custom database engine, AI features, service mesh, complex UI dashboards, external OAuth providers).
- Changing business logic, assertion semantics, or runtime execution behavior of existing tested components.
- Collapsing the two-process deployment topology (`railfog-control` and `railfog-runtime` per `PLAT-1`).
- Introducing synchronous control-plane calls on the data-plane hot path (strictly banned per `PLAT-1`, `PLAT-8`).
