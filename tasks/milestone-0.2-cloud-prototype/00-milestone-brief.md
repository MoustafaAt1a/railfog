# Milestone 0.2 — Cloud Prototype

Goal (roadmap.md): deploy a real application — deployment pipeline, remote
KV/Objects/Queue providers, control/data plane process separation, fail-static
snapshot distribution, queue trigger consumer worker, and CLI `rail deploy`.

## Dependency graph

Computed from each task's actual `Depends on`/`Blocks` fields:

```
Wave 1 (depends only on Milestone 0.1):
  T-0201 (ComputeProvider interface)
  T-0202 (Artifact packaging)
  T-0203 (R2 object provider)
  T-0204 (Deno Deploy KV provider)
  T-0205 (Cloudflare KV provider)
  T-0206 (Cloudflare Queue provider)

Wave 2:
  T-0207 (Control plane deployment pipeline)  — needs T-0202, T-0203
  T-0209 (Queue trigger consumer worker)      — needs T-0108, T-0206

Wave 3:
  T-0208 (Fail-static snapshot distribution)  — needs T-0207
  T-0210 (CLI rail deploy command)            — needs T-0202, T-0207

Wave 4 (closes the milestone):
  T-0211 (Cloud prototype end-to-end flow)    — needs T-0201, T-0203, T-0204,
                                                  T-0205, T-0206, T-0207,
                                                  T-0208, T-0209, T-0210
```

Tasks within a wave have no dependency on each other and can be run through
`/implement-task` in any order — they only depend on tasks in earlier waves.

Each task is sized to one interface, one module, or one behavior — none
should produce a diff larger than a few hundred lines including tests.

## Out of scope for the whole milestone

MicroVM and container sandboxing (`gVisor`/`Firecracker` isolation — Milestone 0.3),
SSRF network proxy and mandatory IP blocking (`docs/contracts/platform.contract.md`
PLAT-5 — 0.3), secrets store and injection (PLAT-15 — 0.3), rate limiting token
bucket (PLAT-9 — 0.3), circuit breakers, automatic retries and backup
accounting (Milestone 0.4), and gradual canary/traffic-splitting (PLAT-3 —
deliberate 1.1+ deferral per PLAT-20).
