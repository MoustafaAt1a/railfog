---
name: anti-slop-code-quality
description: Use when writing or reviewing any code in this repository. Enforces concrete anti-slop rules — naming, comments, structure, error handling, completeness, diff hygiene — separate from and in addition to spec compliance.
---

# Anti-Slop Checklist

Full rules and rationale: `.agents/docs/ANTI-SLOP.md`. Condensed for active use:

- [ ] Names come from `docs/glossary.md` only — no invented synonyms, no
      `Manager`/`Helper`/`Utils` catch-alls.
- [ ] Every comment explains *why*, not *what* — cite a clause ID
      (`.agents/docs/ANTIHALLUCINATION.md` Rule 1) when the "why" is spec-driven.
- [ ] No commented-out code.
- [ ] No speculative generality — nothing built for a feature marked out of
      scope in `docs/contracts/platform.contract.md` PLAT-20.
- [ ] One abstraction level per function body.
- [ ] No magic numbers — every limit/timeout traces to a limits table in
      `docs/contracts/`.
- [ ] No copy-pasted logic across provider adapters — shared behavior lives
      in one place.
- [ ] Error handling uses only the ten codes in
      `docs/contracts/platform.contract.md` PLAT-12 — no ad hoc thrown
      strings, no silent swallowing.
- [ ] No secret value can reach a log, error, or trace, even via a
      stringified object.
- [ ] No `TODO`/`FIXME`/stub function body merged as done.
- [ ] No mock/fake data reachable from a production code path.
- [ ] No dead code — unused exports, unreferenced interfaces, leftover
      experiments are deleted before a task closes.
- [ ] One atomic task, one concern, one diff — if the summary needs "and,"
      it should have been two tasks
      (`.agents/skills/atomic-task-decomposition/SKILL.md`).
- [ ] Nothing outside the task's declared "In scope" list is touched.

Every box here is checked in addition to spec compliance
(`railfog-contract-lock` skill) — matching the contract and being
well-built are separate, both-required conditions.
