# Milestone 0.5 — Developer Experience

Goal (roadmap.md): fast, predictable iteration — CLI polish, TypeScript SDK, documentation, local/cloud parity verification, and deploy diagnostics. Provide an ergonomic, type-safe developer journey from initial project scaffolding (`rail init`) through local development (`rail dev`), static verification (`rail check`), secrets management (`rail secrets`), deployment with diagnostics (`rail deploy`), log streaming (`rail logs`), and instant rollback (`rail rollback`).

## Dependency graph

Computed from each task's actual `Depends on`/`Blocks` fields, grouped into waves for parallel execution:

```
Wave 1 (depends only on Milestones 0.1–0.4 completed foundations):
  T-0501 (TypeScript SDK types & handler interfaces)    — needs T-0102, T-0108
  T-0504 (CLI static configuration validator)           — needs T-0102, T-0107, T-0109
  T-0506 (CLI secrets management subcommands)           — needs T-0110, T-0305

Wave 2:
  T-0502 (TypeScript SDK client bindings & error map)   — needs T-0501
  T-0503 (CLI init and project scaffolding)             — needs T-0110, T-0501, T-0504
  T-0505 (Pre-deploy diagnostics analyzer)              — needs T-0207, T-0504
  T-0507 (CLI structured log viewer & stream)           — needs T-0110, T-0306
  T-0508 (Local dev server live reload & diagnostics)   — needs T-0111, T-0504

Wave 3:
  T-0509 (Local/cloud parity test harness)              — needs T-0111, T-0211, T-0502
  T-0510 (Developer documentation & config schema)      — needs T-0501, T-0502, T-0503, T-0504

Wave 4 (closes the milestone):
  T-0511 (Developer experience end-to-end test suite)   — needs T-0502, T-0503, T-0504,
                                                            T-0505, T-0506, T-0507,
                                                            T-0508, T-0509, T-0510
```

Tasks within a wave have no dependency on each other and can be run through `/implement-task` in any order — they only depend on tasks in earlier waves.

Each task is sized to one interface, one module, or one behavior — none should produce a diff larger than a few hundred lines including tests. If implementing one makes it obvious it is actually two, stop and split it (`.agents/skills/atomic-task-decomposition/SKILL.md`) rather than pushing through.

## Out of scope for the whole milestone

Public beta infrastructure (Milestone 0.6), multi-region active-active deployment (PLAT-20), custom database engine / Raft consensus (KV-3, PLAT-20), gradual canary / traffic-splitting (banned per PLAT-3, PLAT-20), secondary SDKs in other languages (PLAT-20 specifies single TypeScript SDK for 1.0.0), web dashboards / graphical portals (PLAT-20), and third-party marketplace integrations (PLAT-20).
