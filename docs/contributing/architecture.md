# Architectural Guidelines for Contributors

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Authority**:
> [`docs/CONSTITUTION.md`](../CONSTITUTION.md) &nbsp;|&nbsp; **Rule**: The
> Boundary Rule

Every contributor and maintainer must adhere to the architectural doctrine
defined in [`docs/CONSTITUTION.md`](../CONSTITUTION.md).

---

## 1. The Boundary Rule

> **If it crosses a module boundary or is swappable, model it as an interface
> (OOP + SOLID).**\
> **If it lives inside the per-request execution hot path and is never swapped
> independently, model it as plain data plus free functions (Data-Oriented
> Design).**

Never mix the two.

---

## 2. SOLID + OOP at System Boundaries

Module and provider boundaries must be decoupled:

- **Interfaces First**: All infrastructure SPIs (`ComputeProvider`,
  `KVProvider`, `ObjectProvider`, `QueueProvider`) must be declared as pure
  TypeScript interfaces.
- **Dependency Inversion (DIP)**: High-level modules depend only on
  abstractions, never on concrete SQLite, PostgreSQL, or S3 classes.
- **Liskov Substitution (LSP)**: Any provider implementation must be
  hot-swappable without modifying platform runtime behavior or breaking parity
  tests.
- **Single Responsibility (SRP)**: Each provider interface encapsulates exactly
  one primitive.

---

## 3. Data-Oriented Design (DOD) in Request Hot Paths

Inside the per-request data plane (`apps/runtime` and `runtime/`):

- **Zero Allocations**: Avoid creating temporary object wrappers, iterators, or
  prototype chains per request.
- **Flat Layouts**: Invocation headers are stored on prototype-free objects
  (`Object.create(null)`).
- **Contiguous Buffers**: Accumulate log and metric records in circular arrays
  and flush in batches.
- **Direct Traversal**: Route matching relies on direct array indexing of
  pre-computed specificity scores.

---

## 4. Prohibited Code Patterns

1. **No God Objects**: Never combine control-plane operations (deployments,
   billing) and data-plane operations (request proxying, isolate dispatch) in
   the same class.
2. **No Ambient Singletons**: Never export mutable global state or process-wide
   singletons. Dependencies must be passed explicitly via constructors or
   factory parameters.
3. **No Mock Paths in Production**: Production code paths must never branch on
   `isTest` or mock flags. Tests must supply real test doubles implementing the
   SPI interface.
4. **No Speculative Generality**: Never build abstractions for hypothetical
   future features. Build only what is required by current contracts.
