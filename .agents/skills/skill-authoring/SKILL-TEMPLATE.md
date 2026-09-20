---
name: <kebab-case-name, matches the folder name exactly>
description: <One or two sentences. Specific triggers and concrete nouns - "use when doing X, Y, or Z" - not vague language like "use for best practices." This field is the entire auto-trigger mechanism.>
---

# <Human-readable title>

<One paragraph: what recurring situation does this skill exist for, and why
did it need to exist as a skill rather than living in a contract file, an
ADR, or one task's notes? If you can't answer that in a sentence, re-check
`.agents/skills/skill-authoring/SKILL.md`'s "which mechanism fits" table
before continuing.>

## <Section — the actual checklist/rules>

- [ ] <Concrete, checkable rule. Not "write good code" - something a
      reviewer could actually check a box against.>
- [ ] <Cite a `docs/contracts/*.md` clause ID wherever this rule is
      RailFog-specific, e.g. "per `PLAT-16`" - never restate the clause from
      memory, point at it.>

## Non-goals

<What this skill deliberately does NOT cover, especially anything an
existing skill already owns - keeps skills from drifting into overlap over
time.>

## Worked example (if it clarifies more than the checklist alone)

<Optional. A short before/after or a minimal code snippet. Skip this section
entirely if the checklist is already unambiguous - don't pad.>
