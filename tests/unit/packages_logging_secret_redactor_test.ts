/**
 * Tests for structured log auto-redaction (SecretRedactor).
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-15: Secrets (Never committed, logged, returned by an API,
 *   embedded in an artifact, or included in an error/trace. Structured logging must auto-redact any value
 *   matching a bound secret name before it leaves the isolate).
 * - docs/contracts/platform.contract.md#PLAT-13: Observability (Structured logs are JSON, secrets auto-redacted
 *   per PLAT-15).
 * - docs/ANTI-SLOP.md: Error handling (Never log or return a secret value in an error, even accidentally
 *   via a stringified object).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { SecretRedactor } from "../../packages/logging/secret-redactor.ts";

// ============================================================================
// AC4 & String Redaction (PLAT-15, PLAT-13)
// ============================================================================

Deno.test("AC4 — redact replaces bound secret value with [REDACTED] in log message", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Output contains [REDACTED] and never raw secret
  const redactor = new SecretRedactor();
  const secret = "sk_live_secret123";
  const logMessage =
    `User auth error with key: ${secret} while calling payment gateway`;

  const result = redactor.redact(logMessage, [secret]);

  assertEquals(
    result,
    "User auth error with key: [REDACTED] while calling payment gateway",
  );
  assertEquals(result.includes(secret), false);
});

Deno.test("AC4 — redact replaces multiple occurrences of the same secret value", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Replace every occurrence of bound secret values
  const redactor = new SecretRedactor();
  const secret = "sk_live_secret123";
  const text =
    `Attempt 1: ${secret}. Attempt 2 failed with token: ${secret}. Retrying with ${secret}.`;

  const result = redactor.redact(text, [secret]);

  assertEquals(
    result,
    "Attempt 1: [REDACTED]. Attempt 2 failed with token: [REDACTED]. Retrying with [REDACTED].",
  );
  assertEquals(result.includes(secret), false);
});

Deno.test("AC4 — redact replaces multiple different secrets in a single string", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Scan structured log messages before isolate egress
  const redactor = new SecretRedactor();
  const secrets = [
    "stripe_secret_key_999",
    "github_pat_11223344",
    "db_password_xyz!",
  ];
  const text = `Connecting with ${secrets[0]} to Stripe, then using ${
    secrets[1]
  } for repo, and DB pass ${secrets[2]}`;

  const result = redactor.redact(text, secrets);

  assertEquals(
    result,
    "Connecting with [REDACTED] to Stripe, then using [REDACTED] for repo, and DB pass [REDACTED]",
  );
  for (const s of secrets) {
    assertEquals(result.includes(s), false);
  }
});

Deno.test("Unit — redact handles overlapping / substring secret values by prioritizing longer matches", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Clean redaction without fragment leakage
  const redactor = new SecretRedactor();
  const shortSecret = "secret_prefix";
  const longSecret = "secret_prefix_extended";
  const text = `Found ${longSecret} and also ${shortSecret}`;

  // Regardless of input array order, longer matching secret should be cleanly redacted
  const result1 = redactor.redact(text, [shortSecret, longSecret]);
  assertEquals(result1, "Found [REDACTED] and also [REDACTED]");

  const result2 = redactor.redact(text, [longSecret, shortSecret]);
  assertEquals(result2, "Found [REDACTED] and also [REDACTED]");
});

Deno.test("Unit — redact handles secrets inside URLs and headers", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Egress scanning
  const redactor = new SecretRedactor();
  const token = "ya29.a0AfH6SMD_secret_oauth_token";
  const text =
    `GET https://api.example.com/data?token=${token}&user=42 Headers: Authorization: Bearer ${token}`;

  const result = redactor.redact(text, [token]);

  assertEquals(
    result,
    "GET https://api.example.com/data?token=[REDACTED]&user=42 Headers: Authorization: Bearer [REDACTED]",
  );
  assertEquals(result.includes(token), false);
});

// ============================================================================
// JSON Deep Redaction (redactJson) (PLAT-13, PLAT-15)
// ============================================================================

Deno.test("JSON — redactJson redacts flat object string properties", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-13 — Structured logs are JSON, secrets auto-redacted
  const redactor = new SecretRedactor();
  const secret = "sk_live_secret123";
  const input = {
    level: "info",
    message: `Payment authorized via ${secret}`,
    apiKey: secret,
    status: 200,
  };

  const output = redactor.redactJson(input, [secret]) as Record<
    string,
    unknown
  >;

  assertEquals(output.level, "info");
  assertEquals(output.message, "Payment authorized via [REDACTED]");
  assertEquals(output.apiKey, "[REDACTED]");
  assertEquals(output.status, 200);
});

Deno.test("JSON — redactJson deeply traverses nested objects and arrays", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-13 — Deep JSON redaction
  const redactor = new SecretRedactor();
  const secretA = "secret_api_key_AAAA";
  const secretB = "secret_db_pass_BBBB";

  const input = {
    service: "payments",
    config: {
      auth: {
        token: `Bearer ${secretA}`,
        nestedDetails: {
          dbConnection: `postgres://user:${secretB}@db.host:5432/main`,
          retries: 3,
        },
      },
    },
    history: [
      { event: "init", tokenUsed: secretA },
      { event: "query", details: `Executed with ${secretB}` },
      "plain_array_element",
    ],
  };

  const output = redactor.redactJson(input, [secretA, secretB]) as typeof input;

  assertEquals(output.config.auth.token, "Bearer [REDACTED]");
  assertEquals(
    output.config.auth.nestedDetails.dbConnection,
    "postgres://user:[REDACTED]@db.host:5432/main",
  );
  assertEquals(output.config.auth.nestedDetails.retries, 3);
  assertEquals(output.history[0], { event: "init", tokenUsed: "[REDACTED]" });
  assertEquals(output.history[1], {
    event: "query",
    details: "Executed with [REDACTED]",
  });
  assertEquals(output.history[2], "plain_array_element");
});

Deno.test("JSON — redactJson preserves non-string primitives unaltered", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-13 — JSON structure integrity
  const redactor = new SecretRedactor();
  const secret = "sk_live_secret123";
  const input = {
    count: 42,
    rate: 3.14159,
    enabled: true,
    disabled: false,
    empty: null,
    undef: undefined,
    str: `contains ${secret}`,
  };

  const output = redactor.redactJson(input, [secret]) as Record<
    string,
    unknown
  >;

  assertEquals(output.count, 42);
  assertEquals(output.rate, 3.14159);
  assertEquals(output.enabled, true);
  assertEquals(output.disabled, false);
  assertEquals(output.empty, null);
  assertEquals(output.undef, undefined);
  assertEquals(output.str, "contains [REDACTED]");
});

Deno.test("JSON — redactJson sanitizes secret values occurring inside object keys", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Zero secret leakage anywhere in structured logs
  const redactor = new SecretRedactor();
  const secret = "sk_live_secret123";
  const input = {
    [`header_${secret}`]: "some_value",
    normalKey: "normal_val",
  };

  const output = redactor.redactJson(input, [secret]) as Record<
    string,
    unknown
  >;

  assertEquals(output["header_[REDACTED]"], "some_value");
  assertEquals(output.normalKey, "normal_val");
  assertEquals(Object.keys(output).some((k) => k.includes(secret)), false);
});

Deno.test("JSON — redactJson returns a new object and does not mutate input in-place", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-13 — Immutability
  const redactor = new SecretRedactor();
  const secret = "sk_live_secret123";
  const original = {
    nested: {
      secretValue: secret,
    },
  };

  const output = redactor.redactJson(original, [secret]) as typeof original;

  assertNotEquals(output, original);
  assertNotEquals(output.nested, original.nested);
  assertEquals(original.nested.secretValue, secret);
  assertEquals(output.nested.secretValue, "[REDACTED]");
});

// ============================================================================
// Error Traces & Stacks Sanitization (PLAT-15, ANTI-SLOP)
// ============================================================================

Deno.test("Error — redact sanitizes Error message and stack traces", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Never included in an error/trace
  // spec: docs/ANTI-SLOP.md#Error handling — Never log or return a secret in an error
  const redactor = new SecretRedactor();
  const secret = "sk_live_secret123";

  const error = new Error(`Connection failed with credential ${secret}`);
  // In simulated execution, stack trace includes the error message and call frames
  const stack = error.stack ??
    `Error: ${error.message}\n    at invoke (file:///app/api.ts:42:15)`;

  const sanitizedMessage = redactor.redact(error.message, [secret]);
  const sanitizedStack = redactor.redact(stack, [secret]);

  assertEquals(
    sanitizedMessage,
    "Connection failed with credential [REDACTED]",
  );
  assertEquals(sanitizedMessage.includes(secret), false);

  assertEquals(sanitizedStack.includes("[REDACTED]"), true);
  assertEquals(sanitizedStack.includes(secret), false);
});

Deno.test("Error — redactJson sanitizes Error instances and serialized error objects", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Auto-redact errors
  const redactor = new SecretRedactor();
  const secret = "sk_live_secret123";

  const serializedError = {
    name: "StripeAuthenticationError",
    message: `Invalid token: ${secret}`,
    stack:
      `StripeAuthenticationError: Invalid token: ${secret}\n    at Request.send (/app/stripe.ts:88:12)\n    at token=${secret}`,
    context: {
      attemptedKey: secret,
      statusCode: 401,
    },
  };

  const output = redactor.redactJson(serializedError, [
    secret,
  ]) as typeof serializedError;

  assertEquals(output.message, "Invalid token: [REDACTED]");
  assertEquals(output.stack.includes(secret), false);
  assertEquals(output.stack.includes("[REDACTED]"), true);
  assertEquals(output.context.attemptedKey, "[REDACTED]");
  assertEquals(output.context.statusCode, 401);
});

// ============================================================================
// Boundary Condition: Length < 4 Threshold (Task Assumptions)
// ============================================================================

Deno.test("Boundary — Secrets with length < 4 are not redacted (prevents false positive over-redaction)", () => {
  // spec: tasks/milestone-0.3-security/T-0306-dynamic-secret-injection.md#Assumptions made
  // "Secret redactor matches all bound secret values of length >= 4 characters to avoid false positive over-redaction of trivial substrings."
  const redactor = new SecretRedactor();

  // Length 0 (empty string)
  assertEquals(redactor.redact("hello world", [""]), "hello world");

  // Length 1
  assertEquals(
    redactor.redact("user id is 42 and flag is a", ["a"]),
    "user id is 42 and flag is a",
  );

  // Length 2
  assertEquals(
    redactor.redact("error in line 10 or 20", ["in", "10"]),
    "error in line 10 or 20",
  );

  // Length 3
  assertEquals(
    redactor.redact("key abc not found", ["abc", "key"]),
    "key abc not found",
  );

  // Length 4 (boundary threshold — MUST be redacted)
  assertEquals(
    redactor.redact("my code is pass and 1234", ["pass"]),
    "my code is [REDACTED] and 1234",
  );
  assertEquals(
    redactor.redact("my pin is 1234", ["1234"]),
    "my pin is [REDACTED]",
  );

  // Length 5
  assertEquals(redactor.redact("token admin", ["admin"]), "token [REDACTED]");
});

Deno.test("Boundary — Mixed secret list redacts only secrets with length >= 4", () => {
  const redactor = new SecretRedactor();
  const secrets = ["a", "no", "foo", "sk_live_stripe_key_123", "pass"];
  const text = "a foo is no match for sk_live_stripe_key_123 with pass";

  const result = redactor.redact(text, secrets);

  // 'a', 'no', 'foo' (lengths 1, 2, 3) must NOT be redacted
  // 'sk_live_stripe_key_123' and 'pass' (lengths 22, 4) MUST be redacted
  assertEquals(
    result,
    "a foo is no match for [REDACTED] with [REDACTED]",
  );
});

// ============================================================================
// Graceful Handling of Empty / Falsy / Edge Inputs
// ============================================================================

Deno.test("Edge Cases — redact handles empty/falsy inputs without throwing", () => {
  const redactor = new SecretRedactor();
  const secret = "sk_live_secret123";

  assertEquals(redactor.redact("", [secret]), "");
  assertEquals(redactor.redact("simple string", []), "simple string");
  assertEquals(redactor.redact("simple string", [""]), "simple string");
});

Deno.test("Edge Cases — redactJson handles empty/falsy primitives and objects", () => {
  const redactor = new SecretRedactor();
  const secret = "sk_live_secret123";

  assertEquals(redactor.redactJson(null, [secret]), null);
  assertEquals(redactor.redactJson(undefined, [secret]), undefined);
  assertEquals(redactor.redactJson(0, [secret]), 0);
  assertEquals(redactor.redactJson(false, [secret]), false);
  assertEquals(redactor.redactJson("", [secret]), "");
  assertEquals(redactor.redactJson([], [secret]), []);
  assertEquals(redactor.redactJson({}, [secret]), {});
  assertEquals(redactor.redactJson("normal text", []), "normal text");
});

// ============================================================================
// Security & Adversarial Tests (Regex Metacharacters & Circular Refs)
// ============================================================================

Deno.test("Security — Secrets containing RegExp special characters are matched literally", () => {
  // Adversarial: Secrets containing characters like +, $, *, (, ), [, ], ., ?, ^, \, |
  // must not crash the redactor with SyntaxError or cause unintended regex matches.
  const redactor = new SecretRedactor();
  const specialSecret = "sk+test$123(foo)[bar]*?^.|\\";
  const logMessage = `Auth header with special token: ${specialSecret} failed`;

  const result = redactor.redact(logMessage, [specialSecret]);

  assertEquals(
    result,
    "Auth header with special token: [REDACTED] failed",
  );
  assertEquals(result.includes(specialSecret), false);

  // Ensure regex dot (.) does not match arbitrary characters
  const dotSecret = "a.c.e";
  const textWithSimilarChars = "abcde and a.c.e";
  const dotResult = redactor.redact(textWithSimilarChars, [dotSecret]);
  assertEquals(dotResult, "abcde and [REDACTED]");
});

Deno.test("Security — redactJson handles circular references safely without infinite recursion", () => {
  // Adversarial: Objects containing circular self-references must not cause stack overflow
  const redactor = new SecretRedactor();
  const secret = "sk_live_secret123";

  interface CircularObj {
    name: string;
    secret: string;
    self?: CircularObj;
  }

  const obj: CircularObj = {
    name: "circular_test",
    secret: `embedded_${secret}`,
  };
  obj.self = obj;

  const sanitized = redactor.redactJson(obj, [secret]) as CircularObj;

  assertEquals(sanitized.name, "circular_test");
  assertEquals(sanitized.secret, "embedded_[REDACTED]");
});

Deno.test("Security & PLAT-13 — Full structured log event is cleanly redacted", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-13 — JSON structured log format
  // spec: docs/contracts/platform.contract.md#PLAT-15 — Auto-redaction before leaving isolate
  const redactor = new SecretRedactor();
  const stripeSecret = "sk_live_51M001122334455";
  const webhookSecret = "whsec_998877665544332211";

  const structuredLog = {
    timestamp: "2026-09-14T07:56:00.000Z",
    level: "warn",
    project: "proj_checkout",
    function: "webhook_handler",
    revision: "rev_01J8Z000000000000000000000",
    request_id: "req_01J8Z111111111111111111111",
    duration_ms: 45,
    message:
      `Webhook signature verification failed for ${webhookSecret} with API key ${stripeSecret}`,
    headers: {
      authorization: `Bearer ${stripeSecret}`,
      "stripe-signature": `t=12345,v1=${webhookSecret}`,
    },
    error: {
      name: "WebhookSignatureError",
      message: `Invalid signature for secret ${webhookSecret}`,
      stack:
        `WebhookSignatureError: Invalid signature for secret ${webhookSecret}\n    at verify (/app/webhook.ts:25:9)`,
    },
  };

  const output = redactor.redactJson(structuredLog, [
    stripeSecret,
    webhookSecret,
  ]) as typeof structuredLog;

  // Verify full redaction
  const serialized = JSON.stringify(output);
  assertEquals(serialized.includes(stripeSecret), false);
  assertEquals(serialized.includes(webhookSecret), false);
  assertEquals(
    output.message,
    "Webhook signature verification failed for [REDACTED] with API key [REDACTED]",
  );
  assertEquals(output.headers.authorization, "Bearer [REDACTED]");
  assertEquals(output.headers["stripe-signature"], "t=12345,v1=[REDACTED]");
  assertEquals(output.error.message, "Invalid signature for secret [REDACTED]");
  assertEquals(output.error.stack.includes(webhookSecret), false);
  assertEquals(output.error.stack.includes("[REDACTED]"), true);
});

Deno.test("Security — redactJson safely sanitizes Error instances with throwing or non-standard constructors", () => {
  // Adversarial: Errors with non-standard constructors or null constructors must not crash redaction
  const redactor = new SecretRedactor();
  const secret = "sk_live_secret123";

  class ThrowingConstructorError extends Error {
    constructor() {
      if (arguments.length === 1 && typeof arguments[0] === "string") {
        throw new Error("Constructor forbids single string argument");
      }
      super("ThrowingConstructorError");
    }
  }

  const err1 = Object.create(ThrowingConstructorError.prototype);
  err1.name = "ThrowingConstructorError";
  err1.message = `Failed with ${secret}`;
  err1.stack = `ThrowingConstructorError: Failed with ${secret}`;
  err1.secretPayload = secret;

  const sanitized1 = redactor.redactJson(err1, [secret]) as Record<
    string,
    unknown
  >;
  assertEquals(sanitized1.message, "Failed with [REDACTED]");
  assertEquals(sanitized1.secretPayload, "[REDACTED]");

  const err2 = new Error(`Null constructor error with ${secret}`);
  // deno-lint-ignore no-explicit-any
  (err2 as any).constructor = null;
  const sanitized2 = redactor.redactJson(err2, [secret]) as Record<
    string,
    unknown
  >;
  assertEquals(sanitized2.message, "Null constructor error with [REDACTED]");
});
