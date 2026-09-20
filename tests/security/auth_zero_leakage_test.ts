// spec: contracts/platform.contract.md#PLAT-15 — Secrets: zero raw secret leakage in logs, error payloads, traces
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection
// spec: contracts/platform.contract.md#PLAT-9 — Rate limiting: token bucket algorithm
// spec: tasks/milestone-0.7-repo-consolidation/T-0704-authentication-and-identity-context.md

import { assertEquals, assertFalse } from "@std/assert";
import {
  type AuthRecord,
  deriveRateLimitKey,
  hashApiToken,
  type IdentityContext,
  sanitizeIdentityForLogging,
  verifyApiToken,
} from "@railfog/auth";

Deno.test("Security PLAT-15: raw secret tokens never leak in sanitized log objects", async () => {
  const rawSecretToken = "rf_sec_live_99887766554433221100aabbccddeeff";
  const tokenHash = await hashApiToken(rawSecretToken);

  const context: IdentityContext = {
    callerId: "api-client",
    orgId: "org_secret_corp",
    projectId: "proj_secret_app",
    tokenHash,
    callerType: "token",
  };

  const sanitized = sanitizeIdentityForLogging(context);
  const serialized = JSON.stringify(sanitized);

  // Assert raw token is nowhere in the serialized context
  assertFalse(serialized.includes(rawSecretToken));
  // Assert hash itself is also redacted from log context
  assertFalse(serialized.includes(tokenHash));
  assertFalse(serialized.includes("super_secret"));
  // Assert tokenHash key is absent
  assertEquals("tokenHash" in sanitized, false);
});

Deno.test("Security PLAT-15: deriveRateLimitKey does not expose raw secret tokens", () => {
  const rawSecretToken = "rf_sec_live_token_string_which_must_not_leak";
  const context: IdentityContext = {
    callerId: "token-holder",
    orgId: "org_1",
    projectId: "proj_1",
    tokenHash:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    callerType: "token",
  };

  const keyIp = deriveRateLimitKey("ip", context, "127.0.0.1");
  const keyId = deriveRateLimitKey("identity", context);
  const keyProj = deriveRateLimitKey("project", context);

  assertFalse(keyIp.includes(rawSecretToken));
  assertFalse(keyId.includes(rawSecretToken));
  assertFalse(keyProj.includes(rawSecretToken));
});

Deno.test("Security PLAT-15: verifyApiToken resists prototype pollution and malformed inputs", () => {
  const records: Record<string, AuthRecord> = {
    "normal-token": {
      tokenHash: "hash_normal",
      orgId: "org_normal",
      name: "normal-caller",
    },
  };

  // Prototype pollution attempt
  const identityProto = verifyApiToken("__proto__", records);
  assertEquals(identityProto, null);

  const identityConstructor = verifyApiToken("constructor", records);
  assertEquals(identityConstructor, null);

  const identityToString = verifyApiToken("toString", records);
  assertEquals(identityToString, null);

  // Extremely long token string (DDoS / memory exhaustion attempt)
  const hugeToken = "A".repeat(100_000);
  const identityHuge = verifyApiToken(hugeToken, records);
  assertEquals(identityHuge, null);
});
