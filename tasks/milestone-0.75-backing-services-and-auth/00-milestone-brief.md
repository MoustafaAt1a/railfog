# Milestone 0.75 — Backing Services (PostgreSQL, Redis), API Key Authentication, and CLI Login

Goal (`roadmap.md`, `PLAT-1`, `PLAT-6`, `PLAT-9`, `PLAT-12`, `PLAT-15`, `PLAT-16`, `PLAT-17`, `KV-1`..`KV-5`):
Implement production backing service providers for Redis caching (`REDIS_URL`) and PostgreSQL transactional persistence (`DATABASE_URL`), implement persistent API key storage and verification with Redis caching, attach API key authentication middleware to `railfog-control` and `railfog-runtime` daemons, provide a web-based login and API key issuance UI on the control plane (`GET /login`), implement an interactive CLI login workflow (`rail login` -> browser -> copy/paste -> local persistence -> authenticated CLI commands), and wire environment-based provider resolution so that Railway production deployments run with live database, caching, and API key protection while preserving local development parity (`PLAT-17`).

## Dependency graph

Computed from each task's actual `Depends on`/`Blocks` fields, grouped into waves for parallel execution:

```
Wave 1 (Backing Service KV Providers):
  T-0751 (Redis KV and cache provider)                           — needs none
  T-0752 (PostgreSQL KV provider with transactional CAS)         — needs none

Wave 2 (Authentication Storage & Security):
  T-0753 (Persistent API key store with Redis caching)          — needs T-0751, T-0752

Wave 3 (Authentication Middleware):
  T-0754 (API key authentication middleware for daemons)        — needs T-0753

Wave 4 (Daemon Resolution & Production Wiring):
  T-0755 (Wire backing services to control and runtime daemons)  — needs T-0751, T-0752, T-0753, T-0754

Wave 5 (Web Login & CLI Authentication Flow):
  T-0756 (Control plane web login page and API key issuance UI) — needs T-0753, T-0754, T-0755
  T-0757 (CLI interactive login flow and credential management) — needs T-0756

Wave 6 (Full Verification & Security Audit):
  T-0758 (Milestone 0.75 verification and integrity audit)       — needs T-0751, T-0752, T-0753, T-0754,
                                                                   T-0755, T-0756, T-0757
```

Tasks within a wave have no dependency on each other and can be implemented in parallel. They only depend on tasks from earlier waves.

Each task is sized to one interface, one module, or one behavior — none should produce a diff larger than a few hundred lines including tests.

## Out of scope for the whole milestone

- Modifying contract files under `docs/contracts/` (contracts are spec-locked).
- Adding prohibited features from `PLAT-20` (Kubernetes, multi-region active-active, custom database engine, AI features, service mesh, complex UI dashboards, external OAuth providers).
- Changing the two-process deployment topology (`railfog-control` and `railfog-runtime` per `PLAT-1`).
- Introducing synchronous control-plane calls on the data-plane live traffic path (`PLAT-1`, `PLAT-8`).
- Breaking local development zero-dependency experience (`rail dev` must continue to work with SQLite/in-memory fallback per `PLAT-17`).
