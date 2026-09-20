# Milestone 0.3 — Security & Sandboxing

Goal (roadmap.md): safely run untrusted workloads — sandboxing, resource limits,
tenant isolation, secrets, network policy, and adversarial security tests. No
code path allows untrusted customer code to access host resources, break tenant
boundaries, or exfiltrate credentials.

## Dependency graph

Computed from each task's actual `Depends on`/`Blocks` fields, grouped into waves
for parallel execution:

```
Wave 1 (depends only on Milestone 0.1 / Milestone 0.2 completed foundations):
  T-0301 (ComputeProvider InvocationRequest interface extension)  — needs T-0201
  T-0302 (Token bucket rate limiter)                             — needs T-0102
  T-0303 (Egress IP connect-time CIDR blocker)                    — needs T-0102
  T-0305 (SecretStore interface & local encrypted store)         — needs T-0102
  T-0307 (Per-invocation operation counters & call-depth guard)  — needs T-0102, T-0108
  T-0308 (Resource kill enforcer & payload limits)               — needs T-0102, T-0108
  T-0309 (Storage provider tenant prefix defense-in-depth guard) — needs T-0104, T-0105, T-0106

Wave 2:
  T-0304 (HTTP egress proxy with allowlist enforcement)          — needs T-0102, T-0303
  T-0306 (Dynamic secret injection & log auto-redaction)         — needs T-0108, T-0305
  T-0312 (gVisor OCI isolation adapter)                          — needs T-0301

Wave 3:
  T-0310 (LocalIsolation provider with warm-isolate reuse)       — needs T-0301, T-0306, T-0307, T-0308
  T-0311 (ProcessIsolation provider with stdio IPC)              — needs T-0301, T-0304, T-0306, T-0307, T-0308

Wave 4 (closes the milestone):
  T-0313 (Comprehensive security & adversarial test suite)       — needs T-0301, T-0302, T-0303, T-0304,
                                                                    T-0305, T-0306, T-0307, T-0308,
                                                                    T-0309, T-0310, T-0311, T-0312
```

Tasks within a wave have no dependency on each other and can be implemented in
any order — they only depend on tasks in earlier waves.

Each task is sized to one interface, one module, or one behavior — none should
produce a diff larger than a few hundred lines including tests.

## Out of scope for the whole milestone

Distributed multi-node rate limiting (PLAT-8, PLAT-9 — data-plane local token
bucket only), cloud KMS remote integrations (AWS KMS / HashiCorp Vault —
Milestone 0.4/0.6), circuit breakers and automatic retry handling (Milestone 0.4
Reliability), deployment rollback health checking and backup recovery (Milestone
0.4), usage accounting metrics export (Milestone 0.4), and gradual canary /
traffic-splitting (PLAT-3 — deliberate 1.1+ deferral per PLAT-20).
