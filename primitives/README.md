# Primitives (`primitives/`)

The four fundamental building blocks of RailFog, plus compute execution definitions.

Per [`PLAT-20`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L330) and Engineering Rule 7: **Never add a fifth primitive.** All capabilities are composed on top of Functions, KV, Objects, and Queues.

## Primitives

| Primitive | Module | Purpose | Spec Contract |
|---|---|---|---|
| **Functions** | [`primitives/functions`](file:///C:/FM/railfog/primitives/functions/mod.ts) | HTTP request handlers, queue consumer handlers, lifecycle states, context interface | [`functions.contract.md`](file:///C:/FM/railfog/docs/contracts/functions.contract.md) |
| **KV** | [`primitives/kv`](file:///C:/FM/railfog/primitives/kv/mod.ts) | Key-value storage interface, atomic compare-and-swap (CAS), TTL expiration, keyspace partitioning | [`kv.contract.md`](file:///C:/FM/railfog/docs/contracts/kv.contract.md) |
| **Objects** | [`primitives/objects`](file:///C:/FM/railfog/primitives/objects/mod.ts) | Content-addressed artifact store, presigned upload/download URLs, multipart uploads | [`objects.contract.md`](file:///C:/FM/railfog/docs/contracts/objects.contract.md) |
| **Queues** | [`primitives/queues`](file:///C:/FM/railfog/primitives/queues/mod.ts) | At-least-once message delivery, batch send/receive, visibility timeout, dead-letter queues | [`queues.contract.md`](file:///C:/FM/railfog/docs/contracts/queues.contract.md) |
| **Compute** | [`primitives/compute`](file:///C:/FM/railfog/primitives/compute/mod.ts) | Sandboxed execution contract, resource limits, invocation envelopes | [`PLAT-4`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L45), [`PLAT-16`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L268) |

## Architectural Invariants

1. **Contracts, Not Implementations**: `primitives/*` defines domain interfaces and types, never vendor-specific code or concrete storage drivers.
2. **Capability Injection Scoping ([`PLAT-6`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L83))**: Handlers receive instances of bindings that are strictly pre-scoped to their declared permissions (e.g. `KVBinding` restricted to declared namespace prefixes).
