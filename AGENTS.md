# AGENTS.md — RailFog Build Kernel

Read this in full before touching any file. It is the constitution for every
agent, human, or model working in this repository. Skills and agent files add
depth on demand; this file is the part that is never optional.

## 1. What this repository is

RailFog: a minimal application-infrastructure platform — four primitives
(Functions, KV, Objects, Queues), one runtime (Deno), reduced to
`Trigger → Function → {KV, Objects, Queues}`. Full contracts live in
`docs/contracts/`. Full reasoning lives in `docs/00-deep-analysis.md`.

## 2. Spec-lock (read this twice)

`docs/contracts/*.md` is the **only** source of truth for what RailFog's own
API surface, config keys, error codes, limits, and algorithms are. It is a
faithful extraction of the audited LTS spec (`docs/00-deep-analysis.md`
explains why the LTS supersedes the original draft — 15 documented bugs fixed).

- If a detail isn't in a contract file, it is **not RailFog behavior** — it's
  either a free implementation choice (state it explicitly as one) or a gap
  that needs an ADR (`docs/adr/template.md`), not a guess.
- Never invent a method, config key, error code, or default that "sounds
  right." If you can't point to a clause ID (e.g. `KV-3`, `FN-7`), don't write it.
- Full protocol: `docs/ANTIHALLUCINATION.md`. Every agent must follow it.

## 3. Non-negotiable engineering rules

Condensed from the spec's own Part X (these bind the *build process*, not
just the product):

1. Don't add infrastructure because it sounds impressive.
2. Don't create a service when a module is enough — modular monolith first.
3. Don't build what already exists (HTTP, Postgres, S3, Deno, OCI, TLS,
   Web Crypto) — glue, don't reinvent.
4. Don't trust customer code, ever.
5. Don't optimize without measurement.
6. Don't sacrifice security for convenience, or simplicity for theoretical scale.
7. Don't add a fifth primitive when composition on the existing four works.
8. Don't claim a test passed, a type-check succeeded, or a provider guarantees
   something, unless you actually ran the tool call that proves it.

## 4. Architecture doctrine

`docs/CONSTITUTION.md` — SOLID + OOP at every module/provider boundary,
Data-Oriented Design inside the runtime's per-request hot path, never mixed.
Read it before writing anything under `runtime/`, `providers/`, or `primitives/`.

## 5. Code quality doctrine

`docs/ANTI-SLOP.md` — no God objects, no restating-the-code comments, no
speculative generality, no magic numbers, no dead code, no mock paths reachable
in production, naming pulled only from `docs/glossary.md`.

## 6. Task discipline

Every unit of work is an atomic task file (`tasks/TASK-TEMPLATE.md`). Rules:

- One task = one interface, one module, or one behavior. If a task needs "and"
  to describe it, it's two tasks.
- A task's **Out of scope** list is binding. Touching those files means
  stopping and either amending the task or opening a new one — never silent
  scope creep.
- A task is not done until its **Definition of Done** checklist is checked
  *and verified by an actual tool call* (`deno check`, `deno test`, `deno lint`),
  not asserted from memory.
- Every task ends with an **Assumptions made** section. Empty is a valid
  answer; missing is not.

## 7. Model routing

| Role | Model | Writes code? |
|---|---|---|
| `architect` | Gemini 3.8 Flash High | No — design, ADRs, ambiguity resolution only |
| `task-decomposer` | Gemini 3.8 Flash High | No — emits task files only |
| `test-writer` | Claude Opus 4.6 (Thinking) | Tests only, written before implementation |
| `implementer` | Claude Opus 4.6 (Thinking) | Yes — minimum code to satisfy the task |
| `reviewer` | Claude Opus 4.6 (Thinking) | No — re-derives correctness independently |
| `security-auditor` | Claude Opus 4.6 (Thinking) | No — adversarial only, triggered by PLAT-4/5/6/7/15, FN-6, or FN-7 changes |

Adjust the literal model strings in `.agents/agents/*.md` to match whatever
your Antigravity model picker actually lists — the routing logic is what
matters, not the exact label. See `.agents/MODEL-CONFIG.md` for exactly which
files to edit and a one-line command to swap every occurrence at once.

## 8. Stop conditions — halt and ask a human

- A task would touch any of `docs/contracts/platform.contract.md` PLAT-4
  through PLAT-9, PLAT-15, or PLAT-7 (isolation, network, capability
  injection, secrets, multi-tenancy) in a way that changes the guarantee, not
  just the code.
- Two contract files appear to contradict each other.
- A task needs a new third-party dependency or provider not already named in
  `docs/contracts/platform.contract.md` PLAT-16.
- The architect and a contract disagree — the contract wins; flag the
  disagreement, do not silently pick one.

## 9. Skills index

Skills auto-trigger by description, but here's the map (full detail in
`.agents/README.md`):

- `railfog-contract-lock` — spec-lock rule, banned patterns from the audit findings.
- `solid-oop-dod-typescript` — the boundary rule, condensed, with a checklist.
- `anti-slop-code-quality` — the no-slop checklist.
- `provider-abstraction-pattern` — DIP/ISP/LSP rules for every `*Provider`.
- `deno-runtime-conventions` — Web-API-first, Deno-idiomatic rules for runtime code.
- `security-adversarial-review` — attack-the-guarantee checklist for PLAT-4/5/6/7/15, FN-6/7.
- `tdd-atomic-protocol` — red/green/DoD loop for atomic tasks.
- `atomic-task-decomposition` — sizing heuristic for splitting work.
- `skill-authoring` — how to draft, get approved, and register a new skill
  when one of these doesn't cover a recurring pattern (`/new-skill`).

This list is expected to grow. If you find a skill under `.agents/skills/`
that isn't listed here, that's a registration gap — fix it per
`skill-authoring`'s Definition of Done, don't just use the skill silently.

## 10. The loop

```
/new-task <milestone>        → architect + task-decomposer emit task files
/implement-task <id>         → test-writer → implementer → reviewer
                                (→ security-auditor if PLAT-4/5/6/7/15 or FN-6/7 touched)
/status                      → progress dashboard, what's actionable next
/review-task <id>            → re-run review pass standalone
/verify-spec <contract-file> → spot-check the repo against one contract
/new-skill <topic>           → draft, review, and register a new skill
```

New to this repo? Read `QUICKSTART.md` first — it has the exact command
sequence to run Milestone 0.1 end to end.
