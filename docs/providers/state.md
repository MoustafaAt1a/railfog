# State Providers

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Conceptual Layer**: State &nbsp;|&nbsp; **Specification**:
> [`KV-1`](../contracts/kv.contract.md#KV-1) to [`KV-5`](../contracts/kv.contract.md#KV-5),
> [`PLAT-16`](../contracts/platform.contract.md#PLAT-16)

State providers implement structured Key-Value persistence for RailFog applications.

In the infrastructure layer, State maps to the **KV** primitive, managed via the `KVProvider` SPI.

---

## 1. The KVProvider SPI

All State backends implement the `KVProvider` interface in `primitives/`:

```typescript
export interface KVProvider {
  /** Retrieves a value by hierarchical tuple key. */
  get<T = unknown>(key: readonly string[]): Promise<KVEntry<T> | null>;

  /** Stores a value with optional TTL expiration. */
  set<T = unknown>(
    key: readonly string[],
    value: T,
    options?: { ttl?: number },
  ): Promise<void>;

  /** Removes a value by key. */
  delete(key: readonly string[]): Promise<void>;

  /** Performs a prefix scan with cursor pagination. */
  list<T = unknown>(
    prefix: readonly string[],
    options?: ListOptions,
  ): Promise<KVListResult<T>>;

  /** Begins an atomic Check-And-Set transaction. */
  atomic(): KVAtomicOperation;
}
```

---

## 2. Supported State Backends

### 2.1 SQLite (`SqliteKVProvider`)
- **Use Case**: Default local development (`rail dev`) and single-node deployments.
- **Engine**: SQLite in WAL (Write-Ahead Logging) mode with `PRAGMA synchronous = NORMAL`.
- **Atomic CAS**: Implemented via `BEGIN IMMEDIATE` transactions comparing record version stamps.
- **TTL Eviction**: Background sweeper running every 60 seconds to prune expired entries (`KV-2`).

### 2.2 PostgreSQL (`PostgresKVProvider`)
- **Use Case**: Production relational environments (e.g. Railway, Supabase, AWS RDS).
- **Engine**: JSONB column storage with B-tree indexing over key tuples.
- **Atomic CAS**: Row-level locking via `SELECT ... FOR UPDATE` or conditional `UPDATE ... WHERE version = $v`.
- **Consistency**: Linearizable Strong consistency (`KV-5`).

### 2.3 Redis (`RedisKVProvider`)
- **Use Case**: In-memory caching and ultra-low latency coordination.
- **Engine**: Redis Key-Value pairs with TTL support natively enforced via `EXPIRE`.
- **Atomic CAS**: Atomic evaluation via Lua script check-and-set transactions.

### 2.4 Cloudflare KV (`CloudflareKVProvider`)
- **Use Case**: Multi-region edge distribution where read latency dominates.
- **Consistency**: Eventual consistency tier (`KV-5`). Changes propagate to edge nodes asynchronously.

---

## 3. Consistency Tiers (`KV-5`)

State providers declare their supported consistency tier:

- **`strong`**: Immediate read-after-write consistency. Guaranteed by `SqliteKVProvider`, `PostgresKVProvider`, and `RedisKVProvider`.
- **`eventual`**: Reads may return stale data for a propagation window (up to 60 seconds). Declared for `CloudflareKVProvider`.

Application manifests declare required consistency under `[kv.<name>].consistency` (`strong` | `eventual`).
