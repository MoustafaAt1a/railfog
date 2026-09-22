# Architectural Constitution — The Boundary Rule

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Core Rule**:
> SOLID + OOP at Boundaries &nbsp;|&nbsp; Data-Oriented Design (DOD) in Request
> Hot Paths

This document defines the architectural doctrine of RailFog: the separation
between system boundaries and execution hot paths.

---

## 1. The Boundary Rule

> **If it crosses a module boundary or is swappable, model it as an interface
> (OOP + SOLID).** **If it lives inside the per-request execution hot path and
> is never swapped independently, model it as plain data plus free functions
> (Data-Oriented Design).**

Never mix the two.

---

## 2. SOLID + OOP at Boundaries

Module and provider boundaries must be strictly decoupled:

- **`providers/*`**: Infrastructure SPIs (`ComputeProvider`, `KVProvider`,
  `ObjectProvider`, `QueueProvider`) are defined as pure TypeScript interfaces.
- **Dependency Inversion (DIP)**: Higher-level runtime modules depend only on
  abstractions, never on concrete SQLite, Deno KV, or S3 classes.
- **Liskov Substitution (LSP)**: Any provider implementation can be substituted
  at runtime without altering the correctness of the system.
- **Single Responsibility (SRP)**: Each provider interface handles exactly one
  primitive.

---

## 3. Data-Oriented Design (DOD) in Request Hot Paths

Inside the per-request data plane:

- **Zero Allocations**: Avoid instantiating temporary wrapper objects,
  iterators, or prototype chains for each request.
- **Flat Layouts**: Invocation headers are stored on prototype-free records
  (`Object.create(null)`).
- **Pre-Allocated Buffers**: Usage metrics and log frames are accumulated in
  contiguous circular arrays and flushed in batches.
- **Fast Traversal**: Route matching relies on direct array indexing and numeric
  specificity score comparisons (`PLAT-11`).

---

## 4. Prohibited Architectural Patterns

1. **No God Objects**: Never combine control-plane operations (deployments,
   account billing) and data-plane operations (request proxying, isolate
   dispatch) in the same class.
2. **No Ambient Singletons**: Never export mutable global state or process
   singletons. Pass dependencies explicitly via constructor parameters.
3. **No Mock Paths in Production**: Production code paths must never branch on
   `isTest` or mock flags. Tests must supply real test doubles implementing the
   SPI interface.
