# Runtime (`runtime/`)

Per-request execution engine, worker sandboxing, and request lifecycle management.

## Submodules

| Module | Description | Key Responsibilities |
|---|---|---|
| [`runtime/api`](file:///C:/FM/railfog/runtime/api/mod.ts) | Execution Boundary | `RuntimeDispatcher` enforcing ULID `request_id`, call-depth ceilings, error normalization |
| [`runtime/sandbox`](file:///C:/FM/railfog/runtime/sandbox/mod.ts) | Process Isolation | Worker subprocess isolation, IPC communication, memory limits enforcement |
| [`runtime/loader`](file:///C:/FM/railfog/runtime/loader/mod.ts) | Dynamic Module Loader | Caching handler modules, dynamic ESM import, signature verification |
| [`runtime/limits`](file:///C:/FM/railfog/runtime/limits/mod.ts) | Resource Limiters | Wall-clock timeouts, memory kill switches, concurrency slots |
| [`runtime/lifecycle`](file:///C:/FM/railfog/runtime/lifecycle/mod.ts) | Process Lifecycle | Graceful shutdown, in-flight request draining, signal handling |

## Performance Philosophy (Data-Oriented Design)

As mandated by [`docs/CONSTITUTION.md`](file:///C:/FM/railfog/docs/CONSTITUTION.md):
- Hot loops in `runtime/loader`, `runtime/limits`, and request dispatch are designed using **Data-Oriented Design (DOD)**.
- Flat structs, numeric comparisons, and batched metrics/log flushing are favored over deep object hierarchies, per-request allocations, or virtual method calls.
- Routing lookups execute in microseconds against immutable in-memory snapshot indexes.
