# Configuration Reference (`railfog.toml`)

> [!NOTE]
> **Format**: TOML 1.0 &nbsp;|&nbsp;
> **Validation**: Strict Deploy-Time Schema (`PLAT-3`) &nbsp;|&nbsp;
> **IDE Support**: Autocomplete via JSON Schema (`schemas/railfog.schema.json`)

This document is the authoritative configuration reference for `railfog.toml`, the declarative manifest for RailFog projects. A single file configures function entrypoints, triggers, capability permissions, execution limits, routing rules, and backing resources.

---

## 1. Top-Level Attributes

The top-level configuration sets the project identity within the platform hierarchy.

```toml
name = "upload-demo"
```

| Property | Type | Required | Spec Anchor | Description |
|---|---|---|---|---|
| `name` | `string` | **Yes** | [`PLAT-18`](contracts/platform.contract.md#PLAT-18) | Unique project identifier. Governs the resource hierarchy boundary: `Organization -> Project -> { Function, KV, Objects, Queues }`. Physical storage keys and namespaces are prefixed with this name. |

---

## 2. Functions (`[functions.<name>]`)

The `[functions.<name>]` table defines executable functions and their source entrypoints.

```toml
[functions.api]
entry = "functions/api.ts"
```

| Property | Type | Required | Spec Anchor | Description |
|---|---|---|---|---|
| `entry` | `string` | **Yes** | [`FN-1`](contracts/functions.contract.md#FN-1) | Relative path to the TypeScript source file implementing the function handler. The file must export a default handler function. Directory traversal escaping project root (`..`) is rejected at deploy time. |

---

## 3. Triggers (`[functions.<name>.triggers]`)

RailFog strictly models all execution as **Trigger -> Function** ([`PLAT-2`](contracts/platform.contract.md#PLAT-2), [`FN-2`](contracts/functions.contract.md#FN-2)). There are no separate worker daemons or background scheduler containers.

```toml
[functions.processor]
entry = "functions/processor.ts"

[functions.processor.triggers]
queue = "app:jobs"
schedule = "*/5 * * * *"
```

| Trigger Property | Type | Default | Spec Anchor | Description |
|---|---|---|---|---|
| `http` | `boolean` | `false` | [`FN-2`](contracts/functions.contract.md#FN-2) | Enables HTTP request invocation via matching `[[routes]]` patterns. |
| `queue` | `string` | — | [`FN-2`](contracts/functions.contract.md#FN-2) | Name of the queue resource to consume messages from. Invokes the handler for each received message. |
| `schedule` | `string` | — | [`FN-2`](contracts/functions.contract.md#FN-2) | Standard 5-field cron expression (e.g. `"*/5 * * * *"`) for scheduled invocations. |
| `webhook` | `boolean` | `false` | [`FN-2`](contracts/functions.contract.md#FN-2) | Exposes the function as an authenticated webhook receiver endpoint. |

---

## 4. Capability Permissions (`[functions.<name>.permissions]`)

RailFog enforces **Capability-Based Security** ([`PLAT-6`](contracts/platform.contract.md#PLAT-6), [`PLAT-15`](contracts/platform.contract.md#PLAT-15)). Permissions are resolved **once, at deploy time**, into physical client objects scoped strictly to declared resources.

> [!IMPORTANT]
> There are no ambient credentials or runtime ACL checks. If a resource is omitted from `permissions`, the capability binding does not exist on `ctx` at all. Ambiguous multiple namespaces per resource are rejected at deploy time.

```toml
[functions.api.permissions]
kv = ["app:sessions"]
objects = ["app:uploads"]
queues = ["app:jobs"]
network = ["api.example.com"]
secrets = ["STRIPE_SECRET_KEY"]
```

| Capability | Type | Allowed Count | Spec Anchor | Description |
|---|---|---|---|---|
| `kv` | `string[]` | Exactly 1 | [`PLAT-6`](contracts/platform.contract.md#PLAT-6), [`KV-2`](contracts/kv.contract.md#KV-2) | Key-Value namespace identifier bound to `ctx.kv`. |
| `objects` | `string[]` | Exactly 1 | [`PLAT-6`](contracts/platform.contract.md#PLAT-6), [`OBJ-2`](contracts/objects.contract.md#OBJ-2) | Object store bucket identifier bound to `ctx.objects`. |
| `queues` | `string[]` | Exactly 1 | [`PLAT-6`](contracts/platform.contract.md#PLAT-6), [`Q-2`](contracts/queues.contract.md#Q-2) | Target Queue identifier bound to `ctx.queues`. |
| `network` | `string[]` | Variable | [`PLAT-5`](contracts/platform.contract.md#PLAT-5) | Hostname or IP allowlist for outbound HTTP/TCP egress. Mandatory SSRF firewall blocks loopback (`127.0.0.0/8`, `::1/128`), private RFC1918 subnets, link-local (`169.254.0.0/16`), and cloud metadata (`fd00:ec2::/8`). |
| `secrets` | `string[]` | Variable | [`PLAT-15`](contracts/platform.contract.md#PLAT-15) | Array of encrypted secret names accessible via `ctx.env`. Must be valid C-style identifiers (`^[A-Za-z_][A-Za-z0-9_]*$`). Secrets are auto-redacted in runtime logs. |

---

## 5. Resource Limits (`[functions.<name>.limits]`)

Resource limits act as hard security, isolation, and cost boundaries simultaneously ([`FN-5`](contracts/functions.contract.md#FN-5)). Exceeding any limit results in deterministic termination or standardized machine-readable errors ([`PLAT-12`](contracts/platform.contract.md#PLAT-12)).

```toml
[functions.api.limits]
cpu_ms = 200
timeout_ms = 30000
memory_mb = 128
concurrency = 50
"logs.bytes_per_invocation" = 64000
```

| Limit Key | Type | Default Value | Maximum / Ceiling | Enforcement & Behavior ([`FN-5`](contracts/functions.contract.md#FN-5)) |
|---|---|---|---|---|
| `cpu_ms` | `integer` | `200` | — | Hard kill when CPU execution time exceeds limit, independent of wall clock. |
| `timeout_ms` | `integer` | `30000` (HTTP) / `900000` (queue / schedule) | `30000` (HTTP) / `900000` (queue / schedule) | Hard kill when wall-clock execution exceeds deadline. HTTP timeout defaults to 30,000 ms; background queue/schedule triggers default to 900,000 ms (15 minutes). Emits `TIMEOUT` error code. |
| `memory_mb` | `integer` | `128` | `1024` | Hard cgroup/isolate memory ceiling. Exceeding triggers isolate termination. |
| `concurrency` | `integer` | `50` | — | Per-function concurrency limit backed by token bucket (`PLAT-9`). Requests beyond capacity receive `429 RATE_LIMITED` with `Retry-After`. |
| `logs.bytes_per_invocation` | `integer` | `64000` | — | Total log payload volume per invocation. Truncated with `LOG_TRUNCATED` marker if exceeded. |

---

## 6. Routes (`[[routes]]`)

Defines HTTP routing rules mapping incoming URL request paths to target functions ([`PLAT-11`](contracts/platform.contract.md#PLAT-11)).

```toml
[[routes]]
pattern = "/api/users"
function = "api"

[[routes]]
pattern = "/api/*"
function = "api"
```

| Route Field | Type | Required | Description |
|---|---|---|---|
| `pattern` | `string` | **Yes** | URL pattern matching incoming paths (supports literal segments and wildcard `*`). |
| `function` | `string` | **Yes** | Name of the target function declared in `[functions.<name>]`. |

### Route Specificity Scoring Algorithm (`PLAT-11`)
When multiple route patterns match an incoming request, the routing engine evaluates route specificity deterministically using the scoring formula:

$$\text{score} = (\text{literal\_segments} \times 2) + (\text{wildcard\_segments} \times 1)$$

- **literal_segments**: Number of exact literal path segments (each contributes 2 points).
- **wildcard_segments**: Number of wildcard (`*`) segments (each contributes 1 point).
- **Tie-breaker**: The route with the highest score wins. If scores are identical, declaration order breaks ties (the first declared route wins).

---

## 7. Backing Resources

### Key-Value Storage (`[kv.<name>]`)
Configures structured key-value state ([`KV-5`](contracts/kv.contract.md#KV-5)).

```toml
[kv."app:sessions"]
consistency = "strong"

[kv."app:flags"]
consistency = "eventual"
```

| Parameter | Type | Allowed Values | Spec Anchor | Description |
|---|---|---|---|---|
| `consistency` | `string` | `"strong"` \| `"eventual"` | [`KV-5`](contracts/kv.contract.md#KV-5) | **`strong`**: Linearizable per-key consistency with atomic Check-And-Set (`CAS`) support (`KV-3`). Required for sessions, locks, counters, and deduplication markers.<br>**`eventual`**: Replicated convergence within seconds. Backed by distributed edge KV. |

> [!WARNING]
> Requesting `strong` consistency on an eventual-backed provider is a deploy-time validation error, never a silent downgrade (`KV-5`).

---

### Object Storage (`[objects.<name>]`)
Defines durable binary storage buckets ([`OBJ-1`](contracts/objects.contract.md#OBJ-1)) for uploads, media, and backups. Functions generate direct SigV4 presigned URLs (`OBJ-3`) rather than proxying bytes.

```toml
[objects."app:uploads"]
```

---

### Queues (`[queues.<name>]`)
Defines asynchronous message queues with at-least-once delivery ([`Q-3`](contracts/queues.contract.md#Q-3)).

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

| Parameter | Type | Default | Maximum | Spec Anchor | Description |
|---|---|---|---|---|---|
| `visibility_timeout_ms` | `integer` | `30000` | — | [`Q-3`](contracts/queues.contract.md#Q-3) | Milliseconds a message remains invisible to other consumers after delivery. |
| `max_receives` | `integer` | `5` | — | [`Q-3`](contracts/queues.contract.md#Q-3) | Maximum delivery attempts before moving message to dead-letter queue. |
| `retention_days` | `integer` | `4` | `14` | [`Q-3`](contracts/queues.contract.md#Q-3) | Number of days unacknowledged messages are retained before automatic deletion. |
| `dlq` | `string` | — | — | [`Q-3`](contracts/queues.contract.md#Q-3) | Identifier of the dead-letter queue where failing messages are redirected. |

---

## 8. Complete Reference Manifest

Below is the complete `railfog.toml` configuring the canonical upload processing flow ([`docs/contracts/worked-example.md`](contracts/worked-example.md)):

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
