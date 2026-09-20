# Milestone 0.6 — Public Beta

Goal (roadmap.md): real users, real workloads, real cost data — stabilize.
Transition RailFog from developer experience and local/cloud parity to a hardened, two-process
production deployment topology (`railfog-control` and `railfog-runtime` per `PLAT-1`) capable of
serving live multi-tenant traffic under load, calculating accurate usage costs, enforcing token-bucket
rate limits, and proving fail-static availability during control-plane outages.

## Dependency graph

Computed from each task's actual `Depends on`/`Blocks` fields, grouped into waves
for parallel execution:

```
Wave 1 (depends on completed Milestones 0.1–0.5 foundations):
  T-0601 (Multi-tenant cost & metering engine)           — needs T-0403, T-0501
  T-0602 (Multi-tenant token bucket rate limiter)        — needs T-0102, T-0308
  T-0603 (Production container & process packaging)      — needs T-0110, T-0207

Wave 2 (Production Servers & Reporting):
  T-0604 (Ingress reverse proxy gateway server)          — needs T-0109, T-0602
  T-0605 (Standalone control plane daemon server)        — needs T-0207, T-0407, T-0411
  T-0606 (Standalone runtime data plane daemon server)   — needs T-0208, T-0301, T-0407, T-0508
  T-0607 (CLI usage and cost reporting subcommand)       — needs T-0506, T-0601

Wave 3 (Worker Supervisor, Draining & Load Testing):
  T-0608 (Production background worker supervisor)       — needs T-0209, T-0408, T-0606
  T-0609 (High-concurrency multi-tenant load harness)    — needs T-0604, T-0605, T-0606
  T-0610 (Graceful shutdown coordinator)                 — needs T-0604, T-0606

Wave 4 (Closes the milestone):
  T-0611 (Public beta chaos soak test)                   — needs T-0603, T-0604, T-0605, T-0606,
                                                             T-0607, T-0608, T-0609, T-0610
```

Tasks within a wave have no dependency on each other and can be run through
`/implement-task` in any order — they only depend on tasks in earlier waves.

Each task is sized to one interface, one module, or one behavior — none
should produce a diff larger than a few hundred lines including tests.
If implementing one makes it obvious it is actually two, stop and split it
(`.agents/skills/atomic-task-decomposition/SKILL.md`) rather than pushing
through.

## Out of scope for the whole milestone

Kubernetes, multi-region active-active replication (PLAT-20), custom database engine / Raft consensus
subsystem (KV-3, PLAT-20), gradual canary deployments / traffic-splitting (banned per PLAT-3, PLAT-20),
distributed multi-cluster tracing platforms (PLAT-20), secondary SDKs in other languages (PLAT-20),
web dashboards / graphical management consoles (PLAT-20), and third-party marketplace integrations (PLAT-20).
Synchronous control-plane calls on the data-plane hot path remain strictly banned (PLAT-1, PLAT-8).
