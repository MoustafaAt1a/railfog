# Configuration Reference (`railfog.toml`)

This document is the authoritative configuration reference for `railfog.toml`, the declarative manifest for RailFog applications. RailFog projects configure functions, triggers, capability-scoped permissions, resource limits, routing rules, and backing resources within this single file.

---

## 1. Top-Level Attributes

### `name`
- **Type**: `string`
- **Required**: Yes
- **Spec Citation**: `PLAT-18` (Resource Hierarchy)
- **Description**: The project identifier. Per `PLAT-18`, the platform resource hierarchy is strictly:
  ```
  Organization -> Project -> { Function, KV namespace, Object store, Queue }
  Function -> Revision
  ```
  The `name` attribute defines the Project resource boundary. Physical storage keys and isolated namespaces are prefixed using this identifier (see `PLAT-7`).

```toml
name = "upload-demo"
```

---

## 2. Functions (`[functions.<name>]`)

The `[functions.<name>]` table defines the executable functions in the project.

### `entry`
- **Type**: `string`
- **Required**: Yes
- **Spec Citation**: `FN-1` (Function Definition and Entrypoint)
- **Description**: Relative path to the TypeScript source file implementing the function handler. The file must export a default handler function conforming to `FN-1`. The path must reside inside the project directory and cannot escape project root via parent traversal (`..`).

```toml
[functions.api]
entry = "functions/api.ts"
```

---

## 3. Triggers (`[functions.<name>.triggers]`)

- **Spec Citation**: `FN-2` (Triggers — No Fifth Primitive)
- **Description**: In RailFog, every workload is modeled as Trigger -> Function (`PLAT-2`, `FN-2`). There is no separate Worker, API, or Cron daemon service. A single function may declare multiple trigger types.

Supported trigger attributes:
- `http`: `boolean` — Enables HTTP request invocation via matching `[[routes]]`.
- `queue`: `string` — Name of the queue resource to consume messages from.
- `schedule`: `string` — Standard 5-field cron expression (e.g. `"*/5 * * * *"`) for scheduled invocations.
- `webhook`: `boolean` — Exposes the function as an authenticated webhook destination.

```toml
[functions.processor]
entry = "functions/processor.ts"

[functions.processor.triggers]
queue = "app:jobs"
schedule = "*/5 * * * *"
```

---

## 4. Capability Permissions (`[functions.<name>.permissions]`)

- **Spec Citations**: `PLAT-6` (Capability Injection), `PLAT-15` (Secrets Management)
- **Description**: RailFog enforces capability-based security. Permissions are resolved **once, at deploy time**, into client objects physically scoped only to what is explicitly declared (`PLAT-6`). There are no runtime `if (hasPermission(...))` authorization checks — absent permissions mean the code path to address the resource does not exist on `ctx` at all.

Declared permission fields:
- `kv`: `string[]` — Array containing exactly one declared KV namespace identifier. Ambiguous scopes (multiple namespaces) are rejected at deploy time (`PLAT-6`).
- `objects`: `string[]` — Array containing exactly one declared Object store bucket identifier (`PLAT-6`).
- `queues`: `string[]` — Array containing exactly one declared target Queue identifier (`PLAT-6`, `FN-4`).
- `network`: `string[]` — Egress allowlist of hostnames or IP addresses (`PLAT-5`). Enforced by isolation runtime and egress proxy. Independent mandatory IP blocks reject SSRF targets (link-local `169.254.0.0/16`, cloud metadata `fd00:ec2::/8`, RFC1918 private subnets, loopback `127.0.0.0/8`, `::1/128`).
- `secrets`: `string[]` — Array of secret identifiers assigned to this function (`PLAT-15`). Names must be valid C-style identifiers (`^[A-Za-z_][A-Za-z0-9_]*$`). Secrets are resolved at invocation time via `ctx.env` and auto-redacted in structured logs.

```toml
[functions.api.permissions]
kv = ["app:sessions"]
objects = ["app:uploads"]
queues = ["app:jobs"]
network = ["api.example.com"]
secrets = ["STRIPE_SECRET_KEY"]
```

---

## 5. Resource Limits (`[functions.<name>.limits]`)

- **Spec Citation**: `FN-5` (Resource Limits — Hard Enforcements)
- **Description**: Resource limits act as security and cost boundaries simultaneously. In RailFog, all limits are hard kill switches, never soft warnings. Exceeding any limit results in deterministic termination or standardized error codes.

| Limit Key | Type | Default Value | Maximum / Ceiling | Enforcement / Behavior (`FN-5`) |
|---|---|---|---|---|
| `cpu_ms` | integer | `200` | — | Hard kill when CPU execution time consumed exceeds limit, independent of wall clock. |
| `timeout_ms` | integer | `30000` (HTTP) / `900000` (queue / schedule) | `30000` (HTTP) / `900000` (queue / schedule) | Hard kill when invocation wall-clock exceeds deadline. HTTP timeout defaults to 30,000 ms (30s); background queue and schedule triggers default to 900,000 ms (15 minutes). Returns `TIMEOUT` error (`PLAT-12`). |
| `memory_mb` | integer | `128` | `1024` | Hard cgroup/isolate memory ceiling. Exceeding triggers isolate termination. |
| `concurrency` | integer | `50` | — | Per-function concurrency limit backed by token bucket (`PLAT-9`). Requests beyond concurrency limit receive `429 RATE_LIMITED` with `Retry-After`. |
| `logs.bytes_per_invocation` | integer | `64000` | — | Total log payload volume per invocation. Truncated with `LOG_TRUNCATED` marker if exceeded. |

