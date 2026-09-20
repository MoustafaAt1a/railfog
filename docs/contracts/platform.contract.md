# Contract — Platform (Security, Reliability, Deployment, Providers)

Source: `railfog-v1_0_0-lts.md` Parts II, V, VI, VII, VIII, IX, X. This is the
largest contract file because it's where most of the audit findings land —
security and reliability mechanisms are exactly what a plausibility-driven
implementation gets subtly wrong.

## PLAT-1 — Control plane vs. data plane

| | Control Plane | Data Plane |
|---|---|---|
| Handles | Deploys, identity, routing config, permission config | Every live request |
| Executes customer code | Never | Always, inside the isolation boundary |
| Consistency target | Strong | Fail-static (PLAT-8) |
| Failure mode | New deploys pause | Invisible to end users |

Stage 1 deployment topology is a **modular monolith at the control-plane
level only** — exactly two processes (`railfog-control`, `railfog-runtime`).
The runtime/isolation split (PLAT-4) is never collapsed into that monolith,
regardless of how "modular monolith" gets interpreted elsewhere — collapsing
it makes the threat model meaningless (`docs/00-deep-analysis.md` §3).

## PLAT-2 — Everything is Trigger → Function

HTTP, cron, queue consumption are all triggers targeting a Function. No
separate Worker/API/Cron service exists or should be created
(functions.contract.md FN-2).

## PLAT-3 — Deployment pipeline

```
Source → Validate → Resolve dependencies → Security scan (audit + secret scan)
  → Build artifact → Generate manifest + SBOM → Sign artifact
  → Store (content-addressed, objects.contract.md OBJ-4) → Create revision
  → Health check (3 consecutive 200s within 30s)
     → pass: Activate (flip traffic pointer)
     → fail: revision stays inactive, previous revision keeps serving
```

Never activate before validation. No gradual canary/traffic-splitting in
1.0.0 — atomic cutover + instant pointer-flip rollback is the entire deploy
safety story; canary is a deliberate 1.1+ deferral, not a gap to fill in.

Manifest shape:

```json
{
  "runtime": "railfog-deno",
  "runtimeVersion": "1.0",
  "entrypoint": "api.ts",
  "integrity": "sha256-...",
  "permissions": { "kv": ["app:sessions"], "objects": ["app:uploads"] },
  "limits": { "cpu_ms": 200, "timeout_ms": 30000, "memory_mb": 128 },
  "dependencies": { "lockfile": "sha256-..." }
}
```

## PLAT-4 — Isolation, defense in depth

```
Customer Code (untrusted)
  → RailFog Runtime API (controlled surface)
    → Policy Layer (capability injection, PLAT-6)
      → Deno Execution
        → OS Sandbox (seccomp / cgroups / namespaces)
          → MicroVM (Firecracker / gVisor)
```

Deno's own permission model is necessary but explicitly **not sufficient** as
the multi-tenant boundary. Abstracted behind one interface so the application
layer never depends on Firecracker or gVisor directly:

```typescript
interface IsolationProvider { run(artifact: Artifact, limits: Limits): Promise<Result>; }
// LocalIsolation (dev) · ContainerIsolation · GVisorIsolation · FirecrackerIsolation
```

Warm-isolate reuse rule is functions.contract.md FN-6 — repeated here because
it's a security clause, not just a performance one: reuse only within the
same Function + Revision, bindings re-injected every invocation.

## PLAT-5 — Network policy: allowlist + mandatory IP block (SSRF-safe)

Two **independent** layers — an allowlist alone is not sufficient (Audit
Finding #8):

1. Allowlist: `network: [api.example.com]` in permissions, enforced by Deno's
   `--allow-net` plus the egress proxy.
2. Mandatory-block ranges, enforced at the egress proxy **by resolved IP at
   connect time**, independent of the allowlist and immune to DNS rebinding:

```
169.254.0.0/16, fd00:ec2::/8        — link-local / cloud metadata
10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 — RFC1918 private ranges
127.0.0.0/8, ::1/128                 — loopback
any RailFog internal service address
```

A Function never gets filesystem access, host networking, host environment,
host processes, or host credentials by default. No exceptions for "just this
once" — that sentence is itself a signal to stop and open an ADR instead.

## PLAT-6 — Capability injection (the permission model)

Permissions resolve **once, at deploy time**, into client objects physically
scoped to what's permitted. There is no runtime ACL check and no code path
that can address an unpermitted resource — a permission bug becomes a
deploy-time wiring error, not a runtime authorization bypass.

```
Dev → CP: rail deploy (railfog.toml declares permissions)
CP: validate — reject unresolvable/ambiguous scopes
CP → Runtime: push manifest + resolved bindings (cached, PLAT-8)
Runtime → Function: invoke, inject ctx.kv/objects/queues already closed over allowed scope
Function: no API exists to address anything outside that scope
```

```toml
[functions.api.permissions]
kv = ["app:sessions"]
objects = ["app:uploads"]
queues = ["app:jobs"]
network = ["api.example.com"]
secrets = ["STRIPE_KEY"]
# absence of a resource here == no code path to reach it, not "denied at runtime"
```

**Never** implement this as a runtime `if (hasPermission(...))` guard in
front of a resource call — that is the exact pre-audit design this replaced
(`docs/00-deep-analysis.md` §3, Appendix B ADR-011).

**Testability requirement.** This guarantee is only real if it's provable,
not just readable. Any implementation of PLAT-6 must ship with a test that
*attempts* an unpermitted resource access through every method on a
Function's bindings and asserts the access is structurally impossible (does
not compile, or has no argument through which an out-of-scope resource name
could be passed) — not a test that merely asserts a runtime call returns
`PERMISSION_DENIED`. A binding that can be asked for the wrong thing and
politely refuses is still the rejected design; a binding that has no way to
be asked is PLAT-6.

