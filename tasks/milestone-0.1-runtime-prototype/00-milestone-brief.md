# Milestone 0.1 — Runtime Prototype

Goal (roadmap.md): one developer runs an application locally — Deno runtime,
Function loader, permissions, local KV/Objects/Queue, CLI skeleton. No cloud
provider, no security hardening beyond what capability injection gives for
free, no deployment pipeline. Those are 0.2/0.3.

## Dependency graph

Computed from each task's actual `Depends on`/`Blocks` fields, not hand-drawn
— grouped into waves so it also tells you what can run in parallel. Verify
this against the task files themselves if either ever changes; a stale graph
next to precise per-task fields is worse than no graph.

```
Wave 1 (no dependencies):
  T-0101 (scaffold)

Wave 2 (depends only on T-0101):
  T-0102 (error taxonomy)   T-0103 (ULID)   T-0109 (routing)

Wave 3 (depends on T-0101 + T-0102 + T-0103):
  T-0104 (KVProvider)   T-0105 (ObjectProvider)   T-0106 (QueueProvider)

Wave 4:
  T-0107 (capability injection)  — needs T-0102, T-0104, T-0105, T-0106

Wave 5:
  T-0108 (RailFogContext + loader)  — needs T-0102, T-0103, T-0107

Wave 6:
  T-0110 (rail CLI skeleton)  — needs T-0101, T-0108

Wave 7 (closes the milestone):
  T-0111 (rail dev local server)  — needs T-0104, T-0105, T-0106, T-0107,
                                      T-0108, T-0109, T-0110
```

Tasks within a wave have no dependency on each other and can be run through
`/implement-task` in any order (or in parallel, if your setup supports
running more than one at once) — they only depend on tasks in earlier waves.

Each task is sized to one interface, one module, or one behavior — none
should produce a diff larger than a few hundred lines including tests.
If implementing one makes it obvious it's actually two, stop and split it
(`.agents/skills/atomic-task-decomposition/SKILL.md`) rather than pushing
through.

## Out of scope for the whole milestone

Remote providers (Cloudflare/R2/Deno Deploy), the deployment pipeline
(`docs/contracts/platform.contract.md` PLAT-3), microVM isolation (PLAT-4 —
`LocalIsolation` only this milestone), rate limiting (PLAT-9), SSRF network
policy (PLAT-5), secrets (PLAT-15). All isolation/network/secrets hardening beyond what's listed above is 0.3/0.4.
