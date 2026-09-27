# Capability-Based Security

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-6`](../contracts/platform.contract.md#PLAT-6),
> [`PLAT-15`](../contracts/platform.contract.md#PLAT-15) &nbsp;|&nbsp;
> **Foundational Theory**: Saltzer & Schroeder (1975) Principle of Least
> Privilege

RailFog enforces a **Capability-Based Security Model**. Functions possess zero
ambient system authority; instead, access to storage, messaging, networks, and
secrets is explicitly resolved at deploy time into scoped client objects passed
directly to handlers.

---

## 1. Ambient Authority vs. Capability Injection

Traditional cloud platforms grant execution environments ambient credentials
(e.g. AWS instance profiles, environment variables, IAM roles). Any code running
in the process—including third-party dependencies—can read credentials and
perform unauthorized network or database calls.

RailFog eliminates ambient authority:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SANDBOX ISOLATE BOUNDARY                        │
│                                                                        │
│   ❌ Deno.env (Blocked)           ❌ Raw Sockets (Blocked)            │
│   ❌ Host Filesystem (Blocked)    ❌ Process Exit (Blocked)           │
│                                                                        │
│   ✅ Injected RailFogContext (FN-4, CONCEPT-2):                         │
│      • ctx.state  / ctx.kv      ─► Scoped to declared State namespace   │
│      • ctx.data   / ctx.objects ─► Scoped to declared Data bucket       │
│      • ctx.signal / ctx.queues  ─► Scoped to declared Signal target     │
│      • ctx.env                  ─► Scoped to declared secret keys       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Deploy-Time Resolution (`PLAT-6`)

In RailFog, permissions are evaluated **once, at deploy time**, not during the
runtime request path:

1. When `rail deploy` runs, the Control Plane inspects `railfog.toml`.
2. It compiles a capability matrix for each function.
3. If a resource is not listed in `permissions`, the corresponding binding does
   not exist on `ctx` at all.
4. Calling an undeclared resource produces an immediate TypeScript error or
   runtime `PermissionDeniedError` (`403`).

---

## 3. Scoped Secret Access (`PLAT-15`)

Secrets follow the same capability injection rules:

- Functions cannot read host environment variables (`Deno.env` is restricted).
- Functions declare secret names under `permissions.secrets`.
- `deploy-analyzer` statically inspects source code during `rail check` and
  `rail deploy` to verify that all secrets referenced via `c.env.get` or
  `c.env.require` are explicitly declared in the manifest.
- Secrets are fetched dynamically on invocation and redacted from runtime logs.

---

## 4. Why Capability Injection Wins

| Dimension            | Legacy Cloud IAM                                        | RailFog Capability Injection                             |
| -------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| **Specification**    | 50+ lines of IAM JSON with ARNs, actions, and wildcards | 3 lines of TOML in `railfog.toml`                        |
| **Enforcement**      | Runtime network calls to IAM metadata services          | Compile-time injection of scoped client objects          |
| **Credential Bleed** | Ambient credentials readable by third-party packages    | Zero ambient credentials in sandbox scope                |
| **Offline Testing**  | Impossible without cloud mocks or emulators             | Instant via in-memory mock context (`createMockContext`) |

---

## Next Steps

- Learn about [Immutable Revisions](revisions.md).
- Learn about [Provider Abstractions](providers.md).
