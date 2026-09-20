# spec: contracts/platform.contract.md#PLAT-1 — Stage 1 deployment topology: two processes (control on 8081, runtime on 8080)
# spec: contracts/platform.contract.md#PLAT-4 — Isolation, defense in depth, unprivileged execution
# spec: contracts/platform.contract.md#PLAT-8 — Fail-static snapshot distribution and private networking
# spec: contracts/platform.contract.md#PLAT-15 — Dynamic secret injection at invocation time
# spec: contracts/platform.contract.md#PLAT-19 — Repository packaging structure: infra/railway

terraform {
  required_version = ">= 1.3.0"
  required_providers {
    railway = {
      source  = "terraform-community-providers/railway"
      version = "~> 0.4.0"
    }
  }
}

provider "railway" {
  token = var.railway_api_token
}

# 1. Project definition
resource "railway_project" "railfog" {
  name        = var.project_name
  description = "RailFog Edge Compute Platform - Minimalist Trigger-Function Architecture"
}

# 2. Control Plane Service (railfog-control on port 8081)
# spec: contracts/platform.contract.md#PLAT-1 — Never executes customer code
resource "railway_service" "control" {
  name       = "railfog-control"
  project_id = railway_project.railfog.id

  source_repo = "MoustafaAt1a/railfog"
}

resource "railway_variable" "control_port" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.control.id
  name           = "PORT"
  value          = "8081"
}

resource "railway_variable" "control_deno_env" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.control.id
  name           = "DENO_ENV"
  value          = "production"
}

resource "railway_variable" "control_dockerfile" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.control.id
  name           = "RAILWAY_DOCKERFILE_PATH"
  value          = "infra/Dockerfile.control"
}

resource "railway_variable" "control_healthcheck" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.control.id
  name           = "RAILWAY_HEALTHCHECK_TIMEOUT_SEC"
  value          = "300"
}

resource "railway_variable" "control_cf_account" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.control.id
  name           = "CLOUDFLARE_ACCOUNT_ID"
  value          = var.cloudflare_account_id
}

resource "railway_variable" "control_cf_token" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.control.id
  name           = "CLOUDFLARE_API_TOKEN"
  value          = var.cloudflare_api_token
}

resource "railway_variable" "control_cf_kv" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.control.id
  name           = "CLOUDFLARE_KV_NAMESPACE_ID"
  value          = var.cloudflare_kv_namespace_id
}

resource "railway_variable" "control_cf_r2" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.control.id
  name           = "CLOUDFLARE_R2_BUCKET"
  value          = var.cloudflare_r2_bucket
}

resource "railway_variable" "control_cf_queue" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.control.id
  name           = "CLOUDFLARE_QUEUE_NAME"
  value          = var.cloudflare_queue_name
}

# 3. Data Plane Runtime Service (railfog-runtime on port 8080)
# spec: contracts/platform.contract.md#PLAT-1 — Live HTTP traffic ingress
resource "railway_service" "runtime" {
  name       = "railfog-runtime"
  project_id = railway_project.railfog.id

  source_repo = "MoustafaAt1a/railfog"
}

resource "railway_variable" "runtime_port" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.runtime.id
  name           = "PORT"
  value          = "8080"
}

resource "railway_variable" "runtime_deno_env" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.runtime.id
  name           = "DENO_ENV"
  value          = "production"
}

resource "railway_variable" "runtime_dockerfile" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.runtime.id
  name           = "RAILWAY_DOCKERFILE_PATH"
  value          = "infra/Dockerfile.runtime"
}

resource "railway_variable" "runtime_healthcheck" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.runtime.id
  name           = "RAILWAY_HEALTHCHECK_TIMEOUT_SEC"
  value          = "300"
}

# spec: contracts/platform.contract.md#PLAT-1, PLAT-8 — Runtime references control plane via private domain
resource "railway_variable" "runtime_control_url" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.runtime.id
  name           = "RAILFOG_CONTROL_URL"
  value          = "http://$${{railfog-control.RAILWAY_PRIVATE_DOMAIN}}:8081"
}

resource "railway_variable" "runtime_cf_account" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.runtime.id
  name           = "CLOUDFLARE_ACCOUNT_ID"
  value          = var.cloudflare_account_id
}

resource "railway_variable" "runtime_cf_token" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.runtime.id
  name           = "CLOUDFLARE_API_TOKEN"
  value          = var.cloudflare_api_token
}

resource "railway_variable" "runtime_cf_kv" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.runtime.id
  name           = "CLOUDFLARE_KV_NAMESPACE_ID"
  value          = var.cloudflare_kv_namespace_id
}

resource "railway_variable" "runtime_cf_r2" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.runtime.id
  name           = "CLOUDFLARE_R2_BUCKET"
  value          = var.cloudflare_r2_bucket
}

resource "railway_variable" "runtime_cf_queue" {
  project_id     = railway_project.railfog.id
  environment_id = railway_project.railfog.default_environment.id
  service_id     = railway_service.runtime.id
  name           = "CLOUDFLARE_QUEUE_NAME"
  value          = var.cloudflare_queue_name
}

# 4. Public Gateway Ingress Domain for Runtime
resource "railway_service_domain" "runtime_domain" {
  service_id     = railway_service.runtime.id
  environment_id = railway_project.railfog.default_environment.id
}

output "project_id" {
  description = "Railway project ID"
  value       = railway_project.railfog.id
}

output "runtime_public_domain" {
  description = "Public URL for live customer traffic ingress"
  value       = "https://${railway_service_domain.runtime_domain.domain}"
}
