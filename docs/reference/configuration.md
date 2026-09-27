# Configuration Reference (`railfog.toml`)

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-18`, `FN-1`, `FN-2`, `FN-5`, `PLAT-6`, `PLAT-11`, `KV-5`, `OBJ-1`, `Q-3`](../contracts/platform.contract.md)
> &nbsp;|&nbsp; **Schema**:
> [`schemas/railfog.schema.json`](../../schemas/railfog.schema.json)

This reference outlines all configuration tables, keys, types, limits, and
defaults supported in `railfog.toml`. The complete canonical reference is
available in [`docs/configuration-reference.md`](../configuration-reference.md).

---

## 1. Top-Level Table

```toml
name = "my-project"
```

| Key    | Type     | Required | Description                                                | Spec Anchor                                            |
| ------ | -------- | -------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| `name` | `string` | **Yes**  | Project identifier (regex: `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`) | [`PLAT-18`](../contracts/platform.contract.md#PLAT-18) |

---

## 2. Functions Table (`[functions.<name>]`)

```toml
[functions.api]
entry = "functions/api.ts"
```

| Key     | Type     | Required | Description                                                            | Spec Anchor                                       |
| ------- | -------- | -------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| `entry` | `string` | **Yes**  | Relative path to TypeScript handler file (must export default handler) | [`FN-1`](../contracts/functions.contract.md#FN-1) |

---

## 3. Triggers Table (`[functions.<name>.triggers]`)

```toml
[functions.api.triggers]
http = true
queue = "app:jobs"
schedule = "*/5 * * * *"
webhook = false
```

| Key        | Type      | Default | Description                                        | Spec Anchor                                       |
| ---------- | --------- | ------- | -------------------------------------------------- | ------------------------------------------------- |
| `http`     | `boolean` | `false` | Enables invocation via matching HTTP `[[routes]]`  | [`FN-2`](../contracts/functions.contract.md#FN-2) |
| `queue`    | `string`  | —       | Queue resource identifier to consume messages from | [`FN-2`](../contracts/functions.contract.md#FN-2) |
| `schedule` | `string`  | —       | 5-field cron expression (e.g. `"0 * * * *"`)       | [`FN-2`](../contracts/functions.contract.md#FN-2) |
| `webhook`  | `boolean` | `false` | Enables authenticated webhook receiver endpoint    | [`FN-2`](../contracts/functions.contract.md#FN-2) |

---

## 4. Capability Permissions Table (`[functions.<name>.permissions]`)

```toml
[functions.api.permissions]
kv = ["app:sessions"]
objects = ["app:uploads"]
queues = ["app:jobs"]
network = ["api.stripe.com"]
secrets = ["STRIPE_SECRET_KEY"]
```

| Key                 | Type       | Allowed Count | Description                                           | Spec Anchor                                            |
| `state` / `kv`      | `string[]` | Exactly 1     | Bound State namespace on `ctx.state` / `c.state` (or `ctx.kv`)   | [`PLAT-6`](../contracts/platform.contract.md#PLAT-6)   |
| `data` / `objects`  | `string[]` | Exactly 1     | Bound Data bucket on `ctx.data` / `c.data` (or `ctx.objects`)     | [`PLAT-6`](../contracts/platform.contract.md#PLAT-6)   |
| `signal` / `queues` | `string[]` | Exactly 1     | Bound Signal channel on `ctx.signal` / `c.signal` (or `ctx.queues`)| [`PLAT-6`](../contracts/platform.contract.md#PLAT-6)   |
| `network`           | `string[]` | Multiple      | Allowed outbound egress hostnames/IPs                 | [`PLAT-5`](../contracts/platform.contract.md#PLAT-5)   |
| `secrets`           | `string[]` | Multiple      | Allowed secret identifiers accessed via `c.env`       | [`PLAT-15`](../contracts/platform.contract.md#PLAT-15) |

---

## 5. Execution Limits Table (`[functions.<name>.limits]`)

```toml
[functions.api.limits]
cpu_ms = 200
timeout_ms = 30000
memory_mb = 128
concurrency = 50
"logs.bytes_per_invocation" = 64000
```

| Key                         | Type      | Default                           | Maximum            | Description                                          | Spec Anchor                                          |
| --------------------------- | --------- | --------------------------------- | ------------------ | ---------------------------------------------------- | ---------------------------------------------------- |
| `cpu_ms`                    | `integer` | `200`                             | Custom             | Hard kill when CPU execution time exceeds limit      | [`FN-5`](../contracts/functions.contract.md#FN-5)    |
| `timeout_ms`                | `integer` | `30000` (HTTP) / `900000` (Queue) | `30000` / `900000` | Hard kill when wall-clock execution exceeds deadline | [`FN-5`](../contracts/functions.contract.md#FN-5)    |
| `memory_mb`                 | `integer` | `128`                             | `1024`             | Hard cgroup/isolate memory ceiling                   | [`FN-5`](../contracts/functions.contract.md#FN-5)    |
| `concurrency`               | `integer` | `50`                              | Custom             | Maximum concurrent invocations (token bucket)        | [`PLAT-9`](../contracts/platform.contract.md#PLAT-9) |
| `logs.bytes_per_invocation` | `integer` | `64000`                           | Custom             | Max log volume before truncation                     | [`FN-5`](../contracts/functions.contract.md#FN-5)    |

---

## 6. Routes Table (`[[routes]]`)

```toml
[[routes]]
pattern = "/api/v1/users/:id"
function = "users"
```

| Key        | Type     | Required | Description                                                   | Spec Anchor                                            |
| ---------- | -------- | -------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| `pattern`  | `string` | **Yes**  | URL path pattern matching incoming requests                   | [`PLAT-11`](../contracts/platform.contract.md#PLAT-11) |
| `function` | `string` | **Yes**  | Target function name matching a declared `[functions.<name>]` | [`PLAT-11`](../contracts/platform.contract.md#PLAT-11) |

---

## 7. Backing Resources

### `[kv.<name>]`

- `consistency = "strong" | "eventual"` (`KV-5`)

### `[objects.<name>]`

- Declares object storage bucket (`OBJ-1`)

### `[queues.<name>]`

- `visibility_timeout_ms = 30000` (`Q-3`)
- `max_receives = 5` (`Q-3`)
- `retention_days = 4` (max `14`) (`Q-3`)
- `dlq = "<dlq-name>"` (`Q-3`)
