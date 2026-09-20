# Contract — Functions

Source: `railfog-v1_0_0-lts.md` Part III (§3.1–3.2) and Part IV §4.1. This file
is the only thing code should be checked against — not the prose spec, not
memory of the prose spec.

## FN-1 — Definition

A Function is a versioned, isolated unit of code that receives an input and
produces an output, built on standard Web APIs (`Request`, `Response`,
`fetch`, `ReadableStream`, Web Crypto, `URLPattern`) so code stays portable off
the platform.

```typescript
export default async function handler(
  request: Request,
  ctx: RailFogContext,
): Promise<Response> { /* ... */ }
```

## FN-2 — Triggers (no fifth primitive)

HTTP, Queue, Schedule, and Webhook are all triggers that target a Function.
There is no separate Worker/API/Cron service. A single Function may declare
multiple trigger types.

```toml
[functions.processor.triggers]
queue    = "app:jobs"
schedule = "*/5 * * * *"
```

## FN-3 — Lifecycle

```
Created → Building → Ready → Deployed → { Active | Suspended | Failed }
Building → Failed (build failure)
```

Deployments are immutable. A Function accumulates Revisions; traffic points
at exactly one Revision; rollback is a pointer flip (`Revision 3 → Revision 2`
active), never a rebuild.

## FN-4 — RailFogContext (the entire RailFog-specific surface)

```typescript
interface RailFogContext {
  requestId: string;            // ULID
  project: string;
  function: string;
  revision: string;
  deadline: number;             // epoch ms; hard kill time
  timeRemaining(): number;      // ms left; size downstream AbortSignal.timeout() from this
  kv: KVBinding;                // pre-scoped — see KV-1, PLAT-6 (capability injection)
  objects: ObjectBinding;       // pre-scoped
  queues: QueueBinding;         // pre-scoped
  env: EnvBinding;               // only secrets explicitly assigned to this Function
}
```

There is no global `kv.get(anyKey)`. `ctx.kv`/`ctx.objects`/`ctx.queues` are
closures created at injection time over exactly what `railfog.toml` grants —
see `platform.contract.md` PLAT-6. A Function has no code path to construct or
address a key/object/queue outside its granted scope.

## FN-5 — Resource limits (MVP defaults, hard kills, not warnings)

| Limit | Default | Enforcement |
|---|---|---|
| `cpu_ms` | 200 | Kill at CPU time consumed ≥ limit, independent of wall clock |
| `timeout_ms` | 30,000 (HTTP) / 900,000 (queue & schedule triggers) | Kill at `deadline` |
| `memory_mb` | 128 (max 1024) | cgroup / isolate memory ceiling |
| `concurrency` | 50 | Token bucket (see `platform.contract.md` PLAT-9); `429 RATE_LIMITED` + `Retry-After` beyond it |
| `request_body_mb` / `response_body_mb` | 10 / 10 | Streamed responses exempt from full buffering, capped at 512 MB total emitted bytes; reject with `413 PAYLOAD_TOO_LARGE` |
| `network.connections` | 6 concurrent | Enforced at egress proxy |
| `logs.bytes_per_invocation` | 64,000 | Truncate + emit `LOG_TRUNCATED` marker |
| `kv` ops per invocation | 1,000 | Reject further ops with `429` inside the same invocation |
| `objects` ops per invocation | 100 | Same |
| `queue` ops per invocation | 100 | Same |
| `call_depth_max` | 8 | See FN-7 |

These are cost *and* security boundaries simultaneously. A limit that exists
only for billing is a limit an attacker can ignore — never implement one as
"soft."

## FN-6 — Isolation & warm-reuse rule

An isolate may be reused across invocations of the **same Function + Revision
only** — never across different Functions, Projects, or tenants, regardless of
load. Bindings (`ctx.kv`/`ctx.objects`/`ctx.queues`/`ctx.env`) are re-injected
on **every** invocation, never trusted to persist across invocations. Any
surviving module-level state in a warm isolate is a best-effort cache, never a
security boundary. This closes the single most common real-world FaaS
vulnerability class (state bleeding between tenants in a reused sandbox) by
rule, not by hoping the isolation layer catches it. **Never** write code that
persists a scoped binding or credential in module scope and reuses it across
invocations without re-injection.

## FN-7 — Call-depth guard

Every internal Function-to-Function call carries `X-RailFog-Call-Depth`,
incremented by the runtime on each hop. Requests exceeding `call_depth_max`
(default 8) are rejected with `429 CALL_DEPTH_EXCEEDED`. This exists because a
pure trigger→Function model has no other mechanism stopping Function A →
Function B → Function A recursion; treat it as a cost/denial-of-wallet control
as much as a correctness one.

## FN-8 — Request lifecycle (for anything implementing the runtime path)

```
Client → Edge/TLS → Runtime: forward + request_id (ULID)
Runtime: resolve route (specificity score — see PLAT-11)
Runtime: load cached permission snapshot (never call control plane synchronously — PLAT-8)
Runtime → Isolate: create/reuse (FN-6 rule only)
Runtime → Isolate: inject scoped ctx (FN-4)
Isolate → Providers: bound operations only
Providers → Isolate → Runtime → Client: Response + request_id
Runtime: emit structured log + metrics (PLAT-13)
```
