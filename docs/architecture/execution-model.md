# Execution Model & Sandboxing

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp;
> **Specification**: [PLAT-4, PLAT-5, PLAT-6, PLAT-15](../contracts/platform.contract.md) &nbsp;|&nbsp;
> **Security Model**: Zero Ambient Authority (Capability-Based)

RailFog enforces defense-in-depth isolation for all customer code. Functions run inside lightweight V8 execution boundaries with zero ambient authority and hard resource ceilings.

---

## 1. Zero Ambient Authority & Capability Injection (`PLAT-6`)

Traditional serverless runtimes provide untrusted code with global process privileges: environment variables (`process.env`, `Deno.env`), broad network socket access, and raw filesystem paths. 

RailFog eliminates ambient authority entirely:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SANDBOX ISOLATE BOUNDARY                        │
│                                                                        │
│   ❌ Deno.env (Blocked)           ❌ Direct Filesystem (Blocked)      │
│   ❌ Raw Sockets (Blocked)        ❌ Process Exit (Blocked)           │
│                                                                        │
│   ✅ Injected RailFogContext (FN-4):                                   │
│      • ctx.kv      ─► Scoped strictly to declared KV namespace         │
│      • ctx.objects ─► Scoped strictly to declared Object bucket        │
│      • ctx.queues  ─► Scoped strictly to declared Queue target         │
│      • ctx.env     ─► Scoped strictly to declared secret identifiers   │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Deploy-Time Resolution**: Capability permissions in `railfog.toml` are evaluated and compiled at deploy time.
2. **Missing Capabilities are Absent**: If a function does not declare a resource in its permissions, the code path to reach that resource does not exist on `ctx` at all.
3. **Secrets Isolation (`PLAT-15`)**: Secrets are resolved dynamically at invocation time via `ctx.env.get` or `ctx.env.require`. Secret enumeration (`keys()`, `entries()`) is prohibited to prevent credential reflection attacks.

---

## 2. Hard Execution Ceilings (`FN-5`)

Resource limits act as hard security, isolation, and cost boundaries. Exceeding any limit results in deterministic termination:

| Limit Key | Default | Ceiling | Behavior on Violation |
|---|---|---|---|
| `cpu_ms` | `200 ms` | Custom | Hard kill when cumulative CPU execution time exceeds threshold, independent of wall clock. |
| `timeout_ms` | `30,000 ms` (HTTP)<br>`900,000 ms` (Queue/Cron) | `30,000 ms` (HTTP)<br>`900,000 ms` (Queue/Cron) | Hard kill when invocation wall-clock exceeds deadline. Emits `504 TIMEOUT`. |
| `memory_mb` | `128 MB` | `1024 MB` | Hard cgroup/isolate memory ceiling. Immediate isolate termination. |
| `concurrency` | `50` | Custom | Per-function concurrency limit backed by token bucket (`PLAT-9`). Returns `429 RATE_LIMITED` with `Retry-After`. |

---

## 3. Mandatory Egress Firewall & SSRF Mitigation (`PLAT-5`)

All outbound network requests initiated by functions are inspected before socket connection. 

Even if a function declares `"0.0.0.0/0"` or broad network permissions, the following IP ranges are blocked unconditionally:
- **Cloud Metadata Services**: `169.254.169.254`, `fd00:ec2::254`.
- **Link-Local Addresses**: `169.254.0.0/16`, `fe80::/10`.
- **Loopback Interfaces**: `127.0.0.0/8`, `::1/128`.
- **RFC1918 Private Subnets**: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.

---

## 4. Cold-Start Pre-Warming

When a new routing snapshot is ingested, the Data Plane does not wait for customer traffic to compile code. It proactively calls `isolationProvider.prewarm()` to compile and cache TypeScript modules in advance. The very first customer request hits an already-compiled, warm isolate.

---

## Next Steps

- Explore [High-Performance Data-Plane Optimizations](performance.md).
- Learn about the [Functions Primitive](../primitives/functions/overview.md).
