# Roadmap

Source: `railfog-v1_0_0-lts.md` §11.1. Each stage is a milestone folder under
`tasks/`. Only `milestone-0.1-runtime-prototype/` is decomposed in this
harness as a fully worked example — decompose each later milestone with
`/new-task <milestone>` once the prior milestone actually exists in the repo,
since correct task sizing depends on what's already built
(`.agents/skills/atomic-task-decomposition/SKILL.md`).

| Stage | Adds | Goal |
|---|---|---|
| **0.1 Runtime Prototype** | Deno runtime, Function loader, permissions, local KV/Objects/Queue, CLI | One developer runs an app locally |
| 0.2 Cloud Prototype | Deployment, remote KV/Objects/Queue | Deploy a real application |
| 0.3 Security | Sandboxing, resource limits, tenant isolation, secrets, network policy, security tests | Safely run untrusted workloads |
| 0.4 Reliability | Retries, rollback, health checks, provider-failure handling, backup, usage accounting | Survive real failures |
| 0.5 Developer Experience | CLI polish, TypeScript SDK, docs, local/cloud parity, deploy diagnostics | Fast, predictable iteration |
| 0.6 Public Beta | Real users, real workloads, real cost data | No major new features — stabilize |
| 0.7 Repo Consolidation | Standardized `@railfog/*` workspaces, centralized unit tests | Clean codebase layout and structure alignment |
| **0.75 Backing Services & Auth** | PostgreSQL persistence, Redis cache, persistent API key auth middleware | Connect Railway backing infrastructure and secure daemons |
| **0.8 Developer Experience & UX Polish** | Zero-copy callback auth, interactive TUI (spinners/prompts), universal 1-line installers | Railway/Vercel-tier frictionless developer experience |
| **1.0.0 LTS** | Full verification suite, leak elimination, payload limits, DOD route cache, param groups | API stable, runtime stable, security tested, rollback reliable, export works, docs complete |

## Dependency notes for decomposition

- 0.2 cannot start until 0.1's provider interfaces (KVProvider, ObjectProvider,
  QueueProvider, ComputeProvider — `docs/contracts/platform.contract.md`
  PLAT-16) exist, because 0.2 only adds new implementations of those same
  interfaces, not new interfaces.
- 0.3's security tasks assume the isolation boundary from 0.1/0.2 already
  separates the runtime process from the control plane process
  (`docs/contracts/platform.contract.md` PLAT-1) — if that separation was
  skipped earlier, open an ADR before starting 0.3, don't retrofit silently.
- Do not start 0.4 (reliability) tasks before 0.1's KV `atomic()` (CAS) exists
  — every reliability pattern in `docs/contracts/queues.contract.md` Q-6 is
  built on it.
