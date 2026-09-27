# ADR-0005 — Unified Four-Primitives and Developer Conceptual Model

Status: Accepted Date: 2026-09-27 Raised by: architect

## Context

In `docs/contracts/platform.contract.md` PLAT-2, RailFog's architecture is reduced to
`Trigger → Function → {KV, Objects, Queues}`. The original contract set
(`functions.contract.md`, `kv.contract.md`, `objects.contract.md`, `queues.contract.md`)
used infrastructure-level names for both internal runtime engines and developer-facing APIs.

While sufficient for low-level execution, exposing raw infrastructure names leaked backend
mechanics into user application code and obscured the fundamental computational roles
(Execute, Remember, Persist, Communicate). Furthermore, developers composing higher-level
patterns (caching, jobs, pipelines) risked seeking complex third-party workflow frameworks
or requesting redundant primitives.

Task `T-0911` and Milestone 0.9.1 surfaced the requirement to formalize a clean developer
mental model—**Compute**, **State**, **Data**, **Signal**—to govern the SDK and developer
tooling, while preserving existing infrastructure primitives and maintaining zero breaking
changes for running workloads.

## Decision

1. **Two-Tier Taxonomy**: RailFog establishes a permanent separation of concerns:
   - **Developer Conceptual Layer**: `Compute`, `State`, `Data`, `Signal`. Represents the
     mental model, capabilities, verbs, and developer SDK surface.
   - **Infrastructure Primitive Layer**: `Function`, `KV`, `Object`, `Queue`. Represents the
     runtime execution mechanism, isolate boundaries, and driver adapters.
2. **Additive and Non-Breaking Evolution**: The conceptual layer is purely additive.
   Existing primitive names (`kv`, `objects`, `queues`, `FunctionHandler`) remain fully
   supported in `railfog.toml`, internal runtime contexts (`RailFogContext`), and provider
   implementations. No existing application code or configuration breaks.
3. **WHATWG `AbortSignal` Disambiguation**: The Web standard `AbortSignal` used for HTTP
   request cancellation remains bound to `c.req.signal` (or `req.signal`). Asynchronous
   queue messaging is exposed as `c.signal` (`SignalBinding`), strictly decoupled from
   request lifecycle cancellation.
4. **Permissive Capability Aliasing in Tooling**: `railfog.toml` accepts `state`, `data`,
   and `signal` as first-class aliases for `kv`, `objects`, and `queues` under
   `[functions.<name>.permissions]`. To prevent split-brain ambiguity and enforce `PLAT-6`,
   declaring both alias and primitive simultaneously (e.g. `kv` and `state`) is strictly
   prohibited and rejected at validation time.
5. **SDK Context Ergonomics**: `@railfog/sdk` exports `ComputeHandler`, `StateBinding`,
   `DataBinding`, `SignalBinding`, and ergonomic getters on `HandlerContext`
   (`c.state`, `c.data`, `c.signal`). Getters are zero-cost references pointing to
   pre-resolved capability bindings.

## Alternatives considered

1. **Breaking Rename of All Primitives**:
   - *Proposal*: Rename all internal modules, classes, and config keys from `Function`, `KV`,
     `Object`, `Queue` to `Compute`, `State`, `Data`, `Signal`.
   - *Rejected*: Violates Engineering Rule 3 and Rule 6 (`AGENTS.md` §3). Breaking stable,
     tested runtime daemons and storage adapters solely for naming aesthetics creates massive
     operational churn with zero architectural benefit.
2. **Unified Monolithic Resource Abstraction**:
   - *Proposal*: Collapse all four primitives into a single universal interface
     (`resource.get()`, `resource.put()`, `resource.send()`).
   - *Rejected*: Violates Concept 5 (Semantic Honesty) and `.agents/docs/ANTI-SLOP.md`.
     KV, Object, and Queue storage have fundamentally different performance characteristics,
     consistency models, and payload size ceilings. An artificial unified API falsifies
     guarantees and produces runtime footguns.
3. **Incorporating a Workflow Engine into Core SDK**:
   - *Proposal*: Add a built-in state-machine DSL or DAG orchestrator to model multi-step flows.
   - *Rejected*: Violates Engineering Rule 2 (modular monolith first) and Concept 8
     (Anti-Framework Boundary). Complex flows must emerge from the composition of the four
     primitives, keeping the core platform minimal and auditable.

## Consequences

- Formally locked `docs/contracts/concepts.contract.md` (`CONCEPT-1` through `CONCEPT-8`).
- Updated `docs/glossary.md` with developer-layer canonical terms.
- `schemas/railfog.schema.json` updated with permissive aliases and `allOf` mutual exclusivity (`T-0913`).
- `packages/policy/permission-resolver.ts` and `packages/core/artifact/packager.ts` updated to normalize aliases at deploy time (`T-0914`, `T-0918`).
- `cli/check.ts` and `cli/deploy.ts` updated to validate and deploy conceptual capability declarations (`T-0919`, `T-0920`).
- `@railfog/sdk` exports conceptual types and context accessors (`T-0915`, `T-0916`).

## Spec references

`CONCEPT-1`, `CONCEPT-2`, `CONCEPT-3`, `CONCEPT-4`, `CONCEPT-5`, `CONCEPT-6`, `CONCEPT-7`, `CONCEPT-8`, `PLAT-1`, `PLAT-2`, `PLAT-3`, `PLAT-6`, `PLAT-7`, `PLAT-16`, `FN-1`, `FN-4`, `FN-5`, `KV-1`, `OBJ-1`, `Q-1`.
