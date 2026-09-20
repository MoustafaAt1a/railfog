# Infrastructure (`infra/`)

Production container packaging, orchestration, and process specs per [`PLAT-1`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L11).

## Deployment Topology

RailFog maintains a strict two-process deployment model regardless of the number of internal packages:

1. **`railfog-control`** (`Dockerfile.control`): Runs the control-plane server (`apps/api`), handling manifests, deployments, snapshot publishing, and usage metrics.
2. **`railfog-runtime`** (`Dockerfile.runtime`): Runs the data-plane server (`apps/runtime`), handling incoming function requests and serving from cached routing snapshots.

## Files

| File | Purpose |
|---|---|
| [`Dockerfile.control`](file:///C:/FM/railfog/infra/Dockerfile.control) | Standalone Deno container build for the control plane daemon |
| [`Dockerfile.runtime`](file:///C:/FM/railfog/infra/Dockerfile.runtime) | Standalone Deno container build for the data plane daemon |
| [`docker-compose.yaml`](file:///C:/FM/railfog/infra/docker-compose.yaml) | Local multi-container orchestration demonstrating fail-static operation |

## Running with Docker Compose

```bash
# Start control and runtime daemons
docker compose -f infra/docker-compose.yaml up -d

# Verify health
curl -f http://localhost:8080/healthz # Runtime
curl -f http://localhost:8081/healthz # Control Plane
```
