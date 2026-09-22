# Infrastructure Providers (`providers/`)

> [!NOTE]
> **Pattern**: Service Provider Interface (SPI) &nbsp;|&nbsp;
> **Specification**: [PLAT-16 (Provider Abstraction)](../docs/contracts/platform.contract.md#PLAT-16), [PLAT-17 (Local Parity)](../docs/contracts/platform.contract.md#PLAT-17) &nbsp;|&nbsp;
> **Architecture Doctrine**: [CONSTITUTION.md](../docs/reference/constitution.md) (SOLID at Boundaries)

This directory contains swappable infrastructure adapters implementing the Provider Service Provider Interfaces (SPIs) defined in [`PLAT-16`](../docs/contracts/platform.contract.md#PLAT-16).

---

## 1. Local / Cloud Parity ([`PLAT-17`](../docs/contracts/platform.contract.md#PLAT-17))

RailFog enforces identical API behavior and guarantees across local development and production cloud environments:

```
                  ┌────────────────────────────────────────────────────────┐
                  │                 PROVIDER SPI BOUNDARY                  │
                  │   ComputeProvider · KVProvider · ObjectProvider ...    │
                  └───────────────────────────┬────────────────────────────┘
                                              │
                       ┌──────────────────────┴──────────────────────┐
                       ▼                                             ▼
        ┌─────────────────────────────┐               ┌─────────────────────────────┐
        │   Local Dev Adapters        │               │   Production Cloud Adapters │
        │   (PLAT-17 Zero Cloud Auth) │               │   (Cloudflare / AWS / Deno) │
        ├─────────────────────────────┤               ├─────────────────────────────┤
        │ • SQLiteKVProvider          │               │ • DenoDeployKVProvider      │
        │ • LocalFSObjectProvider     │               │ • R2ObjectProvider (S3)     │
        │ • SQLiteQueueProvider       │               │ • CloudflareQueuesProvider  │
        │ • DenoComputeProvider       │               │ • Firecracker / gVisor      │
        └─────────────────────────────┘               └─────────────────────────────┘
```

| Primitive | Local Development Adapter | Production Cloud Adapter | Interface Contract |
|---|---|---|---|
| **Compute** | `DenoComputeProvider` (`providers/compute`) | Firecracker / gVisor / Process sandboxes | [`ComputeProvider`](../docs/contracts/platform.contract.md#PLAT-16) |
| **KV** | `SQLiteKVProvider` (`providers/kv`) | `DenoDeployKVProvider` (`strong`) / `CloudflareKVProvider` (`eventual`) | [`KVProvider`](../docs/contracts/platform.contract.md#PLAT-16) |
| **Objects** | `LocalFSObjectProvider` (`providers/objects`) | `R2ObjectProvider` (S3 SigV4 compatible) | [`ObjectProvider`](../docs/contracts/platform.contract.md#PLAT-16) |
| **Queues** | `SQLiteQueueProvider` (`providers/queues`) | `CloudflareQueuesProvider` | [`QueueProvider`](../docs/contracts/platform.contract.md#PLAT-16) |

---

## 2. Implementation Rules (SOLID & DIP)

1. **Dependency Inversion (DIP)**: Providers implement interfaces defined in `primitives/`. Application services depend purely on abstractions, never on concrete SQLite or AWS drivers.
2. **Liskov Substitution (LSP)**: Every provider claiming a consistency tier must strictly honor all contract guarantees. For instance, any `strong`-tier KV provider must support atomic Check-And-Set (`CAS`) transactions (`KV-3`).
3. **Zero Credential Leakage ([`PLAT-15`](../docs/contracts/platform.contract.md#PLAT-15))**: Provider constructors and error handlers must never log, echo, or leak API keys, secret tokens, or database connection strings.
4. **Resilient Decorator Pattern**: Providers under `providers/resilient` wrap base providers with circuit breakers, retry policies, and timeout protections.
