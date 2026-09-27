# Provider Architecture & SPI Overview

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-16`](../contracts/platform.contract.md#PLAT-16),
> [`PLAT-17`](../contracts/platform.contract.md#PLAT-17),
> [`CONCEPT-7`](../contracts/concepts.contract.md#CONCEPT-7) &nbsp;|&nbsp;
> **Architecture**: Dependency Inversion (DIP) & Boundary Rule ([`docs/CONSTITUTION.md`](../CONSTITUTION.md))

In RailFog, the provider layer represents the pluggable infrastructure drivers that execute computation, store state, persist binary data, and dispatch queue messages.

The application **never** depends directly on a provider (`CONCEPT-7`, Section 14).

---

## 1. The Core Dependency Direction

RailFog strictly enforces an inverted dependency hierarchy:

```
Application Logic
      │
      ▼
SDK Concepts (Compute, State, Data, Signal)
      │
      ▼
Primitive Interfaces (Service Provider Interfaces / SPI)
      │
      ▼
Concrete Infrastructure Providers (Local & Cloud)
```

The provider layer is completely swappable without altering application logic or the SDK mental model:
- Developing locally: providers use in-process SQLite and local filesystem storage (`PLAT-17`).
- Deploying to production: providers bind to globally distributed KV, S3/R2 object storage, and managed cloud queues (`PLAT-16`).

---

## 2. Conceptual to Provider Mapping

| Developer Concept | Infrastructure Primitive | Provider SPI | Local Development | Cloud Production |
| :--- | :--- | :--- | :--- | :--- |
| **Compute** | Function | `IsolationProvider` / `ComputeProvider` | `ProcessIsolationProvider` | `ProcessIsolationProvider`, `GvisorIsolationProvider` |
| **State** | KV | `KVProvider` | `SqliteKVProvider` | `PostgresKVProvider`, `CloudflareKVProvider`, `RedisKVProvider` |
| **Data** | Object | `ObjectProvider` | `LocalFsObjectProvider` | `R2ObjectProvider`, `S3ObjectProvider` |
| **Signal** | Queue | `QueueProvider` | `SqliteQueueProvider` | `CloudflareQueueProvider`, `RedisQueueProvider` |

---

## 3. The Boundary Rule (SOLID + OOP)

Per [`docs/CONSTITUTION.md`](../CONSTITUTION.md), all provider boundaries in RailFog adhere to:

1. **Dependency Inversion Principle (DIP)**: Runtime components depend on abstract provider interfaces, never concrete drivers.
2. **Interface Segregation Principle (ISP)**: Each provider interface exposes only the minimal contract required for its primitive (`KVProvider`, `ObjectProvider`, `QueueProvider`, `IsolationProvider`).
3. **Liskov Substitution Principle (LSP)**: Any conforming provider implementation can substitute another without breaking invariant platform tests or leaking provider-specific failure states.

---

## 4. Multi-Tenant Isolation (`TenantGuard`) (`PLAT-4`)

When running in multi-tenant environments, every provider interaction is wrapped in `TenantGuard`:

- **Deterministic Namespace Prefixes**: Automatically prefixes every storage key, object path, or queue channel with `<tenantId>:<projectId>:`.
- **Path Traversal Protection**: Rejects null bytes, path traversal sequences (`..`), and unauthorized prefix escapes with `PermissionDeniedError` (`PLAT-12`).
- **Transparent Stripping**: Strips tenant prefixes from output listings so application code only interacts with clean resource identifiers.

---

## 5. Provider Navigation

- [**Compute Providers**](compute.md): Process isolation, V8 worker sandboxes, and resource limit enforcement.
- [**State Providers**](state.md): Key-Value backends (SQLite, PostgreSQL, Redis, Cloudflare KV).
- [**Data Providers**](data.md): Object storage backends (Local filesystem, Cloudflare R2, AWS S3).
- [**Signal Providers**](signal.md): Asynchronous queue backends (SQLite, Redis, Cloudflare Queues).
