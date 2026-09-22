// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: sdk/typescript testing module
// spec: contracts/functions.contract.md#FN-4 — RailFogContext structure and capability bindings
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & scoped storage
// spec: contracts/platform.contract.md#PLAT-12 — Error model: exhaustive typed errors
// spec: contracts/platform.contract.md#PLAT-14 — Request correlation ID (ULID algorithm)
// spec: contracts/platform.contract.md#PLAT-15 — Capability-scoped secret access via env
// spec: contracts/kv.contract.md#KV-2 — KVBinding API shape
// spec: contracts/kv.contract.md#KV-3 — Optimistic concurrency CAS version checks
// spec: contracts/objects.contract.md#OBJ-2 — ObjectBinding API shape
// spec: contracts/objects.contract.md#OBJ-4 — Content addressing (SHA-256 hex/base64)
// spec: contracts/queues.contract.md#Q-2 — QueueBinding API shape

import { ValidationFailedError } from "../../packages/errors/mod.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";
import type {
  EnvBinding,
  KVAtomicOperation,
  KVBinding,
  ListOptions,
  ObjectBinding,
  PresignOptions,
  QueueBinding,
  QueueMessage,
  RailFogContext,
} from "./types.ts";

/**
 * Options to configure the in-memory mock RailFogContext.
 */
export interface MockContextOptions {
  requestId?: string;
  project?: string;
  function?: string;
  revision?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  initialKv?: Array<[string[], unknown]> | Record<string, unknown>;
  initialObjects?: Record<string, Uint8Array | string>;
}

/**
 * In-memory storage state exposed for deterministic test assertions.
 */
export interface MockStorageState {
  kv: Map<string, { value: unknown; version: number }>;
  objects: Map<
    string,
    { bytes: Uint8Array; sha256: string; integrity: string }
  >;
  queue: Array<QueueMessage>;
  env: Map<string, string>;
  getKv(key: string[]): unknown | null;
  getKvVersion(key: string[]): number;
}

/**
 * Enhanced RailFogContext for unit and integration tests with inspectable storage.
 */
export interface MockRailFogContext extends RailFogContext {
  readonly storage: MockStorageState;
}

function serializeKey(key: string[]): string {
  return JSON.stringify(key);
}

function isPrefixMatch(fullKey: string[], prefix: string[]): boolean {
  if (prefix.length > fullKey.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (fullKey[i] !== prefix[i]) return false;
  }
  return true;
}

async function computeSha256(
  bytes: Uint8Array,
): Promise<{ sha256: string; integrity: string }> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as BufferSource,
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  // base64 encoding per OBJ-4 Subresource Integrity
  let binary = "";
  const len = hashArray.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(hashArray[i]);
  }
  const b64 = btoa(binary);
  return {
    sha256: `sha256:${hex}`,
    integrity: `sha256-${b64}`,
  };
}

async function streamToBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLength += value.byteLength;
    }
  }
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Creates a zero-dependency, in-memory mock RailFogContext for fast, deterministic unit testing.
 * Provides in-memory KV, Object storage, Queues, and Env secrets conforming to all contracts.
 *
 * @spec contracts/functions.contract.md#FN-4 — RailFogContext structure
 * @spec contracts/platform.contract.md#PLAT-6 — Capability injection
 * @spec contracts/platform.contract.md#PLAT-15 — Capability-scoped secret access
 *
 * @example
 * ```typescript
 * import { assertEquals } from "@std/assert";
 * import { createMockContext } from "@railfog/sdk";
 * import handler from "./api.ts";
 *
 * Deno.test("handles requests", async () => {
 *   const ctx = createMockContext({ env: { API_KEY: "secret" } });
 *   const res = await handler(new Request("https://app.railfog.net/greet"), ctx);
 *   assertEquals(res.status, 200);
 * });
 * ```
 */
