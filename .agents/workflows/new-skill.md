---
name: new-skill
description: Draft, review, and register a new skill when a recurring pattern isn't covered by any existing one.
---

Usage: `/new-skill <short topic description>`

Example: `/new-skill control-plane Postgres schema conventions`

## Steps

1. Whichever agent noticed the gap drafts the skill following
   `.agents/skills/skill-authoring/SKILL.md` — including its "which
   mechanism actually fits" check (contract vs. ADR vs. skill) and its
   duplication check against every existing skill's `description:` field.
2. Hand the draft to `architect` for review: overlap check, contradiction
   check against `docs/CONSTITUTION.md` / `docs/ANTI-SLOP.md` /
   `docs/ANTIHALLUCINATION.md` / any contract file, description-quality
   check.
3. On approval, `architect` writes `.agents/skills/<kebab-case-name>/SKILL.md`
   (using `.agents/skills/skill-authoring/SKILL-TEMPLATE.md` as the shape)
   and registers it in both `AGENTS.md` §9 and `.agents/README.md`'s skills
   table — both, not one.
4. Report the new skill's name and description back, so it's visible it now
   exists rather than only discoverable by chance auto-trigger.

## Do not

- Create the skill file before architect approval, even if the drafting
  agent has write access — the approval gate exists specifically because a
  bad or duplicate skill compounds across every future task it triggers on.
- Register a skill in only one of the two index files — a skill missing from
  either is a registration gap (`.agents/skills/skill-authoring/SKILL.md`).
- Use this for a one-off detail that won't recur — see the "signals it's not
  warranted" list in `.agents/skills/skill-authoring/SKILL.md` first.
