/**
 * LocalIsolation provider with warm-isolate reuse manager.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-4: Isolation, defense in depth ("Local: none (trusted dev machine)")
 * - docs/contracts/platform.contract.md#PLAT-17: Local/production parity (zero cloud account, local development)
 * - docs/contracts/platform.contract.md#PLAT-12: Error model (TIMEOUT, RATE_LIMITED, CALL_DEPTH_EXCEEDED, VALIDATION_FAILED)
 * - docs/contracts/platform.contract.md#PLAT-14: ULID format for request_id (26 chars Crockford Base32)
 * - docs/contracts/platform.contract.md#PLAT-15: Secrets (dynamic invocation-time resolution, tenant-scoped)
 * - docs/contracts/platform.contract.md#PLAT-7: Multi-tenancy & data isolation
 * - docs/contracts/functions.contract.md#FN-1: Function definition (export default async function handler(req, ctx))
 * - docs/contracts/functions.contract.md#FN-4: RailFogContext structure
 * - docs/contracts/functions.contract.md#FN-5: Resource limits (timeout_ms, cpu_ms, kv 1,000 ops, objects 100 ops, queue 100 ops, call_depth_max 8)
 * - docs/contracts/functions.contract.md#FN-6: Isolation & warm-reuse rule (reuse ONLY within same {project, function, revision}; fresh context and bindings per invocation)
 * - docs/contracts/functions.contract.md#FN-7: Call-depth guard (X-RailFog-Call-Depth propagation & limit)
 * - docs/adr/0001-isolation-provider-invocation-protocol.md: ADR-0001
 */

import { basename, join } from "@std/path";
import { toFileUrl } from "@std/path/to-file-url";
import type {
  Artifact,
  ExecutionResult,
  InvocationRequest,
  IsolationProvider,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import type { SecretStore } from "../../packages/policy/secret-store.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";
import {
  InternalError,
  RailFogError,
  statusFromErrorCode,
  TimeoutError,
  toErrorResponseBody,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

// spec: contracts/queues.contract.md#Q-2 — delay <= 900 (15 min); beyond that,
// a schedule trigger (FN-2) is the correct primitive
const MAX_QUEUE_DELAY_SECONDS = 900;
import {
  CALL_DEPTH_HEADER,
  createInvocationTracker,
  type InvocationTracker,
} from "../limits/operation-counter.ts";
import { createKillEnforcer } from "../limits/kill-enforcer.ts";
import type { EnvBinding, RailFogContext } from "../loader/context-builder.ts";
import type {
  KVAtomicBuilder,
  KVProvider,
} from "../../primitives/kv/kv-provider.ts";
import { RedisKVProvider } from "../../providers/kv/redis-provider.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
} from "../../packages/policy/permission-resolver.ts";

/**
 * Options for configuring LocalIsolationProvider.
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-4, PLAT-17.
 */
export interface LocalIsolationOptions {
  maxWarmInstances?: number;
  secretStore?: SecretStore;
  orgId?: string;
  kvProvider?: KVProvider;
  redisUrl?: string;
  queueDispatcher?: (
    queueName: string,
    message: unknown,
    projectId: string,
  ) => Promise<void> | void;
}

/**
 * Metadata identifying a function deployment revision tuple.
 * Spec-anchor: docs/contracts/functions.contract.md#FN-6.
 */
interface FunctionRevisionTuple {
  orgId?: string;
  project: string;
  functionName: string;
  revision: string;
}

/**
 * Cached warm isolate instance representation.
 * Spec-anchor: docs/contracts/functions.contract.md#FN-6.
 */
interface WarmInstance {
  cacheKey: string;
  handler: (req: Request, ctx: RailFogContext) => Promise<Response>;
  lastUsed: number;
  invocationCount: number;
  filePath: string;
}

/**
 * Performs case-insensitive header lookup.
 */
function getHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return v;
    }
  }
  return undefined;
}

/**
 * Creates a KV binding wired to the invocation operation counter and backed by a tenant-scoped persistent Map.
 * Spec-anchor: docs/contracts/functions.contract.md#FN-5, docs/contracts/platform.contract.md#PLAT-7.
 */
