# Global Multi-Region & Edge Deployment Blueprint

> [!NOTE]
> **Documentation**: [Architecture Home](overview.md) &nbsp;|&nbsp; **Specification**:
> [PLAT-1 (Modular Monolith)](../contracts/platform.contract.md#PLAT-1),
> [PLAT-8 (Fail-Static)](../contracts/platform.contract.md#PLAT-8),
> [PLAT-10 (High Availability)](../contracts/platform.contract.md#PLAT-10)

RailFog's lightweight, standalone runtime daemon (`apps/runtime`) is designed for
effortless global geo-distribution. Unlike monolithic cloud platforms requiring
hundreds of proprietary AWS or Cloudflare services, RailFog can be deployed
globally in minutes using any standard container or cloud host (Railway, Fly.io,
AWS Fargate, or Bare Metal).

---

## 1. Global Topology Architecture

```mermaid
flowchart TD
    Client["Global Users & Clients"] --> Anycast["Global Anycast Layer (Cloudflare / Fastly / Route53)"]
    
    subgraph RegionUS["US-East (Primary Edge Station)"]
        GW_US["Ingress Gateway (apps/gateway)"]
        RT_US["Data Plane Runtime (apps/runtime)"]
        WK_US["Worker Daemon (apps/worker)"]
        GW_US --> RT_US
        RT_US --> WK_US
    end

    subgraph RegionEU["EU-Central (Secondary Edge Station)"]
        GW_EU["Ingress Gateway (apps/gateway)"]
        RT_EU["Data Plane Runtime (apps/runtime)"]
        WK_EU["Worker Daemon (apps/worker)"]
        GW_EU --> RT_EU
        RT_EU --> WK_EU
    end

    subgraph RegionAP["AP-Southeast (Edge Station)"]
        GW_AP["Ingress Gateway (apps/gateway)"]
        RT_AP["Data Plane Runtime (apps/runtime)"]
        WK_AP["Worker Daemon (apps/worker)"]
        GW_AP --> RT_AP
        RT_AP --> WK_AP
    end

    Anycast -->|Geo-Routed| GW_US
    Anycast -->|Geo-Routed| GW_EU
    Anycast -->|Geo-Routed| GW_AP

    subgraph SharedControl["Control Plane & Shared State"]
        CP["Control Plane Daemon (apps/api)"]
        PG[("PostgreSQL (Metadata & KV Primary)")]
        RD[("Redis (Queues Broker)")]
        S3[("S3 / R2 Object Storage")]
    end

    RT_US -.->|Poll Snapshot (PLAT-8)| CP
    RT_EU -.->|Poll Snapshot (PLAT-8)| CP
    RT_AP -.->|Poll Snapshot (PLAT-8)| CP

    RT_US --> PG
    RT_EU --> PG
    RT_AP --> PG

    RT_US --> S3
    RT_EU --> S3
    RT_AP --> S3
```

---

## 2. Key Resilience Properties

### 2.1 Fail-Static Autonomous Survivability (`PLAT-8`)

Each edge station caches the latest verified snapshot on disk and in frozen RAM:
- If the central PostgreSQL database or Control Plane API becomes temporarily
  unreachable or experiences a network partition, **edge data planes continue
  serving read and write traffic without interruption**.
- No runtime request depends on synchronous communication with the control
  plane.

### 2.2 Sub-Millisecond Isolate Hot-Reload

When a new revision is deployed via `rail deploy`:
- The Control Plane signs the deployment manifest with SHA-256 and flips the
  atomic revision pointer in PostgreSQL.
- Distributed edge daemons detect the new revision on their periodic poll
  (default: 5 seconds) and hot-swap the in-memory route tree with zero dropped
  connections.

### 2.3 Direct Storage Offloading (`OBJ-3`)

Large static assets, file uploads, and media never traverse edge compute
daemons. Edge nodes generate time-limited presigned URLs pointing directly to
geographically closest S3 / Cloudflare R2 bucket endpoints.

---

## 3. Recommended Edge Hosting Providers

### Option A: Railway (Fastest Setup)
- **Control Plane**: Deploy `apps/api` with PostgreSQL and Redis plugins.
- **Edge Data Planes**: Deploy `apps/runtime` in multiple Railway regions (e.g.
  `us-east4`, `europe-west4`, `asia-southeast1`).
- **Domain Routing**: Assign custom domains with Railway Anycast routing.

### Option B: Fly.io (Native Multi-Region Anycast)
- Use `fly.toml` with `primary_region = "iad"` and scale machines across
  `iad`, `fra`, `sin`. Fly automatically routes users to the nearest machine
  via BGP Anycast.

### Option C: Bare Metal / Hybrid Cloud
- Deploy containerized `railfog-runtime` instances behind HAProxy or NGINX with
  GeoDNS (Amazon Route 53 Geolocation routing or Cloudflare Load Balancing).
