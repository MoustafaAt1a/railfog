// spec: contracts/platform.contract.md#PLAT-9 — Rate limiting: token bucket algorithm
// spec: contracts/platform.contract.md#PLAT-15 — Secrets management: zero raw secret leakage
// spec: tasks/milestone-0.7-repo-consolidation/T-0704-authentication-and-identity-context.md

/**
 * Computes deterministic SHA-256 hex digest of a raw API token using standard Web Crypto.
 *
 * Implements PLAT-9 and PLAT-15 to ensure raw secrets are never retained in rate-limit
 * buckets, logs, or in-memory caches.
 */
export async function hashApiToken(rawToken: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(rawToken);
  const digestBuffer = await crypto.subtle.digest("SHA-256", data);
  const digestArray = new Uint8Array(digestBuffer);

  return Array.from(digestArray)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