function createMockKvBinding(
  tracker: InvocationTracker,
  store: Map<string, unknown> = new Map<string, unknown>(),
  tenantOrgId?: string,
  tenantProjectId?: string,
  redisProvider?: KVProvider | null,
): KVBinding {
  const normalizeKey = (key: unknown): string => {
    if (Array.isArray(key)) return JSON.stringify(key);
    if (typeof key === "string") return JSON.stringify([key]);
    return JSON.stringify(key);
  };

  const toRedisKey = (key: unknown): string[] => {
    const rawSegs = Array.isArray(key)
      ? key.map(String)
      : typeof key === "string"
      ? [key]
      : [JSON.stringify(key)];
    return [
      tenantOrgId ?? "default-org",
      tenantProjectId ?? "default-proj",
      ...rawSegs,
    ];
  };

  // spec: contracts/kv.contract.md#KV-3 — optimistic concurrency state.
  // Versions live beside the values so check/commit can detect CAS conflicts
  // even when the caller holds a stale version from a previous read.
  const versions = new Map<string, number>();
  const versionOf = (normKey: string): number => versions.get(normKey) ?? 0;

  // spec: contracts/kv.contract.md#KV-2/KV-3 — every atomic() call is an
  // independent transaction with its own buffered checks and mutations.
  const newAtomicBuilder = (): KVAtomicBuilder => {
    const pendingChecks: { normKey: string; expectedVersion: number }[] = [];
    const pendingMutations: {
      kind: "set" | "delete";
      normKey: string;
      value?: unknown;
    }[] = [];

    return {
      check(key: string[], expectedVersion: number) {
        tracker.recordKvOp();
        pendingChecks.push({ normKey: normalizeKey(key), expectedVersion });
        return this;
      },
      set(key: string[], value: unknown, opts?: { ttl?: number }) {
        tracker.recordKvOp();
        pendingMutations.push({
          kind: "set",
          normKey: normalizeKey(key),
          value,
        });
        if (redisProvider) {
          redisProvider.set(toRedisKey(key), value, opts).catch(() => {});
        }
        return this;
      },
      delete(key: string[]) {
        tracker.recordKvOp();
        pendingMutations.push({ kind: "delete", normKey: normalizeKey(key) });
        if (redisProvider) {
          redisProvider.delete(toRedisKey(key)).catch(() => {});
        }
        return this;
      },
      commit() {
        // spec: contracts/kv.contract.md#KV-3 — write succeeds iff every checked
        // key's stored version equals the expected version; conflict is reported
        // as { ok: false } so callers re-read and retry.
        for (const c of pendingChecks) {
          if (versionOf(c.normKey) !== c.expectedVersion) {
            return Promise.resolve({ ok: false });
          }
        }
        for (const m of pendingMutations) {
          if (m.kind === "set") {
            store.set(m.normKey, m.value);
          } else {
            store.delete(m.normKey);
          }
          versions.set(m.normKey, versionOf(m.normKey) + 1);
        }
        const version = pendingMutations.length > 0
          ? versionOf(pendingMutations[pendingMutations.length - 1].normKey)
          : undefined;
        return Promise.resolve({ ok: true, version });
      },
    };
  };

  return {
    async get(key: string[] | string) {
      tracker.recordKvOp();
      // The in-memory store is authoritative in local mode; the optional Redis
      // layer is a replica whose writes land asynchronously, so it is only a
      // fallback on miss — never a source of stale reads.
      const normKey = normalizeKey(key);
      if (store.has(normKey)) {
        return store.get(normKey) ?? null;
      }
      if (typeof key === "string" && store.has(key)) {
        return store.get(key) ?? null;
      }
      if (redisProvider) {
        try {
          const val = await redisProvider.get(toRedisKey(key));
          if (val !== null && val !== undefined) {
            return val;
          }
        } catch {
          // miss
        }
      }
      return null;
    },
    async set(key: string[] | string, value: unknown, opts?: { ttl?: number }) {
      tracker.recordKvOp();
      const normKey = normalizeKey(key);
      store.set(normKey, value);
      versions.set(normKey, versionOf(normKey) + 1);
      if (redisProvider) {
        try {
          await redisProvider.set(toRedisKey(key), value, opts);
        } catch {
          // Non-fatal
        }
      }
    },
    async delete(key: string[] | string) {
      tracker.recordKvOp();
      const normKey = normalizeKey(key);
      store.delete(normKey);
      // spec: contracts/kv.contract.md#KV-3 — non-existent key has version 0
      versions.set(normKey, 0);
      if (redisProvider) {
        try {
          await redisProvider.delete(toRedisKey(key));
        } catch {
          // Non-fatal
        }
      }
    },
    async list(prefix: string[] | string) {
      tracker.recordKvOp();
      const keys: {
        key: string[];
        value: unknown;
        version: number;
      }[] = [];
      const prefixArr = Array.isArray(prefix) ? prefix : [prefix];
      for (const [kStr, val] of store.entries()) {
        try {
          const parsed = JSON.parse(kStr) as string[];
          if (
            Array.isArray(parsed) &&
            prefixArr.every((seg, idx) => parsed[idx] === seg)
          ) {
            // spec: contracts/kv.contract.md#KV-2/KV-3 — entries carry the
            // version the SDK KVBinding type promises for CAS check() calls
            keys.push({ key: parsed, value: val, version: versionOf(kStr) });
          }
        } catch {
          // ignore non-json keys
        }
      }
      if (keys.length === 0 && redisProvider) {
        try {
          const res = await redisProvider.list(toRedisKey(prefix));
          const resEntries = (res as Record<string, unknown> | null)?.entries;
          if (res && Array.isArray(resEntries) && resEntries.length > 0) {
            const stripped = resEntries.map((
              e: { key: string[]; value: unknown; version?: number },
            ) => ({
              key: Array.isArray(e.key) ? e.key.slice(2) : e.key,
              value: e.value,
              version: e.version ?? 0,
            }));
            return { entries: stripped, keys: stripped };
          }
        } catch {
          // fallback
        }
      }
      return { keys, entries: keys };
    },
    atomic() {
      return newAtomicBuilder();
    },
  } as unknown as KVBinding;
}

