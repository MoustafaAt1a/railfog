# ADR-0001 — IsolationProvider Invocation Protocol and Multi-Tenant Sandbox Architecture

Status: Proposed Date: 2026-09-14 Raised by: architect

## Context

In `docs/contracts/platform.contract.md` PLAT-4 and PLAT-16, `IsolationProvider`
is sketched as:

```typescript
interface IsolationProvider {
  run(artifact: Artifact, limits: Limits): Promise<Result>;
}
interface ComputeProvider {
  run(artifact, limits): Promise<Result>;
}
```

In Task T-0201, `Result` was materialized as `ExecutionResult` (`statusCode`,
`headers`, `body`, `cpuTimeMs`, `wallClockMs`). However, Milestone 0.3 ("Safely
run untrusted workloads") requires executing live requests (HTTP, queue
triggers, schedule triggers per FN-1, FN-2, FN-8) inside sandboxed isolates
without state bleeding across invocations (FN-6). The contract does not specify:

1. How invocation request payloads (HTTP method, URL, headers, body) are passed
   to `run()`.
2. How the host data plane injects pre-scoped capability bindings (`kv`,
   `objects`, `queues`, `env` per PLAT-6, PLAT-15, FN-4) into an isolated
   sandbox across a process/container boundary without giving untrusted code
   direct host memory access.
3. How `IsolationProvider` adapters (`LocalIsolation`, `ProcessIsolation`,
   `GVisorIsolation`) are structured to satisfy PLAT-17 (local/production
   parity) on development machines (Windows, macOS) and production
   (Linux/gVisor).

## Decision

1. Extend `run` in `IsolationProvider` and `ComputeProvider` with an optional
   `invocation?: InvocationRequest` parameter:

```typescript
export interface InvocationRequest {
  requestId: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}
```

If `invocation` is omitted, the provider defaults to an empty GET request,
maintaining 100% backward compatibility with T-0201 conforming mocks.

2. Sandboxed execution architecture (PLAT-4, PLAT-17):

- `LocalIsolation`: In-process/worker execution for local development and unit
  tests (`rail dev`), matching PLAT-17 ("Local: none (trusted dev machine)").
- `ProcessIsolation`: Multi-process sandboxing using Deno subprocesses
  (`Deno.Command`) with restrictive flags (`--no-prompt`, `--deny-read`,
  `--deny-write`, `--allow-net=<egress-proxy>`). Communication between host and
  sandbox occurs over standard I/O (stdin/stdout JSON-RPC protocol), preventing
  untrusted customer code from holding references to host memory.
- `GVisorIsolation`: Production adapter wrapping OCI/`runsc` container
  execution. In environments where `runsc` is unavailable (e.g. Windows host),
  it provides structural validation, OCI bundle generation, and safe emulation
  for testing.

3. Warm Isolate Lifecycle (FN-6): An isolate instance is cached and reused
   exclusively for the same Function and Revision
   (`{project}:{function}:{revision}`). Fresh `RailFogContext` and invocation
   credentials are injected on each invocation message across the IPC channel.
   Any attempt to reuse an isolate across distinct revisions, functions, or
   projects is strictly rejected.

## Alternatives considered

- **Passing invocation parameters inside `Artifact`**: Rejected because
  `Artifact` is an immutable, content-addressed deployment bundle (PLAT-3,
  OBJ-4). Mutating it per request violates immutability and cacheability.
- **Host-level TCP HTTP loopback server for IPC**: Rejected because exposing
  internal host TCP ports creates unnecessary SSRF risk and port management
  complexity. Standard I/O (stdin/stdout pipes) provides strict process-bound
  isolation with zero network surface.

## Consequences

- `primitives/compute/compute-provider.ts` can define `InvocationRequest` and
  make the 3rd parameter optional on `run(...)`, preserving all existing tests.
- Milestone 0.3 tasks can implement `LocalIsolation`, `ProcessIsolation`, and
  `GVisorIsolation` with unambiguous interfaces.
- The runtime data plane cleanly delegates execution to `IsolationProvider`
  without violating PLAT-1 or PLAT-4.

## Spec references

`PLAT-4`, `PLAT-5`, `PLAT-6`, `PLAT-16`, `PLAT-17`, `FN-1`, `FN-4`, `FN-5`,
`FN-6`, `FN-8`.
