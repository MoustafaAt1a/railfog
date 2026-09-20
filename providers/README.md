# Providers (`providers/`)

Swappable infrastructure adapters implementing the Provider SPI defined in [`PLAT-16`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L268).

## Local / Cloud Parity ([`PLAT-17`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L288))

RailFog enforces identical API behavior across local development and production cloud environments:

| Primitive | Local Development Adapter | Production Cloud Adapter | Interface Contract |
|---|---|---|---|
| **Compute** | `DenoComputeProvider` (`providers/compute`) | Container / Firecracker / gVisor adapter | [`ComputeProvider`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L274) |
| **KV** | `SQLiteKVProvider` (`providers/kv`) | `DenoDeployKVProvider` (`strong`) / `CloudflareKVProvider` (`eventual`) | [`KVProvider`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L271) |
| **Objects** | `LocalFSObjectProvider` (`providers/objects`) | `R2ObjectProvider` (S3 SigV4 compatible) | [`ObjectProvider`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L272) |
| **Queues** | `SQLiteQueueProvider` (`providers/queues`) | `CloudflareQueuesProvider` | [`QueueProvider`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L273) |

## Implementation Rules (SOLID & DIP)

1. **Dependency Inversion**: Providers depend on the interfaces defined in `primitives/`. Application code depends on interfaces, never on concrete providers.
2. **Liskov Substitution**: Every provider claiming a consistency tier must strictly honor all contract guarantees. For instance, a `strong`-tier KV provider must support atomic compare-and-swap (CAS).
3. **Zero Secret Leakage**: Provider constructors must never log, echo, or persist connection credentials or API tokens ([`PLAT-15`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L258)).
