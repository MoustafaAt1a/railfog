# Runtime Architecture Internals

> [!NOTE]
> **Documentation**: [Architecture Home](overview.md) &nbsp;|&nbsp;
> **Specification**:
> [`PLAT-4`, `PLAT-5`, `PLAT-6`, `PLAT-7`, `FN-4`, `FN-5`](../contracts/platform.contract.md)
> &nbsp;|&nbsp; **Source**: `runtime/`

The runtime subsystem (`runtime/`) manages sandboxed isolate creation, context
construction, capability binding injection, execution deadline monitoring, and
response dispatching.

---

## 1. Directory Structure

```
runtime/
├── api/                  # Capability dispatch SPI and internal handler IPC
├── dev-server/           # Local development server, file watcher, and web dashboard
├── lifecycle/            # Cron schedule matcher and graceful shutdown coordinator
├── limits/               # CPU/wall-clock kill enforcer and per-invocation operation counter
├── loader/               # Function module loader, context builder, and secret injector
├── router/               # URLPattern route matcher and specificity scoring engine
├── sandbox/              # Egress IP blocker, egress proxy, Deno process isolation, gVisor
└── snapshot/             # In-memory and disk snapshot caches (PLAT-8)
```

---

## 2. Invalidation & Context Construction Pipeline

When a request is accepted by the data plane:

1. **Route Matcher (`router/route-matcher.ts`)**: Evaluates incoming request
   path against compiled `URLPattern` instances, sorting candidates by `PLAT-11`
   specificity score.
2. **Context Builder (`loader/context-builder.ts`)**:
   - Generates sortable ULID (`requestId`) per `PLAT-14`.
   - Computes execution deadline (`Date.now() + limits.timeout_ms`).
   - Resolves capability bindings (`kv`, `objects`, `queues`) strictly for
     declared resources.
3. **Secret Injector (`loader/secret-injector.ts`)**: Binds `c.env` to
   dynamically fetch declared encrypted secrets from memory vault.
4. **Kill Enforcer (`limits/kill-enforcer.ts`)**: Attaches an `AbortController`
   and monitors wall-clock and CPU time. If `timeout_ms` or `cpu_ms` is reached,
   it signals `abort()` and terminates the worker subprocess.
5. **Operation Counter (`limits/operation-counter.ts`)**: Counts operations per
   invocation. If `kv` operations exceed 1,000, or `objects`/`queues` operations
   exceed 100, subsequent calls throw `RateLimitedError` (`429`).

---

## 3. Sandboxing & Isolation (`sandbox/`)

- **`ProcessIsolationProvider`**: Spawns isolated worker processes
  (`process-worker.ts`) with strict Deno permission flags (`--no-prompt`,
  restricted filesystem, restricted environment).
- **`GvisorIsolationProvider`**: Intercepts guest system calls through Google
  gVisor Sentry in Linux production environments.
- **`EgressIpBlocker`**: Connect-time IP inspection blocking loopback,
  link-local, private subnets (RFC 1918), Carrier-Grade NAT (RFC 6598
  `100.64.0.0/10`), IPv6 ULA (RFC 4193 `fc00::/7`), and cloud metadata
  (`fd00:ec2::/8`, `169.254.169.254`).
