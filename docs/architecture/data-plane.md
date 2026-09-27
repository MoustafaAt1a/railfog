# Data Plane Architecture Internals

> [!NOTE]
> **Documentation**: [Architecture Home](overview.md) &nbsp;|&nbsp;
> **Specification**: [`PLAT-1`](../contracts/platform.contract.md#PLAT-1),
> [`PLAT-8`](../contracts/platform.contract.md#PLAT-8) &nbsp;|&nbsp;
> **Doctrine**: [`CONSTITUTION.md`](../CONSTITUTION.md) (Data-Oriented Design in
> Hot Path)

The Data Plane (`apps/runtime`) serves 100% of live customer traffic. Inside its
per-request execution hot path, it strictly applies **Data-Oriented Design
(DOD)** principles to eliminate heap allocations, avoid prototype lookups, and
maximize V8 inline cache hits.

---

## 1. Hot-Path Execution Pipeline

```
Gateway (UDS / TCP) ──► Data Plane Runtime
                              │
  ┌───────────────────────────┴───────────────────────────┐
  │  1. In-Memory Specificity Route Match (Array Indexing) │
  │  2. Acquire Pre-Warmed Isolate (V8 Bytecode Cache)    │
  │  3. Zero-Copy Header Frame (Object.create(null))      │
  │  4. Fast-Path Context Injection                       │
  │  5. Dispatched Isolate Execution                      │
  │  6. Collect Metrics to Contiguous Circular Buffer     │
  └───────────────────────────┬───────────────────────────┘
                              ▼
                       Client Response
```

---

## 2. Key Data-Oriented Optimizations

### 2.1 Prototype-Free Header Frames

Invocation headers are populated on prototype-free objects
(`Object.create(null)`):

- Bypasses `Object.prototype` property lookups.
- Eliminates prototype pollution vectors when parsing untrusted external
  headers.
- Maximizes V8 inline caching efficiency.

### 2.2 In-Memory Routing Table

Route patterns are compiled ahead of time into immutable `URLPattern` instances
sorted by descending `PLAT-11` specificity score. Request path matching is a
linear array traversal of pre-computed scores with zero runtime regex
compilation.

### 2.3 Fail-Static Snapshot Caching (`PLAT-8`)

The Data Plane never issues remote network calls to the control plane on the
live request path. It stores configuration snapshots in:

1. **L1 In-Memory Cache**: Active routing table and capability matrices.
2. **L2 Atomic Disk Cache (`DiskSnapshotCache`)**: Persisted snapshot on local
   disk.

If the node restarts during a control-plane network partition, it loads the L2
disk snapshot and immediately begins serving traffic.
