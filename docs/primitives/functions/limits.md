# Functions — Resource Limits & Quotas

> [!NOTE]
> **Documentation**: [Docs Home](../../README.md) &nbsp;|&nbsp;
> **Specification**: [FN-5 (Resource Limits)](../../contracts/functions.contract.md#FN-5) &nbsp;|&nbsp;
> **Enforcement**: Hard Kill-Switches (Zero Soft Limits)

Resource limits act as hard isolation and cost boundaries. Exceeding any limit results in deterministic termination or standardized error codes (`PLAT-12`).

---

## 1. Limits Configuration Matrix

Limits are configured per-function under `[functions.<name>.limits]` in `railfog.toml`:

```toml
[functions.api.limits]
cpu_ms = 200
timeout_ms = 30000
memory_mb = 128
concurrency = 50
"logs.bytes_per_invocation" = 64000
```

| Limit Key | Type | Default Value | Maximum / Ceiling | Enforcement Behavior (`FN-5`) |
|---|---|---|---|---|
| `cpu_ms` | `integer` | `200` | Custom | Hard kill when CPU execution time consumed exceeds limit, independent of wall clock. |
| `timeout_ms` | `integer` | `30000` (HTTP)<br>`900000` (Queue/Cron) | `30000` (HTTP)<br>`900000` (Queue/Cron) | Hard kill when invocation wall-clock exceeds deadline. Emits `504 TIMEOUT`. |
| `memory_mb` | `integer` | `128` | `1024` | Hard cgroup/isolate memory ceiling. Immediate isolate termination. |
| `concurrency` | `integer` | `50` | Custom | Per-function concurrency limit backed by token bucket (`PLAT-9`). Returns `429 RATE_LIMITED` with `Retry-After`. |
| `logs.bytes_per_invocation` | `integer` | `64000` | Custom | Total log payload volume per invocation. Truncated with `LOG_TRUNCATED` marker if exceeded. |

---

## 2. Execution Deadline Tracking (`FN-4`)

Inside your function handler, you can check remaining execution time using `ctx.timeRemaining()` to gracefully abort downstream tasks before the hard kill deadline:

```typescript
import type { FunctionHandler } from "@railfog/sdk";

const handler: FunctionHandler = async (req, ctx) => {
  // Check remaining wall-clock execution time
  if (ctx.timeRemaining() < 100) {
    return Response.json(
      { error: "Deadline imminent, aborting early" },
      { status: 504 },
    );
  }

  // Use ctx.timeRemaining() to configure AbortSignal for fetch
  const res = await fetch("https://api.external.com/data", {
    signal: AbortSignal.timeout(ctx.timeRemaining() - 50),
  });

  return Response.json({ ok: res.ok });
};

export default handler;
```

---

## Next Steps

- Explore the [Key-Value Primitive](../kv/overview.md).
- Review the [SDK Developer Guide](../../sdk/overview.md).