export function createMockContext(
  options?: MockContextOptions,
): MockRailFogContext {
  const requestId = options?.requestId ?? generateUlid();
  const project = options?.project ?? "test-project";
  const functionName = options?.function ?? "test-function";
  const revision = options?.revision ?? "rev_1";
  const timeoutMs = options?.timeoutMs ?? 30000;
  const deadline = Date.now() + timeoutMs;

  // 1. Env State
  const envMap = new Map<string, string>();
  if (options?.env) {
    for (const [k, v] of Object.entries(options.env)) {
      envMap.set(k, String(v));
    }
  }

  const env: EnvBinding = {
    get(key: string): string | undefined {
      return envMap.get(key);
    },
    require(key: string): string {
      const val = envMap.get(key);
      if (val === undefined) {
        throw new ValidationFailedError(
          `Missing required secret '${key}'`,
          requestId,
        );
      }
      return val;
    },
  };

  // 2. KV State
  const kvMap = new Map<string, { value: unknown; version: number }>();
  let globalKvVersion = 1;

  if (options?.initialKv) {
    if (Array.isArray(options.initialKv)) {
      for (const [key, val] of options.initialKv) {
        kvMap.set(serializeKey(key), {
          value: val,
          version: globalKvVersion++,
        });
      }
    } else {
      for (const [keyStr, val] of Object.entries(options.initialKv)) {
        const parsedKey = keyStr.includes("/") ? keyStr.split("/") : [keyStr];
        kvMap.set(serializeKey(parsedKey), {
          value: val,
          version: globalKvVersion++,
        });
      }
    }
  }

  const kv: KVBinding = {
    get<T = unknown>(key: string[]): Promise<T | null> {
      const entry = kvMap.get(serializeKey(key));
      if (!entry) return Promise.resolve(null);
      return Promise.resolve(entry.value as T);
    },
    set(
      key: string[],
      value: unknown,
      _options?: { ttl?: number },
    ): Promise<void> {
      kvMap.set(serializeKey(key), {
        value,
        version: globalKvVersion++,
      });
      return Promise.resolve();
    },
    delete(key: string[]): Promise<void> {
      kvMap.delete(serializeKey(key));
      return Promise.resolve();
    },
    list<T = unknown>(
      prefix: string[],
      opts?: ListOptions,
    ): Promise<{
      entries: Array<{ key: string[]; value: T; version: number }>;
      cursor?: string;
    }> {
      const results: Array<{ key: string[]; value: T; version: number }> = [];
      for (const [serialized, entry] of kvMap.entries()) {
        const fullKey = JSON.parse(serialized) as string[];
        if (isPrefixMatch(fullKey, prefix)) {
          results.push({
            key: fullKey,
            value: entry.value as T,
            version: entry.version,
          });
        }
      }
      const limit = opts?.limit ?? results.length;
      return Promise.resolve({
        entries: results.slice(0, limit),
        cursor: undefined,
      });
    },
    atomic(): KVAtomicOperation {
      const checks: Array<{ key: string[]; expectedVersion: number }> = [];
      const mutations: Array<
        | { type: "set"; key: string[]; value: unknown; ttl?: number }
        | { type: "delete"; key: string[] }
      > = [];

      const op: KVAtomicOperation = {
        check(key: string[], expectedVersion: number): KVAtomicOperation {
          checks.push({ key, expectedVersion });
          return op;
        },
        set(
          key: string[],
          value: unknown,
          opts?: { ttl?: number },
        ): KVAtomicOperation {
          mutations.push({
            type: "set",
            key,
            value,
            ttl: opts?.ttl,
          });
          return op;
        },
        delete(key: string[]): KVAtomicOperation {
          mutations.push({ type: "delete", key });
          return op;
        },
        commit(): Promise<{ ok: boolean; version?: number }> {
          for (const chk of checks) {
            const entry = kvMap.get(serializeKey(chk.key));
            const curVersion = entry ? entry.version : 0;
            if (curVersion !== chk.expectedVersion) {
              return Promise.resolve({ ok: false });
            }
          }
          let lastVersion = 1;
          for (const mut of mutations) {
            const sKey = serializeKey(mut.key);
            if (mut.type === "set") {
              lastVersion = globalKvVersion++;
              kvMap.set(sKey, {
                value: mut.value,
                version: lastVersion,
              });
            } else {
              kvMap.delete(sKey);
            }
          }
          return Promise.resolve({ ok: true, version: lastVersion });
        },
      };
      return op;
    },
  };

  // 3. Object State
  const objectMap = new Map<
    string,
    { bytes: Uint8Array; sha256: string; integrity: string }
  >();
  if (options?.initialObjects) {
    for (const [key, val] of Object.entries(options.initialObjects)) {
      const bytes = typeof val === "string"
        ? new TextEncoder().encode(val)
        : val;
      // Precompute sync placeholder, sha computed on demand or immediately
      objectMap.set(key, {
        bytes,
        sha256: "sha256:mock",
        integrity: "sha256-mock",
      });
    }
  }

  const objects: ObjectBinding = {
    async put(
      key: string,
      data: Uint8Array | ReadableStream<Uint8Array>,
    ): Promise<void> {
      const bytes = data instanceof Uint8Array
        ? data
        : await streamToBytes(data);
      const hashes = await computeSha256(bytes);
      objectMap.set(key, {
        bytes,
        sha256: hashes.sha256,
        integrity: hashes.integrity,
      });
    },
    get(key: string): Promise<ReadableStream<Uint8Array> | null> {
      const entry = objectMap.get(key);
      if (!entry) return Promise.resolve(null);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(entry.bytes);
          controller.close();
        },
      });
      return Promise.resolve(stream);
    },
    delete(key: string): Promise<void> {
      objectMap.delete(key);
      return Promise.resolve();
    },
    async head(
      key: string,
    ): Promise<
      { sizeBytes: number; sha256: string; integrity: string } | null
    > {
      const entry = objectMap.get(key);
      if (!entry) return null;
      if (entry.sha256 === "sha256:mock") {
        const hashes = await computeSha256(entry.bytes);
        entry.sha256 = hashes.sha256;
        entry.integrity = hashes.integrity;
      }
      return {
        sizeBytes: entry.bytes.byteLength,
        sha256: entry.sha256,
        integrity: entry.integrity,
      };
    },
    list(
      prefix: string,
      opts?: ListOptions,
    ): Promise<{
      keys: Array<{ key: string; sizeBytes: number; sha256: string }>;
      cursor?: string;
    }> {
      const results: Array<{ key: string; sizeBytes: number; sha256: string }> =
        [];
      for (const [key, entry] of objectMap.entries()) {
        if (prefix === "" || key.startsWith(prefix)) {
          results.push({
            key,
            sizeBytes: entry.bytes.byteLength,
            sha256: entry.sha256,
          });
        }
      }
      const limit = opts?.limit ?? results.length;
      return Promise.resolve({
        keys: results.slice(0, limit),
        cursor: undefined,
      });
    },
    createMultipartUpload(key: string): Promise<{ uploadId: string }> {
      return Promise.resolve({
        uploadId: `mock-upload-${generateUlid()}-${key}`,
      });
    },
    presign(
      key: string,
      options: PresignOptions,
    ): Promise<{ url: string; headers: Record<string, string> }> {
      return Promise.resolve({
        url:
          `https://mock-storage.railfog.local/${key}?method=${options.method}`,
        headers: {},
      });
    },
  };

  // 4. Queue State
  const queueMessages: Array<QueueMessage> = [];

  const queues: QueueBinding = {
    send<T = unknown>(
      message: T,
      _options?: { delay?: number },
    ): Promise<{ id: string }> {
      const id = generateUlid();
      queueMessages.push({
        id,
        body: message,
        attempts: 1,
        timestamp: Date.now(),
      });
      return Promise.resolve({ id });
    },
    sendBatch<T = unknown>(messages: T[]): Promise<Array<{ id: string }>> {
      const results: Array<{ id: string }> = [];
      for (const msg of messages) {
        const id = generateUlid();
        queueMessages.push({
          id,
          body: msg,
          attempts: 1,
          timestamp: Date.now(),
        });
        results.push({ id });
      }
      return Promise.resolve(results);
    },
  };

  const storage: MockStorageState = {
    kv: kvMap,
    objects: objectMap,
    queue: queueMessages,
    env: envMap,
    getKv(key: string[]): unknown | null {
      const entry = kvMap.get(serializeKey(key));
      return entry ? entry.value : null;
    },
    getKvVersion(key: string[]): number {
      const entry = kvMap.get(serializeKey(key));
      return entry ? entry.version : 0;
    },
  };

  return {
    requestId,
    project,
    function: functionName,
    revision,
    deadline,
    timeRemaining(): number {
      return Math.max(0, deadline - Date.now());
    },
    kv,
    objects,
    queues,
    env,
    storage,
  };
}
