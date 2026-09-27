# Provider Architecture & SPI Implementations

> [!NOTE]
> **Documentation**: [Architecture Home](overview.md) &nbsp;|&nbsp;
> **Specification**: [`PLAT-16`](../contracts/platform.contract.md#PLAT-16),
> [`PLAT-17`](../contracts/platform.contract.md#PLAT-17) &nbsp;|&nbsp;
> **Doctrine**: [`CONSTITUTION.md`](../CONSTITUTION.md) (SOLID + OOP at
> Boundaries)

RailFog isolates all backing infrastructure behind Service Provider Interfaces
(SPI). This decoupling allows swapping storage, messaging, and compute backends
without altering platform runtime logic or user application code.

---

## 1. Provider SPI Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                      APPLICATION HANDLER                       │
│        (ctx.state, ctx.data, ctx.signal)                       │
└───────────────────────────────┬────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────┐
│                   PRIMITIVES / SPI INTERFACES                  │
│       KVProvider · ObjectProvider · QueueProvider              │
└───────────────────────────────┬────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────┐
│                   TENANT GUARD WRAPPER (PLAT-4)                │
│       Sanitizes keys, prepends tenantId, rejects '..'          │
└───────────────────────────────┬────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────┐
│                  RESILIENT PROVIDER DECORATOR                  │
│       Exponential backoff · Full jitter · Circuit breaker      │
└───────────────────────────────┬────────────────────────────────┘
                                │
       ┌────────────────────────┼────────────────────────┐
       ▼                        ▼                        ▼
SQLite / LocalFS         PostgreSQL / Redis       Cloudflare KV / R2
(Local Dev Parity)       (Self-Hosted / Cloud)    (Serverless Edge)
```

---

## 2. Concrete Provider Directory Map

```
providers/
├── guard/              # TenantGuard multi-tenant isolation decorator (PLAT-4)
├── kv/                 # Key-Value storage adapters
│   ├── sqlite-provider.ts        # Embedded SQLite (local development)
│   ├── postgres-provider.ts      # PostgreSQL with row-level locks
│   ├── redis-provider.ts         # Redis with atomic Lua scripts
│   ├── cloudflare-kv-provider.ts # Cloudflare KV edge REST API
│   └── deno-deploy-provider.ts   # Native Deno KV backing
├── objects/            # Durable binary storage adapters
│   ├── local-fs-provider.ts      # Local disk storage with SigV4 emulation
│   └── r2-provider.ts            # S3 / Cloudflare R2 presigned storage
├── queues/             # Asynchronous messaging adapters
│   ├── sqlite-queue-provider.ts      # SQLite with transactional visibility lock
│   └── cloudflare-queue-provider.ts  # Cloudflare Queues HTTP API
└── resilient/          # ResilientProvider fallback and circuit breaker decorator
```

---

## 3. Strict LSP & DIP Verification

All providers are subjected to identical contract and parity test suites
(`tests/contract/parity_test.ts`):

- Any provider claiming conformance must pass the exact same test assertions for
  transactions, visibility timeouts, and presigning.
- Local SQLite and filesystem adapters achieve 100% digital-twin behavioral
  parity with cloud backends (`PLAT-17`).
