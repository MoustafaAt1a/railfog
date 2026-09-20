/**
 * Railway Infrastructure as Code (IaC) configuration for RailFog.
 *
 * Implements the two-process architecture defined in PLAT-1:
 * 1. railfog-control (Control Plane on port 8081):
 *    - Built from infra/Dockerfile.control
 *    - Manages manifests, deployments, revisions, and configuration snapshots
 *    - Accessible to the runtime via Railway private networking
 * 2. railfog-runtime (Data Plane on port 8080):
 *    - Built from infra/Dockerfile.runtime
 *    - Serves live customer HTTP traffic and runs sandboxed functions
 *    - Communicates with railfog-control via Railway private domain
 *
 * Spec references:
 * - PLAT-1: Stage 1 deployment topology (control plane on 8081, data plane on 8080)
 * - PLAT-4: Isolation & unprivileged execution
 * - PLAT-8: Fail-static snapshot distribution
 * - PLAT-15: Runtime secrets access
 * - PLAT-19: Repository structure: infra/
 */

export interface RailwayServiceContext {
  environment?: string;
  isEnvironment?: (env: string) => boolean;
}

export default function defineRailwayConfig(ctx?: RailwayServiceContext) {
  const isProd = ctx?.isEnvironment ? ctx.isEnvironment("production") : true;

  return {
    $schema: "https://railway.com/railway.schema.json",
    name: "railfog",
    services: [
      {
        name: "railfog-control",
        build: {
          builder: "DOCKERFILE",
          dockerfilePath: "infra/Dockerfile.control",
        },
        deploy: {
          healthcheckPath: "/healthz",
          healthcheckTimeout: 300,
          restartPolicyType: "ON_FAILURE",
          restartPolicyMaxRetries: 5,
        },
        variables: {
          PORT: "8081",
          DENO_ENV: "production",
          CLOUDFLARE_ACCOUNT_ID: "${{CLOUDFLARE_ACCOUNT_ID}}",
          CLOUDFLARE_API_TOKEN: "${{CLOUDFLARE_API_TOKEN}}",
          CLOUDFLARE_KV_NAMESPACE_ID: "${{CLOUDFLARE_KV_NAMESPACE_ID}}",
          CLOUDFLARE_R2_BUCKET: "${{CLOUDFLARE_R2_BUCKET}}",
          CLOUDFLARE_QUEUE_NAME: "${{CLOUDFLARE_QUEUE_NAME}}",
        },
      },
      {
        name: "railfog-runtime",
        build: {
          builder: "DOCKERFILE",
          dockerfilePath: "infra/Dockerfile.runtime",
        },
        deploy: {
          healthcheckPath: "/healthz",
          healthcheckTimeout: 300,
          restartPolicyType: "ON_FAILURE",
          restartPolicyMaxRetries: 5,
          replicas: isProd ? 2 : 1,
        },
        variables: {
          PORT: "8080",
          DENO_ENV: "production",
          RAILFOG_CONTROL_URL:
            "http://${{railfog-control.RAILWAY_PRIVATE_DOMAIN}}:8081",
          CLOUDFLARE_ACCOUNT_ID: "${{CLOUDFLARE_ACCOUNT_ID}}",
          CLOUDFLARE_API_TOKEN: "${{CLOUDFLARE_API_TOKEN}}",
          CLOUDFLARE_KV_NAMESPACE_ID: "${{CLOUDFLARE_KV_NAMESPACE_ID}}",
          CLOUDFLARE_R2_BUCKET: "${{CLOUDFLARE_R2_BUCKET}}",
          CLOUDFLARE_QUEUE_NAME: "${{CLOUDFLARE_QUEUE_NAME}}",
        },
      },
    ],
  };
}
