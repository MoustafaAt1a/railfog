# Configuration Manifest Reference (`railfog.toml`)

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [PLAT-18, FN-1, FN-2, FN-5, PLAT-6, PLAT-11, KV-5, OBJ-1, Q-3](../contracts/platform.contract.md)
> &nbsp;|&nbsp; **Validation**: Strict Deploy-Time Schema

This document is the authoritative reference for every configuration table, key,
type, limit, and default supported in `railfog.toml`.

---

## 1. Top-Level Table

```toml
name = "upload-demo"
```

| Property | Type     | Required | Default | Spec Anchor                                            | Description                                                                                                                                                                         |
| -------- | -------- | -------- | ------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`   | `string` | **Yes**  | —       | [`PLAT-18`](../contracts/platform.contract.md#PLAT-18) | Project resource identifier. Defines the tenancy boundary: `Organization -> Project -> { Function, KV, Objects, Queues }`. Storage keys and namespaces are prefixed with this name. |

---

## 2. Functions Table (`[functions.<name>]`)

```toml
[functions.api]
entry = "functions/api.ts"
```

| Property | Type     | Required | Spec Anchor                                       | Description                                                                                                                                                       |
| -------- | -------- | -------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry`  | `string` | **Yes**  | [`FN-1`](../contracts/functions.contract.md#FN-1) | Relative path to the TypeScript source file. Must export a default handler function. Directory traversal escaping project root (`..`) is rejected at deploy time. |

---

## 3. Triggers Table (`[functions.<name>.triggers]`)

All workloads are modeled as **Trigger -> Function**
([`PLAT-2`](../contracts/platform.contract.md#PLAT-2),
[`FN-2`](../contracts/functions.contract.md#FN-2)).

```toml
[functions.processor.triggers]
http = false
queue = "app:jobs"
schedule = "*/5 * * * *"
webhook = false
```

| Property   | Type      | Default | Spec Anchor                                       | Description                                                                  |
| ---------- | --------- | ------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `http`     | `boolean` | `false` | [`FN-2`](../contracts/functions.contract.md#FN-2) | Enables HTTP request invocation via matching `[[routes]]` patterns.          |
| `queue`    | `string`  | —       | [`FN-2`](../contracts/functions.contract.md#FN-2) | Queue resource name to consume messages from.                                |
| `schedule` | `string`  | —       | [`FN-2`](../contracts/functions.contract.md#FN-2) | Standard 5-field cron expression (e.g. `"*/5 * * * *"`) for scheduled ticks. |
| `webhook`  | `boolean` | `false` | [`FN-2`](../contracts/functions.contract.md#FN-2) | Exposes function as an authenticated webhook receiver.                       |

---

## 4. Capability Permissions Table (`[functions.<name>.permissions]`)

Enforces capability-based security
([`PLAT-6`](../contracts/platform.contract.md#PLAT-6),
[`PLAT-15`](../contracts/platform.contract.md#PLAT-15)). Permissions are
resolved once, at deploy time.

```toml
[functions.api.permissions]
kv = ["app:sessions"]
objects = ["app:uploads"]
queues = ["app:jobs"]
network = ["api.example.com"]
secrets = ["STRIPE_SECRET_KEY"]
```

| Property  | Type       | Count     | Spec Anchor                                            | Description                                                                                                                   |
| --------- | ---------- | --------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `kv`      | `string[]` | Exactly 1 | [`PLAT-6`](../contracts/platform.contract.md#PLAT-6)   | Declared KV namespace bound to `ctx.kv`.                                                                                      |
| `objects` | `string[]` | Exactly 1 | [`PLAT-6`](../contracts/platform.contract.md#PLAT-6)   | Declared Object bucket bound to `ctx.objects`.                                                                                |
| `queues`  | `string[]` | Exactly 1 | [`PLAT-6`](../contracts/platform.contract.md#PLAT-6)   | Declared target Queue bound to `ctx.queues`.                                                                                  |
| `network` | `string[]` | Multiple  | [`PLAT-5`](../contracts/platform.contract.md#PLAT-5)   | Hostname or IP allowlist for outbound egress. SSRF firewall blocks loopback, private subnets, link-local, and cloud metadata. |
| `secrets` | `string[]` | Multiple  | [`PLAT-15`](../contracts/platform.contract.md#PLAT-15) | Encrypted secret identifiers accessible via `ctx.env`. Must be valid C-style identifiers (`^[A-Za-z_][A-Za-z0-9_]*$`).        |

---

## 5. Limits Table (`[functions.<name>.limits]`)

Resource limits are hard kill-switches, never soft warnings
([`FN-5`](../contracts/functions.contract.md#FN-5)).

```toml
[functions.api.limits]
cpu_ms = 200
timeout_ms = 30000
memory_mb = 128
concurrency = 50
"logs.bytes_per_invocation" = 64000
```

| Limit Key                   | Type      | Default Value                           | Maximum                                 | Spec Anchor                                       | Behavior                                                                         |
| --------------------------- | --------- | --------------------------------------- | --------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `cpu_ms`                    | `integer` | `200`                                   | Custom                                  | [`FN-5`](../contracts/functions.contract.md#FN-5) | Hard kill when CPU time consumed exceeds limit.                                  |
| `timeout_ms`                | `integer` | `30000` (HTTP)<br>`900000` (Queue/Cron) | `30000` (HTTP)<br>`900000` (Queue/Cron) | [`FN-5`](../contracts/functions.contract.md#FN-5) | Hard kill when wall-clock execution exceeds deadline. Returns `TIMEOUT`.         |
| `memory_mb`                 | `integer` | `128`                                   | `1024`                                  | [`FN-5`](../contracts/functions.contract.md#FN-5) | Hard cgroup/isolate memory ceiling. Immediate isolate termination.               |
| `concurrency`               | `integer` | `50`                                    | Custom                                  | [`FN-5`](../contracts/functions.contract.md#FN-5) | Concurrency limit backed by token bucket (`PLAT-9`). Returns `429 RATE_LIMITED`. |
| `logs.bytes_per_invocation` | `integer` | `64000`                                 | Custom                                  | [`FN-5`](../contracts/functions.contract.md#FN-5) | Total log volume per invocation. Truncated with `LOG_TRUNCATED` marker.          |

---

## 6. Routes Table (`[[routes]]`)

Maps incoming HTTP paths to target functions
([`PLAT-11`](../contracts/platform.contract.md#PLAT-11)).

```toml
[[routes]]
pattern = "/api/users"
function = "api"

[[routes]]
pattern = "/api/*"
function = "api"
```

| Property   | Type     | Required | Description                                                                       |
| ---------- | -------- | -------- | --------------------------------------------------------------------------------- |
| `pattern`  | `string` | **Yes**  | URL pattern matching incoming paths (supports literal segments and wildcard `*`). |
| `function` | `string` | **Yes**  | Target function name declared in `[functions.<name>]`.                            |

---

## 7. Storage Resources

### 7.1 Key-Value (`[kv.<name>]`)

```toml
[kv."app:files"]
consistency = "strong"
```

| Property      | Type     | Values                     | Spec Anchor                                | Description                                                                        |
| ------------- | -------- | -------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `consistency` | `string` | `"strong"` \| `"eventual"` | [`KV-5`](../contracts/kv.contract.md#KV-5) | `strong` (linearizable per-key, atomic CAS) or `eventual` (replicated edge cache). |

### 7.2 Objects (`[objects.<name>]`)

```toml
[objects."app:uploads"]
```

### 7.3 Queues (`[queues.<name>]`)

```toml
[queues."app:jobs"]
visibility_timeout_ms = 30000
max_receives = 5
retention_days = 4
dlq = "app:jobs-dlq"
```

| Property                | Type      | Default | Maximum | Spec Anchor                                  | Description                                |
| ----------------------- | --------- | ------- | ------- | -------------------------------------------- | ------------------------------------------ |
| `visibility_timeout_ms` | `integer` | `30000` | —       | [`Q-3`](../contracts/queues.contract.md#Q-3) | Message hidden duration while in progress. |
| `max_receives`          | `integer` | `5`     | —       | [`Q-3`](../contracts/queues.contract.md#Q-3) | Delivery attempts before DLQ relocation.   |
| `retention_days`        | `integer` | `4`     | `14`    | [`Q-3`](../contracts/queues.contract.md#Q-3) | Message retention days before expiration.  |
| `dlq`                   | `string`  | —       | —       | [`Q-3`](../contracts/queues.contract.md#Q-3) | Dead-letter queue target name.             |
