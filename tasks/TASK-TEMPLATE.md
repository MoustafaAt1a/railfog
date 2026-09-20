# T-XXXX — <imperative, one-behavior title>

Status: Not started  <!-- Not started | In progress | Blocked | In review | Done -->
Milestone: <e.g. 0.1 Runtime Prototype>
Depends on: <task IDs, or "none">
Blocks: <task IDs this unblocks, or "none">

## Spec references

Clause IDs only, no prose paraphrase here — the contract file is the source,
this is a pointer to it: `FN-4`, `KV-3`, ...

## Scope

**In scope** (be exact — file/module/interface level, not a feature area):
-

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
-

## Interface to implement

Exact signature(s). If none yet exist, this task probably *is* "define the
interface" and a separate task implements it — see
`.agents/skills/atomic-task-decomposition/SKILL.md`.

```typescript

```

## Acceptance criteria (Given/When/Then)

1. Given ..., when ..., then ...
2.

## Tests required

- [ ] Unit —
- [ ] Integration —
- [ ] Security — (only if this task touches PLAT-4, PLAT-5, PLAT-6, PLAT-7, PLAT-15, FN-6, or FN-7)

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly
- [ ] Spec-anchor comments present at each RailFog-specific decision point
- [ ] Unit tests written first (red), then implementation (green)
- [ ] `deno check` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all required tests passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Reviewer pass complete; security-auditor pass complete if triggered
- [ ] Nothing outside "In scope" touched

## Assumptions made

<"None" is valid. A missing section is not.>
