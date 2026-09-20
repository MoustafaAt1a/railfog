# ANTIHALLUCINATION — Grounding Protocol

Both models working this repo (Gemini as architect/decomposer, Claude as
implementer/reviewer/security-auditor) are subject to this protocol without
exception. It exists because the spec's own history (`docs/00-deep-analysis.md`
§1) shows exactly what happens when "sounds like a reasonable mechanism" is
allowed to stand in for a verified one — the same failure mode that produced
15 audit findings in the human-written draft is the default failure mode of an
LLM asked to fill in an underspecified mechanism.

## Rule 1 — Spec-lock

Every RailFog-specific method signature, config key, error code, limit
default, or algorithm must trace to a clause ID in `docs/contracts/`
(e.g. `KV-3`, `FN-7`, `PLAT-12`). When implementing, add a one-line anchor at
the point of implementation:

```typescript
// spec: contracts/kv.contract.md#KV-3 — atomic() uses CAS, strong tier only
```

Never fabricate a clause ID. If you're not sure one exists, it doesn't — go
check `docs/contracts/`, don't infer one from the shape of a similar clause.

## Rule 2 — Canon vs. superseded

`docs/00-deep-analysis.md` §1 lists patterns the LTS audit explicitly
rejected. These are permanently banned in this repo, even if they'd pass a
casual review:

- Check-then-set idempotency with no TTL on the dedupe key.
- Any claim that a KV namespace is `strong` without verifying the backing
  provider can actually do CAS (`docs/contracts/kv.contract.md`).
- Runtime `if (hasPermission(...))` checks in front of a resource call,
  instead of capability injection at deploy time.
- A network allowlist with no independent IP-range block for
  link-local/metadata/RFC1918/loopback ranges.
- Queue consumption with no visibility timeout, no max-receive count, or no
  DLQ path.
- Any control-plane call synchronously on the data-plane request path.

## Rule 3 — Unknown → stop, don't guess

If a task needs a detail with no clause backing it:

- **Doesn't change observable behavior or the contract** (e.g. an internal
  variable name, a specific Postgres column type for control-plane metadata)
  → free implementation choice. State it explicitly in the task's
  "Assumptions made" section as an implementation decision, not spec.
- **Does change observable behavior or the contract** → stop. Draft an ADR
  (`docs/adr/template.md`) instead of deciding silently.

Never present an invented detail as if it came from the spec. The difference
between "the spec says X" and "I chose X because the spec is silent here" must
always be visible in what you write.

## Rule 4 — Two-model cross-check

The architect (Gemini) proposes design and task breakdowns; it does not write
implementation code. The implementer (Claude) implements strictly to the
task's declared scope and acceptance criteria. The reviewer (Claude, a
separate pass) re-derives correctness independently from `docs/contracts/` —
it does not accept "I checked this against spec" from the implementer's own
notes as sufficient; it re-checks the cited clause itself.

## Rule 5 — Verification over belief

A task is not done because a model believes the code compiles, the tests
pass, or a library behaves a certain way. It's done when the actual tool
output exists:

- `deno check` was run and its real output is in the task record.
- `deno test` was run and its real output is in the task record.
- `deno lint` was run and its real output is in the task record.

Never state a test result, a compile result, or a third-party API's behavior
that wasn't observed from an actual tool call in this session.

## Rule 6 — No silent scope creep

Every task file has an **Out of scope** list. If satisfying a task seems to
require touching something on that list, stop — amend the task or open a new
one. Don't quietly widen the diff.

## Rule 7 — Assumption ledger

Every task's implementation notes end with an **Assumptions made** section.
"None" is a valid, complete answer. A missing section is not — it reads as
"there were no assumptions," which is a claim, and claims need to be true.

## Rule 8 — Provider claims

Never state what a third-party provider (Cloudflare Workers KV, R2, Deno
Deploy KV, etc.) guarantees beyond what `docs/contracts/platform.contract.md`
PLAT-16 already states. The one time the original draft did this
unverified (claiming Workers KV could back strong consistency) is Audit
Finding #1 — the canonical example of why this rule exists.

## Self-check before marking any task done

- Does every RailFog-specific detail in this diff trace to a clause ID?
- Did I resurrect any pattern from the banned list in Rule 2?
- Is there anything here I'm not sure about that I presented as certain?
- Did I actually run the verification commands, or am I inferring the result?
- Is my Assumptions section accurate and complete?
- Did I touch anything on the task's Out of scope list?

If any answer is "not sure," the task is not done — resolve the uncertainty
first, or escalate per `AGENTS.md` §8 (Stop conditions).
