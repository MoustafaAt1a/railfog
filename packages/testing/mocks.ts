// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
// spec: contracts/platform.contract.md#PLAT-17 — Local/production parity
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: packages/testing
// spec: contracts/kv.contract.md#KV-2 — KVProvider API shape
// spec: contracts/objects.contract.md#OBJ-2 — ObjectProvider API shape
// spec: contracts/queues.contract.md#Q-2 — QueueProvider API shape
// spec: tasks/milestone-0.7-repo-consolidation/T-0708-reusable-test-harness-package.md

import type {
  KVAtomicBuilder,
  KVProvider,
} from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";
import type {
  Artifact,
  ComputeProvider,
  ExecutionResult,
  InvocationRequest,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";

function serializeKvKey(key: string[]): string {
  return key.join(":");
}

/**
 * Standardized in-memory mock KVProvider implementing PLAT-16 and KV-2.
 */
export function createMockKVProvider(
  initial?: Map<string, unknown>,
): KVProvider & { storage: Map<string, unknown> } {
  const storage = new Map<string, unknown>(initial ?? []);

  const findEntry = (key: string[]): { found: boolean; value: unknown } => {
    const k1 = serializeKvKey(key);
    if (storage.has(k1)) return { found: true, value: storage.get(k1) };
    const k2 = key.join("/");
    if (storage.has(k2)) return { found: true, value: storage.get(k2) };
    const k3 = JSON.stringify(key);
    if (storage.has(k3)) return { found: true, value: storage.get(k3) };
    if (key.length === 1 && storage.has(key[0])) {
      return { found: true, value: storage.get(key[0]) };
    }
    return { found: false, value: null };
  };

  const provider: KVProvider & { storage: Map<string, unknown> } = {
    storage,

    get(key: string[]): Promise<unknown | null> {
      const { found, value } = findEntry(key);
      return Promise.resolve(found ? value : null);
    },

    set(
      key: string[],
      value: unknown,
      _opts?: { ttl?: number },
    ): Promise<void> {
      storage.set(serializeKvKey(key), value);
      return Promise.resolve();
    },

    delete(key: string[]): Promise<void> {
      storage.delete(serializeKvKey(key));
      storage.delete(key.join("/"));
      storage.delete(JSON.stringify(key));
      if (key.length === 1) storage.delete(key[0]);
      return Promise.resolve();
    },

    list(
      prefix: string[],
      opts?: { limit?: number; cursor?: string },
    ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }> {
      const prefixStr = serializeKvKey(prefix);
      const matched: { key: string[]; value: unknown }[] = [];

      for (const [k, v] of storage.entries()) {
        if (
          prefix.length === 0 || k === prefixStr ||
          k.startsWith(prefixStr + ":") || k.startsWith(prefixStr + "/")
        ) {
          const parts = k.includes(":") ? k.split(":") : k.split("/");
          matched.push({ key: parts, value: v });
        }
      }

      const limit = opts?.limit ?? matched.length;
      const results = matched.slice(0, limit);
      return Promise.resolve({ keys: results });
    },

    atomic(): KVAtomicBuilder {
      const mutations: Array<
        { type: "set" | "delete"; key: string[]; value?: unknown }
      > = [];
      const checks: Array<{ key: string[]; expectedVersion: number }> = [];

      const builder: KVAtomicBuilder = {
        check(key: string[], expectedVersion: number): KVAtomicBuilder {
          checks.push({ key, expectedVersion });
          return builder;
        },
        set(key: string[], value: unknown): KVAtomicBuilder {
          mutations.push({ type: "set", key, value });
          return builder;
        },
        delete(key: string[]): KVAtomicBuilder {
          mutations.push({ type: "delete", key });
          return builder;
        },
        async commit(): Promise<{ ok: boolean; version?: number }> {
          for (const mut of mutations) {
            if (mut.type === "set") {
              await provider.set(mut.key, mut.value);
            } else {
              await provider.delete(mut.key);
            }
          }
          return { ok: true, version: 1 };
        },
      };

      return builder;
    },
  };

  return provider;
}

/**
 * Standardized in-memory mock ObjectProvider implementing PLAT-16 and OBJ-2.
 */
export function createMockObjectProvider(
  initial?: Map<string, Uint8Array>,
): ObjectProvider & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>(initial ?? []);

  const provider: ObjectProvider & { objects: Map<string, Uint8Array> } = {
    objects,

    async put(
      key: string,
      data: ArrayBuffer | ReadableStream,
    ): Promise<{ etag: string }> {
      let bytes: Uint8Array;
      if (data instanceof ArrayBuffer) {
        bytes = new Uint8Array(data);
      } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else {
        const reader = (data as ReadableStream<Uint8Array>).getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            total += value.byteLength;
          }
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }

      objects.set(key, bytes);
      const etag = `"${bytes.byteLength}-${Date.now()}"`;
      return { etag };
    },

    get(key: string): Promise<ReadableStream | null> {
      const bytes = objects.get(key);
      if (!bytes) {
        return Promise.resolve(null);
      }

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });

      return Promise.resolve(stream);
    },

    delete(key: string): Promise<void> {
      objects.delete(key);
      return Promise.resolve();
    },

    head(key: string): Promise<{ size: number; etag: string } | null> {
      const bytes = objects.get(key);
      if (!bytes) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        size: bytes.byteLength,
        etag: `"${bytes.byteLength}"`,
      });
    },

    list(
      prefix: string,
      opts?: { limit?: number; cursor?: string },
    ): Promise<{ keys: string[]; cursor?: string }> {
      const matched = [...objects.keys()].filter((k) => k.startsWith(prefix));
      const limit = opts?.limit ?? matched.length;
      return Promise.resolve({ keys: matched.slice(0, limit) });
    },

    presign(
      key: string,
      opts: {
        method: "GET" | "PUT";
        expiresIn?: number;
        maxExpiresIn?: number;
      },
    ): Promise<{ url: string; expiresAt: number }> {
      const expiry = opts.expiresIn ?? 3600;
      const expiresAt = Date.now() + expiry * 1000;
      return Promise.resolve({
        url: `https://mock.storage.local/${
          encodeURIComponent(key)
        }?method=${opts.method}`,
        expiresAt,
      });
    },

    createMultipartUpload(key: string): Promise<{ uploadId: string }> {
      return Promise.resolve({
        uploadId: `mock-upload-${generateUlid()}-${encodeURIComponent(key)}`,
      });
    },
  };

  return provider;
}

