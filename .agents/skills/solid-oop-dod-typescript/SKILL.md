---
name: solid-oop-dod-typescript
description: Use when writing or reviewing any TypeScript module in this repository, especially anything under runtime/, providers/, primitives/, or packages/. Applies the SOLID+OOP-at-boundaries, DOD-in-hot-paths rule.
---

# SOLID + OOP + Data-Oriented Design

Full reasoning and worked examples: `docs/CONSTITUTION.md`. This is the
condensed checklist for use while writing or reviewing code.

## First question: which zone is this file in?

| If the file is under... | Use |
|---|---|
| `providers/*`, `primitives/*` (public interface shape), `packages/policy`, `packages/auth`, control-plane services | OOP + SOLID |
| `runtime/loader`, `runtime/limits`, request routing, metrics/usage-event batching, log serialization — anything on the per-request hot path | DOD |

## If OOP + SOLID zone — checklist

- [ ] **S**: does this class/module have exactly one reason to change?
- [ ] **O**: can a new Provider be added without editing an existing one?
- [ ] **L**: does every implementation of this interface honor the *same*
      guarantee the interface name implies (see
      `.agents/skills/provider-abstraction-pattern/SKILL.md`)?
- [ ] **I**: does the exposed surface contain only what the caller is
      permitted to use — no fat "does everything" object?
- [ ] **D**: does this module depend on an interface defined in
      `primitives/`, never on a concrete provider from `providers/` directly?

## If DOD zone — checklist

- [ ] Is state modeled as plain data (a typed record/struct), not a class
      hierarchy with behavior attached?
- [ ] Does anything here allocate per-request that could instead be a
      pre-sized buffer or batch, matching how the spec itself batches metrics
      and logs?
- [ ] Is there any virtual dispatch (interface call, strategy object) in this
      hot path that isn't actually swapped at runtime? If so, it's ceremony —
      inline it.
- [ ] Is the *shape* of the data still defined once, as a type, even though
      behavior is free functions? (Shared shape is fine in DOD; shared
      behavior via inheritance is not.)

## Violating either direction is a finding, not a style note

DOD leaking into a Provider interface, or OOP ceremony leaking into the
runtime's hot loop, both fail review — see `docs/CONSTITUTION.md` for why
each direction specifically breaks something the spec asks for.