## PLAT-7 — Multi-tenancy & data isolation

```
physical_key = {org_id}/{project_id}/{resource_name}/{caller_key}
```

Not a hash — a literal prefix. The isolation guarantee comes from PLAT-6
making the prefix inexpressible from inside a Function, not from obscuring
it. Functions never see or construct this prefix; `ctx.kv`/`ctx.objects`
close over it at injection time. Re-enforce the same boundary at the
storage-provider layer too, so a runtime bug alone can't bypass it (defense
in depth mirrors PLAT-4).

## PLAT-8 — Fail-static control/data plane split

Runtime nodes never call the control plane synchronously on the request path
(Audit Finding #7). Routing tables and permission bindings are pushed as an
immutable, versioned snapshot, cached locally, refreshed in the background
(~5s poll or push-invalidated). If the control plane is unreachable, runtime
nodes keep serving the **last-known-good snapshot indefinitely** — new
deploys pause, live traffic does not notice. This is why the data plane's SLO
(PLAT-10) can legitimately exceed the control plane's.

## PLAT-9 — Rate limiting: token bucket

```
tokens(t) = min(burst, tokens(t-1) + rate × Δt)
allow request iff tokens ≥ 1, then tokens -= 1
Retry-After = ceil((1 - tokens) / rate)
```

| Scope | Rate | Burst |
|---|---|---|
| Anonymous / IP | 10 req/s | 20 |
| Identity (API token) | 50 req/s | 100 |
| Project | 200 req/s | 400 |
| Function concurrency | `limits.concurrency` (functions.contract.md FN-5) | — |

Rejected requests get `429 RATE_LIMITED` with a computed `Retry-After` —
never a silent drop.

## PLAT-10 — SLOs & error budget

```
error_budget_minutes = (1 − SLO) × period_minutes
```

| Component | SLO (monthly) | Budget |
|---|---|---|
| Control plane API | 99.9% | ~43.2 min |
| Runtime data plane (per region) | 99.95% | ~21.6 min |
| Queue delivery | at-least-once (delivery guarantee, not a latency SLO) | — |

## PLAT-11 — Routing specificity algorithm

Routes matched with `URLPattern`. Overlapping patterns resolved
deterministically:

```
score(route) = (literal_segments × 2) + (wildcard_or_named_segments × 1)
```

Highest score wins; ties break by declaration order (first-declared wins).
Example: `/api/users` (2 literal → score 4) beats `/api/*` (1 literal + 1
wildcard → score 3).

## PLAT-12 — Error model

`HTTPS + JSON`. Every response carries `request_id` (a ULID, PLAT-14),
propagated Gateway → Control → Runtime → Storage → Logs unchanged. Clients
never parse human-readable messages — one stable machine-readable code per
failure:

| Code | Meaning |
|---|---|
| `RESOURCE_NOT_FOUND` | No such project / function / revision |
| `PERMISSION_DENIED` | Capability not present in the resolved binding (PLAT-6) |
| `VALIDATION_FAILED` | Config or request failed schema validation |
| `RATE_LIMITED` | Token bucket exhausted (PLAT-9) — includes `Retry-After` |
| `CALL_DEPTH_EXCEEDED` | functions.contract.md FN-7 |
| `TIMEOUT` | Deadline exceeded (functions.contract.md FN-5) |
| `PAYLOAD_TOO_LARGE` | Body/value/message exceeded a stated size limit |
| `CONFLICT` | `kv.atomic()` CAS mismatch (kv.contract.md KV-3) |
| `UNAVAILABLE` | Control plane unreachable — data plane still serving via PLAT-8; new deploys only |
| `INTERNAL` | Unclassified platform fault |

This is the exhaustive list. Do not add a new error code without an ADR.

## PLAT-13 — Observability

Metrics (OpenTelemetry-compatible, no proprietary protocol): counters
`function.invocations`, `function.errors`, `kv.reads`, `kv.writes`,
`object.reads`, `object.writes`, `queue.sent`, `queue.processed`,
`queue.failed`, `queue.retry`; histograms `function.duration`,
`function.cpu`, `function.memory`.

Structured logs are JSON, never parsed as free text for platform
observability, secrets auto-redacted per PLAT-15:

```json
{ "timestamp": "...", "level": "info", "project": "...", "function": "...",
  "revision": "rev_01J...", "request_id": "req_01J8Z...", "duration_ms": 12 }
```

## PLAT-14 — ULID

```
128 bits = 48-bit millisecond timestamp + 80-bit randomness
Crockford Base32, 26 characters, lexicographically sortable
```

Used for `request_id`, `revision`, and project-scoped IDs specifically
because sort order = creation order — logs, revisions, and DB indexes behave
correctly without a separate timestamp column. Never substitute UUIDv4 where
a spec clause calls for a ULID.

## PLAT-15 — Secrets

Never committed, logged, returned by an API, embedded in an artifact, or
included in an error/trace. Runtime access is capability-scoped:
`ctx.env.get("STRIPE_KEY")` only works if `STRIPE_KEY` is in that Function's
`permissions.secrets`. Resolved **at invocation time** from the secret store,
never baked into the artifact — this is what makes rotation possible without
a redeploy. Structured logging must auto-redact any value matching a bound
secret name before it leaves the isolate.

## PLAT-16 — Provider abstraction

```typescript
interface KVProvider      { get; set; delete; list; }
interface ObjectProvider  { put; get; delete; head; list; presign; createMultipartUpload; }
interface QueueProvider   { send; sendBatch; receive; ack; }
interface ComputeProvider { run(artifact, limits): Promise<Result>; }
```

```
KVProvider     → DenoDeployKVProvider (strong) · CloudflareKVProvider (eventual) · SQLiteProvider (local)
ObjectProvider → R2Provider (S3-compatible) · LocalFSProvider (dev)
QueueProvider  → CloudflareQueuesProvider · SQLiteQueueProvider (dev)
ComputeProvider→ DenoProvider (+ GVisorIsolation / FirecrackerIsolation adapter)
```

Application code depends on the interface, never the vendor. This is the
CONSTITUTION.md Boundary Rule's canonical OOP+SOLID zone
(`docs/CONSTITUTION.md`).

## PLAT-17 — Local/production parity

Same API, different provider — application code cannot tell the difference.

| | Local | Production |
|---|---|---|
| KV | SQLite | Deno Deploy KV / Workers KV |
| Objects | filesystem | R2 |
| Queue | SQLite-backed | Cloudflare Queues |
| Isolation | none (trusted dev machine) | gVisor / Firecracker |

`rail dev` never requires a cloud account.

## PLAT-18 — Resource hierarchy

```
Organization → Project → { Function, KV namespace, Object store, Queue }
Function → Revision
```

No deeper nesting in 1.0.0 — a cloud-style resource tree is exactly the
"47 configuration files" problem RailFog exists to avoid.

## PLAT-19 — Repository structure

```
railfog/
├── apps/            — api, gateway, runtime, worker
├── packages/        — core, api, auth, config, errors, logging, metrics, policy, protocol, testing
├── primitives/      — functions, kv, objects, queues
├── providers/       — compute, kv, objects, queues (adapters, PLAT-16)
├── runtime/         — api, sandbox, loader, limits, lifecycle
├── sdk/typescript/
├── cli/
├── docs/
├── tests/           — unit, integration, contract, security, e2e
└── infra/
```

Deployment stays two processes (PLAT-1) regardless of how many packages the
repo grows to contain.

## PLAT-20 — Explicitly out of scope for 1.0.0

Kubernetes, multi-region active-active, a custom database/object-storage/
message-broker/JS-engine/TLS/container-runtime, AI features, a service mesh,
a distributed tracing platform, a complex dashboard, a marketplace, gradual
canary/traffic-splitting (PLAT-3), twenty SDKs, a fifth primitive. This list
matters as much as the feature list (functions.contract.md / kv / objects /
queues) — treat a task that reintroduces anything here as scope creep, not
ambition.

## Banned patterns

- A runtime ACL check instead of capability injection (PLAT-6).
- An allowlist with no independent mandatory IP-range block (PLAT-5).
- A control-plane call synchronous on the data-plane request path (PLAT-8).
- Gradual canary/traffic-splitting logic in a 1.0.0 task.
- A new error code not in the PLAT-12 table, added without an ADR.
- UUIDv4 (or any non-ULID scheme) where PLAT-14 calls for a ULID.
- Splitting the two-process deployment topology (PLAT-1) "for cleanliness"
  with no scaling/security/failure-domain justification (Engineering Rule 2).
