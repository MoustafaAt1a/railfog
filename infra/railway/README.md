# Railway Infrastructure as Code (`infra/railway/`)

Declarative Infrastructure as Code (IaC) packaging for deploying the RailFog edge compute platform to [Railway](https://railway.com) per [`PLAT-1`](file:///C:/FM/railfog/docs/contracts/platform.contract.md#L11).

---

## Topology Architecture

RailFog maintains a strict two-process deployment model (`PLAT-1`):

```
┌─────────────────────────────────────────────────────────────┐
│                       Railway Project                       │
│                                                             │
│  ┌───────────────────────┐       ┌───────────────────────┐  │
│  │   railfog-runtime     │       │    railfog-control    │  │
│  │      (Port 8080)      │       │      (Port 8081)      │  │
│  │  - Live HTTP ingress  │       │  - Deployments & CAS  │  │
│  │  - Sandboxed isolates │       │  - Revisions & state  │  │
│  │  - Snapshot cache     │──────>│  - Private network    │  │
│  └───────────────────────┘       └───────────────────────┘  │
│              ▲                               ▲              │
│              │                               │              │
└──────────────┼───────────────────────────────┼──────────────┘
               │                               │
        Public Traffic               Cloudflare Backing
     (railfog.up.railway.app)       (KV, R2, Queues)
```

---

## Deployment Methods

You can provision and manage RailFog on Railway using **Railway IaC**, **Terraform**, or the **Railway CLI**.

### Method 1: Railway Infrastructure as Code (Recommended)

Railway's native TypeScript IaC configuration lives at [`.railway/railway.ts`](file:///C:/FM/railfog/.railway/railway.ts).

1. **Install Railway CLI**:
   ```bash
   npm i -g @railway/cli
   railway login
   ```

2. **Link or initialize your project**:
   ```bash
   railway link
   ```

3. **Plan infrastructure changes**:
   ```bash
   railway config plan
   ```

4. **Apply configuration**:
   ```bash
   railway config apply
   ```

---

### Method 2: Terraform IaC

The directory contains complete Terraform declarations ([`main.tf`](file:///C:/FM/railfog/infra/railway/main.tf), [`variables.tf`](file:///C:/FM/railfog/infra/railway/variables.tf)):

1. **Navigate to the Railway Terraform directory**:
   ```bash
   cd infra/railway
   ```

2. **Configure your secrets**:
   ```bash
   cp terraform.tfvars.example terraform.tfvars
   ```
   Fill in your `railway_api_token` and Cloudflare credentials in `terraform.tfvars`.

3. **Initialize and provision**:
   ```bash
   terraform init
   terraform plan
   terraform apply
   ```

4. **Outputs**:
   Terraform outputs the generated `runtime_public_domain` for live HTTP traffic.

---

### Method 3: Railway Dashboard (GitHub Direct)

1. Open your project in the [Railway Dashboard](https://railway.com/dashboard).
2. Click **New Service** → **GitHub Repo** → select `MoustafaAt1a/railfog`.
3. Create two services:
   * **`railfog-control`**:
     * Build Setting → Dockerfile Path: `infra/Dockerfile.control`
     * Variables: `PORT=8081`, `DENO_ENV=production`, plus Cloudflare credentials.
     * Networking: Enable private networking.
   * **`railfog-runtime`**:
     * Build Setting → Dockerfile Path: `infra/Dockerfile.runtime`
     * Variables: `PORT=8080`, `DENO_ENV=production`, `RAILFOG_CONTROL_URL=http://${{railfog-control.RAILWAY_PRIVATE_DOMAIN}}:8081`.
     * Networking: Generate public domain.

---

## Required Environment Variables

Both services share the Cloudflare storage credentials configured in `.env`:

| Variable | Description | Source |
|---|---|---|
| `PORT` | Service bind port (`8080` for runtime, `8081` for control) | Configured in IaC |
| `DENO_ENV` | Runtime mode (`production`) | Configured in IaC |
| `RAILFOG_CONTROL_URL` | Private URL of control plane daemon | Injected via Railway private domain |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID | Set in Railway variables |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token (KV, R2, Queues) | Set in Railway variables |
| `CLOUDFLARE_KV_NAMESPACE_ID` | Cloudflare KV namespace ID | Set in Railway variables |
| `CLOUDFLARE_R2_BUCKET` | Cloudflare R2 bucket name | Set in Railway variables |
| `CLOUDFLARE_QUEUE_NAME` | Cloudflare Queue name | Set in Railway variables |

---

## Verification & Health Probes

Once deployed, verify that both daemons report healthy (`PLAT-1`):

```bash
# Verify runtime data plane
curl -f https://<runtime-public-domain>/healthz

# Output:
# {"status":"ok","service":"railfog-runtime"}
```

Deploy functions remotely using the RailFog CLI:
```bash
rail deploy --control-url https://<control-plane-url>
rail logs --control-url https://<control-plane-url>
```