/**
 * Creates an Object binding wired to the invocation operation counter and backed by local filesystem or mock.
 * Spec-anchor: docs/contracts/functions.contract.md#FN-5, docs/contracts/objects.contract.md#OBJ-2.
 */
function createMockObjectBinding(
  tracker: InvocationTracker,
  tenantObjectsDir?: string,
): ObjectBinding {
  let fsProvider: LocalFSProvider | null = null;
  if (tenantObjectsDir) {
    try {
      fsProvider = new LocalFSProvider(tenantObjectsDir);
    } catch {
      fsProvider = null;
    }
  }

  return {
    async put(key: string, data: unknown) {
      tracker.recordObjectOp();
      if (fsProvider) {
        try {
          let buf: ArrayBuffer | ReadableStream;
          if (data instanceof Uint8Array) {
            const copy = new Uint8Array(data.byteLength);
            copy.set(data);
            buf = copy.buffer as ArrayBuffer;
          } else if (data instanceof ArrayBuffer) {
            buf = data;
          } else if (typeof data === "string") {
            const enc = new TextEncoder().encode(data);
            buf = enc.buffer as ArrayBuffer;
          } else if (
            data && typeof (data as ReadableStream).getReader === "function"
          ) {
            buf = data as ReadableStream;
          } else {
            const enc = new TextEncoder().encode(JSON.stringify(data));
            buf = enc.buffer as ArrayBuffer;
          }
          return await fsProvider.put(key, buf);
        } catch {
          // fallback to mock etag
        }
      }
      return { etag: `etag-${generateUlid()}` };
    },
    async get(key: string) {
      tracker.recordObjectOp();
      if (fsProvider) {
        try {
          return await fsProvider.get(key);
        } catch {
          return null;
        }
      }
      return null;
    },
    async delete(key: string) {
      tracker.recordObjectOp();
      if (fsProvider) {
        try {
          await fsProvider.delete(key);
        } catch {
          // ignore
        }
      }
    },
    async head(key: string) {
      tracker.recordObjectOp();
      if (fsProvider) {
        try {
          return await fsProvider.head(key);
        } catch {
          return null;
        }
      }
      return null;
    },
    async list(prefix: string) {
      tracker.recordObjectOp();
      if (fsProvider) {
        try {
          const res = await fsProvider.list(prefix);
          return {
            keys: res.keys.map((k) => ({ key: k, sizeBytes: 0, sha256: "" })),
          };
        } catch {
          return { keys: [] };
        }
      }
      return { keys: [] };
    },
    async presign(
      key: string,
      opts?: { method?: "GET" | "PUT"; expiresIn?: number },
    ) {
      tracker.recordObjectOp();
      if (fsProvider) {
        try {
          const res = await fsProvider.presign(key, {
            method: opts?.method ?? "GET",
            expiresIn: opts?.expiresIn ?? 3600,
          });
          return {
            url: res.url,
            expiresAt: res.expiresAt,
            headers: {},
          };
        } catch {
          // fallback
        }
      }
      return {
        url: `https://mock.storage/${key}`,
        expiresAt: Date.now() + 3600000,
        headers: {},
      };
    },
    createMultipartUpload(_key: string) {
      tracker.recordObjectOp();
      return Promise.resolve({ uploadId: `mp-${generateUlid()}` });
    },
  } as unknown as ObjectBinding;
}

