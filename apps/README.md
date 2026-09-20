# Applications (`apps/`)

Deployable service entrypoints and daemon processes conforming to [`PLAT-1`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L11).

## Applications

| Application | Entry Point | Process Role | Spec References |
|---|---|---|---|
| [`apps/api`](file:///C:/FM/railfog/apps/api/mod.ts) | `mod.ts` / `server.ts` | **Control Plane (`railfog-control`)**: Deployment management, revision indexing, manifest validation, snapshot publishing, usage aggregation | [`PLAT-1`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L11), [`PLAT-3`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L35) |
| [`apps/runtime`](file:///C:/FM/railfog/apps/runtime/mod.ts) | `mod.ts` / `server.ts` | **Data Plane (`railfog-runtime`)**: High-performance HTTP request routing, sandboxed isolate execution, fail-static memory snapshot cache | [`PLAT-1`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L11), [`PLAT-8`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L129) |
| [`apps/gateway`](file:///C:/FM/railfog/apps/gateway/mod.ts) | `mod.ts` / `server.ts` | **Ingress Gateway**: Reverse proxy routing external traffic to runtime nodes, token-bucket burst shedding | [`PLAT-9`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L147), [`PLAT-10`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L168) |
| [`apps/worker`](file:///C:/FM/railfog/apps/worker/mod.ts) | `mod.ts` / `supervisor.ts` | **Background Worker**: Consumer supervisor pulling messages from queues, dispatching to worker functions, managing DLQ routing | [`Q-3`](file:///C:/FM/railfog/docs/contracts/queues.contract.md#L45), [`FN-2`](file:///C:/FM/railfog/docs/contracts/functions.contract.md#L20) |

## Operational Guidelines

- **Two-Process Topology**: In production, `apps/api` and `apps/runtime` are built into distinct container images (`infra/Dockerfile.control` and `infra/Dockerfile.runtime`).
- **Zero In-Process Coupling**: The data plane must be able to boot and serve live traffic even when the control plane process is completely unavailable (`PLAT-8`).
