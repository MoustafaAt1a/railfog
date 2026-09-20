// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & deploy-time permission scoping
// spec: contracts/platform.contract.md#PLAT-9 — Rate limiting (identity and project scopes)
// spec: contracts/platform.contract.md#PLAT-15 — Secrets management (zero plaintext leakage)
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: packages/auth
// spec: tasks/milestone-0.7-repo-consolidation/T-0704-authentication-and-identity-context.md

import { assert, assertEquals } from "@std/assert";
import {
  type AuthRecord,
  deriveRateLimitKey,
  extractBearerToken,
  hashApiToken,
  type IdentityContext,
  sanitizeIdentityForLogging,
  verifyApiToken,
} from "@railfog/auth";

Deno.test("T-0704: hashApiToken produces deterministic 64-char SHA-256 hex string (PLAT-9, PLAT-15)", async () => {
  const token = "rf_live_secret_token_12345";
  const hash1 = await hashApiToken(token);
  const hash2 = await hashApiToken(token);

  assertEquals(hash1, hash2);
  assertEquals(hash1.length, 64);
  assert(
    /^[0-9a-f]{64}$/.test(hash1),
    "Hash must be 64-character lowercase hex",
  );
});

Deno.test("T-0704: extractBearerToken extracts token from Authorization header", () => {
  assertEquals(extractBearerToken("Bearer test-token-xyz"), "test-token-xyz");
  assertEquals(extractBearerToken("bearer test-token-xyz"), "test-token-xyz");
  assertEquals(extractBearerToken("BEARER test-token-xyz"), "test-token-xyz");
  assertEquals(extractBearerToken("Basic user:pass"), null);
  assertEquals(extractBearerToken("Bearer "), null);
  assertEquals(extractBearerToken(""), null);
  assertEquals(extractBearerToken(null), null);
});

Deno.test("T-0704: verifyApiToken validates token and returns IdentityContext (PLAT-6)", () => {
  const records: Record<string, AuthRecord> = {
    "valid-token-1": {
      tokenHash: "hash_01",
      orgId: "org_alpha",
      projectId: "proj_beta",
      name: "service-worker",
    },
  };

  const identity = verifyApiToken("valid-token-1", records);
  assert(identity !== null);
  assertEquals(identity.callerType, "token");
  assertEquals(identity.callerId, "service-worker");
  assertEquals(identity.orgId, "org_alpha");
  assertEquals(identity.projectId, "proj_beta");
  assertEquals(identity.tokenHash, "hash_01");

  // Invalid token
  assertEquals(verifyApiToken("unknown-token", records), null);
  assertEquals(verifyApiToken("", records), null);
});

Deno.test("T-0704: deriveRateLimitKey derives keys per PLAT-9 rate limit scopes", () => {
  const context: IdentityContext = {
    callerId: "service-api",
    orgId: "org_01",
    projectId: "proj_01",
    tokenHash: "abc123hash",
    callerType: "token",
  };

  assertEquals(deriveRateLimitKey("ip", context, "192.0.2.1"), "ip:192.0.2.1");
  assertEquals(deriveRateLimitKey("ip", context), "ip:unknown");
  assertEquals(deriveRateLimitKey("identity", context), "identity:abc123hash");
  assertEquals(deriveRateLimitKey("project", context), "project:proj_01");

  // Fallback to orgId or callerId when projectId is missing
  const noProjContext: IdentityContext = {
    callerId: "anon-caller",
    orgId: "org_02",
    callerType: "anonymous",
  };
  assertEquals(deriveRateLimitKey("project", noProjContext), "project:org_02");
});

Deno.test("T-0704: sanitizeIdentityForLogging redacts tokenHash (PLAT-15)", () => {
  const context: IdentityContext = {
    callerId: "service-worker",
    orgId: "org_01",
    projectId: "proj_01",
    tokenHash: "super_secret_hash_value",
    callerType: "token",
  };

  const sanitized = sanitizeIdentityForLogging(context);
  assertEquals(sanitized.callerId, "service-worker");
  assertEquals(sanitized.orgId, "org_01");
  assertEquals(sanitized.projectId, "proj_01");
  assertEquals(sanitized.callerType, "token");
  assertEquals(sanitized.tokenHashRedacted, true);

  // Assert tokenHash property does not exist on sanitized object
  assertEquals("tokenHash" in sanitized, false);
});