/**
 * Standardized in-memory mock QueueProvider implementing PLAT-16 and Q-2.
 */
export function createMockQueueProvider(): QueueProvider & {
  messages: Array<{ id: string; body: unknown }>;
} {
  const messages: Array<{ id: string; body: unknown }> = [];

  const provider: QueueProvider & {
    messages: Array<{ id: string; body: unknown }>;
  } = {
    messages,

    send(body: unknown, _opts?: { delay?: number }): Promise<{ id: string }> {
      const id = generateUlid();
      messages.push({ id, body });
      return Promise.resolve({ id });
    },

    sendBatch(bodies: unknown[]): Promise<{ id: string }[]> {
      const results: { id: string }[] = [];
      for (const body of bodies) {
        const id = generateUlid();
        messages.push({ id, body });
        results.push({ id });
      }
      return Promise.resolve(results);
    },

    receive(
      _opts?: { visibilityTimeoutMs?: number },
    ): Promise<QueueMessage | null> {
      if (messages.length === 0) {
        return Promise.resolve(null);
      }
      const msg = messages[0];
      return Promise.resolve({
        id: msg.id,
        body: msg.body,
        attempts: 1,
      });
    },

    ack(id: string): Promise<void> {
      const index = messages.findIndex((m) => m.id === id);
      if (index !== -1) {
        messages.splice(index, 1);
      }
      return Promise.resolve();
    },
  };

  return provider;
}

/**
 * Standardized in-memory mock ComputeProvider implementing PLAT-16 and ADR-0001.
 */
export function createMockComputeProvider(
  handler?: (
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ) => Promise<ExecutionResult>,
): ComputeProvider & {
  calls: Array<{
    artifact: Artifact;
    limits: Limits;
    invocation?: InvocationRequest;
  }>;
} {
  const calls: Array<{
    artifact: Artifact;
    limits: Limits;
    invocation?: InvocationRequest;
  }> = [];

  const defaultHandler = (
    _artifact: Artifact,
    _limits: Limits,
    _invocation?: InvocationRequest,
  ): Promise<ExecutionResult> => {
    return Promise.resolve({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ ok: true })),
      cpuTimeMs: 1,
      wallClockMs: 2,
    });
  };

  const activeHandler = handler ?? defaultHandler;

  const provider: ComputeProvider & {
    calls: Array<{
      artifact: Artifact;
      limits: Limits;
      invocation?: InvocationRequest;
    }>;
  } = {
    calls,

    run(
      artifact: Artifact,
      limits: Limits,
      invocation?: InvocationRequest,
    ): Promise<ExecutionResult> {
      calls.push({ artifact, limits, invocation });
      return activeHandler(artifact, limits, invocation);
    },
  };

  return provider;
}