```toml
[functions.api.limits]
cpu_ms = 200
timeout_ms = 30000
memory_mb = 128
concurrency = 50
"logs.bytes_per_invocation" = 64000
```

---

## 6. Routes (`[[routes]]`)

- **Spec Citations**: `PLAT-11` (Routing Specificity Algorithm), `PLAT-3` (Deployment Pipeline)
- **Description**: Defines HTTP route mappings from incoming request paths to target functions.
- `pattern`: `string` — A URL pattern matching against incoming HTTP paths.
- `function`: `string` — Name of the target function declared in `[functions.<name>]`.

### Route Specificity Scoring Algorithm (`PLAT-11`)
When multiple route patterns match an incoming request, the routing engine evaluates route specificity deterministically using the scoring formula:

$$\text{score} = (\text{literal\_segments} \times 2) + (\text{wildcard\_segments} \times 1)$$

- **literal_segments**: Number of exact literal path segments (each contributes 2 points).
- **wildcard_segments**: Number of wildcard (`*`) or named/dynamic segments (each contributes 1 point).
- **Tie-breaker**: The route with the highest score wins. If scores are equal, declaration order breaks ties (the first declared route wins).

Example:
- `/api/users` contains 2 literal segments: score is $2 \times 2 = 4$.
- `/api/*` contains 1 literal segment and 1 wildcard segment: score is $1 \times 2 + 1 \times 1 = 3$.
- `/api/users` takes precedence over `/api/*`.

```toml
[[routes]]
pattern = "/api/users"
function = "api"

[[routes]]
pattern = "/api/*"
function = "api"
```

---

## 7. Resources

### Key-Value Storage (`[kv.<name>]`)
- **Spec Citation**: `KV-5` (Consistency Tiers)
- `consistency`: `"strong"` | `"eventual"` — Declares the consistency tier required for this namespace:
  - `strong`: Linearizable per-key consistency with atomic Check-And-Set (`CAS`) support (`KV-3`). Required for sessions, counters, locks, dedupe markers, and atomic transactions. Backed by Deno Deploy KV or SQLite.
  - `eventual`: Replicated with eventual convergence within seconds, no ordering guarantees. Suitable for feature flags, configuration caches, and staleness-tolerant reads. Backed by Cloudflare Workers KV.
  - **Validation rule**: Requesting `strong` consistency on an eventual-backed provider is a deploy-time validation error, never a silent downgrade (`KV-5`).

```toml
[kv."app:sessions"]
consistency = "strong"

[kv."app:flags"]
consistency = "eventual"
```

### Object Storage (`[objects.<name>]`)
- **Spec Citation**: `OBJ-1` (Durable Binary Storage Purpose)
- Defines an S3-compatible durable binary storage bucket for file uploads, build artifacts, backups, and large payloads. Functions access this store via `ctx.objects` using direct client transfers (`OBJ-3`).

```toml
[objects."app:uploads"]
```

### Queues (`[queues.<name>]`)
- **Spec Citation**: `Q-3` (Redelivery Model and Dead-Letter Queues)
- Defines asynchronous message queues providing at-least-once delivery (`Q-1`).
- `visibility_timeout_ms`: `integer` — Milliseconds a message remains invisible to other consumers after delivery (default: `30000`).
- `max_receives`: `integer` — Maximum delivery attempts before moving the message to the dead-letter queue (default: `5`).
- `retention_days`: `integer` — Number of days messages are retained before expiration (default: `4`, maximum: `14`).
- `dlq`: `string` (optional) — Identifier of the dead-letter queue where poisoned or failing messages are routed after exceeding `max_receives`.

```toml
[queues."app:jobs"]
visibility_timeout_ms = 30000
max_receives = 5
retention_days = 4
dlq = "app:jobs-dlq"

[queues."app:jobs-dlq"]
visibility_timeout_ms = 30000
max_receives = 5
retention_days = 14
```

---

## Complete Reference Example

Below is a complete `railfog.toml` configuring the canonical upload processing flow (`docs/contracts/worked-example.md`):

```toml
name = "upload-demo"

[functions.api]
entry = "functions/api.ts"

[functions.api.triggers]
http = true

[functions.api.permissions]
objects = ["app:uploads"]
queues = ["app:jobs"]

[functions.api.limits]
cpu_ms = 200
timeout_ms = 30000
memory_mb = 128
concurrency = 50

[functions.processor]
entry = "functions/processor.ts"

[functions.processor.triggers]
queue = "app:jobs"

[functions.processor.permissions]
objects = ["app:uploads"]
kv = ["app:files"]

[functions.processor.limits]
cpu_ms = 200
timeout_ms = 900000
memory_mb = 128
concurrency = 50

[[routes]]
pattern = "/upload"
function = "api"

[kv."app:files"]
consistency = "strong"

[objects."app:uploads"]

[queues."app:jobs"]
visibility_timeout_ms = 30000
max_receives = 5
retention_days = 4
dlq = "app:jobs-dlq"

[queues."app:jobs-dlq"]
visibility_timeout_ms = 30000
max_receives = 5
retention_days = 14
```