/**
 * Creates a Queue binding wired to the invocation operation counter and queue dispatcher.
 * Spec-anchor: docs/contracts/functions.contract.md#FN-5, docs/contracts/queues.contract.md#Q-2.
 */
function createMockQueueBinding(
  tracker: InvocationTracker,
  projectId?: string,
  queueDispatcher?: (
    queueName: string,
    body: unknown,
    projectId: string,
    messageId?: string,
  ) => Promise<void> | void,
  defaultQueueName = "default",
): QueueBinding {
  return {
    send(arg1: unknown, arg2?: unknown, arg3?: unknown) {
      tracker.recordQueueOp();
      const id = `msg-${generateUlid()}`;
      let queue = defaultQueueName;
      let body = arg1;
      let delay = 0;

      if (typeof arg1 === "string" && arg2 !== undefined) {
        queue = arg1;
        body = arg2;
        if (
          arg3 &&
          typeof arg3 === "object" &&
          "delay" in (arg3 as Record<string, unknown>)
        ) {
          delay = (arg3 as { delay?: number }).delay ?? 0;
        }
      } else if (
        arg2 &&
        typeof arg2 === "object" &&
        "delay" in (arg2 as Record<string, unknown>)
      ) {
        delay = (arg2 as { delay?: number }).delay ?? 0;
      }

      // spec: contracts/queues.contract.md#Q-2 — delay <= 900s; longer delays
      // belong to a schedule trigger (FN-2), validated not silently clamped
      if (
        typeof delay !== "number" || !Number.isFinite(delay) || delay < 0 ||
        delay > MAX_QUEUE_DELAY_SECONDS
      ) {
        return Promise.reject(
          new ValidationFailedError(
            "VALIDATION_FAILED: Delay must be a non-negative number <= 900s. Use a schedule trigger instead per FN-2",
          ),
        );
      }

      if (queueDispatcher && projectId) {
        queueMicrotask(async () => {
          try {
            if (delay > 0) {
              await new Promise((r) => setTimeout(r, delay * 1000));
            }
            await queueDispatcher(queue, body, projectId, id);
          } catch (e) {
            console.error(`[Queue Dispatcher] Error delivering ${id}:`, e);
          }
        });
      }
      return Promise.resolve({ id });
    },
    sendBatch(bodies: unknown[]) {
      tracker.recordQueueOp();
      const results = bodies.map(() => ({ id: `msg-${generateUlid()}` }));
      if (queueDispatcher && projectId) {
        for (let i = 0; i < bodies.length; i++) {
          const body = bodies[i];
          const id = results[i].id;
          queueMicrotask(async () => {
            try {
              await queueDispatcher(defaultQueueName, body, projectId, id);
            } catch (e) {
              console.error(
                `[Queue Dispatcher] Error delivering batch ${id}:`,
                e,
              );
            }
          });
        }
      }
      return Promise.resolve(results);
    },
  } as unknown as QueueBinding;
}

/**
 * Local in-process isolation provider with FN-6 warm-isolate reuse manager.
 *
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-4, PLAT-17.
 * Spec-anchor: docs/contracts/functions.contract.md#FN-6.
 */
export class LocalIsolationProvider implements IsolationProvider {
  private readonly maxWarmInstances?: number;
  private readonly secretStore?: SecretStore;
  private readonly configuredOrgId?: string;
  private readonly warmInstances = new Map<string, WarmInstance>();
  private readonly tempDir: string;
  private fileGeneration = 0;
  // Persistent tenant-isolated key-value stores per PLAT-7
  private readonly projectKvStores = new Map<string, Map<string, unknown>>();
  private redisProvider: KVProvider | null = null;
  private queueDispatcher?: (
    queueName: string,
    body: unknown,
    projectId: string,
    messageId?: string,
  ) => Promise<void> | void;

  constructor(options?: LocalIsolationOptions) {
    this.maxWarmInstances = options?.maxWarmInstances;
    this.secretStore = options?.secretStore;
    this.configuredOrgId = options?.orgId;
    this.tempDir = Deno.makeTempDirSync({ prefix: "railfog_local_iso_" });
    this.queueDispatcher = options?.queueDispatcher;

    if (options?.kvProvider) {
      this.redisProvider = options.kvProvider;
    } else {
      const redisUrl = options?.redisUrl ??
        (typeof Deno !== "undefined" ? Deno.env.get("REDIS_URL") : undefined);
      if (redisUrl && redisUrl.trim().length > 0) {
        try {
          this.redisProvider = new RedisKVProvider({
            url: redisUrl,
            keyPrefix: "rfk:",
          });
        } catch {
          this.redisProvider = null;
        }
      }
    }
  }

