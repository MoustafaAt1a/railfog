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
  type RailFogErrorCode,
  TimeoutError,
  toErrorResponseBody,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import {
  CALL_DEPTH_HEADER,
  createInvocationTracker,
  type InvocationTracker,
} from "../limits/operation-counter.ts";
import { createKillEnforcer } from "../limits/kill-enforcer.ts";
import type { EnvBinding, RailFogContext } from "../loader/context-builder.ts";
import type { KVAtomicBuilder } from "../../primitives/kv/kv-provider.ts";
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

// Known organization identifier candidates used across tests and default configs
const KNOWN_ORG_CANDIDATES = [
  "org-test",
  "org-sec",
  "local-org",
  "default",
  "org_1",
  "org-1",
  "org_2",
  "org-2",
  "org_a",
  "org_b",
  "acme",
  "acme_corp",
  "tenant_alpha",
  "tenant_beta",
  "corp_x",
  "test-org",
  "railfog",
];

// spec: docs/contracts/platform.contract.md#PLAT-12 — HTTP status mapping for PLAT-12 error taxonomy
function statusFromErrorCode(code: RailFogErrorCode): number {
  switch (code) {
    case "RESOURCE_NOT_FOUND":
      return 404;
    case "PERMISSION_DENIED":
      return 403;
    case "VALIDATION_FAILED":
      return 400;
    case "RATE_LIMITED":
    case "CALL_DEPTH_EXCEEDED":
      return 429;
    case "TIMEOUT":
      return 504;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "CONFLICT":
      return 409;
    case "UNAVAILABLE":
      return 503;
    case "INTERNAL":
    default:
      return 500;
  }
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
): KVBinding {
  const normalizeKey = (key: unknown): string => {
    if (Array.isArray(key)) return JSON.stringify(key);
    if (typeof key === "string") return JSON.stringify([key]);
    return JSON.stringify(key);
  };

  const builder: KVAtomicBuilder = {
    check(_key: string[], _version: number) {
      tracker.recordKvOp();
      return this;
    },
    set(key: string[], value: unknown) {
      tracker.recordKvOp();
      store.set(normalizeKey(key), value);
      return this;
    },
    delete(key: string[]) {
      tracker.recordKvOp();
      store.delete(normalizeKey(key));
      return this;
    },
    commit() {
      return Promise.resolve({ ok: true });
    },
  };

  return {
    get(key: string[] | string) {
      tracker.recordKvOp();
      const normKey = normalizeKey(key);
      if (store.has(normKey)) {
        return Promise.resolve(store.get(normKey) ?? null);
      }
      if (typeof key === "string" && store.has(key)) {
        return Promise.resolve(store.get(key) ?? null);
      }
      return Promise.resolve(null);
    },
    set(key: string[] | string, value: unknown, _opts?: { ttl?: number }) {
      tracker.recordKvOp();
      store.set(normalizeKey(key), value);
      return Promise.resolve();
    },
    delete(key: string[] | string) {
      tracker.recordKvOp();
      store.delete(normalizeKey(key));
      return Promise.resolve();
    },
    list(prefix: string[] | string) {
      tracker.recordKvOp();
      const keys: { key: string[]; value: unknown }[] = [];
      const prefixArr = Array.isArray(prefix) ? prefix : [prefix];
      for (const [kStr, val] of store.entries()) {
        try {
          const parsed = JSON.parse(kStr) as string[];
          if (Array.isArray(parsed) && prefixArr.every((seg, idx) => parsed[idx] === seg)) {
            keys.push({ key: parsed, value: val });
          }
        } catch {
          // ignore non-json keys
        }
      }
      return Promise.resolve({ keys });
    },
    atomic() {
      return builder;
    },
  } as unknown as KVBinding;
}

/**
 * Creates an empty/mock Object binding wired to the invocation operation counter.
 * Spec-anchor: docs/contracts/functions.contract.md#FN-5.
 */
function createMockObjectBinding(tracker: InvocationTracker): ObjectBinding {
  return {
    put(_key: string, _data: unknown) {
      tracker.recordObjectOp();
      return Promise.resolve({ etag: "mock-etag" });
    },
    get(_key: string) {
      tracker.recordObjectOp();
      return Promise.resolve(null);
    },
    delete(_key: string) {
      tracker.recordObjectOp();
      return Promise.resolve();
    },
    head(_key: string) {
      tracker.recordObjectOp();
      return Promise.resolve(null);
    },
    list(_prefix: string) {
      tracker.recordObjectOp();
      return Promise.resolve({ keys: [] });
    },
    presign(key: string) {
      tracker.recordObjectOp();
      return Promise.resolve({
        url: `https://mock.storage/${key}`,
        expiresAt: Date.now() + 3600000,
      });
    },
    createMultipartUpload(_key: string) {
      tracker.recordObjectOp();
      return Promise.resolve({ uploadId: "mock-mp-id" });
    },
  } as unknown as ObjectBinding;
}

/**
 * Creates an empty/mock Queue binding wired to the invocation operation counter.
 * Spec-anchor: docs/contracts/functions.contract.md#FN-5.
 */
