# Milestone 0.4 — Reliability

Goal (roadmap.md): survive real failures — retries, rollback, health checks, provider-failure
handling, state backup, and usage accounting. Ensure that control-plane outages, transient network
partitions, third-party provider failures, and bad deployments do not compromise data-plane
availability or corrupt customer state.

## Dependency graph

Computed from each task's actual `Depends on`/`Blocks` fields, grouped into waves
for parallel execution:

```
Wave 1 (depends only on Milestone 0.1, 0.2, and 0.3 foundations):
  T-0401 (Decorrelated jitter retry engine)              — needs T-0102
  T-0402 (KV atomic circuit breaker library)             — needs T-0102, T-0104
  T-0403 (Data-plane usage accounting batch collector)   — needs T-0102
  T-0404 (State backup archive schema and validation)    — needs T-0102, T-0103

Wave 2:
  T-0405 (Deployment health check gating)                — needs T-0207
  T-0406 (Instant pointer-flip rollback & CLI command)   — needs T-0207, T-0210, T-0405
  T-0407 (Fail-static snapshot disk cache & recovery)    — needs T-0102, T-0208
  T-0408 (Queue consumer retry and backoff integration)  — needs T-0209, T-0401
  T-0409 (OpenTelemetry metrics exporter)                — needs T-0403

Wave 3:
  T-0410 (Provider resilient adapter & error normalizer) — needs T-0104, T-0105, T-0106,
                                                             T-0309, T-0401, T-0402
  T-0411 (State export and disaster recovery service)    — needs T-0104, T-0105, T-0106,
                                                             T-0207, T-0404

Wave 4 (closes the milestone):
  T-0412 (Reliability & fault injection test suite)      — needs T-0401, T-0402, T-0403,
                                                             T-0404, T-0405, T-0406,
                                                             T-0407, T-0408, T-0409,
                                                             T-0410, T-0411
```

Tasks within a wave have no dependency on each other and can be run through
`/implement-task` in any order — they only depend on tasks in earlier waves.

Each task is sized to one interface, one module, or one behavior — none
should produce a diff larger than a few hundred lines including tests.
If implementing one makes it obvious it is actually two, stop and split it
(`.agents/skills/atomic-task-decomposition/SKILL.md`) rather than pushing
through.

## Out of scope for the whole milestone

Multi-region active-active replication (PLAT-20), gradual canary deployments /
traffic splitting (banned per PLAT-3, PLAT-20), custom database engine / Raft consensus
subsystem (KV-3, PLAT-20), distributed multi-cluster tracing platforms (PLAT-20),
and synchronous control-plane calls on the data-plane hot path (banned per PLAT-1, PLAT-8).
Bare POST requests without an idempotency key are strictly excluded from automatic retries
(banned per Q-5).
