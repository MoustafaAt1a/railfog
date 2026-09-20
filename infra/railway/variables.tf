variable "railway_api_token" {
  description = "Railway Personal Access Token or Project Token"
  type        = string
  sensitive   = true
}

variable "project_name" {
  description = "Railway project name"
  type        = string
  default     = "railfog"
}

variable "environment_name" {
  description = "Target Railway environment name"
  type        = string
  default     = "production"
}

variable "cloudflare_account_id" {
  description = "Cloudflare Account ID for KV, R2, and Queues"
  type        = string
}

variable "cloudflare_api_token" {
  description = "Cloudflare API Token with permissions for Workers KV, R2, and Queues"
  type        = string
  sensitive   = true
}

variable "cloudflare_kv_namespace_id" {
  description = "Cloudflare Workers KV namespace ID"
  type        = string
}

variable "cloudflare_r2_bucket" {
  description = "Cloudflare R2 bucket name"
  type        = string
}

variable "cloudflare_queue_name" {
  description = "Cloudflare Queue name"
  type        = string
}
