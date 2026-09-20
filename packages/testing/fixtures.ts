// spec: contracts/platform.contract.md#PLAT-14 — ULID format for requestId and revision
// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: packages/testing
// spec: contracts/functions.contract.md#FN-4 — RailFogContext structure
// spec: contracts/functions.contract.md#FN-5 — Resource limits defaults
// spec: tasks/milestone-0.7-repo-consolidation/T-0708-reusable-test-harness-package.md

import type {
  Artifact,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import type {
  EnvBinding,
  KVBinding,
  ObjectBinding,
  QueueBinding,
  RailFogContext,
} from "../../primitives/functions/types.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";

/**
 * Creates deterministic resource limits for testing per FN-5.
 */
export function createTestLimits(overrides?: Partial<Limits>): Limits {
  return {
    cpuMs: 200,
    timeoutMs: 30000,
    memoryMb: 128,
    ...overrides,
  };
}

/**
 * Creates deterministic test function artifact per PLAT-3 and OBJ-4.
 */
export function createTestArtifact(overrides?: Partial<Artifact>): Artifact {
  return {
    id:
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    entrypoint: "handler.ts",
    code: new Uint8Array([0, 1, 2]),
    ...overrides,
  };
}

/**
 * Creates a mock KVBinding for RailFogContext.
 */
function createMockKVBinding(): KVBinding {
  const store = new Map<string, unknown>();
  return {
    get<T = unknown>(key: string[]): Promise<T | null> {
      const val = store.get(key.join(":"));
      return Promise.resolve((val as T) ?? null);
    },
    set(key: string[], value: unknown): Promise<void> {
      store.set(key.join(":"), value);
      return Promise.resolve();
    },
    delete(key: string[]): Promise<void> {
      store.delete(key.join(":"));
      return Promise.resolve();
    },
    list<T = unknown>(prefix: string[]): Promise<{
      entries: Array<{ key: string[]; value: T; version: number }>;
      cursor?: string;
    }> {
      const p = prefix.join(":");
      const entries: Array<{ key: string[]; value: T; version: number }> = [];
      for (const [k, v] of store.entries()) {
        if (k.startsWith(p)) {
          entries.push({ key: k.split(":"), value: v as T, version: 1 });
        }
      }
      return Promise.resolve({ entries });
    },
    atomic() {
      const ops: Array<() => void> = [];
      return {
        check(_k: string[], _v: number) {
          return this;
        },
        set(k: string[], val: unknown) {
          ops.push(() => store.set(k.join(":"), val));
          return this;
        },
        delete(k: string[]) {
          ops.push(() => store.delete(k.join(":")));
          return this;
        },
        commit(): Promise<{ ok: boolean; version?: number }> {
          for (const op of ops) op();
          return Promise.resolve({ ok: true, version: 1 });
        },
      };
    },
  };
}

/**
 * Creates a mock ObjectBinding for RailFogContext.
 */
function createMockObjectBinding(): ObjectBinding {
  const store = new Map<string, Uint8Array>();
  return {
    put(
      key: string,
      data: Uint8Array | ReadableStream<Uint8Array>,
    ): Promise<void> {
      if (data instanceof Uint8Array) {
        store.set(key, data);
      }
      return Promise.resolve();
    },
    get(key: string): Promise<ReadableStream<Uint8Array> | null> {
      const bytes = store.get(key);
      if (!bytes) return Promise.resolve(null);
      return Promise.resolve(
        new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      );
    },
    delete(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },
    head(key: string) {
      const bytes = store.get(key);
      if (!bytes) return Promise.resolve(null);
      return Promise.resolve({
        sizeBytes: bytes.byteLength,
        sha256: "mock-sha256",
        integrity: "mock-integrity",
      });
    },
    list(prefix: string) {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({
          key: k,
          sizeBytes: store.get(k)?.byteLength ?? 0,
          sha256: "mock-sha256",
        }));
      return Promise.resolve({ keys });
    },
    createMultipartUpload(key: string) {
      return Promise.resolve({ uploadId: `mock-${key}` });
    },
    presign(key: string) {
      return Promise.resolve({
        url: `https://mock.storage/${key}`,
        headers: {},
      });
    },
  };
}

/**
 * Creates a mock QueueBinding for RailFogContext.
 */
function createMockQueueBinding(): QueueBinding {
  const messages: unknown[] = [];
  return {
    send(message: unknown): Promise<{ id: string }> {
      const id = generateUlid();
      messages.push({ id, message });
      return Promise.resolve({ id });
    },
    sendBatch(batch: unknown[]): Promise<{ id: string }[]> {
      return Promise.resolve(
        batch.map((m) => {
          const id = generateUlid();
          messages.push({ id, message: m });
          return { id };
        }),
      );
    },
  };
}

/**
 * Creates a mock EnvBinding for RailFogContext.
 */
function createMockEnvBinding(): EnvBinding {
  const env = new Map<string, string>();
  return {
    get(key: string): string | undefined {
      return env.get(key);
    },
    has(key: string): boolean {
      return env.has(key);
    },
  };
}

/**
 * Deterministic RailFogContext fixture constructor per FN-4.
 */
export function createTestContext(
  overrides?: Partial<RailFogContext>,
): RailFogContext {
  const deadline = overrides?.deadline ?? (Date.now() + 30000);

  const context: RailFogContext = {
    requestId: overrides?.requestId ?? generateUlid(),
    project: overrides?.project ?? "test-project",
    function: overrides?.function ?? "test-function",
    revision: overrides?.revision ?? "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    deadline,
    timeRemaining(): number {
      return Math.max(0, this.deadline - Date.now());
    },
    kv: overrides?.kv ?? createMockKVBinding(),
    objects: overrides?.objects ?? createMockObjectBinding(),
    queues: overrides?.queues ?? createMockQueueBinding(),
    env: overrides?.env ?? createMockEnvBinding(),
    ...overrides,
  };

  return context;
}
