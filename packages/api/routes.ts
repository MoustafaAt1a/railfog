// spec: contracts/platform.contract.md#PLAT-1 — Stage 1 deployment topology (control plane & data plane routes)
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: packages/api
// spec: tasks/milestone-0.7-repo-consolidation/T-0703-shared-api-contracts-and-dtos.md

/**
 * Standard API endpoint routes shared across the control plane (8081)
 * and data plane (8080) per PLAT-1.
 */
export const API_ROUTES = {
  HEALTH: "/healthz",
  PROJECTS: "/v1/projects",
  FUNCTIONS: "/v1/functions",
  DEPLOYMENTS: "/v1/deployments",
  INVOCATIONS: "/v1/invocations",
} as const;

export type ApiRouteKey = keyof typeof API_ROUTES;
export type ApiRoutePath = typeof API_ROUTES[ApiRouteKey];