  /**
   * Sets the background queue dispatcher callback.
   * Spec-anchor: docs/contracts/queues.contract.md#Q-2
   */
  setQueueDispatcher(
    dispatcher: (
      queueName: string,
      body: unknown,
      projectId: string,
      messageId?: string,
    ) => Promise<void> | void,
  ): void {
    this.queueDispatcher = dispatcher;
  }

  /**
   * Returns the count of cached warm isolates.
   * Spec-anchor: tasks/T-0310.
   */
  getWarmCount(): number {
    return this.warmInstances.size;
  }

  /**
   * Evicts all cached warm isolates and resets module-level state.
   * Spec-anchor: tasks/T-0310.
   */
  clearWarm(): void {
    this.warmInstances.clear();
    // Increment generation so any re-evaluated module receives a fresh file URL
    this.fileGeneration++;
  }

  /**
   * Extracts function metadata from artifact and invocation request.
   * Spec-anchor: docs/contracts/functions.contract.md#FN-6.
   */
  private extractMetadata(
    artifact: Artifact,
    invocation?: InvocationRequest,
  ): FunctionRevisionTuple {
    const artObj = artifact as unknown as Record<string, unknown>;
    const headers = invocation?.headers;

    const project = (artObj.project as string) ??
      (artObj.projectName as string) ??
      getHeader(headers, "x-railfog-project") ??
      "default";

    const functionName = (artObj.function as string) ??
      (artObj.functionName as string) ??
      getHeader(headers, "x-railfog-function") ??
      (artifact.entrypoint
        ? basename(artifact.entrypoint).replace(/\.[^/.]+$/, "")
        : "default");

    const orgId = (artObj.orgId as string) ??
      (artObj.org as string) ??
      getHeader(headers, "x-railfog-org") ??
      getHeader(headers, "x-railfog-org-id") ??
      this.configuredOrgId;

    const revision = (artObj.revision as string) ??
      (artObj.revisionId as string) ??
      getHeader(headers, "x-railfog-revision") ??
      artifact.id ??
      "latest";

    return { orgId, project, functionName, revision };
  }

  /**
   * Extracts executable bundle code bytes from artifact.
   * Spec-anchor: docs/contracts/objects.contract.md#OBJ-4.
   */
  private async getArtifactCodeBytes(artifact: Artifact): Promise<Uint8Array> {
    if (artifact.code instanceof Uint8Array) {
      if (artifact.code.byteLength > 0) {
        return artifact.code;
      }
      // If code is empty Uint8Array, check if entrypoint points to an existing file
      if (artifact.entrypoint) {
        try {
          return await Deno.readFile(artifact.entrypoint);
        } catch {
          // Fall through to empty code bytes
        }
      }
      return artifact.code;
    }

    if (
      artifact.code &&
      typeof (artifact.code as ReadableStream<Uint8Array>).getReader ===
        "function"
    ) {
      const reader = (artifact.code as ReadableStream<Uint8Array>).getReader();
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

      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return combined;
    }

    return new Uint8Array(0);
  }

