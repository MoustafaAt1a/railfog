# CONSTITUTION — SOLID + OOP + Data-Oriented Design

RailFog's own spec leans OOP everywhere it talks about providers ("interface
KVProvider { ... }") and leans DOD everywhere it talks about the runtime's
per-request loop ("measure everything before optimizing" — the LTS spec's own
Performance Philosophy principle, not a `docs/contracts/` clause since it's a
process rule rather than an API contract). Those are different tools for
different jobs, not a contradiction to paper over. This file draws the line so
two different models (and every human reviewer) draw it in the same place.

## The Boundary Rule

> **If it crosses a module/package boundary, or is swappable, model it as an
> interface (OOP + SOLID). If it lives entirely inside the runtime's per-request
> hot path and is never swapped independently, model it as plain data plus free
> functions (DOD).**

Concretely, in this repo's layout (`docs/contracts/platform.contract.md` has the
full repository structure):

| Layer                                                                                                               | Rule                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers/*` (KV, Objects, Queues, Compute/Isolation adapters)                                                     | OOP + SOLID. Always. These exist _specifically_ to be swapped (local SQLite ↔ Deno Deploy KV, filesystem ↔ R2) without call sites changing — that's Principle 4 (no lock-in), made structural.                                                                                         |
| `primitives/*` (the public shape of Function/KV/Object/Queue as the SDK exposes them)                               | OOP + SOLID. This is the contract developers build against; it must stay small, typed, and stable across provider swaps.                                                                                                                                                               |
| `packages/policy`, `packages/auth`, control-plane services                                                          | OOP + SOLID. Low-volume, config-shaped, correctness-over-throughput — exactly where clear interfaces cost nothing.                                                                                                                                                                     |
| `runtime/loader`, `runtime/limits`, the request-routing match loop, metrics/usage-event batching, log serialization | DOD. This is the code that runs on every single request. Represent state as flat records, process in batches where the spec's own defaults imply batching (e.g. usage events, structured logs), and don't pay for virtual dispatch or per-request allocation the spec never asked for. |

Violating this in either direction is a code smell, not a style preference:

- **DOD leaking into a Provider interface** (e.g., a `KVProvider.get` that
  returns a raw byte buffer instead of a typed value, "for performance," with no
  measurement backing it) violates Engineering Rule 5 (don't optimize without
  measurement) and breaks the whole point of the interface existing.
- **OOP ceremony leaking into the runtime hot path** (an abstract factory that
  builds a strategy that builds a visitor to decide how to increment a counter)
  is exactly the kind of AI-slop indirection `docs/ANTI-SLOP.md` exists to
  block, and it's on the one code path the spec explicitly asks you to keep fast
  (cold starts, routing, serialization — the LTS spec's own Runtime Optimization
  principle).

## SOLID, with RailFog's own interfaces as the examples

**S — Single Responsibility.** `PermissionResolver` resolves capability bindings
at deploy time (contracts/platform.contract.md PLAT-6). It does not also
validate `railfog.toml` syntax, and it does not also write the deployment
manifest. Those are different reasons to change.

**O — Open/Closed.** Adding `FirecrackerIsolation` must never require editing
`GVisorIsolation` or the code that calls `IsolationProvider.run(...)`. If adding
a provider means touching an existing provider's file, the abstraction is wrong.

**L — Liskov Substitution.** Every `KVProvider` implementation must honor the
_same_ consistency tier it claims. A `strong`-tier provider that can't actually
do compare-and-swap is not a smaller/faster implementation of the interface —
it's a different, undeclared interface wearing the same name. This is precisely
the bug the LTS audit found and fixed (Workers KV cannot back `strong`) — treat
any future provider claim the same way: verify it against
`docs/contracts/kv.contract.md` before trusting it.

**I — Interface Segregation.** `RailFogContext` hands a Function exactly `kv` /
`objects` / `queues` / `env`, each already scoped to that Function's declared
permissions. It does not hand back one fat "platform client" that happens to 404
on anything unpermitted — the unpermitted surface must not exist on the object
at all (see `docs/contracts/platform.contract.md` PLAT-6).

**D — Dependency Inversion.** `runtime/loader` depends on `KVProvider`,
`ObjectProvider`, `QueueProvider` — interfaces defined in `primitives/`. It
never imports `providers/kv/sqlite` or `providers/kv/deno-deploy` directly.
Wiring the concrete provider happens once, at composition time (CLI/config
loading), not scattered through the runtime.

## Worked example — decomposing a God object

A first draft of the runtime tends to arrive as one `RuntimeManager` that loads
artifacts, resolves permissions, enforces limits, and executes the Function.
Reject that shape on sight. The spec's own five-layer runtime architecture (User
Function → RailFog Runtime API → Permission/Policy → Deno Execution → Isolation
Boundary) is already the SRP decomposition:

```
ArtifactLoader        — loads + verifies a content-addressed artifact (contracts/platform.contract.md PLAT-3)
PermissionResolver     — resolves railfog.toml permissions into scoped bindings, deploy-time only
LimitEnforcer          — wall-clock/CPU/memory/concurrency kill switches (contracts/functions.contract.md limits table)
IsolationProvider      — the swappable sandbox boundary (interface; Local/Container/GVisor/Firecracker impls)
ExecutionScheduler      — the DOD hot loop: takes a resolved binding + limits + artifact, drives one invocation
```

`ExecutionScheduler` is the one piece that's legitimately DOD: it runs once per
request, so it should operate on a plain `InvocationRecord` struct rather than
instantiating a chain of collaborating objects per request.

## Worked example — DOD inside the hot path

Usage accounting (`contracts/platform.contract.md` PLAT-13) generates one event
per resource operation. Don't model that as one heap-allocated `UsageEvent`
class instance per call with a `.serialize()` method invoked immediately. Model
it as a flat, pre-sized buffer of plain records, appended to in the hot path,
flushed in a batch on a timer or size threshold — the "process in batches"
instinct the spec already applies to metrics and logs. The _shape_ of a usage
event (what fields it has) is still defined once, in one place, as a type —
that's the one place OOP-style structure belongs even inside this DOD code:
shared shape, not shared behavior.
