# Infrastructure & Packaging (`infra/`)

> [!NOTE]
> **Packaging**: Standalone Deno Container Images &nbsp;|&nbsp;
> **Specification**: [PLAT-1 (Modular Monolith)](../docs/contracts/platform.contract.md#PLAT-1), [PLAT-8 (Fail-Static)](../docs/contracts/platform.contract.md#PLAT-8) &nbsp;|&nbsp;
> **Deployment Targets**: Docker, Railway, Fly.io, Kubernetes

Production container packaging, orchestration manifests, and deployment specifications for RailFog.

---

## 1. Two-Process Deployment Model (`PLAT-1`)

Regardless of the number of internal packages or modules, RailFog packages and deploys into two independent container images:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        PHYSICAL DEPLOYMENT TOPOLOGY                    │
│                                                                        │
│   ┌───────────────────────────────┐   ┌──────────────────────────────┐ │
│   │        railfog-runtime        │   │        railfog-control       │ │
│   │    (infra/Dockerfile.runtime) │   │    (infra/Dockerfile.control)│ │
│   ├───────────────────────────────┤   ├──────────────────────────────┤ │
│   │ • Data Plane Daemon           │   │ • Control Plane Daemon       │ │
│   │ • Sandboxed Isolates (PLAT-4) │   │ • Revisions & Snapshots      │ │
│   │ • Fail-Static Cache (PLAT-8)  │   │ • Capability Resolver (PLAT-6│ │
│   │ • Port: 8080 (or UDS socket)  │   │ • Port: 8081                 │ │
│   └───────────────────────────────┘   └──────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Infrastructure Files

| File | Purpose |
|---|---|
| [`Dockerfile.control`](Dockerfile.control) | Minimal standalone Deno container build for `railfog-control` (`apps/api`). |
| [`Dockerfile.runtime`](Dockerfile.runtime) | Minimal standalone Deno container build for `railfog-runtime` (`apps/runtime`). |
| [`docker-compose.yaml`](docker-compose.yaml) | Local multi-container orchestration demonstrating fail-static operation during control plane outages. |
| [`fly.toml`](fly.toml) | Fly.io deployment manifest for edge hosting. |
| [`railway/`](railway/) | Complete Infrastructure as Code (IaC) packaging for Railway, including Terraform and TypeScript IaC. |

---

## 3. Running Locally with Docker Compose

```bash
# Start both control plane and runtime daemons
docker compose -f infra/docker-compose.yaml up -d

# Verify health probes
curl -f http://localhost:8080/healthz  # Data Plane Runtime
curl -f http://localhost:8081/healthz  # Control Plane API

# Test fail-static resilience (PLAT-8):
docker compose -f infra/docker-compose.yaml stop control
# Runtime continues serving traffic without degradation from cached snapshots
curl -f http://localhost:8080/healthz
```
