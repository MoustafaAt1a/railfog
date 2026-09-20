# Deep Analysis — RailFog v1.0.0

## 1. The two files are not redundant

`railfog-v1_0_0-engineering-reference.md` (869 lines) is a philosophy-first
draft: five principles, four primitives, a lot of "should" and "must" with
almost no algorithms behind them. `railfog-v1_0_0-lts.md` (1085 lines) is that
same draft after an audit pass, and its own Part 0 is a table of 15 findings.
The pattern across all fifteen is identical: **the draft names a mechanism and
never specifies it.** A sample of what that looked like in practice:

| Draft said | LTS found | LTS fixed with |
|---|---|---|
| "KV should be strongly consistent" ... then lists Cloudflare Workers KV as a candidate | Workers KV is eventually consistent (~60s propagation) — the two claims are incompatible | Two named tiers, each mapped only to a provider that can actually deliver it; requesting `strong` on an `eventual` namespace is a deploy-time error |
| "Permissions" as a YAML block | No enforcement mechanism specified — an ACL check can always be forgotten somewhere | **Capability injection**: permissions resolve once at deploy time into pre-scoped client objects; there is no code path left that can address an unpermitted resource |
| `kv.set(["processed", id], true)` for idempotency | No TTL on the key — the dedupe table grows forever | `ttl` added to `kv.set`, keyed to the queue's retention window |
| "At-least-once" queue delivery | No visibility timeout, no max-receive count, no DLQ trigger specified | Full redelivery state machine: visibility timeout → receive-count threshold → automatic DLQ |
| Network allowlist | Nothing blocks cloud metadata IPs or defends against DNS rebinding | Mandatory IP-range block (link-local, RFC1918, loopback) enforced at the egress proxy by *resolved* IP, independent of the allowlist |

This is the single most important fact for how this repository should be
built: **an LLM asked to implement the draft directly would silently
reproduce every one of these bugs**, because "sounds like a reasonable
mechanism" is exactly the failure mode a plausibility-driven model defaults to
when a spec names a concept without an algorithm. That is why this harness
treats the LTS document as the *only* source of truth (`docs/contracts/`) and
why `docs/ANTIHALLUCINATION.md` explicitly bans resurrecting any of the
patterns in the left column above, even though they'd look fine in a diff.

## 2. The core reduction

Everything in the spec collapses to one graph, and it is worth holding
literally in mind for every design decision made in this repo:

```
Trigger (HTTP | Queue | Schedule | Webhook) → Function → { KV, Objects, Queues }
```

There is no fifth primitive, no separate "Worker Service" or "Cron Service."
If a proposed feature can't be drawn as a new arrow on that graph, it doesn't
belong in 1.0.0 (spec §10.5 / Engineering Rule 13). This is the sharpest test
available for scope creep and should be applied to every task before it's
written, not just at architecture review time.

## 3. The architectural tensions this harness resolves

**Modular monolith, but the runtime is not just another module.** The spec is
explicit that Stage 1 is a monolith at the *deployment* level (two processes:
`railfog-control`, `railfog-runtime`), but the isolation boundary between
customer code and the host must still be real — a monolith with a fake
isolation boundary makes the entire threat model (the LTS spec's own Part V) meaningless. Read
"modular monolith" as scoped to control-plane internals only; the
runtime/isolation split is never negotiable.

**Control plane vs. data plane.** The control plane owns config (strong
consistency, low volume); the data plane serves every request and must never
call the control plane synchronously (`docs/contracts/platform.contract.md` PLAT-8, fail-static). Any code that puts a
control-plane round-trip on the request path is a spec violation regardless of
how clean it looks.

**Capability injection vs. runtime ACL checks.** This is the spec's most
novel decision (Appendix B, ADR-011) and the one most likely to get
"simplified" away by an agent that doesn't understand why it exists: moving
permission *resolution* to deploy time and permission *enforcement* to "the
unpermitted code path doesn't exist" removes an entire bug class instead of
adding a bigger authorization engine. Any implementation that re-introduces a
runtime `if (hasPermission(...))` check in front of a KV/Object/Queue call is
regressing to the exact design the audit rejected.

**OOP/SOLID vs. Data-Oriented Design.** The spec never states this tension
explicitly, but it's implicit in "provider abstraction everywhere" (interfaces,
naturally OOP) coexisting with "measure before optimizing" and a runtime that
sits on the hot path of every request (naturally DOD territory). This harness
resolves it with an explicit boundary rule in `docs/CONSTITUTION.md`: OOP/SOLID
at every swappable boundary (a `Provider`, a control-plane service), DOD inside
the runtime's per-request loop where allocation and dispatch overhead is
directly on the latency budget the spec asks you to measure.

## 4. Why atomic tasks + dual-model + contract-lock, specifically for this spec

The spec's own failure mode (plausible-sounding mechanism, no algorithm) is
the default failure mode of any LLM asked to "implement RailFog" from a
paragraph description. The countermeasure has to attack the same root cause:

- **Atomic tasks** force every unit of work down to one interface or one
  behavior, so there's nowhere for an unspecified mechanism to hide inside a
  larger diff.
- **Contract files with clause IDs** turn "does this match spec" from a vibe
  check into a citation check — a reviewer re-derives correctness from
  `docs/contracts/`, not from the implementer's summary of what it did.
- **Two independent models** (Gemini plans, Claude implements, Claude
  separately reviews) means the model that wrote the code is never the last
  model to check it against the contract.
- **Verification over belief** (`docs/ANTIHALLUCINATION.md` Rule 5) means a
  task can't close on "this should type-check" — the actual `deno check` /
  `deno test` output has to exist.

None of this is exotic tooling. It's the same discipline the LTS audit itself
demonstrates: replace every "should" with a formula, a default, or a rule, and
make deviation from that formula, default, or rule visible in review.
