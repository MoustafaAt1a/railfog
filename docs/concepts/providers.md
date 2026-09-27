# Provider Abstractions & SPI Pattern

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-16`](../contracts/platform.contract.md#PLAT-16),
> [`PLAT-17`](../contracts/platform.contract.md#PLAT-17) &nbsp;|&nbsp;
> **Doctrine**: [`CONSTITUTION.md`](../CONSTITUTION.md) (Boundary Rule)

RailFog enforces strict **Dependency Inversion (DIP)**. Runtime servers,
routers, and application functions depend exclusively on abstract Service
Provider Interfaces (SPI), never on concrete infrastructure vendors.

---

## 1. The Provider SPI Interfaces (`PLAT-16`)

Every storage and compute primitive is modeled as a pure TypeScript interface in
`primitives/`:

```
┌────────────────────────────────────────────────────────┐
│                   PROVIDER SPIs                        │
│                                                        │
│  • ComputeProvider  ─► Execution, sandboxing, limits   │
│  • KVProvider       ─► Tuple keys, atomic CAS, TTL     │
│  • ObjectProvider   ─► Multipart streams, presigning   │
│  • QueueProvider    ─► Send, pull, ack, visibility     │
└────────────────────────────────────────────────────────┘
```

Application code interacts with `ctx.state`, `ctx.data`, and `ctx.signal`
(with backward-compatible support for `ctx.kv`, `ctx.objects`, `ctx.queues`)
without ever knowing whether the underlying backend is SQLite on a developer's
laptop, PostgreSQL on Railway, or Cloudflare KV at the edge.

---

## 2. Supported Provider Backends

| Primitive   | Local Development (`PLAT-17`) | Cloud Production (`PLAT-16`)                                                            |
| ----------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| **KV**      | `SqliteKVProvider`            | `PostgresKVProvider`, `CloudflareKVProvider`, `RedisKVProvider`, `DenoDeployKVProvider` |
| **Objects** | `LocalFsObjectProvider`       | `R2ObjectProvider` (Cloudflare R2 / AWS S3)                                             |
| **Queues**  | `SqliteQueueProvider`         | `CloudflareQueueProvider`, `RedisQueueProvider`                                         |
| **Compute** | `ProcessIsolationProvider`    | `ProcessIsolationProvider`, `GvisorIsolationProvider`                                   |

---

## 3. Multi-Tenant Data Isolation (`TenantGuard`) (`PLAT-4`)

In multi-tenant deployments, all provider interactions are wrapped in
`TenantGuard`:

1. **Deterministic Key Prefixes**: Prepends `<tenantId>:<projectId>:` to every
   KV key, Object path, and Queue channel.
2. **Path Traversal Rejection**: Rejects any key or path containing parent
   traversal (`..`) or null bytes, preventing namespace escapes.
3. **Transparent Stripping**: Strips tenant prefixes on read results so customer
   handlers only see their declared names.

---

## 4. Resilience & Fallbacks (`ResilientProvider`)

Production providers are wrapped in a resilient decorator providing:

- **Exponential Backoff with Full Jitter**: Randomizes retry intervals to
  prevent thundering herd spikes.
- **Circuit Breaking**: Automatically trips open after 5 consecutive backend
  failures, protecting failing databases and failing fast for callers.
- **Linearizable Downgrade Guard (`KV-5`)**: Requesting strong consistency on an
  eventual-only backend is an explicit deploy-time error, never a silent runtime
  downgrade.

---

## Next Steps

- Learn about [Defense-in-Depth Isolation](isolation.md).
- Understand [Consistency Tiers](consistency.md).
