# Defense-in-Depth Isolation

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-4`, `PLAT-5`, `PLAT-7`](../contracts/platform.contract.md)
> &nbsp;|&nbsp; **Security Model**: Layered Zero-Trust Sandboxing

RailFog protects the host, platform infrastructure, and tenant boundaries
through a layered defense-in-depth architecture.

---

## 1. The Three Isolation Layers

```
┌────────────────────────────────────────────────────────┐
│             LAYER 1: V8 ISOLATE SANDBOX                │
│  • Zero ambient authority (no Deno.env, no raw disk)   │
│  • Capability-scoped bindings (ctx.state, ctx.data, ctx.signal) │
│  • Hard CPU and memory ceilings (cgroups / V8 limits)  │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│            LAYER 2: HOST PROCESS CONTAINMENT           │
│  • Deno subprocess isolation / gVisor syscall filter   │
│  • Linux namespaces & seccomp-bpf containment          │
│  • Dedicated non-root unprivileged execution user      │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│            LAYER 3: EGRESS NETWORK FIREWALL            │
│  • Connect-time IP resolution inspection               │
│  • SSRF firewall blocking metadata and private subnets │
│  • Connection count and throughput rate limiting       │
└────────────────────────────────────────────────────────┘
```

---

## 2. Egress Network Policy & SSRF Mitigation (`PLAT-5`)

Functions are prohibited from connecting to private networks, internal cloud
metadata endpoints, or Kubernetes overlay networks.

The egress firewall (`EgressIpBlocker`) resolves destination hostnames at
connect time and blocks the following IP ranges unconditionally:

| Target Range          | CIDR / Address                                  | Standard / Purpose                                                   |
| --------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| **Loopback**          | `127.0.0.0/8`, `::1/128`                        | Localhost interfaces                                                 |
| **Private Networks**  | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | RFC 1918 Private Address Space                                       |
| **Carrier-Grade NAT** | `100.64.0.0/10`                                 | RFC 6598 Shared Address Space (cloud VPCs / Kubernetes pod overlays) |
| **Link-Local**        | `169.254.0.0/16`, `fe80::/10`                   | RFC 3927 Subnets                                                     |
| **Unique Local IPv6** | `fc00::/7`                                      | RFC 4193 IPv6 ULA (covering `fc00::/8` and `fd00::/8`)               |
| **Cloud Metadata**    | `169.254.169.254`, `fd00:ec2::/8`               | AWS, GCP, Azure, and OpenStack instance metadata services            |

Attempts to connect to any blocked address fail immediately with
`PERMISSION_DENIED` (`403`).

---

## 3. Host Process Containment (`PLAT-7`)

Functions do not share operating system processes with the Data Plane or Control
Plane daemons:

- **Process Isolation**: Each tenant execution runs inside a restricted Deno
  subprocess (`--no-prompt`, restricted permissions).
- **gVisor Containment**: On Linux production hosts, `GvisorIsolationProvider`
  intercepts all application system calls in user space using a secure Sentry
  kernel, preventing host kernel privilege escalation.

---

## Next Steps

- Learn about [Consistency Tiers](consistency.md).
- Understand the [Failure Model](failure-model.md).
