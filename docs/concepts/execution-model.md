# Execution Model & Isolate Sandboxing

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`FN-4` to `FN-8`](../contracts/functions.contract.md),
> [`PLAT-4`](../contracts/platform.contract.md#PLAT-4) &nbsp;|&nbsp;
> **Isolation**: V8 Isolates with Zero Ambient Authority

This document defines how RailFog executes untrusted customer TypeScript code,
isolates multi-tenant workloads, and enforces deterministic resource boundaries.

---

## 1. Request Execution Lifecycle (`FN-8`)

Every incoming HTTP request traverses a deterministic 8-step execution path:

```
Client ──► Gateway ──► Runtime (Data Plane)
                         │
                         ├─► 1. Resolve Route (PLAT-11 specificity score)
                         ├─► 2. Load Cached Snapshot (PLAT-8, no remote calls)
                         ├─► 3. Acquire/Warm Isolate (FN-6 warm reuse rule)
                         ├─► 4. Inject Scoped Context (FN-4 RailFogContext)
                         ├─► 5. Execute Handler Function
                         ├─► 6. Enforce Hard Limits (FN-5 cpu_ms & timeout_ms)
                         ├─► 7. Return Sanitized Response
                         └─► 8. Flush Structured Log & Metrics (PLAT-13)
```

---

## 2. The Warm-Reuse Rule (`FN-6`)

A major vulnerability class in serverless runtimes is **tenant state bleeding**
caused by reusing sandboxes across different customers or functions.

RailFog eliminates this by specification rule (`FN-6`):

1. **Strict Binding to Function + Revision**: A warm isolate may be reused
   across invocations of the **same Function + Revision only**. An isolate is
   never reused across different Functions, different Projects, or different
   tenants.
2. **Re-Injection on Every Invocation**: Capability bindings (`ctx.state`,
   `ctx.data`, `ctx.signal`, `ctx.env`) are re-instantiated and injected on
   **every single invocation**. Bindings are never trusted to persist in module
   scope.
3. **Module State as Best-Effort Cache**: Any variables stored in global or
   module scope (e.g. `let cache = ...`) are treated as an uncommitted cache,
   never as a security boundary.

---

## 3. Call-Depth Recursion Guard (`FN-7`)

To prevent denial-of-wallet attacks and infinite recursion loops (e.g. Function
A triggering Function B which calls Function A):

1. Every internal function-to-function invocation carries an
   `X-RailFog-Call-Depth` HTTP header.
2. The runtime increments this counter on each hop.
3. If the depth exceeds `call_depth_max` (default: 8), the invocation is
   immediately aborted with `429 CALL_DEPTH_EXCEEDED`.

---

## 4. Hard Execution Ceilings (`FN-5`)

Limits are hard operational and security kill-switches, never soft metrics:

- **CPU Time (`cpu_ms: 200`)**: Enforced by isolate execution clocks. Exceeding
  CPU budget triggers immediate termination.
- **Wall-Clock Time (`timeout_ms: 30000`)**: Hard timeout kill via
  `AbortController` and process signals.
- **Memory Ceiling (`memory_mb: 128`, max `1024`)**: Cgroup and isolate heap
  ceilings.
- **Concurrency (`concurrency: 50`)**: Token-bucket limit returning
  `429 RATE_LIMITED` with `Retry-After`.

---

## Next Steps

- Learn about [Capability Injection](capabilities.md).
- Understand [Revisions & Deployments](revisions.md).
