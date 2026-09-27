# Compute Providers

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Conceptual Layer**: Compute &nbsp;|&nbsp; **Specification**:
> [`PLAT-7`](../contracts/platform.contract.md#PLAT-7),
> [`PLAT-16`](../contracts/platform.contract.md#PLAT-16),
> [`FN-1`](../contracts/functions.contract.md#FN-1) to [`FN-7`](../contracts/functions.contract.md#FN-7)

Compute providers implement the infrastructure mechanisms required to execute customer code securely within bounded resources.

In RailFog, Compute maps to the **Function** infrastructure primitive, managed via the `IsolationProvider` SPI.

---

## 1. The Isolation Provider SPI

All Compute isolation backends implement the `IsolationProvider` interface defined in `primitives/`:

```typescript
export interface IsolationProvider {
  /**
   * Spawns an isolated execution sandbox for a specific function revision.
   */
  spawn(options: SpawnOptions): Promise<SandboxInstance>;

  /**
   * Dispatches a request to an active sandbox and streams the response.
   */
  dispatch(
    instance: SandboxInstance,
    request: Request,
    context: InvocationContext,
  ): Promise<Response>;

  /**
   * Gracefully drains and terminates an isolate instance.
   */
  destroy(instance: SandboxInstance): Promise<void>;
}
```

---

## 2. Supported Implementations

### 2.1 Process Isolation (`ProcessIsolationProvider`)
- **Default for Local & Cloud Edge**: Spawns isolated Deno subprocesses or worker threads with restricted permissions.
- **Flags Applied**: `--no-read`, `--no-write`, `--no-net`, `--no-env` except for explicitly mounted temporary directories and IPC pipes.
- **Communication Channel**: Unix Domain Sockets (UDS) or named pipes for high-throughput, low-latency IPC.

### 2.2 gVisor Sandbox (`GvisorIsolationProvider`) (`PLAT-7`)
- **Adversarial Multi-Tenant Environments**: Wraps execution in user-space kernel virtualization (`runsc`).
- **Syscall Filtering**: Intercepts and filters system calls to protect the host kernel against privilege escalation or container escapes.
- **Resource Constraints**: Hard cgroups ceilings for memory (`memory.max`) and CPU quota (`cpu.max`).

---

## 3. Limit Enforcement (`FN-5`)

Compute providers strictly enforce hardware and execution ceilings:

| Metric | Default | Hard Ceiling | Provider Enforcement Mechanism |
| :--- | :--- | :--- | :--- |
| **Execution Timeout** | 15 seconds | 60 seconds (HTTP) / 900 seconds (Queue) | Wall-clock timer with SIGKILL termination |
| **Memory Allocation** | 128 MB | 512 MB | V8 heap limit (`--v8-flags=--max-old-space-size`) & cgroup limit |
| **CPU Time** | 15 seconds | 60 seconds | CFS quota / SIGXCPU signals |
| **Call Depth** | 1 | 5 levels | `x-railfog-call-depth` header inspection (`FN-7`) |

---

## 4. Capability Injection (`PLAT-6`)

Compute isolates are launched with **zero ambient authority**:
- File system access is disabled.
- Direct outbound networking is blocked by default (`PLAT-5`).
- Environment variables containing raw secrets are never passed in bulk.
- Storage and queue capabilities (`state`, `data`, `signal`) are passed via capability tokens over the private IPC channel.
