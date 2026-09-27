# Security Policy & Architecture

## Reporting Security Vulnerabilities

If you discover a security vulnerability in RailFog, please report it privately:

- **Email**: `MoustafaAt1a@outlook.com`
- **Subject**: `[SECURITY VULNERABILITY] <Component/Subsystem>`
- **Response Target**: Within 48 hours for triage and initial response.

Please **do not** open public GitHub issues or discussions for undisclosed security vulnerabilities. We will coordinate remediation and disclosure timelines with you.

---

## 1. Security Architecture & Threat Model

RailFog enforces zero-trust, defense-in-depth isolation across three physical and logical boundaries:

```
┌────────────────────────────────────────────────────────┐
│            1. V8 ISOLATE RUNTIME SANDBOX               │
│  • Zero ambient authority (no Deno.env, no raw disk)   │
│  • Scoped capability injection (ctx.kv, ctx.objects)   │
│  • Prototype pollution mitigation (Object.create(null))│
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│         2. PROCESS & SYSTEM CALL CONTAINMENT           │
│  • Linux namespaces + seccomp-bpf / gVisor sandboxing  │
│  • Unprivileged non-root OS user execution             │
│  • Zero cross-tenant process or isolate sharing        │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│         3. CONNECT-TIME EGRESS NETWORK FIREWALL        │
│  • Connect-time IP inspection on all outbound sockets  │
│  • SSRF filtering: RFC 1918, RFC 6598, RFC 4193, cloud │
│    metadata endpoints (169.254.169.254, fd00:ec2::/8)  │
└────────────────────────────────────────────────────────┘
```

---

## 2. Contractual Security Guarantees

Every guarantee below is enforced by formal contract specifications and verified in continuous integration:

| Guarantee | Contract Clause | Enforcement Mechanism |
|---|---|---|
| **Host Isolation** | [`PLAT-4`](docs/contracts/platform.contract.md#PLAT-4) | Customer code never executes in the host process. Sandboxes run under strict memory and CPU caps. |
| **SSRF Mitigation** | [`PLAT-5`](docs/contracts/platform.contract.md#PLAT-5) | Sockets resolve destination IPs at connect time. Private subnets, CGNAT (`100.64.0.0/10`), IPv6 ULA (`fc00::/7`), and cloud metadata IPs fail immediately with `PERMISSION_DENIED` (`403`). |
| **Capability Scoping** | [`PLAT-6`](docs/contracts/platform.contract.md#PLAT-6) | Storage bindings (`ctx.kv`, `ctx.objects`, `ctx.queues`) are pre-scoped to declared prefixes at deploy time. Unpermitted operations fail. |
| **Tenant Isolation** | [`PLAT-7`](docs/contracts/platform.contract.md#PLAT-7) | Distinct projects never share compute isolates or storage namespaces. All backend operations pass through `TenantGuard`. |
| **Secret Protection** | [`PLAT-15`](docs/contracts/platform.contract.md#PLAT-15) | Secrets are capability-scoped and injected at invocation time into `ctx.env`. Values are automatically redacted from logs and error traces. |
| **Warm Isolate Purity** | [`FN-6`](docs/contracts/functions.contract.md#FN-6) | Sequential invocations within warm isolates receive fresh `RailFogContext` instances, unique ULID request IDs, and cleared globals. |
| **Call Depth Guard** | [`FN-7`](docs/contracts/functions.contract.md#FN-7) | Internal function-to-function invocations are bounded to a maximum depth of 8 hops to prevent cascading loops. |

---

## 3. Implemented vs. Environment-Dependent Guarantees

### Implemented Everywhere (Local & Production)
- **Zero Ambient Authority**: User code cannot access `Deno.env`, local files outside its bundle, or system APIs.
- **Connect-Time IP Filtering**: Local and remote egress requests pass through `EgressIpBlocker`.
- **Automatic Secret Redaction**: All logged outputs, traces, and serialization paths pass through `SecretRedactor`.
- **Tenant Validation**: Cross-project and cross-function rollbacks or data access attempts are rejected with `RESOURCE_NOT_FOUND`.

### Environment-Dependent (Production Linux Only)
- **gVisor System Call Interception**: On Linux hosts configured with `gvisor`, application system calls are intercepted in user-space by the Sentry kernel, neutralizing kernel privilege escalation attacks.
- **Local Dev Mode (`rail dev`)**: Local development runs inside a local Deno process with restricted permissions. It is intended for rapid debugging and functional parity (`PLAT-17`), not as a secure multi-tenant production environment.

---

## 4. Operator Responsibilities

Platform operators deploying RailFog onto self-hosted or cloud infrastructure must:

1. **Terminate TLS**: Terminate HTTPS and WSS traffic upstream using a reverse proxy or load balancer.
2. **Dedicated User**: Run `railfog-runtime` and `railfog-control` daemons under a dedicated, unprivileged POSIX user (e.g. `railfog:railfog`), never `root`.
3. **Firewall Control Plane**: Restrict incoming traffic to the Control Plane port (`8082` by default) to authorized administrative networks.
4. **Secret Rotation**: Rotate storage credentials and cryptographic signing keys periodically.

---

## 5. Security Boundaries & Limitations

- **Volumetric DDoS Mitigation**: RailFog provides token-bucket rate limiting (`PLAT-9`), but volumetric Layer 3/4 network floods must be mitigated by an upstream anycast network.
- **Customer Code Bugs**: RailFog isolates customer code execution but cannot prevent logic flaws within customer application handlers.
