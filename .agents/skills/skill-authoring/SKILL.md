---
name: skill-authoring
description: Use whenever a recurring pattern, convention, or repeated correction shows up across two or more tasks or reviews and isn't covered by any existing skill in .agents/skills/. Also use before creating a new skill, to check it doesn't duplicate or overlap one that already exists. Drafts new skills in the repo's exact SKILL.md format.
---

# Skill Authoring

This harness ships with 8 seed skills. It isn't meant to stay at 8 — as the
build reaches domains the seed skills don't cover (a real Postgres
control-plane schema in 0.2, a specific provider's quirks, a testing pattern
that keeps getting reinvented), any agent should be able to notice that and
turn it into a ninth, tenth, eleventh skill, in the same format, discoverable
the same way. This skill is how that happens without producing a pile of
inconsistent, overlapping, or low-quality skill files.

## First: which of the three mechanisms actually fits?

This harness has three places new knowledge can go, and picking the wrong
one is the most common mistake. Before drafting a skill, check the other two
aren't the actual right home:

| Mechanism | Answers | Example |
|---|---|---|
| `docs/contracts/*.md` | **What** is RailFog's own behavior — a fact, default, or algorithm | "KV `atomic()` uses CAS" |
| `docs/adr/` | **Why** a decision was made where the contract was silent | "Why we picked SQLite over Postgres for local dev queues" |
| `.agents/skills/` | **How** to act correctly in a recurring situation — a process, checklist, or convention | "How to structure a provider adapter's tests" |

If what you noticed is a fact about RailFog's own API surface, it's a
contract addition (route it to `architect`, cite it with a new/updated
clause ID). If it's a one-time design call, it's an ADR. Only genuinely
recurring **process** knowledge — the kind that saves the next task from
making the same mistake or re-deriving the same checklist — is a skill.

## Signals a new skill is actually warranted

- The same correction has come up in **two or more** separate tasks' review
  findings (`reviewer` or `security-auditor` flagged the same class of
  mistake more than once).
- A new technical domain has entered the build (a real database, a specific
  cloud provider's SDK, a new file format) that none of the existing 8+
  skills' descriptions cover.
- A pattern is genuinely reusable across many future tasks, not specific to
  one module.

## Signals it's not warranted — do this instead

- **It's a single task's implementation detail that won't recur** — put it
  in that task's Assumptions section, not a skill.
- **An existing skill already covers this, just not explicitly** — extend
  that skill's file instead of creating a near-duplicate. (Before drafting
  anything, read every `description:` field under `.agents/skills/*/SKILL.md`
  — if two skills would trigger on overlapping situations, merge them.)
- **It's actually a spec fact** — that's a contract clause, not a skill; see
  the table above.
- **It's vague philosophy with no concrete checklist** — every existing skill
  in this repo has an actionable checklist or concrete rule set, not just
  restated principle. If a draft skill reads like prose with no checklist,
  it isn't done yet.

## How to draft one

1. Confirm the name doesn't collide and the topic doesn't overlap an
   existing skill (previous section).
2. Copy `SKILL-TEMPLATE.md` (in this same folder) to
   `.agents/skills/<kebab-case-name>/SKILL.md`.
3. Write the `description:` field first, and write it like the other 8 —
   specific triggers, concrete nouns, no vague language. This field is the
   entire auto-trigger mechanism; a vague description means the skill
   silently never fires. Compare against
   `.agents/skills/provider-abstraction-pattern/SKILL.md`'s description as
   the bar to match.
4. Write the body as a concrete checklist or rule set, not narrative
   philosophy. Cite `docs/contracts/` clause IDs wherever the rule is
   RailFog-specific (`docs/ANTIHALLUCINATION.md` Rule 1 applies to skills
   too — a skill is code that shapes code, and it's wrong just as easily).
5. State explicit non-goals — what this skill does *not* cover — so it
   doesn't quietly grow into overlapping neighboring skills over time.

## Approval and registration — do not skip this

A skill isn't "live" just because the file exists. Any agent may **draft**
one, but `architect` is the only agent that finalizes and registers it,
because a bad or redundant skill compounds across every future task that
triggers it — the same reason design decisions route through `architect`
rather than getting made inline. Hand the draft to `architect`, which checks:

- No overlap with an existing skill (merge instead, if there is).
- No contradiction with `docs/CONSTITUTION.md`, `docs/ANTI-SLOP.md`,
  `docs/ANTIHALLUCINATION.md`, or any `docs/contracts/*.md` file.
- The description is specific enough to trigger correctly.
- The body is a concrete checklist, not restated philosophy.

Once approved, `architect` (or whoever it delegates the mechanical step to)
must add one line to **both**:

- `AGENTS.md` §9 (skills index)
- `.agents/README.md`'s skills table

A skill that exists on disk but isn't in both indexes is a registration gap
— `AGENTS.md`'s whole point is being readable without relying on dynamic
skill search, and that promise breaks quietly if the index goes stale.

## Definition of Done for a new skill

- [ ] Checked against every existing skill's description for overlap — none found, or an existing skill was extended instead
- [ ] `description:` field is specific (matches the style of the existing 8, not vague)
- [ ] Body is a concrete checklist/rule set, cites contract clause IDs where RailFog-specific
- [ ] Explicit non-goals stated
- [ ] `architect` reviewed and approved
- [ ] Registered in both `AGENTS.md` §9 and `.agents/README.md`
