# Documentation Standards & Guidelines

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Audience**:
> Platform Contributors & Technical Writers &nbsp;|&nbsp; **Standard**:
> Truth-Synchronized, Slop-Free Engineering Documentation

Documentation in RailFog is treated as an executable engineering artifact, not
promotional marketing copy.

---

## 1. Absolute Source-of-Truth Hierarchy

When writing or updating documentation, resolve facts using this strict
authority model:

1. **Contracts (`docs/contracts/*.md`)**: The sole authority for API surfaces,
   configuration keys, limits, and algorithms.
2. **Constitution (`docs/CONSTITUTION.md`)**: The authority for architectural
   boundaries.
3. **Glossary (`docs/glossary.md`)**: The authority for domain terminology and
   canonical nouns.
4. **Verified Code & Tests**: The authority for actual implemented behavior.

If documentation contradicts a contract, **the documentation is wrong**. Never
rewrite documentation to conceal a code defect.

---

## 2. Hard Anti-Slop Style Rules

Write like a careful engineer documenting software for another engineer:

- **Direct Sentences**: State facts simply and concisely.
- **No Marketing Fluff**: Never use empty adjectives such as _"blazing-fast"_,
  _"seamless"_, _"world-class"_, _"revolutionary"_, _"effortless"_, or
  _"enterprise-grade"_.
- **No Meta-Commentary**: Never write phrases like _"In this guide, we will
  explore..."_ or _"Let's dive in..."_. Start immediately with actionable
  technical information.
- **No Invented Features**: Never document hypothetical capabilities or planned
  1.0 features as if they are already implemented.

---

## 3. Executability & Validation

Every code example is an executable contract:

- **TypeScript Snippets**: All code blocks marked `typescript` or `ts` must
  type-check cleanly with `deno check`.
- **TOML Snippets**: All configuration snippets marked `toml` must parse validly
  with `@std/toml`.
- **Link Integrity**: All relative links must resolve to existing files and
  valid section anchors.
- **Automated Verification**: Run `deno test -A tests/unit/docs_test.ts` to
  verify documentation syntax and snippet type-checking.
