# Resource Limits & Quotas Reference

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`FN-5`](../contracts/functions.contract.md#FN-5),
> [`FN-7`](../contracts/functions.contract.md#FN-7) &nbsp;|&nbsp;
> **Enforcement**: Hard Operational & Security Boundaries

In RailFog, resource limits are hard kill-switches and rate throttles, never
soft warnings. Exceeding any limit results in deterministic termination or
standardized machine-readable errors (`PLAT-12`).

---

## 1. Execution Ceilings Matrix (`FN-5`)

| Limit Identifier            | Default Quota                                   | Maximum Ceiling                                 | Enforcement Mechanism & Behavior                                                                    | Error Code                    |
| --------------------------- | ----------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------- |
| `cpu_ms`                    | `200 ms`                                        | Custom                                          | Hard process/thread kill when CPU time consumed exceeds limit, independent of wall clock.           | `INTERNAL`                    |
| `timeout_ms`                | `30,000 ms` (HTTP)<br>`900,000 ms` (Queue/Cron) | `30,000 ms` (HTTP)<br>`900,000 ms` (Queue/Cron) | Hard kill when wall-clock execution reaches deadline.                                               | `TIMEOUT` (`504`)             |
| `memory_mb`                 | `128 MB`                                        | `1024 MB`                                       | Hard cgroup and V8 isolate heap ceiling. Triggers immediate isolate termination.                    | `INTERNAL`                    |
| `concurrency`               | `50`                                            | Custom                                          | Per-function token bucket (`PLAT-9`). Requests beyond capacity receive HTTP 429 with `Retry-After`. | `RATE_LIMITED` (`429`)        |
| `request_body_mb`           | `10 MB`                                         | `10 MB`                                         | Maximum buffered incoming request body size.                                                        | `PAYLOAD_TOO_LARGE` (`413`)   |
| `response_body_mb`          | `10 MB`                                         | `10 MB` (Buffered)<br>`512 MB` (Streamed)       | Maximum response body size. Streamed responses can emit up to 512 MB.                               | `PAYLOAD_TOO_LARGE` (`413`)   |
| `network.connections`       | `6` concurrent                                  | `6`                                             | Maximum concurrent outbound sockets per isolate, enforced by egress proxy.                          | `RATE_LIMITED` (`429`)        |
| `logs.bytes_per_invocation` | `64,000 bytes`                                  | Custom                                          | Maximum log bytes emitted per invocation. Truncated with `LOG_TRUNCATED` marker if exceeded.        | —                             |
| `kv` ops / invocation       | `1,000`                                         | `1,000`                                         | Rejects further operations inside the same invocation.                                              | `RATE_LIMITED` (`429`)        |
| `objects` ops / invocation  | `100`                                           | `100`                                           | Rejects further operations inside the same invocation.                                              | `RATE_LIMITED` (`429`)        |
| `queue` ops / invocation    | `100`                                           | `100`                                           | Rejects further operations inside the same invocation.                                              | `RATE_LIMITED` (`429`)        |
| `call_depth_max`            | `8` hops                                        | `8`                                             | Maximum internal function-to-function recursion depth (`FN-7`).                                     | `CALL_DEPTH_EXCEEDED` (`429`) |

---

## 2. Rationale: Cost & Security Boundaries

As stated in `FN-5`:

> **These are cost _and_ security boundaries simultaneously. A limit that exists
> only for billing is a limit an attacker can ignore — never implement one as
> "soft."**

Hard limits prevent algorithmic complexity attacks, denial-of-wallet exploits,
and cascading memory leaks from affecting peer tenant isolates.
