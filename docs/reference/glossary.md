# Platform Glossary & Terminology

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp;
> **Source of Truth**: [docs/contracts/](../contracts/platform.contract.md)

Standard definitions for domain concepts, terms, and acronyms used across RailFog.

---

## Terms & Concepts

### Artifact (`OBJ-4`)
The packaged, immutable bundle of customer source code and metadata, addressed by its SHA-256 content hash.

### Capability Injection (`PLAT-6`)
The security model whereby customer functions receive zero ambient system authority (`Deno.env`, network, filesystem). All access to resources (`ctx.kv`, `ctx.objects`, `ctx.queues`, `ctx.env`) is explicitly scoped at deploy time and injected into `RailFogContext`.

### Dead-Letter Queue (DLQ) (`Q-3`)
A secondary queue designated to receive messages that fail processing after exceeding the configured `max_receives` limit.

### Fail-Static Availability (`PLAT-8`)
The operational guarantee that the Data Plane runtime continues serving live traffic from an immutable memory snapshot and disk cache without downtime if the Control Plane becomes unreachable.

### Function (`FN-1`)
A stateless TypeScript execution unit running in a sandboxed V8 isolate under hard resource limits.

### Key-Value (KV) (`KV-1` to `KV-5`)
Low-latency structured storage supporting hierarchical tuple keys and atomic Check-And-Set (`CAS`) transactions under `strong` or `eventual` consistency.

### Modular Monolith (`PLAT-1`)
RailFog's architectural structure: a single codebase and deployment repository decomposed into clean, decoupled modules with strict downward dependency rules, deployed across a two-process boundary.

### Objects (`OBJ-1` to `OBJ-4`)
S3-compatible durable binary asset storage accessed via direct SigV4 presigned URLs.

### Queues (`Q-1` to `Q-5`)
Decoupled message pipelines providing at-least-once delivery, visibility timeouts, and backoff retries.

### RailFogContext (`FN-4`)
The per-invocation context object passed to function handlers, carrying request metadata (`requestId`, `project`, `revision`, `deadline`, `timeRemaining()`) and capability bindings (`kv`, `objects`, `queues`, `env`).

### Revision (`FN-3`, `PLAT-3`)
An immutable record of a deployed application version, uniquely identified by a ULID and associated with specific function artifacts and routing rules.

### Route Specificity (`PLAT-11`)
The deterministic numeric formula:
$$\text{score} = (\text{literal\_segments} \times 2) + (\text{wildcard\_segments} \times 1)$$
used to resolve URL path routing ambiguity.

### Trigger (`FN-2`)
An event source that initiates function execution (HTTP request, queue message, cron schedule, or webhook).
