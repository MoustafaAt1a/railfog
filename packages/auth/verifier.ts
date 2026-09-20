// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & deploy-time permission scoping
// spec: contracts/platform.contract.md#PLAT-9 — Rate limiting: token bucket algorithm
// spec: contracts/platform.contract.md#PLAT-15 — Secrets management: zero raw secret leakage
// spec: tasks/milestone-0.7-repo-consolidation/T-0704-authentication-and-identity-context.md

export type CallerType = "anonymous" | "token" | "project" | "internal";

export interface IdentityContext {
  callerId: string;
  orgId: string;
  projectId?: string;
  tokenHash?: string;
  callerType: CallerType;
}

export interface AuthRecord {
  tokenHash: string;
  orgId: string;
  projectId?: string;
  name: string;
}

/**
 * Extracts bearer token string from HTTP Authorization header.
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

/**
 * Derives rate limit cache key according to PLAT-9 scope rules.
 */
export function deriveRateLimitKey(
  scope: "ip" | "identity" | "project",
  context: IdentityContext,
  clientIp?: string,
): string {
  switch (scope) {
    case "ip":
      return `ip:${clientIp ?? "unknown"}`;
    case "identity":
      return `identity:${context.tokenHash ?? context.callerId}`;
    case "project":
      return `project:${
        context.projectId ?? context.orgId ?? context.callerId
      }`;
  }
}

/**
 * Verifies API token against registered auth records safely without leaking secrets.
 */
export function verifyApiToken(
  token: string,
  records: Record<string, AuthRecord>,
): IdentityContext | null {
  if (!token || typeof token !== "string") {
    return null;
  }

  // Safe property lookup preventing prototype pollution
  if (!Object.prototype.hasOwnProperty.call(records, token)) {
    // Check if records are indexed by name/id while record contains tokenHash
    for (const record of Object.values(records)) {
      if (record && record.tokenHash === token) {
        return {
          callerId: record.name,
          orgId: record.orgId,
          projectId: record.projectId,
          tokenHash: record.tokenHash,
          callerType: "token",
        };
      }
    }
    return null;
  }

  const record = records[token];
  if (!record) {
    return null;
  }

  return {
    callerId: record.name,
    orgId: record.orgId,
    projectId: record.projectId,
    tokenHash: record.tokenHash,
    callerType: "token",
  };
}

/**
 * Strips tokenHash and ensures zero raw secret leakage into structured logs per PLAT-15.
 */
export function sanitizeIdentityForLogging(
  context: IdentityContext,
): Omit<IdentityContext, "tokenHash"> & { tokenHashRedacted: boolean } {
  const { tokenHash, ...rest } = context;
  return {
    ...rest,
    tokenHashRedacted: tokenHash !== undefined,
  };
}
