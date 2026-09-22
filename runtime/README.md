# Runtime Engine (`runtime/`)

> [!NOTE]
> **Engine**: V8 Sandboxed Isolates &nbsp;|&nbsp;
> **Hot-Path Architecture**: Data-Oriented Design (DOD) &nbsp;|&nbsp;
> **Specification**: [PLAT-4 (Isolation)](../docs/contracts/platform.contract.md#PLAT-4), [FN-5 (Limits)](../docs/contracts/functions.contract.md#FN-5), [FN-6 (Warm Reuse)](../docs/contracts/functions.contract.md#FN-6) &nbsp;|&nbsp;
> **Documentation**: [Hot-Path Performance](../docs/architecture/performance.md)

This directory contains the per-request execution engine, worker sandboxing subsystem, and request lifecycle management for RailFog's Data Plane.

---

## 1. Engine Submodules

```
runtime/
├── api/          # Execution boundary: RuntimeDispatcher, ULID tracing, error normalization
├── sandbox/      # Worker isolate sandboxes, LocalIsolationProvider, IPC transport
├── loader/       # Dynamic module loader, code caching, signature verification
├── limits/       # Hard resource limits, timeouts, memory kill-switches, concurrency
└── lifecycle/    # Process lifecycle, graceful shutdown, in-flight request draining
```

| Submodule | Responsibilities | Key Contracts |
|---|---|---|
| [`runtime/api`](api/) | `RuntimeDispatcher` enforcing Crockford Base32 ULID `request_id`, call-depth recursion ceilings, and standard `PLAT-12` error mapping. | [`PLAT-12`](../docs/contracts/platform.contract.md#PLAT-12), [`PLAT-14`](../docs/contracts/platform.contract.md#PLAT-14), [`FN-7`](../docs/contracts/functions.contract.md#FN-7) |
| [`runtime/sandbox`](sandbox/) | Worker subprocess/thread isolation, capability context injection, pre-warmed isolate management, and UDS IPC transport. | [`PLAT-4`](../docs/contracts/platform.contract.md#PLAT-4), [`PLAT-6`](../docs/contracts/platform.contract.md#PLAT-6) |
| [`runtime/loader`](loader/) | Caching compiled TypeScript modules, dynamic ESM imports, and secret injection. | [`FN-1`](../docs/contracts/functions.contract.md#FN-1), [`PLAT-15`](../docs/contracts/platform.contract.md#PLAT-15) |
| [`runtime/limits`](limits/) | Wall-clock execution deadlines (`timeout_ms`), memory cgroup monitoring, and concurrency token buckets. | [`FN-5`](../docs/contracts/functions.contract.md#FN-5), [`PLAT-9`](../docs/contracts/platform.contract.md#PLAT-9) |
| [`runtime/lifecycle`](lifecycle/) | Graceful SIGTERM/SIGINT signal handling, in-flight invocation draining, and resource cleanup. | [`PLAT-10`](../docs/contracts/platform.contract.md#PLAT-10) |

---

## 2. Hot-Path Performance Architecture (Data-Oriented Design)

As mandated by [`docs/reference/constitution.md`](../docs/reference/constitution.md):
- **Zero-Copy Header Frames**: Invocation headers are populated using `Object.create(null)` to eliminate prototype lookups and optimize V8 inline caches.
- **Pre-Warmed Sandboxes**: When routing snapshots are ingested, `prewarm()` compiles TypeScript modules into memory in advance, eliminating cold-start latency.
- **Unix Domain Socket (UDS) IPC**: On POSIX environments, data plane requests are received over `/tmp/railfog-data.sock`, bypassing the kernel TCP loopback stack.
- **Flat Structs & Numeric Comparisons**: Route matching evaluates pre-computed specificity scores (`PLAT-11`) with direct array indexing.

---

## 3. Sandboxing Invariants

1. **Warm Reuse Isolation ([`FN-6`](../docs/contracts/functions.contract.md#FN-6))**: Isolates are reused ONLY within the exact same `Function + Revision` pair. Bindings (`ctx.kv`, `ctx.objects`, `ctx.queues`, `ctx.env`) are re-injected freshly on every invocation.
2. **Call-Depth Guard ([`FN-7`](../docs/contracts/functions.contract.md#FN-7))**: Functions propagating downstream calls attach `x-railfog-call-depth`. If the depth exceeds 8, the runtime returns `429 CALL_DEPTH_EXCEEDED` to prevent infinite recursion.
3. **Hard Deadlines ([`FN-5`](../docs/contracts/functions.contract.md#FN-5))**: When `timeout_ms` expires, the execution promise is rejected with a standardized `504 TIMEOUT` error and the isolate is terminated.
