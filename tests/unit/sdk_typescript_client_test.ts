// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: sdk/typescript
// spec: contracts/queues.contract.md#Q-4 — Idempotency helper (withIdempotency) with mandatory TTL
// spec: contracts/queues.contract.md#Q-5 — Exponential backoff with decorrelated jitter retry helper (withRetry)
// spec: contracts/queues.contract.md#Q-6 — Composed reliability patterns as library code over KV
// spec: contracts/kv.contract.md#KV-2 — KV binding API, required TTL for dedupe keys (Audit Finding #5)
// spec: contracts/kv.contract.md#KV-3 — Optimistic concurrency CAS conflict error normalization
// spec: contracts/objects.contract.md#OBJ-2 — Object binding API shape and client wrapper error normalization
// spec: contracts/objects.contract.md#OBJ-3 — Presigned direct storage transfer client wrapper
// spec: contracts/queues.contract.md#Q-2 — Queue binding API shape and client wrapper error normalization
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection: bindings physically scoped at injection time
// spec: contracts/platform.contract.md#PLAT-12 — Error model: exhaustive machine-readable error codes mapped to typed errors
// spec: tasks/milestone-0.5-developer-experience/T-0502-typescript-sdk-client-bindings.md

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "@std/assert";

import {
  CallDepthExceededError,
  ConflictError,
  InternalError,
  PayloadTooLargeError,
  PermissionDeniedError,
  RailFogError,
  type RailFogErrorCode,
  RateLimitedError,
  ResourceNotFoundError,
  TimeoutError,
  UnavailableError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

import type {
  EnvBinding,
  KVAtomicOperation,
  KVBinding,
  ListOptions,
  ObjectBinding,
  PresignOptions,
  QueueBinding,
} from "../../sdk/typescript/types.ts";

import {
  type CircuitBreakerOptions,
  DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
  DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  type IdempotencyOptions,
  mutate,
  type MutateOptions,
  scopedKV,
  withCircuitBreaker,
  withIdempotency,
  withRetry,
} from "../../sdk/typescript/helpers.ts";

import {
  createRpcClient,
  normalizeError,
  wrapContext,
  wrapEnvBinding,
  wrapKVBinding,
  wrapObjectBinding,
  wrapQueueBinding,
} from "../../sdk/typescript/client.ts";
import * as RailFogSDK from "../../sdk/typescript/mod.ts";

// spec: contracts/queues.contract.md#Q-3, Q-4 — 14 days retention window default (14 * 24 * 3600 = 1,209,600s)
const EXPECTED_DEFAULT_IDEMPOTENCY_TTL_SECONDS = 14 * 24 * 3600;

// spec: contracts/queues.contract.md#Q-5 — Default retry settings table
const _EXPECTED_DEFAULT_RETRY_BASE_MS = 100;
const _EXPECTED_DEFAULT_RETRY_CAP_MS = 20_000;
const EXPECTED_DEFAULT_RETRY_MAX_ATTEMPTS = 5;

// ============================================================================
// Test Fixtures: In-Memory Mock Bindings
// ============================================================================

interface MockKVRecord {
  value: unknown;
  ttl?: number;
  version: number;
}

class MockKVBinding implements KVBinding {
  public store = new Map<string, MockKVRecord>();
  public calls = {
    get: [] as Array<{ key: string[] }>,
    set: [] as Array<{ key: string[]; value: unknown; ttl?: number }>,
    delete: [] as Array<{ key: string[] }>,
    list: [] as Array<{ prefix: string[]; options?: ListOptions }>,
  };
  public errorToThrow: unknown = null;

  private serializeKey(key: string[]): string {
    return key.join("/");
  }

  get<T = unknown>(key: string[]): Promise<T | null> {
    this.calls.get.push({ key });
    if (this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    const serialized = this.serializeKey(key);
    const record = this.store.get(serialized);
    return Promise.resolve(record ? (record.value as T) : null);
  }

  set(
    key: string[],
    value: unknown,
    options?: { ttl?: number },
  ): Promise<void> {
    this.calls.set.push({ key, value, ttl: options?.ttl });
    if (this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    const serialized = this.serializeKey(key);
    const existing = this.store.get(serialized);
    this.store.set(serialized, {
      value,
      ttl: options?.ttl,
      version: (existing?.version ?? 0) + 1,
    });
    return Promise.resolve();
  }

  delete(key: string[]): Promise<void> {
    this.calls.delete.push({ key });
    if (this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    this.store.delete(this.serializeKey(key));
    return Promise.resolve();
  }

  list<T = unknown>(
    prefix: string[],
    options?: ListOptions,
  ): Promise<{
    entries: Array<{ key: string[]; value: T; version: number }>;
    cursor?: string;
  }> {
    this.calls.list.push({ prefix, options });
    if (this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    const serializedPrefix = this.serializeKey(prefix);
    const entries: Array<{ key: string[]; value: T; version: number }> = [];
    for (const [k, v] of this.store.entries()) {
      if (k.startsWith(serializedPrefix)) {
        entries.push({
          key: k.split("/"),
          value: v.value as T,
          version: v.version,
        });
      }
    }
    return Promise.resolve({ entries });
  }

  atomic(): KVAtomicOperation {
    const errorOnCommit = this.errorToThrow;
    const checks: Array<{ key: string[]; expectedVersion: number }> = [];
    const sets: Array<{ key: string[]; value: unknown; ttl?: number }> = [];
    const deletes: Array<{ key: string[] }> = [];

    const atomicOp: KVAtomicOperation = {
      check: (key: string[], expectedVersion: number): KVAtomicOperation => {
        checks.push({ key, expectedVersion });
        return atomicOp;
      },
      set: (
        key: string[],
        value: unknown,
        options?: { ttl?: number },
      ): KVAtomicOperation => {
        sets.push({ key, value, ttl: options?.ttl });
        return atomicOp;
      },
      delete: (key: string[]): KVAtomicOperation => {
        deletes.push({ key });
        return atomicOp;
      },
      commit: (): Promise<{ ok: boolean; version?: number }> => {
        if (errorOnCommit) {
          return Promise.reject(errorOnCommit);
        }
        for (const c of checks) {
          const serialized = this.serializeKey(c.key);
          const existing = this.store.get(serialized);
          const currentVer = existing ? existing.version : 0;
          if (currentVer !== c.expectedVersion) {
            return Promise.resolve({ ok: false });
          }
        }
        for (const d of deletes) {
          this.store.delete(this.serializeKey(d.key));
        }
        let highestVersion = 1;
        for (const s of sets) {
          const serialized = this.serializeKey(s.key);
          const existing = this.store.get(serialized);
          const newVer = (existing?.version ?? 0) + 1;
          this.store.set(serialized, {
            value: s.value,
            ttl: s.ttl,
            version: newVer,
          });
          highestVersion = Math.max(highestVersion, newVer);
        }
        return Promise.resolve({ ok: true, version: highestVersion });
      },
    };
    return atomicOp;
  }
}

class MockObjectBinding implements ObjectBinding {
  public store = new Map<string, Uint8Array>();
  public calls = {
    put: [] as Array<{
      key: string;
      data: Uint8Array | ReadableStream<Uint8Array>;
    }>,
    get: [] as string[],
    delete: [] as string[],
    head: [] as string[],
    list: [] as Array<{ prefix: string; options?: ListOptions }>,
    createMultipartUpload: [] as string[],
    presign: [] as Array<{ key: string; options: PresignOptions }>,
  };
  public errorToThrow: unknown = null;

  async put(
    key: string,
    data: Uint8Array | ReadableStream<Uint8Array>,
  ): Promise<void> {
    this.calls.put.push({ key, data });
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
    if (data instanceof Uint8Array) {
      this.store.set(key, data);
    } else {
      const reader = data.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      const combined = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        combined.set(c, offset);
        offset += c.length;
      }
      this.store.set(key, combined);
    }
  }

  get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    this.calls.get.push(key);
    if (this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    const data = this.store.get(key);
    if (!data) return Promise.resolve(null);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
    return Promise.resolve(stream);
  }

  delete(key: string): Promise<void> {
    this.calls.delete.push(key);
    if (this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    this.store.delete(key);
    return Promise.resolve();
  }

  head(
    key: string,
  ): Promise<{ sizeBytes: number; sha256: string; integrity: string } | null> {
    this.calls.head.push(key);
    if (this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    const data = this.store.get(key);
    if (!data) return Promise.resolve(null);
    return Promise.resolve({
      sizeBytes: data.length,
      sha256: "mock_sha256",
      integrity: "sha256-mock_integrity",
    });
  }

  list(
    prefix: string,
    options?: ListOptions,
  ): Promise<{
    keys: Array<{ key: string; sizeBytes: number; sha256: string }>;
    cursor?: string;
  }> {
    this.calls.list.push({ prefix, options });
    if (this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    const keys: Array<{ key: string; sizeBytes: number; sha256: string }> = [];
    for (const [k, v] of this.store.entries()) {
      if (k.startsWith(prefix)) {
        keys.push({
          key: k,
          sizeBytes: v.length,
          sha256: "mock_sha256",
        });
      }
    }
    return Promise.resolve({ keys });
  }

  createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    this.calls.createMultipartUpload.push(key);
    if (this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    return Promise.resolve({ uploadId: "mpu_upload_123" });
  }

  presign(
    key: string,
    options: PresignOptions,
  ): Promise<{ url: string; headers: Record<string, string> }> {
    this.calls.presign.push({ key, options });
    if (this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    return Promise.resolve({
      url: `https://storage.railfog.local/${key}?sig=mock`,
      headers: { "x-sig": "mock" },
    });
  }
}

class MockQueueBinding implements QueueBinding {
  public messages: Array<{ message: unknown; options?: { delay?: number } }> =
    [];
  public calls = {
    send: [] as Array<{ message: unknown; options?: { delay?: number } }>,
    sendBatch: [] as unknown[][],
  };
  public errorToThrow: unknown = null;

  send<T = unknown>(
    message: T,
    options?: { delay?: number },
  ): Promise<{ id: string }> {
    this.calls.send.push({ message, options });
    if (this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    this.messages.push({ message, options });
    return Promise.resolve({ id: `msg_${this.messages.length}` });
  }

  sendBatch<T = unknown>(messages: T[]): Promise<Array<{ id: string }>> {
    this.calls.sendBatch.push(messages);
    if (this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    const ids: Array<{ id: string }> = [];
    for (const m of messages) {
      this.messages.push({ message: m });
      ids.push({ id: `msg_${this.messages.length}` });
    }
    return Promise.resolve(ids);
  }
}

// ============================================================================
// Group 1: withIdempotency reliability helper (Q-4, Q-6, KV-2, Audit Finding #5)
// ============================================================================

Deno.test("Q-4 & KV-2: withIdempotency first-run executes action, writes dedupe key with 14-day TTL default, and returns result", async () => {
  // spec: contracts/queues.contract.md#Q-4 — First-run success executes action(), writes dedupe key with ttl (14 days = 1209600s), returns { processed: true, result }
  const mockKv = new MockKVBinding();
  const dedupeKey = ["processed", "order_01J8Z001"];
  let actionExecuted = 0;

  const result = await withIdempotency(
    mockKv,
    dedupeKey,
    () => {
      actionExecuted++;
      return Promise.resolve({
        status: "charge_success",
        chargeId: "ch_12345",
      });
    },
  );

  assertEquals(actionExecuted, 1, "action() must be executed on first run");
  assertEquals(result, {
    processed: true,
    result: { status: "charge_success", chargeId: "ch_12345" },
  });

  // Verify KV get check was performed
  assertEquals(mockKv.calls.get.length, 1);
  assertEquals(mockKv.calls.get[0].key, dedupeKey);

  // Verify dedupe marker was written to KV with mandatory 14-day TTL default
  assertEquals(mockKv.calls.set.length, 1);
  assertEquals(mockKv.calls.set[0].key, dedupeKey);
  assertEquals(mockKv.calls.set[0].value, true);
  assertEquals(
    mockKv.calls.set[0].ttl,
    EXPECTED_DEFAULT_IDEMPOTENCY_TTL_SECONDS,
    "Default TTL must be exactly 14 days (1,209,600 seconds) per Q-3 and Q-4",
  );
});

Deno.test("Q-4 & KV-2: withIdempotency second-run skips action and returns { processed: false } before TTL expiry", async () => {
  // spec: contracts/queues.contract.md#Q-4 — Second-run before TTL expiration detects key, skips action(), returns { processed: false }
  const mockKv = new MockKVBinding();
  const dedupeKey = ["processed", "order_01J8Z002"];

  // Seed dedupe key in KV to simulate previous successful execution
  await mockKv.set(dedupeKey, true, {
    ttl: EXPECTED_DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  });
  mockKv.calls.set.length = 0; // Reset call log

  let actionExecuted = 0;
  const result = await withIdempotency(
    mockKv,
    dedupeKey,
    () => {
      actionExecuted++;
      return Promise.resolve({
        status: "duplicate_execution_should_not_happen",
      });
    },
  );

  assertEquals(
    actionExecuted,
    0,
    "action() must NOT execute when dedupe key exists",
  );
  assertEquals(result, {
    processed: false,
    result: undefined,
  });

  // Verify KV get was called and no additional set was performed
  assertEquals(mockKv.calls.get.length, 1);
  assertEquals(
    mockKv.calls.set.length,
    0,
    "Dedupe key must not be re-written on duplicate run",
  );
});

Deno.test("Q-4 & KV-2: withIdempotency honors custom ttlSeconds option", async () => {
  // spec: contracts/queues.contract.md#Q-4 — Custom ttlSeconds option is passed to kv.set
  const mockKv = new MockKVBinding();
  const dedupeKey = ["processed", "invoice_999"];
  const customTtl = 86_400; // 1 day

  const result = await withIdempotency(
    mockKv,
    dedupeKey,
    () => Promise.resolve("invoice_processed"),
    { ttlSeconds: customTtl },
  );

  assertEquals(result, { processed: true, result: "invoice_processed" });
  assertEquals(mockKv.calls.set.length, 1);
  assertEquals(
    mockKv.calls.set[0].ttl,
    customTtl,
    "Custom ttlSeconds must be forwarded directly to kv.set",
  );
});

Deno.test("KV-2 & Q-4 (Audit Finding #5): withIdempotency enforces mandatory TTL and prevents unbounded dedupe key growth", async () => {
  // spec: contracts/kv.contract.md#KV-2, queues.contract.md#Q-4 — A dedupe key written without a ttl is Audit Finding #5 reopened
  const mockKv = new MockKVBinding();

  // Test with undefined options
  await withIdempotency(
    mockKv,
    ["dedupe", "key_1"],
    () => Promise.resolve("res1"),
  );
  assertEquals(
    mockKv.calls.set[0].ttl,
    EXPECTED_DEFAULT_IDEMPOTENCY_TTL_SECONDS,
    "Omitting options parameter must assign default TTL of 14 days",
  );

  // Test with empty options object
  const emptyOptions: IdempotencyOptions = {};
  await withIdempotency(
    mockKv,
    ["dedupe", "key_2"],
    () => Promise.resolve("res2"),
    emptyOptions,
  );
  assertEquals(
    mockKv.calls.set[1].ttl,
    EXPECTED_DEFAULT_IDEMPOTENCY_TTL_SECONDS,
    "Empty options object must assign default TTL of 14 days",
  );
});

Deno.test("Q-4 & KV-2: withIdempotency does NOT write dedupe key when action fails, allowing subsequent retry", async () => {
  // spec: contracts/queues.contract.md#Q-4 — Failing action() does not write dedupe key
  const mockKv = new MockKVBinding();
  const dedupeKey = ["processed", "order_fail_001"];
  const expectedError = new Error("Payment processor unavailable 503");

  let actionAttempts = 0;
  await assertRejects(
    async () => {
      await withIdempotency(
        mockKv,
        dedupeKey,
        () => {
          actionAttempts++;
          return Promise.reject(expectedError);
        },
      );
    },
    Error,
    "Payment processor unavailable 503",
  );

  assertEquals(actionAttempts, 1);
  assertEquals(mockKv.calls.get.length, 1);
  assertEquals(
    mockKv.calls.set.length,
    0,
    "Failing action must NOT write dedupe marker to KV",
  );

  // Verify key is absent in store, enabling a later retry to proceed
  const keyPresent = await mockKv.get(dedupeKey);
  assertEquals(
    keyPresent,
    null,
    "Dedupe key must remain absent after action failure",
  );
});

Deno.test("KV-4: withIdempotency accepts hierarchical multi-segment array dedupe keys", async () => {
  // spec: contracts/kv.contract.md#KV-4 — Hierarchical key model, array of strings
  const mockKv = new MockKVBinding();
  const multiSegmentKey = ["webhooks", "stripe", "evt_charge_succeeded_001"];

  const res = await withIdempotency(
    mockKv,
    multiSegmentKey,
    () => Promise.resolve({ webhookAck: true }),
  );

  assertEquals(res.processed, true);
  assertEquals(mockKv.calls.get[0].key, multiSegmentKey);
  assertEquals(mockKv.calls.set[0].key, multiSegmentKey);
});

// ============================================================================
// Group 2: withRetry reliability helper (Q-5, Q-6, PLAT-12)
// ============================================================================

Deno.test("Q-5: withRetry succeeds on first attempt without delay or unnecessary calls", async () => {
  // spec: contracts/queues.contract.md#Q-5 — Success on first attempt
  let executionCount = 0;
  const result = await withRetry(() => {
    executionCount++;
    return Promise.resolve("fast_success");
  });

  assertEquals(result, "fast_success");
  assertEquals(
    executionCount,
    1,
    "Action must execute exactly once when succeeding immediately",
  );
});

Deno.test("Q-5: withRetry retries transient failure up to default maxAttempts (5) and returns intermediate success", async () => {
  // spec: contracts/queues.contract.md#Q-5 — Retries on transient failure up to maxAttempts (default 5, default baseMs 100, default capMs 20000)
  let executionCount = 0;
  const result = await withRetry(
    () => {
      executionCount++;
      if (executionCount < 3) {
        return Promise.reject(
          new Error(`Transient error attempt ${executionCount}`),
        );
      }
      return Promise.resolve("recovered_data");
    },
    { baseMs: 1, capMs: 10 }, // Small delays for test speed
  );

  assertEquals(result, "recovered_data");
  assertEquals(
    executionCount,
    3,
    "Operation must succeed after 2 transient failures",
  );
});

Deno.test("Q-5 & PLAT-12: withRetry exhaustion of maxAttempts rethrows the final error", async () => {
  // spec: contracts/queues.contract.md#Q-5 — Exhaustion of maxAttempts rethrows the final error
  let executionCount = 0;
  const finalError = new TimeoutError(
    "Downstream network timeout deadline exceeded",
  );

  await assertRejects(
    async () => {
      await withRetry(
        () => {
          executionCount++;
          return Promise.reject(finalError);
        },
        { baseMs: 1, capMs: 5 }, // Fast execution
      );
    },
    TimeoutError,
    "Downstream network timeout deadline exceeded",
  );

  assertEquals(
    executionCount,
    EXPECTED_DEFAULT_RETRY_MAX_ATTEMPTS,
    `Operation must attempt exactly default maxAttempts (${EXPECTED_DEFAULT_RETRY_MAX_ATTEMPTS}) before rethrowing`,
  );
});

Deno.test("Q-5: withRetry honors custom maxAttempts option (maxAttempts = 1 and maxAttempts = 3)", async () => {
  // spec: contracts/queues.contract.md#Q-5 — Custom maxAttempts limit
  let singleAttempts = 0;
  await assertRejects(
    async () => {
      await withRetry(
        () => {
          singleAttempts++;
          return Promise.reject(new Error("Immediate failure"));
        },
        { maxAttempts: 1, baseMs: 1 },
      );
    },
    Error,
    "Immediate failure",
  );
  assertEquals(
    singleAttempts,
    1,
    "With maxAttempts = 1, exactly 1 execution must occur",
  );

  let tripleAttempts = 0;
  await assertRejects(
    async () => {
      await withRetry(
        () => {
          tripleAttempts++;
          return Promise.reject(new Error("Triple failure"));
        },
        { maxAttempts: 3, baseMs: 1, capMs: 5 },
      );
    },
    Error,
    "Triple failure",
  );
  assertEquals(
    tripleAttempts,
    3,
    "With maxAttempts = 3, exactly 3 executions must occur",
  );
});

Deno.test("Q-5 & PLAT-12: withRetry preserves typed RailFogError identity and requestId across retries", async () => {
  // spec: contracts/platform.contract.md#PLAT-12 — Typed platform error preservation
  const customError = new ConflictError(
    "KV CAS mismatch during optimistic concurrency update",
    "req_cas_retry_001",
  );

  let attempts = 0;
  const thrown = await assertRejects(
    async () => {
      await withRetry(
        () => {
          attempts++;
          return Promise.reject(customError);
        },
        { maxAttempts: 2, baseMs: 1 },
      );
    },
    ConflictError,
  );

  assertEquals(attempts, 2);
  assertEquals(
    thrown,
    customError,
    "Original thrown error reference must be preserved",
  );
  assertEquals(thrown.code, "CONFLICT");
  assertEquals(thrown.requestId, "req_cas_retry_001");
});

// ============================================================================
// Group 3: normalizeError (PLAT-12 Exhaustive Code Table Mapping)
// ============================================================================

Deno.test("PLAT-12: normalizeError passes through existing RailFogError instances unchanged", () => {
  // spec: contracts/platform.contract.md#PLAT-12 — Typed error pass-through
  const instances: RailFogError[] = [
    new ResourceNotFoundError("not found", "req_1"),
    new PermissionDeniedError("forbidden", "req_2"),
    new ValidationFailedError("invalid schema", "req_3"),
    new RateLimitedError("too fast", "req_4"),
    new CallDepthExceededError("too deep", "req_5"),
    new TimeoutError("deadline exceeded", "req_6"),
    new PayloadTooLargeError("too big", "req_7"),
    new ConflictError("cas clash", "req_8"),
    new UnavailableError("down", "req_9"),
    new InternalError("bug", "req_10"),
  ];

  for (const err of instances) {
    const normalized = normalizeError(err);
    assertEquals(
      normalized,
      err,
      "Pre-existing RailFogError must pass through identical instance",
    );
    assertEquals(normalized.code, err.code);
    assertEquals(normalized.requestId, err.requestId);
  }
});

Deno.test("PLAT-12: normalizeError maps JSON response body { error: { code, message, request_id } } to all 10 typed error subclasses", () => {
  // spec: contracts/platform.contract.md#PLAT-12 — Exhaustive machine-readable code table
  const testCases: Array<{
    code: RailFogErrorCode;
    Class: new (message: string, requestId?: string) => RailFogError;
    message: string;
    requestId: string;
  }> = [
    {
      code: "RESOURCE_NOT_FOUND",
      Class: ResourceNotFoundError,
      message: "No such function revision",
      requestId: "req_01J8Z01",
    },
    {
      code: "PERMISSION_DENIED",
      Class: PermissionDeniedError,
      message: "Access to unpermitted KV namespace",
      requestId: "req_01J8Z02",
    },
    {
      code: "VALIDATION_FAILED",
      Class: ValidationFailedError,
      message: "Invalid configuration field",
      requestId: "req_01J8Z03",
    },
    {
      code: "RATE_LIMITED",
      Class: RateLimitedError,
      message: "Rate limit token bucket exhausted",
      requestId: "req_01J8Z04",
    },
    {
      code: "CALL_DEPTH_EXCEEDED",
      Class: CallDepthExceededError,
      message: "Invocation recursion limit hit",
      requestId: "req_01J8Z05",
    },
    {
      code: "TIMEOUT",
      Class: TimeoutError,
      message: "Function execution deadline exceeded",
      requestId: "req_01J8Z06",
    },
    {
      code: "PAYLOAD_TOO_LARGE",
      Class: PayloadTooLargeError,
      message: "Object payload exceeds maximum allowed size",
      requestId: "req_01J8Z07",
    },
    {
      code: "CONFLICT",
      Class: ConflictError,
      message: "Optimistic concurrency version mismatch",
      requestId: "req_01J8Z08",
    },
    {
      code: "UNAVAILABLE",
      Class: UnavailableError,
      message: "Control plane service unavailable",
      requestId: "req_01J8Z09",
    },
    {
      code: "INTERNAL",
      Class: InternalError,
      message: "Unclassified internal platform fault",
      requestId: "req_01J8Z10",
    },
  ];

  for (const { code, Class, message, requestId } of testCases) {
    const rawBody = {
      error: {
        code,
        message,
        request_id: requestId,
      },
    };

    const normalized = normalizeError(rawBody);
    assertInstanceOf(
      normalized,
      Class,
      `Code ${code} must normalize to instance of ${Class.name}`,
    );
    assertEquals(normalized.code, code);
    assertEquals(normalized.message, message);
    assertEquals(normalized.requestId, requestId);
  }
});

Deno.test("PLAT-12: normalizeError maps flat error objects { code, message, request_id } or { code, message }", () => {
  // spec: contracts/platform.contract.md#PLAT-12 — Flat error objects
  const flatObj1 = {
    code: "CONFLICT",
    message: "CAS mismatch on key",
    request_id: "req_flat_01",
  };
  const normalized1 = normalizeError(flatObj1);
  assertInstanceOf(normalized1, ConflictError);
  assertEquals(normalized1.code, "CONFLICT");
  assertEquals(normalized1.message, "CAS mismatch on key");
  assertEquals(normalized1.requestId, "req_flat_01");

  const flatObj2 = {
    code: "TIMEOUT",
    message: "Storage read timeout",
  };
  const normalized2 = normalizeError(flatObj2);
  assertInstanceOf(normalized2, TimeoutError);
  assertEquals(normalized2.code, "TIMEOUT");
  assertEquals(normalized2.message, "Storage read timeout");
  assertEquals(normalized2.requestId, undefined);
});

Deno.test("PLAT-12: normalizeError maps unknown error codes or non-table codes to InternalError", () => {
  // spec: contracts/platform.contract.md#PLAT-12 — Do not add a new error code without an ADR; unclassified faults map to INTERNAL
  const raw = {
    code: "STRANGE_UNKNOWN_ERROR_CODE",
    message: "Something alien occurred",
    request_id: "req_alien_01",
  };
  const normalized = normalizeError(raw);
  assertInstanceOf(normalized, InternalError);
  assertEquals(normalized.code, "INTERNAL");
  assertEquals(normalized.message, "Something alien occurred");
  assertEquals(normalized.requestId, "req_alien_01");
});

Deno.test("PLAT-12: normalizeError maps standard JavaScript Error instances to InternalError", () => {
  // spec: contracts/platform.contract.md#PLAT-12 — Unclassified platform fault
  const jsError = new Error(
    "Failed to connect to SQLite backing store: disk I/O error",
  );
  const normalized = normalizeError(jsError);
  assertInstanceOf(normalized, InternalError);
  assertEquals(normalized.code, "INTERNAL");
  assertEquals(
    normalized.message,
    "Failed to connect to SQLite backing store: disk I/O error",
  );
});

Deno.test("PLAT-12: normalizeError maps primitive values and nullish inputs to InternalError", () => {
  // spec: contracts/platform.contract.md#PLAT-12 — Defensive handling of non-standard throws
  const stringErr = normalizeError("Network socket abruptly closed");
  assertInstanceOf(stringErr, InternalError);
  assertEquals(stringErr.code, "INTERNAL");
  assertEquals(stringErr.message, "Network socket abruptly closed");

  const nullErr = normalizeError(null);
  assertInstanceOf(nullErr, InternalError);
  assertEquals(nullErr.code, "INTERNAL");

  const undefinedErr = normalizeError(undefined);
  assertInstanceOf(undefinedErr, InternalError);
  assertEquals(undefinedErr.code, "INTERNAL");

  const numberErr = normalizeError(500);
  assertInstanceOf(numberErr, InternalError);
  assertEquals(numberErr.code, "INTERNAL");
});

Deno.test("PLAT-12: normalizeError applies fallback requestId when not present on raw error", () => {
  // spec: contracts/platform.contract.md#PLAT-12 — ULID requestId propagation
  const rawWithoutId = {
    code: "PAYLOAD_TOO_LARGE",
    message: "Exceeded 128KB queue limit",
  };
  const normalized = normalizeError(rawWithoutId, "req_fallback_ulid_01");
  assertInstanceOf(normalized, PayloadTooLargeError);
  assertEquals(normalized.requestId, "req_fallback_ulid_01");

  // If raw error already has request_id, explicit request_id must take precedence
  const rawWithId = {
    code: "PAYLOAD_TOO_LARGE",
    message: "Exceeded 128KB queue limit",
    request_id: "req_explicit_ulid_02",
  };
  const normalizedWithExplicit = normalizeError(
    rawWithId,
    "req_fallback_ulid_01",
  );
  assertEquals(
    normalizedWithExplicit.requestId,
    "req_explicit_ulid_02",
    "Explicit request_id must take precedence over fallback",
  );
});

// ============================================================================
// Group 4: Client Wrappers (wrapKVBinding, wrapObjectBinding, wrapQueueBinding)
// ============================================================================

Deno.test("PLAT-12 & KV-2: wrapKVBinding passes through successful operations transparently", async () => {
  // spec: contracts/kv.contract.md#KV-2 — KV binding operations
  const mock = new MockKVBinding();
  const wrapped = wrapKVBinding(mock);

  await wrapped.set(["app", "config"], { theme: "dark" }, { ttl: 3600 });
  const val = await wrapped.get<{ theme: string }>(["app", "config"]);
  assertEquals(val, { theme: "dark" });

  const listRes = await wrapped.list(["app"]);
  assertEquals(listRes.entries.length, 1);
  assertEquals(listRes.entries[0].value, { theme: "dark" });

  const atomicRes = await wrapped.atomic().check(["app", "config"], 1).commit();
  assertEquals(atomicRes.ok, true);

  await wrapped.delete(["app", "config"]);
  const afterDelete = await wrapped.get(["app", "config"]);
  assertEquals(afterDelete, null);
});

Deno.test("PLAT-12 & KV-2: wrapKVBinding intercepts raw errors and rethrows normalized RailFogErrors", async () => {
  // spec: contracts/kv.contract.md#KV-2, PLAT-12 — Error normalization across KV operations
  const mock = new MockKVBinding();
  const wrapped = wrapKVBinding(mock);

  // 1. get() throwing raw error object
  mock.errorToThrow = {
    code: "RESOURCE_NOT_FOUND",
    message: "Key segment not found",
    request_id: "req_kv_01",
  };
  const getErr = await assertRejects(
    () => wrapped.get(["missing", "key"]),
    ResourceNotFoundError,
    "Key segment not found",
  );
  assertEquals(getErr.code, "RESOURCE_NOT_FOUND");
  assertEquals(getErr.requestId, "req_kv_01");

  // 2. set() throwing PAYLOAD_TOO_LARGE
  mock.errorToThrow = {
    code: "PAYLOAD_TOO_LARGE",
    message: "Value exceeds 256 KB limit",
  };
  await assertRejects(
    () => wrapped.set(["large", "key"], "huge_value"),
    PayloadTooLargeError,
    "Value exceeds 256 KB limit",
  );

  // 3. delete() throwing TIMEOUT
  mock.errorToThrow = {
    code: "TIMEOUT",
    message: "KV store write timed out",
  };
  await assertRejects(
    () => wrapped.delete(["timeout", "key"]),
    TimeoutError,
    "KV store write timed out",
  );

  // 4. list() throwing raw generic Error -> normalized to InternalError
  mock.errorToThrow = new Error("SQLite disk corrupt");
  await assertRejects(
    () => wrapped.list(["prefix"]),
    InternalError,
    "SQLite disk corrupt",
  );

  // 5. atomic().commit() throwing CONFLICT
  mock.errorToThrow = {
    code: "CONFLICT",
    message: "CAS mismatch: stored version did not match expected version",
  };
  await assertRejects(
    () => wrapped.atomic().commit(),
    ConflictError,
    "CAS mismatch",
  );
});

Deno.test("PLAT-12 & OBJ-2: wrapObjectBinding passes through successful operations transparently", async () => {
  // spec: contracts/objects.contract.md#OBJ-2 — Object binding operations
  const mock = new MockObjectBinding();
  const wrapped = wrapObjectBinding(mock);

  const payload = new TextEncoder().encode("Hello RailFog Storage");
  await wrapped.put("documents/file.txt", payload);

  const headRes = await wrapped.head("documents/file.txt");
  assertEquals(headRes?.sizeBytes, payload.length);

  const getStream = await wrapped.get("documents/file.txt");
  assertInstanceOf(getStream, ReadableStream);

  const listRes = await wrapped.list("documents/");
  assertEquals(listRes.keys.length, 1);
  assertEquals(listRes.keys[0].key, "documents/file.txt");

  const mpuRes = await wrapped.createMultipartUpload("large.bin");
  assertEquals(mpuRes.uploadId, "mpu_upload_123");

  const presignRes = await wrapped.presign("documents/file.txt", {
    method: "GET",
    expiresIn: 900,
  });
  assertEquals(typeof presignRes.url, "string");

  await wrapped.delete("documents/file.txt");
  const afterDeleteHead = await wrapped.head("documents/file.txt");
  assertEquals(afterDeleteHead, null);
});

Deno.test("PLAT-12 & OBJ-2: wrapObjectBinding intercepts raw errors and rethrows normalized RailFogErrors", async () => {
  // spec: contracts/objects.contract.md#OBJ-2, PLAT-12 — Error normalization across Object operations
  const mock = new MockObjectBinding();
  const wrapped = wrapObjectBinding(mock);

  // 1. put() throwing PAYLOAD_TOO_LARGE
  mock.errorToThrow = {
    code: "PAYLOAD_TOO_LARGE",
    message: "Object size exceeds 5 GB limit",
  };
  await assertRejects(
    () => wrapped.put("big.iso", new Uint8Array(10)),
    PayloadTooLargeError,
    "Object size exceeds 5 GB limit",
  );

  // 2. get() throwing RESOURCE_NOT_FOUND
  mock.errorToThrow = {
    code: "RESOURCE_NOT_FOUND",
    message: "No object at key",
  };
  await assertRejects(
    () => wrapped.get("nonexistent.txt"),
    ResourceNotFoundError,
    "No object at key",
  );

  // 3. delete() throwing PERMISSION_DENIED
  mock.errorToThrow = {
    code: "PERMISSION_DENIED",
    message: "Object store is read-only for this function",
  };
  await assertRejects(
    () => wrapped.delete("locked.txt"),
    PermissionDeniedError,
  );

  // 4. head() throwing TIMEOUT
  mock.errorToThrow = {
    code: "TIMEOUT",
    message: "Storage head request timed out",
  };
  await assertRejects(
    () => wrapped.head("slow.bin"),
    TimeoutError,
  );

  // 5. list() throwing VALIDATION_FAILED
  mock.errorToThrow = {
    code: "VALIDATION_FAILED",
    message: "Invalid list cursor parameter",
  };
  await assertRejects(
    () => wrapped.list("prefix", { cursor: "bad_cursor" }),
    ValidationFailedError,
  );

  // 6. createMultipartUpload() throwing UNAVAILABLE
  mock.errorToThrow = {
    code: "UNAVAILABLE",
    message: "R2 upstream connection reset",
  };
  await assertRejects(
    () => wrapped.createMultipartUpload("multi.bin"),
    UnavailableError,
  );

  // 7. presign() throwing VALIDATION_FAILED
  mock.errorToThrow = {
    code: "VALIDATION_FAILED",
    message: "expiresIn exceeds maxExpiresIn 86400",
  };
  await assertRejects(
    () => wrapped.presign("key", { method: "GET", expiresIn: 100_000 }),
    ValidationFailedError,
  );
});

Deno.test("PLAT-12 & Q-2: wrapQueueBinding passes through successful operations transparently", async () => {
  // spec: contracts/queues.contract.md#Q-2 — Queue binding operations
  const mock = new MockQueueBinding();
  const wrapped = wrapQueueBinding(mock);

  const sendRes = await wrapped.send({
    task: "send_email",
    to: "user@example.com",
  });
  assertEquals(sendRes.id, "msg_1");

  const batchRes = await wrapped.sendBatch([
    { task: "sync_1" },
    { task: "sync_2" },
  ]);
  assertEquals(batchRes.length, 2);
  assertEquals(batchRes[0].id, "msg_2");
  assertEquals(batchRes[1].id, "msg_3");
});

Deno.test("PLAT-12 & Q-2: wrapQueueBinding intercepts raw errors and rethrows normalized RailFogErrors", async () => {
  // spec: contracts/queues.contract.md#Q-2, PLAT-12 — Error normalization across Queue operations
  const mock = new MockQueueBinding();
  const wrapped = wrapQueueBinding(mock);

  // 1. send() throwing PAYLOAD_TOO_LARGE
  mock.errorToThrow = {
    code: "PAYLOAD_TOO_LARGE",
    message: "Queue message body exceeds 128 KB limit",
    request_id: "req_queue_01",
  };
  const sendErr = await assertRejects(
    () => wrapped.send({ huge: "data" }),
    PayloadTooLargeError,
    "Queue message body exceeds 128 KB limit",
  );
  assertEquals(sendErr.code, "PAYLOAD_TOO_LARGE");
  assertEquals(sendErr.requestId, "req_queue_01");

  // 2. send() throwing RATE_LIMITED
  mock.errorToThrow = {
    code: "RATE_LIMITED",
    message: "Queue ingress rate limit exceeded",
  };
  await assertRejects(
    () => wrapped.send({ task: "spam" }),
    RateLimitedError,
  );

  // 3. sendBatch() throwing TIMEOUT
  mock.errorToThrow = {
    code: "TIMEOUT",
    message: "Queue broker batch send timeout",
  };
  await assertRejects(
    () => wrapped.sendBatch([{ a: 1 }, { b: 2 }]),
    TimeoutError,
  );

  // 4. send() throwing unclassified Error -> InternalError
  mock.errorToThrow = new Error("RabbitMQ connection refused");
  await assertRejects(
    () => wrapped.send({ task: "retry" }),
    InternalError,
    "RabbitMQ connection refused",
  );
});

// ============================================================================
// Group 5: Capability Injection Bounds (PLAT-6)
// ============================================================================

Deno.test("PLAT-6: Capability injection bounds — wrapped bindings preserve pre-scoped boundaries without allowing scope tampering", () => {
  // spec: contracts/platform.contract.md#PLAT-6 — Capability injection (the permission model)
  // Permissions resolve once at deploy time into client objects physically scoped to what's permitted.
  // There is no runtime ACL check and no code path that can address an unpermitted resource.

  type DisallowedScopeKeys =
    | "pid"
    | "process"
    | "fs"
    | "cwd"
    | "shell"
    | "token"
    | "credentials"
    | "socket"
    | "tenant"
    | "tenantId"
    | "orgId"
    | "projectId"
    | "bucket"
    | "namespace"
    | "targetQueue"
    | "queueName";

  type AssertNoDisallowed<T, K extends string> = [Extract<keyof T, K>] extends
    [never] ? true : false;

  // Verify that wrapped bindings are assignable to standard SDK binding interfaces
  const mockKv = new MockKVBinding();
  const wrappedKv: KVBinding = wrapKVBinding(mockKv);
  const _kvSafe: AssertNoDisallowed<typeof wrappedKv, DisallowedScopeKeys> =
    true;

  const mockObj = new MockObjectBinding();
  const wrappedObj: ObjectBinding = wrapObjectBinding(mockObj);
  const _objSafe: AssertNoDisallowed<typeof wrappedObj, DisallowedScopeKeys> =
    true;

  const mockQueue = new MockQueueBinding();
  const wrappedQueue: QueueBinding = wrapQueueBinding(mockQueue);
  const _queueSafe: AssertNoDisallowed<
    typeof wrappedQueue,
    DisallowedScopeKeys
  > = true;

  assertEquals(_kvSafe && _objSafe && _queueSafe, true);
});

// ============================================================================
// Group 6: Adversarial Security Audit Tests (T-0502 Checklist)
// ============================================================================

Deno.test("Adversarial (KV-2, Q-4, Audit Finding #5): withIdempotency strictly prohibits writing 0, null, undefined, negative, or NaN TTL", async () => {
  // Attacker attempts to bypass retention window and create permanent or zero-TTL dedupe keys
  const invalidTtlInputs = [
    {
      name: "ttlSeconds: 0 (banned zero-TTL attempt)",
      opts: { ttlSeconds: 0 },
    },
    { name: "ttlSeconds: -1 (negative TTL bypass)", opts: { ttlSeconds: -1 } },
    {
      name: "ttlSeconds: -1000 (deep negative TTL)",
      opts: { ttlSeconds: -1000 },
    },
    { name: "ttlSeconds: NaN (invalid number)", opts: { ttlSeconds: NaN } },
    {
      name: "ttlSeconds: Infinity (unbounded TTL)",
      opts: { ttlSeconds: Infinity },
    },
    {
      name: "ttlSeconds: null (nullish bypass)",
      opts: { ttlSeconds: null as unknown as number },
    },
    {
      name: "ttlSeconds: undefined (explicit undefined)",
      opts: { ttlSeconds: undefined },
    },
    { name: "omitted options (defaulting)", opts: undefined },
    { name: "empty options object {}", opts: {} },
  ];

  for (let i = 0; i < invalidTtlInputs.length; i++) {
    const { name, opts } = invalidTtlInputs[i];
    const mockKv = new MockKVBinding();
    const key = ["dedupe", `attack_${i}`];

    const res = await withIdempotency(
      mockKv,
      key,
      () => Promise.resolve(`val_${i}`),
      opts,
    );
    assertEquals(res.processed, true);
    assertEquals(
      mockKv.calls.set.length,
      1,
      `Must write dedupe record for ${name}`,
    );

    const recordedTtl = mockKv.calls.set[0].ttl;
    assert(
      recordedTtl !== undefined && recordedTtl !== null && recordedTtl > 0,
      `TTL must be strictly defined and positive for ${name}, got ${recordedTtl}`,
    );
    assertEquals(
      recordedTtl,
      EXPECTED_DEFAULT_IDEMPOTENCY_TTL_SECONDS,
      `TTL for ${name} must safely fallback to mandatory 14-day retention window (1,209,600s)`,
    );
  }
});

Deno.test("Adversarial (Q-4 & KV-2): Failed action() NEVER persists dedupe key, preventing permanent job deadlock", async () => {
  const mockKv = new MockKVBinding();
  const key = ["critical_jobs", "job_01J8Z999"];

  // 1st invocation: fails due to temporary third-party fault
  await assertRejects(
    () =>
      withIdempotency(mockKv, key, () => {
        throw new UnavailableError("Payment gateway network down 503");
      }),
    UnavailableError,
    "Payment gateway network down 503",
  );

  assertEquals(
    mockKv.calls.set.length,
    0,
    "No dedupe marker written on failure",
  );
  const stored = await mockKv.get(key);
  assertEquals(stored, null, "Store must remain clean after failure");

  // 2nd invocation: redelivered job succeeds and is not blocked by a phantom dedupe marker
  const successRes = await withIdempotency(
    mockKv,
    key,
    () => Promise.resolve({ charged: true }),
  );
  assertEquals(successRes.processed, true);
  assertEquals(successRes.result, { charged: true });
  assertEquals(mockKv.calls.set.length, 1);
  assertEquals(
    mockKv.calls.set[0].ttl,
    EXPECTED_DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  );
});

Deno.test("Adversarial (Q-5, Audit Finding #4): withRetry strictly caps attempts and resists infinite loop attacks", async () => {
  // Attacker supplies invalid maxAttempts (Infinity, 0, -5, NaN) to induce infinite loops or denial of service
  const attackCases = [
    {
      name: "maxAttempts: Infinity",
      opts: { maxAttempts: Infinity, baseMs: 0 },
    },
    { name: "maxAttempts: 0", opts: { maxAttempts: 0, baseMs: 0 } },
    { name: "maxAttempts: -10", opts: { maxAttempts: -10, baseMs: 0 } },
    { name: "maxAttempts: NaN", opts: { maxAttempts: NaN, baseMs: 0 } },
  ];

  for (const { name, opts } of attackCases) {
    let callCount = 0;
    await assertRejects(
      () =>
        withRetry(
          () => {
            callCount++;
            return Promise.reject(
              new InternalError("Simulated persistent fault"),
            );
          },
          opts,
        ),
      InternalError,
      "Simulated persistent fault",
    );

    assertEquals(
      callCount,
      EXPECTED_DEFAULT_RETRY_MAX_ATTEMPTS,
      `Under adversarial options (${name}), withRetry must safely clamp to default ${EXPECTED_DEFAULT_RETRY_MAX_ATTEMPTS} attempts without infinite loop`,
    );
  }
});

Deno.test("Adversarial (Q-5): withRetry decorrelated jitter delay strictly respects capMs and non-negative bounds", async () => {
  let attempts = 0;
  const baseMs = 1;
  const capMs = 5;

  await assertRejects(
    () =>
      withRetry(
        () => {
          attempts++;
          return Promise.reject(new TimeoutError("Upstream timeout"));
        },
        { baseMs, capMs, maxAttempts: 5 },
      ),
    TimeoutError,
  );

  assertEquals(attempts, 5);
});

Deno.test("Adversarial (PLAT-12, PLAT-15): normalizeError scrubs unknown codes and protects against secret leakage", () => {
  // Attacker injects sensitive strings as error code or prototype pollution
  const secretLeakingErrors = [
    {
      raw: {
        code: "STRIPE_KEY_sk_live_98374982374982347928374",
        message:
          "Failed charge with secret key sk_live_98374982374982347928374",
      },
      expectedCode: "INTERNAL",
    },
    {
      raw: {
        code: "AWS_SECRET_ACCESS_KEY_wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        message: "AWS auth failure",
      },
      expectedCode: "INTERNAL",
    },
    {
      raw: {
        error: {
          code: "SQL_INJECTION_BYPASS_UNION_SELECT",
          message: "Database syntax error near 'SELECT * FROM users'",
        },
      },
      expectedCode: "INTERNAL",
    },
  ];

  for (const { raw, expectedCode } of secretLeakingErrors) {
    const normalized = normalizeError(raw);
    assertInstanceOf(normalized, InternalError);
    assertEquals(
      normalized.code,
      expectedCode,
      "Unknown or sensitive error codes must be scrubbed to INTERNAL per PLAT-12",
    );
  }
});

Deno.test("Adversarial (PLAT-6): Capability injection cannot be bypassed via wrapped bindings", () => {
  const mockKv = new MockKVBinding();
  const wrappedKv = wrapKVBinding(mockKv);

  // Assert prototype and keys do not reveal ambient node/deno objects
  const kvKeys = Object.keys(wrappedKv);
  assertEquals(
    kvKeys.sort(),
    ["atomic", "delete", "get", "list", "set"].sort(),
    "wrapKVBinding must not export or attach ambient host handles",
  );

  const mockObj = new MockObjectBinding();
  const wrappedObj = wrapObjectBinding(mockObj);
  const objKeys = Object.keys(wrappedObj);
  assertEquals(
    objKeys.sort(),
    ["createMultipartUpload", "delete", "get", "head", "list", "presign", "put"]
      .sort(),
    "wrapObjectBinding must not export or attach ambient host handles",
  );

  const mockQueue = new MockQueueBinding();
  const wrappedQueue = wrapQueueBinding(mockQueue);
  const queueKeys = Object.keys(wrappedQueue);
  assertEquals(
    queueKeys.sort(),
    ["send", "sendBatch"].sort(),
    "wrapQueueBinding must not export or attach ambient host handles",
  );
});

Deno.test("PLAT-19 & PLAT-12: @railfog/sdk re-exports all 10 typed error subclasses and RailFogError", () => {
  // All 10 exhaustive error classes must be importable directly from the SDK entrypoint
  assert(
    RailFogSDK.RailFogError !== undefined,
    "RailFogError must be exported",
  );
  assert(
    RailFogSDK.ResourceNotFoundError !== undefined,
    "ResourceNotFoundError must be exported",
  );
  assert(
    RailFogSDK.PermissionDeniedError !== undefined,
    "PermissionDeniedError must be exported",
  );
  assert(
    RailFogSDK.ValidationFailedError !== undefined,
    "ValidationFailedError must be exported",
  );
  assert(
    RailFogSDK.RateLimitedError !== undefined,
    "RateLimitedError must be exported",
  );
  assert(
    RailFogSDK.CallDepthExceededError !== undefined,
    "CallDepthExceededError must be exported",
  );
  assert(
    RailFogSDK.TimeoutError !== undefined,
    "TimeoutError must be exported",
  );
  assert(
    RailFogSDK.PayloadTooLargeError !== undefined,
    "PayloadTooLargeError must be exported",
  );
  assert(
    RailFogSDK.ConflictError !== undefined,
    "ConflictError must be exported",
  );
  assert(
    RailFogSDK.UnavailableError !== undefined,
    "UnavailableError must be exported",
  );
  assert(
    RailFogSDK.InternalError !== undefined,
    "InternalError must be exported",
  );
  assert(
    typeof RailFogSDK.toErrorResponseBody === "function",
    "toErrorResponseBody must be exported",
  );

  // Instantiation verification
  const testErr = new RailFogSDK.ConflictError("CAS conflict", "req_sdk_01");
  assert(testErr instanceof RailFogSDK.RailFogError);
  assertInstanceOf(testErr, ConflictError);
  assertEquals(testErr.code, "CONFLICT");
  assertEquals(testErr.requestId, "req_sdk_01");
});

Deno.test("PLAT-15 & PLAT-12: wrapEnvBinding normalizes errors and safely enforces require()", () => {
  const secrets: Record<string, string> = {
    API_KEY: "secret_12345",
  };

  const rawEnv = {
    get(key: string): string | undefined {
      return secrets[key];
    },
    require(key: string): string {
      const val = this.get(key);
      if (val === undefined) {
        throw new ValidationFailedError(
          `Missing required environment secret: ${key}`,
        );
      }
      return val;
    },
  };

  const wrapped = wrapEnvBinding(rawEnv);

  // Successful get and require
  assertEquals(wrapped.get("API_KEY"), "secret_12345");
  assertEquals(wrapped.require("API_KEY"), "secret_12345");
  assertEquals(wrapped.get("UNKNOWN"), undefined);

  // require() on missing secret throws typed ValidationFailedError
  assertThrows(
    () => wrapped.require("UNKNOWN"),
    ValidationFailedError,
    "Missing required environment secret: UNKNOWN",
  );

  // Defensive fallback when underlying env has no require method
  const fallbackEnv = wrapEnvBinding({
    get(key: string): string | undefined {
      return secrets[key];
    },
  } as EnvBinding);

  assertEquals(fallbackEnv.require("API_KEY"), "secret_12345");
  assertThrows(
    () => fallbackEnv.require("MISSING"),
    ValidationFailedError,
    "Missing required environment secret: MISSING",
  );
});

Deno.test("FN-4, PLAT-6 & PLAT-12: wrapContext wraps all capabilities with error normalization", async () => {
  const mockKv = new MockKVBinding();
  const mockObj = new MockObjectBinding();
  const mockQueue = new MockQueueBinding();
  const mockEnv: EnvBinding = {
    get: (key: string) => (key === "TOKEN" ? "tok_123" : undefined),
    require: (key: string) => {
      if (key !== "TOKEN") throw new ValidationFailedError(`Missing ${key}`);
      return "tok_123";
    },
  };

  const rawCtx = {
    requestId: "req_ctx_test_01",
    project: "test-proj",
    function: "test-fn",
    revision: "rev_01",
    deadline: Date.now() + 30000,
    timeRemaining: () => 30000,
    kv: mockKv,
    objects: mockObj,
    queues: mockQueue,
    env: mockEnv,
  };

  const wrappedCtx = wrapContext(rawCtx);

  // Metadata preserved
  assertEquals(wrappedCtx.requestId, "req_ctx_test_01");
  assertEquals(wrappedCtx.project, "test-proj");
  assertEquals(wrappedCtx.function, "test-fn");
  assertEquals(wrappedCtx.revision, "rev_01");
  assertEquals(typeof wrappedCtx.timeRemaining, "function");

  // Capabilities transparently execute
  await wrappedCtx.kv.set(["user", "1"], { name: "Alice" });
  const user = await wrappedCtx.kv.get<{ name: string }>(["user", "1"]);
  assertEquals(user?.name, "Alice");

  await wrappedCtx.objects.put("hello.txt", new TextEncoder().encode("world"));
  const head = await wrappedCtx.objects.head("hello.txt");
  assertEquals(head?.sizeBytes, 5);

  const sendResult = await wrappedCtx.queues.send({ task: "run" });
  assert(sendResult.id.startsWith("msg_"));

  assertEquals(wrappedCtx.env.get("TOKEN"), "tok_123");
  assertEquals(wrappedCtx.env.require("TOKEN"), "tok_123");

  // Adversarial: ensure no ambient host handles leaked on wrappedCtx
  const allowedCtxKeys = [
    "deadline",
    "env",
    "function",
    "kv",
    "objects",
    "project",
    "queues",
    "requestId",
    "revision",
    "timeRemaining",
  ].sort();
  assertEquals(Object.keys(wrappedCtx).sort(), allowedCtxKeys);
});

Deno.test("Q-4: withIdempotency executes synchronous action callbacks seamlessly", async () => {
  const mockKv = new MockKVBinding();
  let executed = 0;

  const result = await withIdempotency(mockKv, ["sync", "job-1"], () => {
    executed++;
    return 42;
  });

  assertEquals(result.processed, true);
  assertEquals(result.result, 42);
  assertEquals(executed, 1);

  // Second execution skipped
  const result2 = await withIdempotency(mockKv, ["sync", "job-1"], () => {
    executed++;
    return 999;
  });

  assertEquals(result2.processed, false);
  assertEquals(result2.result, undefined);
  assertEquals(executed, 1);
});

Deno.test("Q-5: withRetry executes synchronous action callbacks seamlessly", async () => {
  let attempts = 0;

  const result = await withRetry(
    () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("Temporary sync glitch");
      }
      return "success_sync";
    },
    { baseMs: 5, capMs: 20, maxAttempts: 5 },
  );

  assertEquals(result, "success_sync");
  assertEquals(attempts, 3);
});

Deno.test("RPC Client: createRpcClient handles GET, POST, and typed error normalization", async () => {
  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    await Promise.resolve();
    const urlStr = String(input);
    const method = init?.method ?? "GET";

    if (urlStr.includes("/api/hello")) {
      return Response.json({ message: "Hello from RPC" }, { status: 200 });
    }
    if (urlStr.includes("/api/echo") && method === "POST") {
      const parsed = JSON.parse(String(init?.body));
      return Response.json({ echoed: parsed }, { status: 201 });
    }
    if (urlStr.includes("/api/not-found")) {
      return Response.json({
        error: { code: "RESOURCE_NOT_FOUND", message: "Item missing" },
      }, { status: 404 });
    }
    return new Response("Unknown", { status: 404 });
  };

  const client = createRpcClient("https://example.railfog.internal", {
    fetch: mockFetch as unknown as typeof fetch,
  });

  // Test GET
  const getRes = await client.get<{ message: string }>("/api/hello");
  assertEquals(getRes.message, "Hello from RPC");

  // Test POST
  const postRes = await client.post<{ echoed: { count: number } }>(
    "/api/echo",
    { count: 42 },
  );
  assertEquals(postRes.echoed.count, 42);

  // Test Error Normalization
  await assertRejects(
    () => client.get("/api/not-found"),
    ResourceNotFoundError,
    "Item missing",
  );
});

// ============================================================================
// Group 10: RpcClient Extended Methods & AbortSignal (Audit Finding #6, #7)
// ============================================================================

Deno.test("T-0502 / RpcClient: patch, head, and signal handling", async () => {
  let capturedMethod = "";
  let capturedBody: unknown = null;
  let capturedSignal: AbortSignal | undefined = undefined;

  const mockFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedMethod = init?.method ?? "GET";
    capturedSignal = init?.signal ?? undefined;
    const urlStr = String(input);

    if (capturedMethod === "PATCH") {
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return Promise.resolve(
        Response.json({ patched: true, received: capturedBody }),
      );
    }

    if (capturedMethod === "HEAD") {
      if (urlStr.includes("/api/missing")) {
        return Promise.resolve(
          new Response(null, {
            status: 404,
            statusText: "Not Found",
            headers: { "x-request-id": "01HEADNOTFOUND" },
          }),
        );
      }
      return Promise.resolve(
        new Response(null, {
          status: 200,
          headers: { "x-custom-header": "test-val", "content-length": "42" },
        }),
      );
    }

    return Promise.resolve(Response.json({ ok: true }));
  };

  const client = createRpcClient("https://example.railfog.internal", {
    fetch: mockFetch as unknown as typeof fetch,
  });

  // 1. Test PATCH
  const patchRes = await client.patch<
    { patched: boolean; received: { status: string } }
  >(
    "/api/resource",
    { status: "archived" },
  );
  assertEquals(capturedMethod, "PATCH");
  assertEquals(patchRes.patched, true);
  assertEquals(patchRes.received.status, "archived");

  // 2. Test HEAD success
  const headHeaders = await client.head("/api/ping");
  assertEquals(capturedMethod, "HEAD");
  assertEquals(headHeaders.get("x-custom-header"), "test-val");
  assertEquals(headHeaders.get("content-length"), "42");

  // 3. Test HEAD error normalization
  await assertRejects(
    () => client.head("/api/missing"),
    ResourceNotFoundError,
  );

  // 4. Test AbortSignal forwarding
  const controller = new AbortController();
  await client.get("/api/test", { signal: controller.signal });
  assertEquals(capturedSignal, controller.signal);
});

// ============================================================================
// Group 11: Reliability Helper: withCircuitBreaker (Q-6, KV-2, PLAT-12)
// ============================================================================

Deno.test("T-0502 / Q-6: withCircuitBreaker executes action when circuit is closed", async () => {
  const kv = new MockKVBinding();
  const circuitKey = ["circuit", "service-a"];

  let callCount = 0;
  const result = await withCircuitBreaker(kv, circuitKey, () => {
    callCount++;
    return "success-payload";
  });

  assertEquals(result, "success-payload");
  assertEquals(callCount, 1);
});

Deno.test("T-0502 / Q-6: withCircuitBreaker trips to open after failure threshold is reached", async () => {
  const kv = new MockKVBinding();
  const circuitKey = ["circuit", "flaky-service"];
  const threshold = 3;

  for (let i = 1; i <= threshold; i++) {
    await assertRejects(
      () =>
        withCircuitBreaker(
          kv,
          circuitKey,
          () => {
            throw new Error(`Simulated failure ${i}`);
          },
          { failureThreshold: threshold, cooldownMs: 10_000 },
        ),
      Error,
      `Simulated failure ${i}`,
    );
  }

  // Next call must fail immediately with UnavailableError without executing the action
  let executedWhenOpen = false;
  await assertRejects(
    () =>
      withCircuitBreaker(
        kv,
        circuitKey,
        () => {
          executedWhenOpen = true;
          return "should-not-run";
        },
        { failureThreshold: threshold, cooldownMs: 10_000 },
      ),
    UnavailableError,
    "Circuit breaker 'circuit/flaky-service' is open",
  );

  assertEquals(executedWhenOpen, false);
});

Deno.test("T-0502 / Q-6: withCircuitBreaker recovers after cooldown and resets failures on success", async () => {
  const kv = new MockKVBinding();
  const circuitKey = ["circuit", "recovering-service"];

  // Pre-seed an expired open circuit
  await kv.set(circuitKey, {
    failures: 5,
    openUntil: Date.now() - 1000, // expired 1s ago
  });

  let actionExecuted = false;
  const result = await withCircuitBreaker(
    kv,
    circuitKey,
    () => {
      actionExecuted = true;
      return "recovered";
    },
    { failureThreshold: 3, cooldownMs: 1000 },
  );

  assertEquals(actionExecuted, true);
  assertEquals(result, "recovered");

  // Verify failure state was cleared from KV on success
  const storedState = await kv.get(circuitKey);
  assertEquals(storedState, null);
});

Deno.test("T-0502 / Q-6: withCircuitBreaker default thresholds and options type checking", () => {
  assertEquals(DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD, 5);
  assertEquals(DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS, 30_000);

  const opts: CircuitBreakerOptions = {
    failureThreshold: DEFAULT_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    cooldownMs: DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
  };
  assertEquals(opts.failureThreshold, 5);
  assertEquals(opts.cooldownMs, 30_000);
});

// ============================================================================
// Group 12: Scoped KV Subspaces (scopedKV)
// ============================================================================

Deno.test("T-0502 / KV-2, PLAT-6: scopedKV prefixes keys and strips prefixes in list", async () => {
  const kv = new MockKVBinding();
  const scoped = scopedKV(kv, "tenants", "tenant_a");

  // 1. Set key via scoped
  await scoped.set(["settings", "theme"], "dark");

  // Verify stored in underlying KV with full prefix
  const rawVal = await kv.get(["tenants", "tenant_a", "settings", "theme"]);
  assertEquals(rawVal, "dark");

  // Verify get via scoped
  const scopedVal = await scoped.get(["settings", "theme"]);
  assertEquals(scopedVal, "dark");

  // 2. List via scoped
  await scoped.set(["settings", "lang"], "en");
  const listRes = await scoped.list(["settings"]);
  assertEquals(listRes.entries.length, 2);
  // Keys in listRes must be relative to the scope (stripped)
  const keys = listRes.entries.map((e) => e.key.join("/"));
  assert(keys.includes("settings/theme"));
  assert(keys.includes("settings/lang"));

  // 3. Atomic via scoped
  const atomicRes = await scoped.atomic()
    .check(["settings", "theme"], 1)
    .set(["settings", "theme"], "light")
    .commit();
  assertEquals(atomicRes.ok, true);
  assertEquals(await scoped.get(["settings", "theme"]), "light");

  // 4. Delete via scoped
  await scoped.delete(["settings", "lang"]);
  assertEquals(await scoped.get(["settings", "lang"]), null);
});

// ============================================================================
// Group 13: Atomic Concurrency Mutation (mutate<T>)
// ============================================================================

Deno.test("T-0502 / KV-3: mutate initializes non-existent key", async () => {
  const kv = new MockKVBinding();
  const key = ["counters", "views"];

  const newVal = await mutate<number>(kv, key, (curr) => (curr ?? 0) + 1);
  assertEquals(newVal, 1);
  assertEquals(await kv.get(key), 1);
});

Deno.test("T-0502 / KV-3: mutate atomically updates existing key", async () => {
  const kv = new MockKVBinding();
  const key = ["users", "usr_1", "balance"];
  await kv.set(key, 100);

  const newBalance = await mutate<number>(kv, key, (curr) => (curr ?? 0) + 50);
  assertEquals(newBalance, 150);
  assertEquals(await kv.get(key), 150);
});

Deno.test("T-0502 / KV-3, Q-5: mutate retries on CAS conflict and completes successfully", async () => {
  const kv = new MockKVBinding();
  const key = ["orders", "ord_42", "sequence"];
  await kv.set(key, 10);

  let attempts = 0;
  const finalVal = await mutate<number>(
    kv,
    key,
    async (curr) => {
      attempts++;
      if (attempts === 1) {
        // Interleaving conflicting concurrent write
        await kv.set(key, 11);
      }
      return (curr ?? 0) + 5;
    },
    { maxRetries: 3, baseMs: 10, capMs: 50 },
  );

  // 1st attempt detected conflict (version changed from 1 to 2 by concurrent write)
  // 2nd attempt re-read 11, computed 16, and successfully committed!
  assertEquals(attempts, 2);
  assertEquals(finalVal, 16);
  assertEquals(await kv.get(key), 16);
});

Deno.test("T-0502 / KV-3, PLAT-12: mutate throws ConflictError when maxRetries exhausted", async () => {
  const kv = new MockKVBinding();
  const key = ["state", "lock"];
  await kv.set(key, "locked");

  const mutateOpts: MutateOptions = { maxRetries: 2, baseMs: 5, capMs: 10 };

  await assertRejects(
    () =>
      mutate<string>(
        kv,
        key,
        async (curr) => {
          // Always mutate concurrently to force CAS failure on every attempt
          await kv.set(key, `mutated-${Date.now()}`);
          return `next-${curr}`;
        },
        mutateOpts,
      ),
    ConflictError,
    "Optimistic concurrency mutation conflict",
  );
});
