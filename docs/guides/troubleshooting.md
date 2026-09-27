# Troubleshooting & Diagnostics Guide

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-12`](../contracts/platform.contract.md#PLAT-12),
> [`PLAT-13`](../contracts/platform.contract.md#PLAT-13) &nbsp;|&nbsp; **CLI
> Diagnostic Commands**: `rail doctor`, `rail check`, `rail logs`

This guide explains how to diagnose issues, interpret error codes, and
troubleshoot failures in RailFog.

---

## 1. Built-in Diagnostic Commands

### 1.1 Platform Health Check (`rail doctor`)

Run `rail doctor` to verify local toolchain health, dependencies, and execution
performance:

```bash
rail doctor
```

Sample output:

```text
RailFog Doctor — Platform Diagnostics
  [✓] Deno Runtime:        v2.0.4 (x86_64-apple-darwin)
  [✓] File Permissions:   Read/Write allowed
  [✓] Network Access:     Outbound HTTP operational
  [✓] Local Storage:      SQLite (.railfog/local/state.db) write test passed
  [✓] Isolate Sandbox:    Warm-start isolate compiled in 11ms
```

---

### 1.2 Configuration & Pre-Deploy Scan (`rail check`)

Statically inspects your project manifest and function source code:

```bash
rail check
```

Catches syntax errors, route collisions, missing entrypoints, and undeclared
secret references before deployment.

---

### 1.3 Streaming Runtime Logs (`rail logs`)

Stream and filter live structured JSON logs:

```bash
# Follow live logs in real time
rail logs --follow

# Filter by log level
rail logs --level error

# Filter by specific function
rail logs --function api
```

Logs include the correlation ULID (`requestId`) and automatically redact
sensitive secrets (`PLAT-13`).

---

## 2. Resolving Common Platform Errors (`PLAT-12`)

### `RESOURCE_NOT_FOUND` (`404`)

- **Cause**: Incoming request did not match any declared `[[routes]]` pattern,
  or requested project/function is inactive.
- **Solution**:
  1. Run `rail simulate --path <url>` to verify pattern specificity and
     matching.
  2. Confirm the function is listed under `[functions.<name>]` in
     `railfog.toml`.
  3. Ensure a live revision is active via `rail status`.

---

### `PERMISSION_DENIED` (`403`)

- **Cause**: A function attempted to access a KV namespace, Object bucket,
  Queue, or Secret that was not declared in its `permissions` table (`PLAT-6`,
  `PLAT-15`).
- **Solution**:
  1. Check the function declaration in `railfog.toml`.
  2. Ensure the required resource is listed in `permissions.kv`,
     `permissions.objects`, `permissions.queues`, or `permissions.secrets`.
  3. Note: Ambient `Deno.env` is restricted; access secrets through
     `c.env.get("KEY")`.

---

### `RATE_LIMITED` (`429`)

- **Cause**: Inbound request concurrency exceeded the function's configured
  `limits.concurrency` ceiling, or client IP exhausted Gateway token bucket
  (`PLAT-9`).
- **Solution**:
  1. Inspect the `Retry-After` response header and implement backoff on client
     callers.
  2. Increase `concurrency` under `[functions.<name>.limits]` in `railfog.toml`
     if your infrastructure can support higher load.

---

### `TIMEOUT` (`504`)

- **Cause**: Wall-clock execution exceeded the configured `timeout_ms` limit
  (default: 30,000 ms for HTTP; 900,000 ms for queues) (`FN-5`).
- **Solution**:
  1. Optimize database queries or avoid slow blocking operations.
  2. Use `ctx.timeRemaining()` inside long-running handlers to gracefully abort
     before the hard deadline:
     ```typescript
     if (ctx.timeRemaining() < 500) {
       return c.json({ error: "Operation taking too long" }, 504);
     }
     ```
  3. Offload multi-second workloads to [Queues](queues.md).

---

### `CONFLICT` (`409`)

- **Cause**: Optimistic concurrency version mismatch during
  `kv.atomic().check().set().commit()` (`KV-3`).
- **Solution**:
  1. Retry the mutation using `@railfog/sdk`'s `mutate()` helper, which
     automatically re-fetches and retries with exponential jitter.

---

### Egress Blocked / SSRF Connection Refused (`PLAT-5`)

- **Cause**: Function attempted an outbound HTTP/TCP request to a blocked
  non-routable address (loopback `127.0.0.0/8`, private RFC 1918 subnets,
  Carrier-Grade NAT `100.64.0.0/10`, IPv6 ULA `fc00::/7`, or cloud metadata
  `169.254.169.254`).
- **Solution**:
  1. Outbound egress to private/internal networks is prohibited by contract to
     protect infrastructure security.
  2. Target public internet APIs or connect through an authorized external
     gateway.

---

## Next Steps

- Explore the [Complete Error Code Reference](../reference/error-codes.md).
- Review [Resource Limits & Ceilings](../reference/limits.md).
