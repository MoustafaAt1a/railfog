---
name: railfog-contract-lock
description: Use whenever generating, reviewing, or discussing code, config, or design for the RailFog platform itself (Functions, KV, Objects, Queues, runtime, providers, CLI). Enforces that every RailFog-specific detail traces to docs/contracts/, never to memory or plausibility.
---

# RailFog Contract Lock

`docs/contracts/*.md` is the only source of truth for RailFog's own API
surface, config keys, error codes, limits, and algorithms. This skill exists
because the spec's own history proves the failure mode is real: the original
draft named mechanisms ("permissions," "rate limiting," "idempotent
consumer") without algorithms behind them, and an audited revision
(`railfog-v1_0_0-lts.md`) found 15 concrete bugs as a result — see
`.agents/docs/00-deep-analysis.md` §1 for the full list. An LLM filling in an
underspecified mechanism from plausibility defaults to the exact same
failure mode.

## The rule

Every RailFog-specific method signature, config key, error code, limit
default, or algorithm must trace to a clause ID (e.g. `KV-3`, `FN-7`,
`PLAT-12`) in `docs/contracts/`. Cite it inline:

```typescript
// spec: contracts/queues.contract.md#Q-3 — visibility timeout + max_receives → DLQ
```

If you can't name a clause ID, don't write the detail — go check
`docs/contracts/` first. If nothing's there, it's either a free
implementation choice (say so explicitly, don't imply it's spec) or a gap for
an ADR (`docs/adr/template.md`).

## Banned patterns (never implement, never approve)

Pulled from every contract file's own "Banned patterns" section — the full,
current list always lives there, not duplicated stale here. Check:
`docs/contracts/kv.contract.md`, `queues.contract.md`, `objects.contract.md`,
`platform.contract.md` — each has one at the bottom.

## Self-check before writing or approving anything

- Does every RailFog-specific detail here trace to a clause ID?
- Am I resurrecting anything from a "Banned patterns" list?
- Am I stating a third-party provider's guarantee I haven't verified against
  `platform.contract.md` PLAT-16?

Full protocol: `.agents/docs/ANTIHALLUCINATION.md`.