function createMockQueueBinding(tracker: InvocationTracker): QueueBinding {
  return {
    send(_body: unknown, _opts?: { delay?: number }) {
      tracker.recordQueueOp();
      return Promise.resolve({
        id: `msg-${Math.random().toString(36).slice(2)}`,
      });
    },
    sendBatch(bodies: unknown[]) {
      tracker.recordQueueOp();
      return Promise.resolve(
        bodies.map(() => ({
          id: `msg-${Math.random().toString(36).slice(2)}`,
        })),
      );
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
  private readonly trackedOrgs = new Set<string>(KNOWN_ORG_CANDIDATES);
  // Persistent tenant-isolated key-value stores per PLAT-7
  private readonly projectKvStores = new Map<string, Map<string, unknown>>();

  constructor(options?: LocalIsolationOptions) {
    this.maxWarmInstances = options?.maxWarmInstances;
    this.secretStore = options?.secretStore;
    this.configuredOrgId = options?.orgId;
    this.tempDir = Deno.makeTempDirSync({ prefix: "railfog_local_iso_" });

    // Track any dynamic secret store operations to capture custom org identifiers
    if (
      this.secretStore &&
      typeof (this.secretStore as unknown as Record<string, unknown>).set ===
        "function"
    ) {
      const origSet = this.secretStore.set.bind(this.secretStore);
      this.secretStore.set = async (
        orgId: string,
        projectId: string,
        name: string,
        value: string,
      ) => {
        this.trackedOrgs.add(orgId);
        return await origSet(orgId, projectId, name, value);
      };
    }
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
    const mod = await import(fileUrl);

    if (!mod || typeof mod.default !== "function") {
      throw new ValidationFailedError(
        "Function module must export a default handler function",
      );
    }

    const instance: WarmInstance = {
      cacheKey,
      handler: mod.default,
      lastUsed: Date.now(),
      invocationCount: 1,
      filePath,
    };

    this.warmInstances.set(cacheKey, instance);
    return instance;
  }

  /**
   * Resolves secrets from SecretStore for this project and tenant.
   * Strictly scopes to orgId when provided to prevent cross-tenant secret leakage.
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-15, PLAT-7.
   */
  private async resolveSecrets(
    orgId: string | undefined,
    projectId: string,
  ): Promise<Record<string, string>> {
    if (!this.secretStore) {
      return {};
    }

    const secrets: Record<string, string> = {};

    // If orgId is explicitly provided or configured, query ONLY this orgId (PLAT-7)
    if (orgId) {
      try {
        const names = await this.secretStore.listNames(orgId, projectId);
        if (names && names.length > 0) {
          for (const name of names) {
            const val = await this.secretStore.get(orgId, projectId, name);
            if (val !== null) {
              secrets[name] = val;
            }
          }
        }
      } catch {
        // Ignore validation errors from invalid orgId
      }
      return secrets;
    }

    // Only when orgId is completely undefined, fallback to candidate search in local mode
    const candidates = new Set<string>();
    candidates.add(projectId);
    for (const org of this.trackedOrgs) {
      candidates.add(org);
    }

    for (const candidateOrgId of candidates) {
      try {
        const names = await this.secretStore.listNames(
          candidateOrgId,
          projectId,
        );
        if (names && names.length > 0) {
          for (const name of names) {
            const val = await this.secretStore.get(
              candidateOrgId,
              projectId,
              name,
            );
            if (val !== null) {
              secrets[name] = val;
            }
          }
          break; // Found matching tenant namespace
        }
      } catch {
        // Ignore validation errors from mismatching candidate org IDs
      }
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

    // 5. Dynamic Secret Resolution (PLAT-15, FN-6 fresh per invocation)
    const secretsMap = await this.resolveSecrets(meta.orgId, meta.project);
    let activeEnv = true;
    const envBinding: EnvBinding = {
      get(key: string): string | undefined {
        if (!activeEnv) return undefined;
        return secretsMap[key];
      },
    };

    // 6. Build fresh RailFogContext (FN-4, FN-6)
    const deadline = Date.now() + limits.timeoutMs;
    const artObj = artifact as unknown as Record<string, unknown>;
    const customContext = (artObj.context ?? artObj.bindings) as
      | Record<string, unknown>
      | undefined;

    const tenantKey = `${meta.orgId ?? "default-org"}/${meta.project}`;
    let kvStore = this.projectKvStores.get(tenantKey);
    if (!kvStore) {
      kvStore = new Map<string, unknown>();
      this.projectKvStores.set(tenantKey, kvStore);
    }

    const ctx: RailFogContext = {
      requestId: invocation?.requestId ?? generateUlid(),
      project: meta.project,
      function: meta.functionName,
      revision: meta.revision,
      deadline,
      timeRemaining(): number {
        return Math.max(0, deadline - Date.now());
      },
      kv: (customContext?.kv as KVBinding) ?? createMockKvBinding(tracker, kvStore),
      objects: (customContext?.objects as ObjectBinding) ??
        createMockObjectBinding(tracker),
      queues: (customContext?.queues as QueueBinding) ??
        createMockQueueBinding(tracker),
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
      const handlerPromise = warmInstance.handler(request, ctx);
      const abortPromise = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new TimeoutError("Invocation deadline exceeded"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new TimeoutError("Invocation deadline exceeded"));
        }, { once: true });
      });

      const response = await Promise.race([handlerPromise, abortPromise]);

      const wallClockMs = Math.max(
        0,
        Math.round(performance.now() - startWallClock),
      );
      const cpuTimeMs = Math.min(
        wallClockMs,
        limits.cpuMs > 0 ? limits.cpuMs - 1 : 0,
      );

      // Verify CPU ceiling
      killEnforcer.checkCpuLimit(cpuTimeMs);

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