  /**
   * Resolves or dynamically imports the warm isolate instance.
   * Strictly respects the {project}:{function}:{revision} cache key (FN-6)
   * structured to prevent delimiter collisions across names.
   * Spec-anchor: docs/contracts/functions.contract.md#FN-6.
   */
  private async getOrCreateWarmInstance(
    meta: FunctionRevisionTuple,
    artifact: Artifact,
  ): Promise<WarmInstance> {
    const cacheKey = JSON.stringify([
      meta.orgId ?? "",
      meta.project,
      meta.functionName,
      meta.revision,
    ]);

    const existing = this.warmInstances.get(cacheKey);
    if (existing) {
      existing.lastUsed = Date.now();
      existing.invocationCount++;
      return existing;
    }

    // Check capacity and evict oldest LRU instance if maxWarmInstances exceeded
    if (
      this.maxWarmInstances !== undefined &&
      this.warmInstances.size >= this.maxWarmInstances
    ) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;

      for (const [key, inst] of this.warmInstances.entries()) {
        if (inst.lastUsed < oldestTime) {
          oldestTime = inst.lastUsed;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        this.warmInstances.delete(oldestKey);
      }
    }

    // Write code bundle to a dedicated file for this isolate generation
    this.fileGeneration++;
    const codeBytes = await this.getArtifactCodeBytes(artifact);
    const safeOrg = (meta.orgId ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeProject = meta.project.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeFn = meta.functionName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeRev = meta.revision.replace(/[^a-zA-Z0-9_-]/g, "_");
    const fileName =
      `${safeOrg}_${safeProject}_${safeFn}_${safeRev}_gen${this.fileGeneration}.ts`;
    const filePath = join(this.tempDir, fileName);

    await Deno.writeFile(filePath, codeBytes);

    const fileUrl = toFileUrl(filePath).href;
    let mod: Record<string, unknown>;
    try {
      mod = await import(fileUrl);
    } catch (importErr) {
      const errMsg = importErr instanceof Error
        ? importErr.message
        : String(importErr);
      throw new ValidationFailedError(
        `Failed to load function module: ${errMsg}`,
      );
    }

    if (!mod || typeof mod.default !== "function") {
      throw new ValidationFailedError(
        "Function module must export a default handler function",
      );
    }

    const instance: WarmInstance = {
      cacheKey,
      handler: mod.default as (
        req: Request,
        ctx: RailFogContext,
      ) => Promise<Response>,
      lastUsed: Date.now(),
      invocationCount: 1,
      filePath,
    };

    this.warmInstances.set(cacheKey, instance);
    return instance;
  }

  /**
   * Loads or gets the warm module instance for an artifact and revision tuple.
   * Spec-anchor: docs/contracts/functions.contract.md#FN-6.
   */
  private async getOrLoadModule(
    artifact: Artifact,
    tuple: FunctionRevisionTuple,
  ): Promise<WarmInstance> {
    return await this.getOrCreateWarmInstance(tuple, artifact);
  }

  /**
   * Pre-warms isolate / code caches for an artifact before the first request.
   * Spec-anchor: docs/contracts/functions.contract.md#FN-6.
   */
  async prewarm(artifact: Artifact, _limits?: Limits): Promise<void> {
    if (!artifact || typeof artifact !== "object") {
      return;
    }
    const tuple = this.extractMetadata(artifact);
    const cacheKey = JSON.stringify([
      tuple.orgId ?? "",
      tuple.project,
      tuple.functionName,
      tuple.revision,
    ]);
    if (this.warmInstances.has(cacheKey)) {
      return;
    }
    const instance = await this.getOrLoadModule(artifact, tuple);
    instance.invocationCount = 0;
  }

  /**
   * Resolves secrets from SecretStore for this project and tenant.
   * Strictly scoped: only secrets stored under the resolved (orgId, projectId)
   * pair, and — when the artifact declares permissions.secrets (PLAT-6) — only
   * those names are exposed to the Function.
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-15, PLAT-6, PLAT-7.
   */
  private async resolveSecrets(
    orgId: string | undefined,
    projectId: string,
    allowedSecretNames?: string[],
  ): Promise<Record<string, string>> {
    // spec: docs/contracts/platform.contract.md#PLAT-7 — no org context, no secrets
    if (!this.secretStore || !orgId) {
      return {};
    }

    const secrets: Record<string, string> = {};
    try {
      const names = await this.secretStore.listNames(orgId, projectId);
      for (const name of names) {
        if (allowedSecretNames && !allowedSecretNames.includes(name)) {
          continue;
        }
        const val = await this.secretStore.get(orgId, projectId, name);
        if (val !== null) {
          secrets[name] = val;
        }
      }
    } catch {
      // Invalid identifiers or store failures resolve to no secrets (PLAT-6:
      // absence of a binding is unaddressable, never a fallback scan)
    }
    return secrets;
  }

  /**
   * Runs an isolated function invocation within the local runtime.
   *
   * Spec references:
   * - PLAT-4: Isolation (in-process execution)
   * - FN-4: Fresh RailFogContext per invocation
   * - FN-5: Limits enforcement (timeout, cpu, operations)
   * - FN-6: Warm-reuse rule (isolate reused ONLY within same {project, function, revision})
   * - FN-7: Call-depth guard propagation & limit
   */
  async run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult> {
    if (!artifact || typeof artifact !== "object") {
      throw new ValidationFailedError("Artifact must be a non-null object");
    }
    if (!limits || typeof limits !== "object") {
      throw new ValidationFailedError("Limits must be a non-null object");
    }

    const meta = this.extractMetadata(artifact, invocation);

    // 1. Invocation Tracker (FN-5, FN-7 per-invocation operation quotas)
    const tracker = createInvocationTracker();

    // 2. Call-Depth Guard (FN-7)
    const callDepthRaw = getHeader(invocation?.headers, CALL_DEPTH_HEADER);
    let nextHopDepth = 1;
    try {
      nextHopDepth = tracker.checkCallDepth(callDepthRaw);
    } catch (err) {
      if (err instanceof RailFogError) {
        return this.formatErrorResult(err);
      }
      throw err;
    }

    // 3. Kill Enforcer (FN-5 timeout and payload limits)
    const killEnforcer = createKillEnforcer({
      timeoutMs: limits.timeoutMs,
      cpuMs: limits.cpuMs,
    });
    const { signal, cleanup } = killEnforcer.createAbortController();

    // 4. Resolve or create warm isolate instance (FN-6)
    let warmInstance: WarmInstance;
    try {
      warmInstance = await this.getOrCreateWarmInstance(meta, artifact);
    } catch (err) {
      cleanup();
      if (err instanceof RailFogError) {
        return this.formatErrorResult(err);
      }
      throw err;
    }

    // 5. Dynamic Secret Resolution (PLAT-15, FN-6 fresh per invocation).
    // Scoped to the Function's declared permissions.secrets when the manifest
    // carries them (PLAT-6); every name in the namespace otherwise.
    const artObj = artifact as unknown as Record<string, unknown>;
    const declaredPermissions = artObj.permissions as
      | Record<string, unknown>
      | undefined;
    const declaredSecretNames = declaredPermissions?.secrets;
    const allowedSecretNames = Array.isArray(declaredSecretNames)
      ? (declaredSecretNames as unknown[]).filter(
        (n): n is string => typeof n === "string",
      )
      : undefined;
    const secretsMap = await this.resolveSecrets(
      meta.orgId,
      meta.project,
      allowedSecretNames,
    );
    let activeEnv = true;
    const envBinding: EnvBinding = {
      get(key: string): string | undefined {
        if (!activeEnv) return undefined;
        return secretsMap[key];
      },
    };

    // 6. Build fresh RailFogContext (FN-4, FN-6)
    const deadline = Date.now() + limits.timeoutMs;
    const customContext = (artObj.context ?? artObj.bindings) as
      | Record<string, unknown>
      | undefined;

    const tenantOrg = meta.orgId ?? this.configuredOrgId ?? "default-org";
    const tenantKey = `${tenantOrg}/${meta.project}`;
    let kvStore = this.projectKvStores.get(tenantKey);
    if (!kvStore) {
      kvStore = new Map<string, unknown>();
      this.projectKvStores.set(tenantKey, kvStore);
    }
    const tenantObjectsDir = join(
      this.tempDir,
      "objects",
      tenantOrg,
      meta.project,
    );

    const ctx: RailFogContext = {
      requestId: invocation?.requestId ?? generateUlid(),
      project: meta.project,
      function: meta.functionName,
      revision: meta.revision,
      deadline,
      timeRemaining(): number {
        return Math.max(0, deadline - Date.now());
      },
      kv: (customContext?.kv as KVBinding) ??
        createMockKvBinding(
          tracker,
          kvStore,
          tenantOrg,
          meta.project,
          this.redisProvider,
        ),
      objects: (customContext?.objects as ObjectBinding) ??
        createMockObjectBinding(tracker, tenantObjectsDir),
      queues: (customContext?.queues as QueueBinding) ??
        createMockQueueBinding(
          tracker,
          meta.project,
          this.queueDispatcher,
        ),
      env: envBinding,
    };

    // 7. Construct incoming Request object
    const requestHeaders = new Headers(invocation?.headers);
    requestHeaders.set(CALL_DEPTH_HEADER, String(nextHopDepth));
    requestHeaders.set("X-RailFog-Request-ID", ctx.requestId);

    const requestMethod = invocation?.method ?? "GET";
    const requestUrl = invocation?.url ?? "https://example.com/api";

    const hasBody = invocation?.body &&
      invocation.body.byteLength > 0 &&
      requestMethod !== "GET" &&
      requestMethod !== "HEAD";

    const request = new Request(requestUrl, {
      method: requestMethod,
      headers: requestHeaders,
      body: hasBody ? (invocation?.body as unknown as BodyInit) : undefined,
      signal,
    });

    // 8. Snapshot global scope and prototype before execution to prevent state bleeding (PLAT-4, FN-6)
    const initialGlobalKeys = new Set(Reflect.ownKeys(globalThis));
    const initialProtoKeys = new Set(Reflect.ownKeys(Object.prototype));
    const startWallClock = performance.now();

    try {
      // Race handler with abort signal for strict deadline enforcement (FN-5)
      const isQueueTrigger =
        requestHeaders.get("x-railfog-trigger") === "queue";
      let handlerPromise: Promise<unknown>;

      if (isQueueTrigger) {
        let parsedPayload: unknown = undefined;
        if (invocation?.body && invocation.body.byteLength > 0) {
          try {
            const text = new TextDecoder().decode(invocation.body);
            parsedPayload = JSON.parse(text);
          } catch {
            parsedPayload = invocation.body;
          }
        }
        const queueMsgObj: Record<string, unknown> = {
          id: requestHeaders.get("x-railfog-message-id") ??
            invocation?.requestId ?? ctx.requestId,
          body: parsedPayload,
          attempts: 1,
          timestamp: Date.now(),
          json: () => Promise.resolve(parsedPayload),
          text: () =>
            Promise.resolve(
              typeof parsedPayload === "string"
                ? parsedPayload
                : JSON.stringify(parsedPayload),
            ),
          headers: requestHeaders,
          url: requestUrl,
          method: requestMethod,
        };

        handlerPromise = Promise.resolve(
          (warmInstance.handler as unknown as (
            arg1: unknown,
            arg2: unknown,
          ) => unknown)(
            queueMsgObj,
            ctx,
          ),
        );
      } else {
        handlerPromise = Promise.resolve(warmInstance.handler(request, ctx));
      }

      const abortPromise = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new TimeoutError("Invocation deadline exceeded"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new TimeoutError("Invocation deadline exceeded"));
        }, { once: true });
      });

      const rawResponse = await Promise.race([handlerPromise, abortPromise]);

      let response: Response;
      if (rawResponse instanceof Response) {
        response = rawResponse;
      } else if (rawResponse === undefined || rawResponse === null) {
        response = Response.json({ ok: true });
      } else {
        response = Response.json(rawResponse);
      }

      const wallClockMs = Math.max(
        0,
        Math.round(performance.now() - startWallClock),
      );
      // spec: docs/contracts/platform.contract.md#PLAT-17 — LocalIsolation is the
      // trusted-dev column ("Isolation: none"): per-isolate CPU time is not
      // measurable in-process, so wall clock is reported as the honest proxy and
      // cpu_ms enforcement is delegated to the process/microVM isolation layers
      // (PLAT-4). Never fabricate a value below the limit.
      const cpuTimeMs = wallClockMs;

      // Extract response payload
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((val, key) => {
        responseHeaders[key] = val;
      });

      const bodyBuffer = await response.arrayBuffer();
      const body = new Uint8Array(bodyBuffer);

      return {
        statusCode: response.status,
        headers: responseHeaders,
        body,
        cpuTimeMs,
        wallClockMs,
      };
    } catch (err) {
      if (signal.aborted) {
        const timeoutErr = new TimeoutError("Invocation deadline exceeded");
        return this.formatErrorResult(timeoutErr);
      }
      if (err instanceof RailFogError) {
        return this.formatErrorResult(err);
      }
      const internalErr = new InternalError(
        err instanceof Error ? err.message : String(err),
      );
      return this.formatErrorResult(internalErr);
    } finally {
      cleanup();

      // Deactivate and wipe resolved secrets immediately after invocation (PLAT-15)
      activeEnv = false;
      for (const k of Object.keys(secretsMap)) {
        delete secretsMap[k];
      }

      // Clean up any leaked properties attached to globalThis (PLAT-4, FN-6)
      const currentGlobalKeys = Reflect.ownKeys(globalThis);
      for (const key of currentGlobalKeys) {
        if (!initialGlobalKeys.has(key)) {
          try {
            delete (globalThis as Record<PropertyKey, unknown>)[key];
          } catch {
            // Ignore non-configurable globals
          }
        }
      }

      // Clean up any prototype pollution attached to Object.prototype (PLAT-4, FN-6)
      const currentProtoKeys = Reflect.ownKeys(Object.prototype);
      for (const key of currentProtoKeys) {
        if (!initialProtoKeys.has(key)) {
          try {
            delete (Object.prototype as Record<PropertyKey, unknown>)[key];
          } catch {
            // Ignore non-configurable properties
          }
        }
      }
    }
  }

  /**
   * Formats a RailFogError into a compliant ExecutionResult per PLAT-12.
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12.
   */
  private formatErrorResult(err: RailFogError): ExecutionResult {
    const status = statusFromErrorCode(err.code);
    const bodyObj = toErrorResponseBody(err);
    const bodyBytes = new TextEncoder().encode(JSON.stringify(bodyObj));

    return {
      statusCode: status,
      headers: {
        "content-type": "application/json",
      },
      body: bodyBytes,
      cpuTimeMs: 0,
      wallClockMs: 0,
    };
  }
}
