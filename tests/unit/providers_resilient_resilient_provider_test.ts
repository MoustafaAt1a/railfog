/**
 * Comprehensive test suite for Provider Resilient Adapter and Error Normalizer (T-0410).
 *
 * Spec references:
 * - PLAT-10: Runtime data plane SLO (99.95%) and circuit breaker protection
 * - PLAT-12: Canonical error model (RESOURCE_NOT_FOUND, TIMEOUT, RATE_LIMITED, UNAVAILABLE, CONFLICT, INTERNAL)
 * - PLAT-15: Auto-redaction of secrets in errors and logs (Bearer tokens, AWS4-HMAC-SHA256, railfog_sec_*, connection strings)
 * - PLAT-16: Provider abstraction wrappers (KVProvider, ObjectProvider, QueueProvider)
 * - Q-5: Decorrelated jitter retry loop on idempotent operations; banned automatic retries on non-idempotent operations
 * - tasks/milestone-0.4-reliability/T-0410-provider-resilient-adapter.md: AC1 - AC5, Tests required
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
} from "@std/assert";

import {
  ConflictError,
  InternalError,
  PermissionDeniedError,
  RateLimitedError,
  ResourceNotFoundError,
  TimeoutError,
  UnavailableError,
} from "../../packages/errors/mod.ts";

import type {
  KVAtomicBuilder,
  KVProvider,
} from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";

import {
  type CircuitBreaker,
  createCircuitBreaker,
} from "../../packages/policy/circuit-breaker.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import {
  createGuardedKVProvider,
  createGuardedObjectProvider,
  createGuardedQueueProvider,
} from "../../providers/guard/tenant-guard.ts";

import {
  normalizeProviderError,
  type ResilientProviderOptions,
  wrapResilientKv,
  wrapResilientObjects,
  wrapResilientQueues,
} from "../../providers/resilient/resilient-provider.ts";

// ============================================================================
// Test Double Helpers / Mock Providers
// ============================================================================

function createMemoryKV(): SQLiteKVProvider {
  return new SQLiteKVProvider(":memory:");
}

class MockKVAtomicBuilder implements KVAtomicBuilder {
  public checks: Array<{ key: string[]; version: number }> = [];
  public sets: Array<{ key: string[]; value: unknown }> = [];
  public deletes: Array<{ key: string[] }> = [];
  public commitCalls = 0;

  constructor(
    private readonly commitFn?: (
      builder: MockKVAtomicBuilder,
    ) => Promise<{ ok: boolean; version?: number }>,
  ) {}

  check(key: string[], expectedVersion: number): this {
    this.checks.push({ key, version: expectedVersion });
    return this;
  }

  set(key: string[], value: unknown): this {
    this.sets.push({ key, value });
    return this;
  }

  delete(key: string[]): this {
    this.deletes.push({ key });
    return this;
  }

  commit(): Promise<{ ok: boolean; version?: number }> {
    this.commitCalls++;
    if (this.commitFn) {
      return this.commitFn(this);
    }
    return Promise.resolve({ ok: true, version: 1 });
  }
}

class MockKVProvider implements KVProvider {
  public getCalls = 0;
  public setCalls = 0;
  public deleteCalls = 0;
  public listCalls = 0;
  public atomicCalls = 0;

  public getHandler?: (key: string[]) => Promise<unknown | null>;
  public setHandler?: (
    key: string[],
    value: unknown,
    opts?: { ttl?: number },
  ) => Promise<void>;
  public deleteHandler?: (key: string[]) => Promise<void>;
  public listHandler?: (
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ) => Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }>;
  public atomicCommitHandler?: (
    builder: MockKVAtomicBuilder,
  ) => Promise<{ ok: boolean; version?: number }>;

  get(key: string[]): Promise<unknown | null> {
    this.getCalls++;
    if (this.getHandler) {
      return this.getHandler(key);
    }
    return Promise.resolve(null);
  }

  set(key: string[], value: unknown, opts?: { ttl?: number }): Promise<void> {
    this.setCalls++;
    if (this.setHandler) {
      return this.setHandler(key, value, opts);
    }
    return Promise.resolve();
  }

  delete(key: string[]): Promise<void> {
    this.deleteCalls++;
    if (this.deleteHandler) {
      return this.deleteHandler(key);
    }
    return Promise.resolve();
  }

  list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }> {
    this.listCalls++;
    if (this.listHandler) {
      return this.listHandler(prefix, opts);
    }
    return Promise.resolve({ keys: [] });
  }

  atomic(): KVAtomicBuilder {
    this.atomicCalls++;
    return new MockKVAtomicBuilder(this.atomicCommitHandler);
  }
}

class MockObjectProvider implements ObjectProvider {
  public putCalls = 0;
  public getCalls = 0;
  public deleteCalls = 0;
  public headCalls = 0;
  public listCalls = 0;
  public presignCalls = 0;
  public createMultipartCalls = 0;

  public putHandler?: (
    key: string,
    data: ArrayBuffer | ReadableStream,
  ) => Promise<{ etag: string }>;
  public getHandler?: (key: string) => Promise<ReadableStream | null>;
  public deleteHandler?: (key: string) => Promise<void>;
  public headHandler?: (
    key: string,
  ) => Promise<{ size: number; etag: string } | null>;
  public listHandler?: (
    prefix: string,
    opts?: { limit?: number; cursor?: string },
  ) => Promise<{ keys: string[]; cursor?: string }>;
  public presignHandler?: (
    key: string,
    opts: { method: "GET" | "PUT"; expiresIn?: number; maxExpiresIn?: number },
  ) => Promise<{ url: string; expiresAt: number }>;
  public createMultipartHandler?: (
    key: string,
  ) => Promise<{ uploadId: string }>;

  put(
    key: string,
    data: ArrayBuffer | ReadableStream,
  ): Promise<{ etag: string }> {
    this.putCalls++;
    if (this.putHandler) {
      return this.putHandler(key, data);
    }
    return Promise.resolve({ etag: "mock-etag" });
  }

  get(key: string): Promise<ReadableStream | null> {
    this.getCalls++;
    if (this.getHandler) {
      return this.getHandler(key);
    }
    return Promise.resolve(null);
  }

  delete(key: string): Promise<void> {
    this.deleteCalls++;
    if (this.deleteHandler) {
      return this.deleteHandler(key);
    }
    return Promise.resolve();
  }

  head(key: string): Promise<{ size: number; etag: string } | null> {
    this.headCalls++;
    if (this.headHandler) {
      return this.headHandler(key);
    }
    return Promise.resolve(null);
  }

  list(
    prefix: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: string[]; cursor?: string }> {
    this.listCalls++;
    if (this.listHandler) {
      return this.listHandler(prefix, opts);
    }
    return Promise.resolve({ keys: [] });
  }

  presign(
    key: string,
    opts: { method: "GET" | "PUT"; expiresIn?: number; maxExpiresIn?: number },
  ): Promise<{ url: string; expiresAt: number }> {
    this.presignCalls++;
    if (this.presignHandler) {
      return this.presignHandler(key, opts);
    }
    return Promise.resolve({
      url: "https://example.com/presigned",
      expiresAt: Date.now() + 3600,
    });
  }

  createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    this.createMultipartCalls++;
    if (this.createMultipartHandler) {
      return this.createMultipartHandler(key);
    }
    return Promise.resolve({ uploadId: "mock-upload-id" });
  }
}

class MockQueueProvider implements QueueProvider {
  public sendCalls = 0;
  public sendBatchCalls = 0;
  public receiveCalls = 0;
  public ackCalls = 0;

  public sendHandler?: (
    body: unknown,
    opts?: { delay?: number },
  ) => Promise<{ id: string }>;
  public sendBatchHandler?: (bodies: unknown[]) => Promise<{ id: string }[]>;
  public receiveHandler?: (
    opts?: { visibilityTimeoutMs?: number },
  ) => Promise<QueueMessage | null>;
  public ackHandler?: (id: string) => Promise<void>;

  send(body: unknown, opts?: { delay?: number }): Promise<{ id: string }> {
    this.sendCalls++;
    if (this.sendHandler) {
      return this.sendHandler(body, opts);
    }
    return Promise.resolve({ id: "mock-msg-id" });
  }

  sendBatch(bodies: unknown[]): Promise<{ id: string }[]> {
    this.sendBatchCalls++;
    if (this.sendBatchHandler) {
      return this.sendBatchHandler(bodies);
    }
    return Promise.resolve(bodies.map((_, i) => ({ id: `mock-msg-${i}` })));
  }

  receive(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null> {
    this.receiveCalls++;
    if (this.receiveHandler) {
      return this.receiveHandler(opts);
    }
    return Promise.resolve(null);
  }

  ack(id: string): Promise<void> {
    this.ackCalls++;
    if (this.ackHandler) {
      return this.ackHandler(id);
    }
    return Promise.resolve();
  }
}

// ============================================================================
// Group 1: Unit — Error Normalization Mapping (PLAT-12, AC2, Tests required #1)
// ============================================================================

Deno.test("AC2 (PLAT-12): normalizeProviderError maps HTTP 503 to typed UnavailableError with UNAVAILABLE code", () => {
  // spec: tasks/milestone-0.4-reliability/T-0410-provider-resilient-adapter.md#AC2
  // spec: docs/contracts/platform.contract.md#PLAT-12
  const http503Error = Object.assign(new Error("Service Unavailable"), {
    status: 503,
  });

  const normalized = normalizeProviderError(http503Error);
  assertInstanceOf(normalized, UnavailableError);
  assertEquals((normalized as UnavailableError).code, "UNAVAILABLE");
  assert(normalized.message.length > 0);
});

Deno.test("Unit (PLAT-12): normalizeProviderError maps network drops and socket exceptions to UnavailableError", () => {
  // Network connection resets, drops, ECONNRESET, ECONNREFUSED, fetch failed
  const econnreset = new Error("read ECONNRESET at TCP.onStreamRead");
  const normConnReset = normalizeProviderError(econnreset);
  assertInstanceOf(normConnReset, UnavailableError);
  assertEquals((normConnReset as UnavailableError).code, "UNAVAILABLE");

  const econnrefused = new Error("connect ECONNREFUSED 127.0.0.1:443");
  const normConnRefused = normalizeProviderError(econnrefused);
  assertInstanceOf(normConnRefused, UnavailableError);
  assertEquals((normConnRefused as UnavailableError).code, "UNAVAILABLE");

  const fetchFailed = new TypeError("fetch failed");
  const normFetchFailed = normalizeProviderError(fetchFailed);
  assertInstanceOf(normFetchFailed, UnavailableError);
  assertEquals((normFetchFailed as UnavailableError).code, "UNAVAILABLE");

  const socketHangUp = new Error("socket hang up");
  const normHangUp = normalizeProviderError(socketHangUp);
  assertInstanceOf(normHangUp, UnavailableError);
  assertEquals((normHangUp as UnavailableError).code, "UNAVAILABLE");

  // AWS S3 / Cloud SDK metadata status code 503
  const aws503 = Object.assign(new Error("SlowDown / 503"), {
    $metadata: { httpStatusCode: 503 },
  });
  const normAws503 = normalizeProviderError(aws503);
  assertInstanceOf(normAws503, UnavailableError);
  assertEquals((normAws503 as UnavailableError).code, "UNAVAILABLE");
});

Deno.test("Unit (PLAT-12): normalizeProviderError maps HTTP 404 and missing keys to ResourceNotFoundError", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-12
  const notFoundStatus = Object.assign(new Error("Not Found"), { status: 404 });
  const norm404 = normalizeProviderError(notFoundStatus);
  assertInstanceOf(norm404, ResourceNotFoundError);
  assertEquals((norm404 as ResourceNotFoundError).code, "RESOURCE_NOT_FOUND");

  const s3NoSuchKey = Object.assign(
    new Error("NoSuchKey: The specified key does not exist."),
    { statusCode: 404 },
  );
  const normS3Key = normalizeProviderError(s3NoSuchKey);
  assertInstanceOf(normS3Key, ResourceNotFoundError);
  assertEquals((normS3Key as ResourceNotFoundError).code, "RESOURCE_NOT_FOUND");

  const missingKeyError = new Error("Key not found in kv namespace: users/123");
  const normMissing = normalizeProviderError(missingKeyError);
  assertInstanceOf(normMissing, ResourceNotFoundError);
  assertEquals(
    (normMissing as ResourceNotFoundError).code,
    "RESOURCE_NOT_FOUND",
  );
});

Deno.test("Unit (PLAT-12): normalizeProviderError maps HTTP 408 and timeouts to TimeoutError", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-12
  const timeoutStatus = Object.assign(new Error("Request Timeout"), {
    status: 408,
  });
  const norm408 = normalizeProviderError(timeoutStatus);
  assertInstanceOf(norm408, TimeoutError);
  assertEquals((norm408 as TimeoutError).code, "TIMEOUT");

  const etimedout = new Error("connect ETIMEDOUT 198.51.100.1:443");
  const normEtimeout = normalizeProviderError(etimedout);
  assertInstanceOf(normEtimeout, TimeoutError);
  assertEquals((normEtimeout as TimeoutError).code, "TIMEOUT");

  const deadlineError = new Error(
    "Socket timeout: deadline exceeded after 30000ms",
  );
  const normDeadline = normalizeProviderError(deadlineError);
  assertInstanceOf(normDeadline, TimeoutError);
  assertEquals((normDeadline as TimeoutError).code, "TIMEOUT");
});

Deno.test("Unit (PLAT-12): normalizeProviderError maps HTTP 429 and rate limit errors to RateLimitedError", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-12
  const rateLimitStatus = Object.assign(new Error("Too Many Requests"), {
    statusCode: 429,
  });
  const norm429 = normalizeProviderError(rateLimitStatus);
  assertInstanceOf(norm429, RateLimitedError);
  assertEquals((norm429 as RateLimitedError).code, "RATE_LIMITED");

  const throttlingError = new Error("ThrottlingException: Rate limit exceeded");
  const normThrottle = normalizeProviderError(throttlingError);
  assertInstanceOf(normThrottle, RateLimitedError);
  assertEquals((normThrottle as RateLimitedError).code, "RATE_LIMITED");
});

Deno.test("Unit (PLAT-12): normalizeProviderError maps CAS mismatches to ConflictError", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-12
  // spec: docs/contracts/kv.contract.md#KV-3
  const casMismatch = new Error("CAS mismatch: expected version 4 but found 5");
  const normCas = normalizeProviderError(casMismatch);
  assertInstanceOf(normCas, ConflictError);
  assertEquals((normCas as ConflictError).code, "CONFLICT");

  const versionConflict = new Error(
    "atomic commit failed due to version conflict",
  );
  const normConflict = normalizeProviderError(versionConflict);
  assertInstanceOf(normConflict, ConflictError);
  assertEquals((normConflict as ConflictError).code, "CONFLICT");
});

Deno.test("Unit (PLAT-12): normalizeProviderError maps unclassified exceptions and primitives to InternalError", () => {
  // spec: docs/contracts/platform.contract.md#PLAT-12
  const genericError = new Error(
    "Unexpected memory corruption or invariant violation",
  );
  const normGeneric = normalizeProviderError(genericError);
  assertInstanceOf(normGeneric, InternalError);
  assertEquals((normGeneric as InternalError).code, "INTERNAL");

  const typeError = new TypeError(
    "Cannot read properties of undefined (reading 'foo')",
  );
  const normTypeError = normalizeProviderError(typeError);
  assertInstanceOf(normTypeError, InternalError);
  assertEquals((normTypeError as InternalError).code, "INTERNAL");

  // Non-Error thrown values
  const stringError = normalizeProviderError("fatal crash string");
  assertInstanceOf(stringError, InternalError);
  assertEquals((stringError as InternalError).code, "INTERNAL");

  const nullError = normalizeProviderError(null);
  assertInstanceOf(nullError, InternalError);
  assertEquals((nullError as InternalError).code, "INTERNAL");

  const undefinedError = normalizeProviderError(undefined);
  assertInstanceOf(undefinedError, InternalError);
  assertEquals((undefinedError as InternalError).code, "INTERNAL");
});

Deno.test("Unit (PLAT-12): normalizeProviderError preserves error cause while normalizing", () => {
  const rootCause = new Error("Underlying socket drop: ECONNRESET");
  const outerError = new Error("Database query failed", { cause: rootCause });

  const normalized = normalizeProviderError(outerError);
  assertInstanceOf(normalized, UnavailableError);
  // Cause should be preserved on the normalized error
  assert(
    (normalized as { cause?: unknown }).cause !== undefined,
    "Normalized error must preserve causality via cause",
  );
});

// ============================================================================
// Group 2: Security (PLAT-15) — Auto-Redaction of Secrets (AC3, Tests required #4)
// ============================================================================

Deno.test("AC3 (Security PLAT-15): Vendor error containing Bearer token redacts token to [REDACTED] in message and stack", () => {
  // spec: tasks/milestone-0.4-reliability/T-0410-provider-resilient-adapter.md#AC3
  // spec: docs/contracts/platform.contract.md#PLAT-15
  const secretToken = "super-secret-key-12345";
  const vendorError = new Error(
    `Downstream provider authentication failed: Bearer ${secretToken} rejected with status 401`,
  );

  const normalized = normalizeProviderError(vendorError);

  // Message must not contain secret token
  assert(
    !normalized.message.includes(secretToken),
    "Secret Bearer token must not appear in error message",
  );
  assert(
    normalized.message.includes("[REDACTED]"),
    "Secret Bearer token must be replaced with [REDACTED]",
  );

  // Stack trace must not contain secret token
  if (normalized.stack) {
    assert(
      !normalized.stack.includes(secretToken),
      "Secret Bearer token must not appear in error stack trace",
    );
  }

  // String representation must not contain secret token
  assert(
    !String(normalized).includes(secretToken),
    "Secret Bearer token must not appear in String(error)",
  );
});

Deno.test("Security (PLAT-15): Auto-redacts AWS4-HMAC-SHA256 authorization credentials", () => {
  const awsAuthHeader =
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260915/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=fe5f80f77d5fa3be10f001cc38d22329ad0668171f4b1b990a42e237b4462b01";
  const awsError = new Error(
    `Request signature mismatch for header: ${awsAuthHeader}`,
  );

  const normalized = normalizeProviderError(awsError);

  assert(
    !normalized.message.includes("AKIAIOSFODNN7EXAMPLE"),
    "AWS access key credential must not leak in error message",
  );
  assert(
    !normalized.message.includes(
      "fe5f80f77d5fa3be10f001cc38d22329ad0668171f4b1b990a42e237b4462b01",
    ),
    "AWS signature must not leak in error message",
  );
  assert(
    normalized.message.includes("[REDACTED]"),
    "AWS authorization signature must be replaced with [REDACTED]",
  );
});

Deno.test("Security (PLAT-15): Auto-redacts railfog_sec_* pattern tokens", () => {
  const secretKey = "railfog_sec_live_9876543210abcdef0123456789";
  const error = new Error(
    `Invalid invocation using token ${secretKey} on route`,
  );

  const normalized = normalizeProviderError(error);

  assert(
    !normalized.message.includes(secretKey),
    "railfog_sec_* token must not leak in error message",
  );
  assert(
    normalized.message.includes("[REDACTED]"),
    "railfog_sec_* token must be replaced with [REDACTED]",
  );
});

Deno.test("Security (PLAT-15): Auto-redacts database and redis connection strings", () => {
  const connString =
    "postgres://admin:superSecretPass123!@db.internal.railfog.net:5432/production";
  const dbError = new Error(
    `Failed to establish connection to ${connString}: socket hang up`,
  );

  const normalized = normalizeProviderError(dbError);

  assert(
    !normalized.message.includes("superSecretPass123!"),
    "Connection string password must not leak in error message",
  );
  assert(
    normalized.message.includes("[REDACTED]"),
    "Connection credentials must be replaced with [REDACTED]",
  );
});

Deno.test("Security (PLAT-15): Redacts custom sensitivePatterns supplied in options", () => {
  const customSecret = "CUSTOMER_API_KEY_xyz999888777";
  const customPattern = /CUSTOMER_API_KEY_[a-z0-9]+/gi;

  const error = new Error(`Upstream rejected key: ${customSecret}`);
  const normalized = normalizeProviderError(error, [customPattern]);

  assert(
    !normalized.message.includes(customSecret),
    "Custom sensitive pattern value must not leak in error message",
  );
  assert(
    normalized.message.includes("[REDACTED]"),
    "Custom sensitive pattern must be replaced with [REDACTED]",
  );
});

Deno.test("Security (PLAT-15): Wrapped provider operations sanitize error secrets thrown to caller", async () => {
  const mockKv = new MockKVProvider();
  const rawSecret = "railfog_sec_internal_token_99999";
  mockKv.getHandler = () => {
    throw new Error(`Failed authentication: Bearer ${rawSecret}`);
  };

  const resilientKv = wrapResilientKv(mockKv, {
    retryPolicy: { maxAttempts: 1 },
  });

  const thrownError = await assertRejects(
    () => resilientKv.get(["users", "123"]),
  );

  assert(thrownError instanceof Error);
  assert(
    !thrownError.message.includes(rawSecret),
    "Wrapped provider error message must not contain raw secret token",
  );
  if (thrownError.stack) {
    assert(
      !thrownError.stack.includes(rawSecret),
      "Wrapped provider error stack must not contain raw secret token",
    );
  }
});

// ============================================================================
// Group 3: Unit — Retry Loop on Safe, Idempotent Operations (Q-5, AC1, Tests required #2)
// ============================================================================

Deno.test("AC1 (Unit Q-5): objects.get retries on transient connection reset and succeeds on 3rd attempt", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0410-provider-resilient-adapter.md#AC1
  // spec: docs/contracts/queues.contract.md#Q-5
  const mockObjects = new MockObjectProvider();
  let attemptCount = 0;

  const streamPayload = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("file-content-payload"));
      controller.close();
    },
  });

  mockObjects.getHandler = (_key: string) => {
    attemptCount++;
    if (attemptCount < 3) {
      // First 2 attempts fail with connection reset
      throw new Error("read ECONNRESET at TCP.onStreamRead");
    }
    // 3rd attempt succeeds
    return Promise.resolve(streamPayload);
  };

  const options: ResilientProviderOptions = {
    retryPolicy: {
      maxAttempts: 5,
      baseMs: 1,
      capMs: 10,
    },
  };
  const resilientObjects = wrapResilientObjects(mockObjects, options);

  const resultStream = await resilientObjects.get("artifacts/build-01.tar.gz");
  assert(
    resultStream !== null,
    "Result stream must be returned on 3rd attempt",
  );
  assertEquals(
    attemptCount,
    3,
    "Underlying provider must be invoked exactly 3 times",
  );
  assertEquals(mockObjects.getCalls, 3);
});

Deno.test("Unit (Q-5): kv.get retries on transient HTTP 503 and returns cached value", async () => {
  const mockKv = new MockKVProvider();
  let callCount = 0;

  mockKv.getHandler = (key: string[]) => {
    callCount++;
    if (callCount === 1) {
      throw Object.assign(new Error("Service Unavailable"), { status: 503 });
    }
    return Promise.resolve({ user: key[1], active: true });
  };

  const resilientKv = wrapResilientKv(mockKv, {
    retryPolicy: { maxAttempts: 3, baseMs: 1, capMs: 5 },
  });

  const result = await resilientKv.get(["users", "alice"]);
  assertEquals(result, { user: "alice", active: true });
  assertEquals(callCount, 2);
  assertEquals(mockKv.getCalls, 2);
});

Deno.test("Unit (Q-5): kv.list retries on transient socket timeout and returns keys", async () => {
  const mockKv = new MockKVProvider();
  let callCount = 0;

  mockKv.listHandler = (prefix: string[]) => {
    callCount++;
    if (callCount === 1) {
      throw new Error("Socket timeout: ETIMEDOUT while listing keys");
    }
    return Promise.resolve({
      keys: [{ key: [...prefix, "item1"], value: 100 }],
    });
  };

  const resilientKv = wrapResilientKv(mockKv, {
    retryPolicy: { maxAttempts: 3, baseMs: 1, capMs: 5 },
  });

  const result = await resilientKv.list(["sessions"]);
  assertEquals(result.keys.length, 1);
  assertEquals(callCount, 2);
  assertEquals(mockKv.listCalls, 2);
});

Deno.test("Unit (Q-5): objects.head retries on transient network drop and returns metadata", async () => {
  const mockObjects = new MockObjectProvider();
  let callCount = 0;

  mockObjects.headHandler = (_key: string) => {
    callCount++;
    if (callCount === 1) {
      throw new Error("connect ECONNREFUSED 127.0.0.1:443");
    }
    return Promise.resolve({ size: 2048, etag: "head-etag-xyz" });
  };

  const resilientObjects = wrapResilientObjects(mockObjects, {
    retryPolicy: { maxAttempts: 3, baseMs: 1, capMs: 5 },
  });

  const head = await resilientObjects.head("docs/manifest.json");
  assertEquals(head, { size: 2048, etag: "head-etag-xyz" });
  assertEquals(callCount, 2);
  assertEquals(mockObjects.headCalls, 2);
});

Deno.test("Unit (Q-5): objects.list retries on transient 503 and returns listing", async () => {
  const mockObjects = new MockObjectProvider();
  let callCount = 0;

  mockObjects.listHandler = (_prefix: string) => {
    callCount++;
    if (callCount === 1) {
      throw Object.assign(new Error("Service Unavailable"), { status: 503 });
    }
    return Promise.resolve({
      keys: ["docs/a.txt", "docs/b.txt"],
      cursor: "cur-1",
    });
  };

  const resilientObjects = wrapResilientObjects(mockObjects, {
    retryPolicy: { maxAttempts: 3, baseMs: 1, capMs: 5 },
  });

  const listing = await resilientObjects.list("docs/");
  assertEquals(listing.keys, ["docs/a.txt", "docs/b.txt"]);
  assertEquals(listing.cursor, "cur-1");
  assertEquals(callCount, 2);
});

Deno.test("Unit (Q-5): queue.receive retries on transient fetch failed and returns message", async () => {
  const mockQueue = new MockQueueProvider();
  let callCount = 0;

  mockQueue.receiveHandler = () => {
    callCount++;
    if (callCount === 1) {
      throw new TypeError("fetch failed");
    }
    return Promise.resolve({
      id: "msg-12345",
      body: { task: "index_document" },
      attempts: 1,
    });
  };

  const resilientQueue = wrapResilientQueues(mockQueue, {
    retryPolicy: { maxAttempts: 3, baseMs: 1, capMs: 5 },
  });

  const message = await resilientQueue.receive();
  assert(message !== null);
  assertEquals(message.id, "msg-12345");
  assertEquals(message.body, { task: "index_document" });
  assertEquals(callCount, 2);
  assertEquals(mockQueue.receiveCalls, 2);
});

Deno.test("Unit (Q-5): Exhausted retries on idempotent operation rethrows normalized error after maxAttempts", async () => {
  const mockKv = new MockKVProvider();
  let callCount = 0;

  mockKv.getHandler = () => {
    callCount++;
    throw Object.assign(new Error("Service Unavailable"), { status: 503 });
  };

  const resilientKv = wrapResilientKv(mockKv, {
    retryPolicy: {
      maxAttempts: 3,
      baseMs: 1,
      capMs: 5,
    },
  });

  const err = await assertRejects(
    () => resilientKv.get(["missing", "item"]),
    UnavailableError,
  );

  assertEquals((err as UnavailableError).code, "UNAVAILABLE");
  assertEquals(
    callCount,
    3,
    "Operation must be retried up to maxAttempts (3) before failing",
  );
  assertEquals(mockKv.getCalls, 3);
});

// ============================================================================
// Group 4: Unit — Non-Idempotent Operations are NOT Automatically Retried (AC5, Q-5)
// ============================================================================

Deno.test("AC5 (Q-5): kv.set fails immediately on transient error without retrying", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0410-provider-resilient-adapter.md#AC5
  // spec: docs/contracts/queues.contract.md#Q-5 — Banned: retrying non-idempotent operations
  const mockKv = new MockKVProvider();
  mockKv.setHandler = () => {
    throw Object.assign(new Error("Service Unavailable"), { status: 503 });
  };

  const resilientKv = wrapResilientKv(mockKv, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  const err = await assertRejects(
    () => resilientKv.set(["users", "123"], { name: "Alice" }),
    UnavailableError,
  );

  assertEquals((err as UnavailableError).code, "UNAVAILABLE");
  assertEquals(
    mockKv.setCalls,
    1,
    "Non-idempotent kv.set must execute exactly once and not be retried",
  );
});

Deno.test("AC5 (Q-5): kv.delete fails immediately without retrying", async () => {
  const mockKv = new MockKVProvider();
  mockKv.deleteHandler = () => {
    throw new Error("read ECONNRESET");
  };

  const resilientKv = wrapResilientKv(mockKv, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  await assertRejects(
    () => resilientKv.delete(["users", "123"]),
    UnavailableError,
  );

  assertEquals(
    mockKv.deleteCalls,
    1,
    "Non-idempotent kv.delete must execute exactly once and not be retried",
  );
});

Deno.test("AC5 (Q-5): kv.atomic().commit() fails immediately on error without retrying", async () => {
  const mockKv = new MockKVProvider();
  mockKv.atomicCommitHandler = () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:443");
  };

  const resilientKv = wrapResilientKv(mockKv, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  await assertRejects(
    () => resilientKv.atomic().set(["key"], "val").commit(),
    UnavailableError,
  );

  assertEquals(mockKv.atomicCalls, 1);
});

Deno.test("AC5 (Q-5): objects.put fails immediately on error without retrying", async () => {
  const mockObjects = new MockObjectProvider();
  mockObjects.putHandler = () => {
    throw Object.assign(new Error("Service Unavailable"), { status: 503 });
  };

  const resilientObjects = wrapResilientObjects(mockObjects, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  const testBuffer = new Uint8Array([1, 2, 3]).buffer;
  await assertRejects(
    () => resilientObjects.put("uploads/photo.png", testBuffer),
    UnavailableError,
  );

  assertEquals(
    mockObjects.putCalls,
    1,
    "Non-idempotent objects.put must not be retried",
  );
});

Deno.test("AC5 (Q-5): objects.delete fails immediately on error without retrying", async () => {
  const mockObjects = new MockObjectProvider();
  mockObjects.deleteHandler = () => {
    throw new Error("socket hang up");
  };

  const resilientObjects = wrapResilientObjects(mockObjects, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  await assertRejects(
    () => resilientObjects.delete("uploads/temp.txt"),
    UnavailableError,
  );

  assertEquals(
    mockObjects.deleteCalls,
    1,
    "Non-idempotent objects.delete must not be retried",
  );
});

Deno.test("AC5 (Q-5): objects.presign fails immediately on error without retrying", async () => {
  const mockObjects = new MockObjectProvider();
  mockObjects.presignHandler = () => {
    throw Object.assign(new Error("Service Unavailable"), { status: 503 });
  };

  const resilientObjects = wrapResilientObjects(mockObjects, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  await assertRejects(
    () => resilientObjects.presign("uploads/file.pdf", { method: "GET" }),
    UnavailableError,
  );

  assertEquals(
    mockObjects.presignCalls,
    1,
    "Non-idempotent objects.presign must not be retried",
  );
});

Deno.test("AC5 (Q-5): objects.createMultipartUpload fails immediately on error without retrying", async () => {
  const mockObjects = new MockObjectProvider();
  mockObjects.createMultipartHandler = () => {
    throw new Error("read ECONNRESET");
  };

  const resilientObjects = wrapResilientObjects(mockObjects, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  await assertRejects(
    () => resilientObjects.createMultipartUpload("uploads/huge.zip"),
    UnavailableError,
  );

  assertEquals(
    mockObjects.createMultipartCalls,
    1,
    "Non-idempotent objects.createMultipartUpload must not be retried",
  );
});

Deno.test("AC5 (Q-5): queue.send fails immediately on error without retrying", async () => {
  const mockQueue = new MockQueueProvider();
  mockQueue.sendHandler = () => {
    throw Object.assign(new Error("Service Unavailable"), { status: 503 });
  };

  const resilientQueue = wrapResilientQueues(mockQueue, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  await assertRejects(
    () => resilientQueue.send({ task: "send_email" }),
    UnavailableError,
  );

  assertEquals(
    mockQueue.sendCalls,
    1,
    "Non-idempotent queue.send must not be retried",
  );
});

Deno.test("AC5 (Q-5): queue.sendBatch fails immediately on error without retrying", async () => {
  const mockQueue = new MockQueueProvider();
  mockQueue.sendBatchHandler = () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:443");
  };

  const resilientQueue = wrapResilientQueues(mockQueue, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  await assertRejects(
    () => resilientQueue.sendBatch([{ t: 1 }, { t: 2 }]),
    UnavailableError,
  );

  assertEquals(
    mockQueue.sendBatchCalls,
    1,
    "Non-idempotent queue.sendBatch must not be retried",
  );
});

Deno.test("AC5 (Q-5): queue.ack fails immediately on error without retrying", async () => {
  const mockQueue = new MockQueueProvider();
  mockQueue.ackHandler = () => {
    throw Object.assign(new Error("Service Unavailable"), { status: 503 });
  };

  const resilientQueue = wrapResilientQueues(mockQueue, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  await assertRejects(
    () => resilientQueue.ack("msg-12345"),
    UnavailableError,
  );

  assertEquals(
    mockQueue.ackCalls,
    1,
    "Non-idempotent queue.ack must not be retried",
  );
});

Deno.test("Unit (PLAT-16): Non-idempotent operations delegate and succeed when provider succeeds", async () => {
  const mockKv = new MockKVProvider();
  const mockObjects = new MockObjectProvider();
  const mockQueue = new MockQueueProvider();

  const resilientKv = wrapResilientKv(mockKv);
  const resilientObjects = wrapResilientObjects(mockObjects);
  const resilientQueue = wrapResilientQueues(mockQueue);

  // kv.set
  await resilientKv.set(["test"], "val");
  assertEquals(mockKv.setCalls, 1);

  // kv.delete
  await resilientKv.delete(["test"]);
  assertEquals(mockKv.deleteCalls, 1);

  // kv.atomic
  const commitRes = await resilientKv.atomic().check(["a"], 1).set(["a"], 2)
    .delete(["b"]).commit();
  assertEquals(commitRes.ok, true);

  // objects.put
  const putRes = await resilientObjects.put("key", new ArrayBuffer(8));
  assertEquals(putRes.etag, "mock-etag");

  // objects.delete
  await resilientObjects.delete("key");
  assertEquals(mockObjects.deleteCalls, 1);

  // objects.presign
  const presignRes = await resilientObjects.presign("key", { method: "GET" });
  assert(presignRes.url.startsWith("https://"));

  // objects.createMultipartUpload
  const mpRes = await resilientObjects.createMultipartUpload("key");
  assertEquals(mpRes.uploadId, "mock-upload-id");

  // queue.send
  const sendRes = await resilientQueue.send({ data: 1 });
  assertEquals(sendRes.id, "mock-msg-id");

  // queue.sendBatch
  const sendBatchRes = await resilientQueue.sendBatch([{ a: 1 }, { b: 2 }]);
  assertEquals(sendBatchRes.length, 2);

  // queue.ack
  await resilientQueue.ack("msg-1");
  assertEquals(mockQueue.ackCalls, 1);
});

// ============================================================================
// Group 5: Integration — Circuit Breaker Integration (PLAT-10, AC4, Tests required #3)
// ============================================================================

Deno.test("AC4 (Integration PLAT-10): Consecutive failures trip circuit breaker and subsequent calls fail fast with UnavailableError", async () => {
  // spec: tasks/milestone-0.4-reliability/T-0410-provider-resilient-adapter.md#AC4
  // spec: docs/contracts/platform.contract.md#PLAT-10
  const kv = createMemoryKV();
  const breakerKey = ["circuit_breaker", "vendor_kv"];
  const failureThreshold = 3;

  const breaker: CircuitBreaker = createCircuitBreaker(kv, breakerKey, {
    failureThreshold,
    cooldownMs: 60_000,
  });

  const mockKv = new MockKVProvider();
  mockKv.setHandler = () => {
    throw Object.assign(new Error("Service Unavailable"), { status: 503 });
  };

  const resilientKv = wrapResilientKv(mockKv, {
    circuitBreaker: breaker,
  });

  // Cause 3 failures to hit the threshold
  for (let i = 0; i < failureThreshold; i++) {
    await assertRejects(
      () => resilientKv.set(["test"], "data"),
      UnavailableError,
    );
  }

  assertEquals(
    mockKv.setCalls,
    3,
    "Underlying provider was called 3 times to trip breaker",
  );

  // Breaker should now be Open
  const breakerState = await breaker.getState();
  assertEquals(breakerState.state, "Open");

  // 4th call: must FAIL FAST with UnavailableError WITHOUT hitting underlying provider
  const fastFailError = await assertRejects(
    () => resilientKv.set(["test"], "data"),
    UnavailableError,
  );

  assertEquals((fastFailError as UnavailableError).code, "UNAVAILABLE");
  assertEquals(
    mockKv.setCalls,
    3,
    "Underlying provider MUST NOT be called when circuit breaker is Open (fast-fail)",
  );
});

Deno.test("Integration (PLAT-10): Circuit breaker trips on wrapResilientObjects and fast-fails subsequent operations", async () => {
  const kv = createMemoryKV();
  const breakerKey = ["circuit_breaker", "vendor_r2"];
  const failureThreshold = 2;

  const breaker = createCircuitBreaker(kv, breakerKey, {
    failureThreshold,
    cooldownMs: 60_000,
  });

  const mockObjects = new MockObjectProvider();
  mockObjects.putHandler = () => {
    throw new Error("read ECONNRESET");
  };

  const resilientObjects = wrapResilientObjects(mockObjects, {
    circuitBreaker: breaker,
  });

  // 2 failures trip breaker
  await assertRejects(
    () => resilientObjects.put("obj1", new ArrayBuffer(0)),
    UnavailableError,
  );
  await assertRejects(
    () => resilientObjects.put("obj2", new ArrayBuffer(0)),
    UnavailableError,
  );

  assertEquals(mockObjects.putCalls, 2);

  // Breaker is Open; 3rd call fails fast without calling mockObjects.put
  await assertRejects(
    () => resilientObjects.put("obj3", new ArrayBuffer(0)),
    UnavailableError,
  );

  assertEquals(
    mockObjects.putCalls,
    2,
    "Mock provider put was not invoked because breaker is Open",
  );

  // Also verify get fails fast
  await assertRejects(
    () => resilientObjects.get("obj3"),
    UnavailableError,
  );

  assertEquals(
    mockObjects.getCalls,
    0,
    "Mock provider get was not invoked because breaker is Open",
  );
});

Deno.test("Integration (PLAT-10): Circuit breaker trips on wrapResilientQueues and fast-fails subsequent operations", async () => {
  const kv = createMemoryKV();
  const breakerKey = ["circuit_breaker", "vendor_queues"];
  const failureThreshold = 2;

  const breaker = createCircuitBreaker(kv, breakerKey, {
    failureThreshold,
    cooldownMs: 60_000,
  });

  const mockQueue = new MockQueueProvider();
  mockQueue.sendHandler = () => {
    throw Object.assign(new Error("Service Unavailable"), { status: 503 });
  };

  const resilientQueue = wrapResilientQueues(mockQueue, {
    circuitBreaker: breaker,
  });

  // 2 failures
  await assertRejects(
    () => resilientQueue.send({ msg: 1 }),
    UnavailableError,
  );
  await assertRejects(
    () => resilientQueue.send({ msg: 2 }),
    UnavailableError,
  );

  assertEquals(mockQueue.sendCalls, 2);

  // 3rd call fails fast
  await assertRejects(
    () => resilientQueue.send({ msg: 3 }),
    UnavailableError,
  );

  assertEquals(
    mockQueue.sendCalls,
    2,
    "Mock queue send was not invoked because breaker is Open",
  );
});

Deno.test("Integration (PLAT-10): Normal successful calls pass through circuit breaker and keep state Closed", async () => {
  const kv = createMemoryKV();
  const breakerKey = ["circuit_breaker", "vendor_healthy"];

  const breaker = createCircuitBreaker(kv, breakerKey, {
    failureThreshold: 3,
  });

  const mockKv = new MockKVProvider();
  mockKv.getHandler = (key: string[]) =>
    Promise.resolve(`value-for-${key.join("/")}`);

  const resilientKv = wrapResilientKv(mockKv, {
    circuitBreaker: breaker,
  });

  const val1 = await resilientKv.get(["app", "config"]);
  assertEquals(val1, "value-for-app/config");

  const val2 = await resilientKv.get(["app", "theme"]);
  assertEquals(val2, "value-for-app/theme");

  assertEquals(mockKv.getCalls, 2);

  const state = await breaker.getState();
  assertEquals(state.state, "Closed");
  assertEquals(state.consecutiveFailures, 0);
});

// ============================================================================
// Group 6: Adversarial Security Audit Suite (PLAT-15, Q-5, PLAT-10, PLAT-7)
// ============================================================================

// ----------------------------------------------------------------------------
// 6.1 Secret Leakage (PLAT-15) — Adversarial Probes
// ----------------------------------------------------------------------------

Deno.test("Security Adversarial (PLAT-15): Cause chain preserves causality while completely redacting Bearer tokens", () => {
  const secret = "secret-bearer-token-xyz987654";
  const innerError = new Error(`Upstream auth failed: Bearer ${secret}`);
  const outerError = new Error("Gateway failed to proxy request", {
    cause: innerError,
  });

  const normalized = normalizeProviderError(outerError);

  // 1. Check outer error message and stack
  assert(!normalized.message.includes(secret), "Secret in outer message");
  if (normalized.stack) {
    assert(!normalized.stack.includes(secret), "Secret in outer stack");
  }

  // 2. Check inner cause message and stack
  assert(normalized.cause !== undefined, "Cause must be preserved");
  const cause = normalized.cause as Error;
  assert(
    !cause.message.includes(secret),
    "Secret must not leak in cause.message",
  );
  assert(
    cause.message.includes("[REDACTED]"),
    "Cause message must contain [REDACTED]",
  );
  if (cause.stack) {
    assert(
      !cause.stack.includes(secret),
      "Secret must not leak in cause.stack",
    );
    assert(
      cause.stack.includes("[REDACTED]"),
      "Cause stack must contain [REDACTED]",
    );
  }

  // 3. Naive console.log / Deno.inspect representation must NOT leak secret
  const inspected = Deno.inspect(normalized);
  assert(
    !inspected.includes(secret),
    "Secret must not appear in Deno.inspect / console.log formatting",
  );
  assert(
    inspected.includes("[REDACTED]"),
    "Deno.inspect must show [REDACTED]",
  );
});

Deno.test("Security Adversarial (PLAT-15): Multi-level nested cause chain redacts database passwords at all depths", () => {
  const pass = "SuperSecretDbPassword#999";
  const level3 = new Error(
    `Socket hang up connecting to postgres://pgadmin:${pass}@db-internal.prod.railfog:5432/main`,
  );
  const level2 = new Error("Database pool connection timeout", {
    cause: level3,
  });
  const level1 = new Error("KV read transaction failed", { cause: level2 });

  const normalized = normalizeProviderError(level1);

  // Check top level
  assert(!normalized.message.includes(pass));
  if (normalized.stack) assert(!normalized.stack.includes(pass));

  // Check level 2
  const cause2 = normalized.cause as Error;
  assert(cause2 !== undefined);
  assert(!cause2.message.includes(pass));
  if (cause2.stack) assert(!cause2.stack.includes(pass));

  // Check level 3
  const cause3 = cause2.cause as Error;
  assert(cause3 !== undefined);
  assert(
    !cause3.message.includes(pass),
    "Password must not leak in deep cause level 3",
  );
  assert(
    cause3.message.includes("[REDACTED]"),
    "Password in deep cause level 3 must be replaced with [REDACTED]",
  );
  if (cause3.stack) assert(!cause3.stack.includes(pass));

  // Deno.inspect representation across entire tree
  const inspected = Deno.inspect(normalized);
  assert(!inspected.includes(pass), "Password must not appear in Deno.inspect");
});

Deno.test("Security Adversarial (PLAT-15): Redacts basic auth HTTP/HTTPS URLs in errors and cause chains", () => {
  const secretPass = "SuperSecretHTTPPass456";
  const httpUrl =
    `https://internal-service:${secretPass}@api.railfog.internal/v1/store`;
  const err = new Error(
    `Failed to POST to ${httpUrl}: 503 Service Unavailable`,
  );

  const normalized = normalizeProviderError(err);
  assert(
    !normalized.message.includes(secretPass),
    "HTTP basic auth password leaked in message",
  );
  assert(
    normalized.message.includes("[REDACTED]"),
    "HTTP basic auth password not redacted",
  );
  assert(
    !Deno.inspect(normalized).includes(secretPass),
    "HTTP basic auth password leaked in inspect",
  );
});

Deno.test("Security Adversarial (PLAT-15): Redacts standalone AWS access key IDs and secret parameters in cause chains", () => {
  const accessKey = "AKIAIOSFODNN7EXAMPLE";
  const secretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const innerError = new Error(
    `S3 operation failed with SecretAccessKey=${secretKey} and AccessKeyId=${accessKey}`,
  );
  const outerError = new Error("Object storage failed", { cause: innerError });

  const normalized = normalizeProviderError(outerError);
  const cause = normalized.cause as Error;

  assert(!cause.message.includes(accessKey), "AWS AccessKeyId leaked in cause");
  assert(
    !cause.message.includes(secretKey),
    "AWS SecretAccessKey leaked in cause",
  );
  assert(
    cause.message.includes("[REDACTED]"),
    "AWS credentials not redacted in cause",
  );
  assert(!Deno.inspect(normalized).includes(accessKey));
  assert(!Deno.inspect(normalized).includes(secretKey));
});

Deno.test("Security Adversarial (PLAT-15): Custom sensitive patterns are redacted recursively across cause chain and properties", () => {
  const customSecret = "CUSTOM_TENANT_KEY_abcdef123456";
  const customPattern = /CUSTOM_TENANT_KEY_[a-z0-9]+/gi;

  const inner = Object.assign(new Error("Inner token validation failed"), {
    secretProp: customSecret,
    detail: `Token was ${customSecret}`,
  });
  const outer = new Error("Authentication failed", { cause: inner });

  const normalized = normalizeProviderError(outer, [customPattern]);
  const cause = normalized.cause as Record<string, unknown>;

  assert(
    !String(cause.secretProp).includes(customSecret),
    "Custom property leaked secret",
  );
  assertEquals(cause.secretProp, "[REDACTED]");
  assert(
    !String(cause.detail).includes(customSecret),
    "Detail property leaked secret",
  );
  assert(
    !Deno.inspect(normalized).includes(customSecret),
    "Custom secret leaked in inspect",
  );
});

Deno.test("Security Adversarial (PLAT-15): Circular references in cause chain do not cause stack overflow and secrets are redacted", () => {
  const secret = "railfog_sec_super_confidential_99";
  const circularError = new Error(`Failed with ${secret}`);
  (circularError as unknown as Record<string, unknown>).self = circularError;

  const normalized = normalizeProviderError(circularError);
  assert(!normalized.message.includes(secret));
  assert(normalized.message.includes("[REDACTED]"));
  assert(!Deno.inspect(normalized).includes(secret));
});

Deno.test("Security Adversarial (PLAT-15): Wrapped KV, Objects, and Queues do not leak secrets through thrown error cause chains", async () => {
  const kvSecret = "railfog_sec_kv_secret_11111";
  const objSecret = "railfog_sec_obj_secret_22222";
  const queueSecret = "railfog_sec_queue_secret_33333";

  // 1. KV failure with secret
  const mockKv = new MockKVProvider();
  mockKv.getHandler = () => {
    throw new Error(`KV backend crash: Bearer ${kvSecret}`);
  };
  const resilientKv = wrapResilientKv(mockKv, {
    retryPolicy: { maxAttempts: 1 },
  });
  const kvErr = await assertRejects(() => resilientKv.get(["k"]));
  assert(!String(kvErr).includes(kvSecret));
  assert(!Deno.inspect(kvErr).includes(kvSecret));

  // 2. Object failure with secret
  const mockObjects = new MockObjectProvider();
  mockObjects.getHandler = () => {
    throw new Error(
      `S3 download failed: https://key:${objSecret}@s3.internal/bucket`,
    );
  };
  const resilientObjects = wrapResilientObjects(mockObjects, {
    retryPolicy: { maxAttempts: 1 },
  });
  const objErr = await assertRejects(() => resilientObjects.get("file.txt"));
  assert(!String(objErr).includes(objSecret));
  assert(!Deno.inspect(objErr).includes(objSecret));

  // 3. Queue failure with secret
  const mockQueue = new MockQueueProvider();
  mockQueue.sendHandler = () => {
    throw new Error(
      `Queue cluster unreachable: redis://user:${queueSecret}@redis:6379`,
    );
  };
  const resilientQueue = wrapResilientQueues(mockQueue);
  const qErr = await assertRejects(() => resilientQueue.send({ task: 1 }));
  assert(!String(qErr).includes(queueSecret));
  assert(!Deno.inspect(qErr).includes(queueSecret));
});

// ----------------------------------------------------------------------------
// 6.2 Idempotency & Retry Safety (Q-5) — Exhaustive Verification
// ----------------------------------------------------------------------------

Deno.test("Security Adversarial (Q-5): All 10 non-idempotent operations NEVER retry on transient errors", async () => {
  // We configure retryPolicy with maxAttempts: 10.
  // If ANY non-idempotent operation retries even once, the test FAILS.
  const aggressiveRetryOpts: ResilientProviderOptions = {
    retryPolicy: {
      maxAttempts: 10,
      baseMs: 1,
      capMs: 5,
    },
  };

  const transientError = () =>
    Object.assign(new Error("Service Unavailable"), { status: 503 });

  // 1. kv.set
  const mockKv = new MockKVProvider();
  mockKv.setHandler = () => {
    throw transientError();
  };
  mockKv.deleteHandler = () => {
    throw transientError();
  };
  mockKv.atomicCommitHandler = () => {
    throw transientError();
  };
  const resilientKv = wrapResilientKv(mockKv, aggressiveRetryOpts);

  await assertRejects(() => resilientKv.set(["a"], 1), UnavailableError);
  assertEquals(mockKv.setCalls, 1, "kv.set must not retry");

  // 2. kv.delete
  await assertRejects(() => resilientKv.delete(["a"]), UnavailableError);
  assertEquals(mockKv.deleteCalls, 1, "kv.delete must not retry");

  // 3. kv.atomic().commit()
  await assertRejects(
    () => resilientKv.atomic().set(["a"], 2).commit(),
    UnavailableError,
  );
  assertEquals(mockKv.atomicCalls, 1, "kv.atomic().commit must not retry");

  // 4. objects.put
  const mockObjects = new MockObjectProvider();
  mockObjects.putHandler = () => {
    throw transientError();
  };
  mockObjects.deleteHandler = () => {
    throw transientError();
  };
  mockObjects.presignHandler = () => {
    throw transientError();
  };
  mockObjects.createMultipartHandler = () => {
    throw transientError();
  };
  const resilientObjects = wrapResilientObjects(
    mockObjects,
    aggressiveRetryOpts,
  );

  await assertRejects(
    () => resilientObjects.put("key", new ArrayBuffer(0)),
    UnavailableError,
  );
  assertEquals(mockObjects.putCalls, 1, "objects.put must not retry");

  // 5. objects.delete
  await assertRejects(() => resilientObjects.delete("key"), UnavailableError);
  assertEquals(mockObjects.deleteCalls, 1, "objects.delete must not retry");

  // 6. objects.presign
  await assertRejects(
    () => resilientObjects.presign("key", { method: "PUT" }),
    UnavailableError,
  );
  assertEquals(mockObjects.presignCalls, 1, "objects.presign must not retry");

  // 7. objects.createMultipartUpload
  await assertRejects(
    () => resilientObjects.createMultipartUpload("key"),
    UnavailableError,
  );
  assertEquals(
    mockObjects.createMultipartCalls,
    1,
    "objects.createMultipartUpload must not retry",
  );

  // 8. queue.send
  const mockQueue = new MockQueueProvider();
  mockQueue.sendHandler = () => {
    throw transientError();
  };
  mockQueue.sendBatchHandler = () => {
    throw transientError();
  };
  mockQueue.ackHandler = () => {
    throw transientError();
  };
  const resilientQueue = wrapResilientQueues(mockQueue, aggressiveRetryOpts);

  await assertRejects(() => resilientQueue.send("msg"), UnavailableError);
  assertEquals(mockQueue.sendCalls, 1, "queue.send must not retry");

  // 9. queue.sendBatch
  await assertRejects(
    () => resilientQueue.sendBatch(["m1", "m2"]),
    UnavailableError,
  );
  assertEquals(mockQueue.sendBatchCalls, 1, "queue.sendBatch must not retry");

  // 10. queue.ack
  await assertRejects(() => resilientQueue.ack("msg-id"), UnavailableError);
  assertEquals(mockQueue.ackCalls, 1, "queue.ack must not retry");
});

Deno.test("Security Adversarial (Q-5): Idempotent operations do NOT retry on non-transient errors (404, 409, 400)", async () => {
  const mockKv = new MockKVProvider();
  mockKv.getHandler = () => {
    throw Object.assign(new Error("Not Found"), { status: 404 });
  };
  const resilientKv = wrapResilientKv(mockKv, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  const err = await assertRejects(
    () => resilientKv.get(["not", "found"]),
    ResourceNotFoundError,
  );
  assertEquals((err as ResourceNotFoundError).code, "RESOURCE_NOT_FOUND");
  assertEquals(
    mockKv.getCalls,
    1,
    "Idempotent read must NOT retry on 404 (non-transient)",
  );
});

// ----------------------------------------------------------------------------
// 6.3 Fast-Fail / SLO Protection (PLAT-10) — Adversarial Probes
// ----------------------------------------------------------------------------

Deno.test("Security Adversarial (PLAT-10): Open circuit breaker fast-fails ALL methods across KV, Objects, Queues with ZERO downstream calls", async () => {
  const kv = createMemoryKV();
  const breaker = createCircuitBreaker(kv, ["circuit", "fast_fail_test"], {
    failureThreshold: 1,
    cooldownMs: 60_000,
  });

  // Trip the breaker with 1 failure
  await assertRejects(
    () =>
      breaker.execute(() => {
        throw new Error("Downstream connection refused");
      }),
  );
  assertEquals((await breaker.getState()).state, "Open");

  // Verify KV methods fail fast with ZERO calls
  const mockKv = new MockKVProvider();
  let atomicCommits = 0;
  mockKv.atomicCommitHandler = () => {
    atomicCommits++;
    return Promise.resolve({ ok: true });
  };
  const resilientKv = wrapResilientKv(mockKv, { circuitBreaker: breaker });

  await assertRejects(() => resilientKv.get(["k"]), UnavailableError);
  await assertRejects(() => resilientKv.set(["k"], 1), UnavailableError);
  await assertRejects(() => resilientKv.delete(["k"]), UnavailableError);
  await assertRejects(() => resilientKv.list(["k"]), UnavailableError);
  await assertRejects(() => resilientKv.atomic().commit(), UnavailableError);

  assertEquals(mockKv.getCalls, 0);
  assertEquals(mockKv.setCalls, 0);
  assertEquals(mockKv.deleteCalls, 0);
  assertEquals(mockKv.listCalls, 0);
  assertEquals(
    atomicCommits,
    0,
    "Underlying atomic commit must not be called when breaker is Open",
  );

  // Verify Object methods fail fast with ZERO calls
  const mockObjects = new MockObjectProvider();
  const resilientObjects = wrapResilientObjects(mockObjects, {
    circuitBreaker: breaker,
  });

  await assertRejects(() => resilientObjects.get("f"), UnavailableError);
  await assertRejects(
    () => resilientObjects.put("f", new ArrayBuffer(0)),
    UnavailableError,
  );
  await assertRejects(() => resilientObjects.delete("f"), UnavailableError);
  await assertRejects(() => resilientObjects.head("f"), UnavailableError);
  await assertRejects(() => resilientObjects.list("f"), UnavailableError);
  await assertRejects(
    () => resilientObjects.presign("f", { method: "GET" }),
    UnavailableError,
  );
  await assertRejects(
    () => resilientObjects.createMultipartUpload("f"),
    UnavailableError,
  );

  assertEquals(mockObjects.getCalls, 0);
  assertEquals(mockObjects.putCalls, 0);
  assertEquals(mockObjects.deleteCalls, 0);
  assertEquals(mockObjects.headCalls, 0);
  assertEquals(mockObjects.listCalls, 0);
  assertEquals(mockObjects.presignCalls, 0);
  assertEquals(mockObjects.createMultipartCalls, 0);

  // Verify Queue methods fail fast with ZERO calls
  const mockQueue = new MockQueueProvider();
  const resilientQueue = wrapResilientQueues(mockQueue, {
    circuitBreaker: breaker,
  });

  await assertRejects(() => resilientQueue.send("m"), UnavailableError);
  await assertRejects(() => resilientQueue.sendBatch(["m"]), UnavailableError);
  await assertRejects(() => resilientQueue.receive(), UnavailableError);
  await assertRejects(() => resilientQueue.ack("id"), UnavailableError);

  assertEquals(mockQueue.sendCalls, 0);
  assertEquals(mockQueue.sendBatchCalls, 0);
  assertEquals(mockQueue.receiveCalls, 0);
  assertEquals(mockQueue.ackCalls, 0);
});

// ----------------------------------------------------------------------------
// 6.4 Tenant Guard Compatibility (PLAT-7) — Adversarial Probes
// ----------------------------------------------------------------------------

Deno.test("Security Adversarial (PLAT-7): Composition wrapResilientKv(createGuardedKVProvider) enforces tenant boundaries and does NOT retry violations", async () => {
  const tenant = { orgId: "org_acme", projectId: "proj_main" };
  const mockKv = new MockKVProvider();
  mockKv.getHandler = (key) => Promise.resolve(`data-at-${key.join("/")}`);

  const guardedKv = createGuardedKVProvider(mockKv, tenant);
  const resilientGuardedKv = wrapResilientKv(guardedKv, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  // 1. Valid tenant key succeeds
  const val = await resilientGuardedKv.get([
    "org_acme",
    "proj_main",
    "users",
    "1",
  ]);
  assertEquals(val, "data-at-org_acme/proj_main/users/1");
  assertEquals(mockKv.getCalls, 1);

  // 2. Cross-tenant key is rejected with PermissionDeniedError and NOT retried
  const crossTenantErr = await assertRejects(
    () => resilientGuardedKv.get(["org_other", "proj_other", "secret"]),
    PermissionDeniedError,
  );
  assertEquals(
    (crossTenantErr as PermissionDeniedError).code,
    "PERMISSION_DENIED",
  );
  // Downstream provider getCalls must NOT have increased!
  assertEquals(
    mockKv.getCalls,
    1,
    "Downstream provider must NOT be called on tenant violation",
  );

  // 3. Path traversal attack is rejected and NOT retried
  await assertRejects(
    () => resilientGuardedKv.get(["org_acme", "proj_main", "..", "leak"]),
    PermissionDeniedError,
  );
  assertEquals(mockKv.getCalls, 1);
});

Deno.test("Security Adversarial (PLAT-7): Composition createGuardedKVProvider(wrapResilientKv) enforces tenant boundaries and allows resilient retries on valid keys", async () => {
  const tenant = { orgId: "org_finance", projectId: "proj_ledger" };
  const mockKv = new MockKVProvider();

  let callCount = 0;
  mockKv.getHandler = (key) => {
    callCount++;
    if (callCount < 3) {
      throw Object.assign(new Error("Service Unavailable"), { status: 503 });
    }
    return Promise.resolve(`ledger-data-for-${key.join("/")}`);
  };

  const resilientKv = wrapResilientKv(mockKv, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });
  const guardedResilientKv = createGuardedKVProvider(resilientKv, tenant);

  // 1. Cross-tenant attempt is blocked immediately at the outer guard boundary
  await assertRejects(
    () => guardedResilientKv.get(["org_hacked", "proj_hacked", "key"]),
    PermissionDeniedError,
  );
  assertEquals(callCount, 0, "No downstream calls on cross-tenant attempt");

  // 2. Valid tenant key retries through transient failures and succeeds
  const data = await guardedResilientKv.get([
    "org_finance",
    "proj_ledger",
    "balance",
  ]);
  assertEquals(data, "ledger-data-for-org_finance/proj_ledger/balance");
  assertEquals(
    callCount,
    3,
    "Valid tenant call retried transient failures to success",
  );
});

Deno.test("Security Adversarial (PLAT-7): Composition with Objects and Queues blocks cross-tenant access without retrying", async () => {
  const tenant = { orgId: "org_corp", projectId: "proj_app" };

  // Objects
  const mockObjects = new MockObjectProvider();
  const guardedObjects = createGuardedObjectProvider(mockObjects, tenant);
  const resilientGuardedObjects = wrapResilientObjects(guardedObjects, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  await assertRejects(
    () => resilientGuardedObjects.get("org_evil/proj_evil/dump.sql"),
    PermissionDeniedError,
  );
  assertEquals(
    mockObjects.getCalls,
    0,
    "Objects provider must not be called on cross-tenant access",
  );

  // Queues
  const mockQueue = new MockQueueProvider();
  const validQueueName = "org_corp_proj_app_events";
  const guardedQueue = createGuardedQueueProvider(
    mockQueue,
    tenant,
    validQueueName,
  );
  const resilientGuardedQueue = wrapResilientQueues(guardedQueue, {
    retryPolicy: { maxAttempts: 5, baseMs: 1, capMs: 5 },
  });

  // Valid send succeeds
  const sendRes = await resilientGuardedQueue.send({ event: "login" });
  assertEquals(sendRes.id, "mock-msg-id");
  assertEquals(mockQueue.sendCalls, 1);
});
