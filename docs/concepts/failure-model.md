# Failure Model & Reliability

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-8`](../contracts/platform.contract.md#PLAT-8),
> [`PLAT-10`](../contracts/platform.contract.md#PLAT-10),
> [`Q-3`](../contracts/queues.contract.md#Q-3) &nbsp;|&nbsp; **Philosophy**:
> Fail-Static & Fail-Closed

RailFog is architected to survive infrastructure partitions, control-plane
outages, database disconnections, and untrusted workload crashes without
cascading failures.

---

## 1. Fail-Static Data Plane (`PLAT-8`)

The live customer request path must never depend on the health of administrative
management services.

```
┌────────────────────────────────┐
│      Control Plane Daemon      │ (Outage / Network Partition)
│           [apps/api]           │
└───────────────┬────────────────┘
                │  ❌ Synchronous Remote Call (BLOCKED BY RULE)
                ▼
┌────────────────────────────────┐
│       Data Plane Daemon        │
│       (railfog-runtime)        │ ──► Continues serving 100% of live traffic
├────────────────────────────────┤     from in-memory snapshot and disk cache
│ • Local Frozen Routing Table   │
│ • Local Capability Matrix      │
│ • Pre-Warmed Sandboxes         │
└────────────────────────────────┘
```

1. **Snapshot Decoupling**: Data plane runtime nodes maintain a frozen routing
   table and compiled capability matrix in memory and atomic disk caches
   (`DiskSnapshotCache`).
2. **Autonomous Operation**: If the control plane or metadata database fails or
   undergoes maintenance, running runtime instances continue executing requests
   without downtime.
3. **No Dynamic Discovery on Hot Path**: Route matching and capability
   resolution never issue remote RPCs during request processing.

---

## 2. Provider Outage Handling & Circuit Breaking

When backing databases or cloud storage services experience latency or
degradation:

1. **Resilient Decorator**: External provider calls are wrapped with automated
   retry logic using exponential backoff with decorrelated full jitter.
2. **Circuit Breakers**: If a backing provider experiences 5 consecutive
   failures, the circuit trips open for a 30-second cooldown window. Inbound
   operations fail fast with `503 UNAVAILABLE` rather than exhausting thread
   pools and waiting for socket timeouts.

---

## 3. Poison Message Containment (`Q-3`)

In asynchronous queue processing:

- When a consumer function throws an unhandled error or exceeds its execution
  deadline, the message remains hidden on the queue for `visibility_timeout_ms`
  (default: 30s).
- The worker increments the message `attempts` counter.
- If delivery attempts reach `max_receives` (default: 5), the supervisor routes
  the message to the configured `dlq` (dead-letter queue) and acknowledges the
  primary queue, preventing infinite retry loops.

---

## 4. Graceful Shutdown & Drain Coordination

When a runtime or worker instance receives `SIGTERM` or `SIGINT`:

1. **Mark Draining**: The Ingress Gateway health check returns `503`, causing
   upstream load balancers to route new traffic to peer nodes.
2. **Drain Window**: The `ShutdownCoordinator` waits up to 10 seconds for all
   in-flight requests to complete execution.
3. **Pool Teardown**: Database connection pools, Redis clients, and file
   descriptors are closed cleanly before process termination.

---

## Next Steps

- Explore the [CLI Command Reference](../reference/cli.md).
- Review the [Error Codes Reference](../reference/error-codes.md).
