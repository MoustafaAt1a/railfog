import { ValidationFailedError } from "../errors/mod.ts";
import type {
  KVAtomicBuilder,
  KVProvider,
} from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type {
  QueueMessage,
  QueueProvider,
} from "../../primitives/queues/queue-provider.ts";

/**
 * Spec-anchor comments:
 * - PLAT-6: Deploy-time capability injection. Bindings expose only caller parameters, no project/resource specifiers.
 *           There are NO runtime `if (hasPermission(...))` checks. The closures enforce access by structurally prepending the prefix.
 * - PLAT-7: Scoping & physical prefixing. physical_key = {org_id}/{project_id}/{resource_name}/{caller_key}.
 * - KV-4: KV keys are arrays of strings. Max key length/segments limits are assumed checked in the provider.
 * - CONCEPT-2 / CONCEPT-6: Canonical developer conceptual aliases (state -> kv, data -> objects, signal -> queues).
 * - Q-2: Client-facing QueueBinding attenuates internal worker-only methods (receive, ack).
 */

export interface DeclaredPermissions {
  kv?: string[];
  state?: string[];
  objects?: string[];
  data?: string[];
  queues?: string[];
  signal?: string[];
  network?: string[];
  secrets?: string[];
}

/**
 * Normalizes conceptual capability aliases to canonical infrastructure primitives (CONCEPT-2, CONCEPT-6).
 * Enforces strict mutual exclusivity: declaring both alias and primitive throws ValidationFailedError (PLAT-6).
 */
export function normalizeDeclaredCapabilities(
  declared: DeclaredPermissions,
): {
  kv?: string[];
  objects?: string[];
  queues?: string[];
  network?: string[];
  secrets?: string[];
} {
  // PLAT-6: Mutual exclusivity enforcement
  if (declared.kv !== undefined && declared.state !== undefined) {
    throw new ValidationFailedError(
      "Cannot declare both 'kv' and 'state' capabilities (PLAT-6 mutual exclusivity violation)",
    );
  }
  if (declared.objects !== undefined && declared.data !== undefined) {
    throw new ValidationFailedError(
      "Cannot declare both 'objects' and 'data' capabilities (PLAT-6 mutual exclusivity violation)",
    );
  }
  if (declared.queues !== undefined && declared.signal !== undefined) {
    throw new ValidationFailedError(
      "Cannot declare both 'queues' and 'signal' capabilities (PLAT-6 mutual exclusivity violation)",
    );
  }

  const kv = declared.state ?? declared.kv;
  const objects = declared.data ?? declared.objects;
  const queues = declared.signal ?? declared.queues;

  return {
    ...(kv !== undefined ? { kv } : {}),
    ...(objects !== undefined ? { objects } : {}),
    ...(queues !== undefined ? { queues } : {}),
    ...(declared.network !== undefined ? { network: declared.network } : {}),
    ...(declared.secrets !== undefined ? { secrets: declared.secrets } : {}),
  };
}

export interface KVBinding {
  get(key: string[]): Promise<unknown>;
  set(key: string[], value: unknown, opts?: { ttl?: number }): Promise<void>;
  delete(key: string[]): Promise<void>;
  list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{
    keys: { key: string[]; value: unknown }[];
    entries?: { key: string[]; value: unknown; version?: number }[];
    cursor?: string;
  }>;
  atomic(): KVAtomicBuilder;
}

export interface ObjectBinding {
  put(
    key: string,
    data: ArrayBuffer | ReadableStream,
  ): Promise<{ etag: string }>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  list(
    prefix: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: string[]; cursor?: string }>;
  presign(
    key: string,
    opts: { method: "GET" | "PUT"; expiresIn?: number; maxExpiresIn?: number },
  ): Promise<{ url: string; expiresAt: number }>;
  createMultipartUpload(key: string): Promise<{ uploadId: string }>;
}

export interface QueueBinding {
  send(body: unknown, opts?: { delay?: number }): Promise<{ id: string }>;
  sendBatch(bodies: unknown[]): Promise<{ id: string }[]>;
  /**
   * Internal worker consumption method. Purged from client-scoped capability bindings (Q-2).
   */
  receive?(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null>;
  /**
   * Internal worker acknowledgment method. Purged from client-scoped capability bindings (Q-2).
   */
  ack?(id: string): Promise<void>;
}

export type StateBinding = KVBinding;
export type DataBinding = ObjectBinding;
export type SignalBinding = QueueBinding;

export interface ResolvedBindings {
  kv?: KVBinding;
  objects?: ObjectBinding;
  queues?: QueueBinding;
}

function validateIdentifier(id: string, name: string): void {
  if (!id || id.trim() === "") {
    throw new ValidationFailedError(`Invalid empty resource name for ${name}`);
  }
  if (
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    throw new ValidationFailedError(
      `Invalid identifier "${id}" for ${name}: path traversal characters ('..', '/', '\\') and null bytes are forbidden (PLAT-7)`,
    );
  }
}

export function resolvePermissions(
  declared: DeclaredPermissions,
  orgId: string,
  projectId: string,
  providers: {
    kv: KVProvider;
    objects: ObjectProvider;
    queues: QueueProvider;
  },
): ResolvedBindings {
  if (!orgId || !projectId) {
    throw new ValidationFailedError("orgId and projectId are required");
  }
  if (
    orgId.includes("..") ||
    orgId.includes("/") ||
    orgId.includes("\\") ||
    orgId.includes("\0")
  ) {
    throw new ValidationFailedError(
      `Invalid identifier "${orgId}" for orgId: path traversal characters ('..', '/', '\\') and null bytes are forbidden (PLAT-7)`,
    );
  }
  if (
    projectId.includes("..") ||
    projectId.includes("/") ||
    projectId.includes("\\") ||
    projectId.includes("\0")
  ) {
    throw new ValidationFailedError(
      `Invalid identifier "${projectId}" for projectId: path traversal characters ('..', '/', '\\') and null bytes are forbidden (PLAT-7)`,
    );
  }

  const normalized = normalizeDeclaredCapabilities(declared);
  const bindings: ResolvedBindings = {};

  const validateResourceName = (resName: string, type: string) => {
    validateIdentifier(resName, type);
  };

  if (normalized.kv) {
    if (normalized.kv.length > 1) {
      throw new ValidationFailedError(
        "Ambiguous scope: Multiple KV namespaces requested",
      );
    }
    if (normalized.kv.length === 1) {
      const resName = normalized.kv[0];
      validateResourceName(resName, "kv");
      const prefix = [orgId, projectId, resName];
      bindings.kv = {
        get: (key: string[]) => providers.kv.get([...prefix, ...key]),
        set: (key: string[], value: unknown, opts?: { ttl?: number }) =>
          providers.kv.set([...prefix, ...key], value, opts),
        delete: (key: string[]) => providers.kv.delete([...prefix, ...key]),
        list: async (
          queryPrefix: string[],
          opts?: { limit?: number; cursor?: string },
        ) => {
          const res = await providers.kv.list(
            [...prefix, ...queryPrefix],
            opts,
          );
          const mappedKeys = res.keys.map((item) => ({
            ...item,
            key: item.key.slice(prefix.length),
          }));
          return {
            ...res,
            keys: mappedKeys,
            entries: mappedKeys.map((item) => ({
              key: item.key,
              value: item.value,
              version: (item as { version?: number }).version ?? 1,
            })),
          };
        },
        atomic: () => {
          const atm = providers.kv.atomic();
          const atomicBinding = {
            check: (key: string[], version: number) => {
              atm.check([...prefix, ...key], version);
              return atomicBinding;
            },
            set: (key: string[], value: unknown) => {
              atm.set([...prefix, ...key], value);
              return atomicBinding;
            },
            delete: (key: string[]) => {
              atm.delete([...prefix, ...key]);
              return atomicBinding;
            },
            commit: () => atm.commit(),
          };
          return atomicBinding;
        },
      };
    }
  }

  if (normalized.objects) {
    if (normalized.objects.length > 1) {
      throw new ValidationFailedError(
        "Ambiguous scope: Multiple Object buckets requested",
      );
    }
    if (normalized.objects.length === 1) {
      const resName = normalized.objects[0];
      validateResourceName(resName, "objects");
      const prefix = `${orgId}/${projectId}/${resName}/`;

      const validateObjectKey = (key: string) => {
        if (
          key.startsWith("/") ||
          key.includes("..") ||
          key.includes("\\")
        ) {
          throw new ValidationFailedError(
            "Path traversal not allowed in object keys",
          );
        }
      };

      bindings.objects = {
        put: (key: string, data: ArrayBuffer | ReadableStream) => {
          validateObjectKey(key);
          return providers.objects.put(prefix + key, data);
        },
        get: (key: string) => {
          validateObjectKey(key);
          return providers.objects.get(prefix + key);
        },
        delete: (key: string) => {
          validateObjectKey(key);
          return providers.objects.delete(prefix + key);
        },
        head: (key: string) => {
          validateObjectKey(key);
          return providers.objects.head(prefix + key);
        },
        list: async (
          queryPrefix: string,
          opts?: { limit?: number; cursor?: string },
        ) => {
          validateObjectKey(queryPrefix);
          const providerOpts = opts
            ? {
              ...opts,
              cursor: opts.cursor
                ? (opts.cursor.startsWith(prefix)
                  ? opts.cursor
                  : prefix + opts.cursor)
                : undefined,
            }
            : undefined;
          const res = await providers.objects.list(
            prefix + queryPrefix,
            providerOpts,
          );
          const nextCursor = res.cursor && res.cursor.startsWith(prefix)
            ? res.cursor.slice(prefix.length)
            : res.cursor;
          return {
            keys: res.keys
              .filter((k) => k.startsWith(prefix))
              .map((k) => k.slice(prefix.length)),
            cursor: nextCursor,
          };
        },
        presign: (
          key: string,
          opts: {
            method: "GET" | "PUT";
            expiresIn?: number;
            maxExpiresIn?: number;
          },
        ) => {
          validateObjectKey(key);
          return providers.objects.presign(prefix + key, opts);
        },
        createMultipartUpload: (key: string) => {
          validateObjectKey(key);
          return providers.objects.createMultipartUpload(prefix + key);
        },
      };
    }
  }

  if (normalized.queues) {
    if (normalized.queues.length > 1) {
      throw new ValidationFailedError(
        "Ambiguous scope: Multiple Queues requested",
      );
    }
    if (normalized.queues.length === 1) {
      const resName = normalized.queues[0];
      validateResourceName(resName, "queues");
      // Queue provider does not accept a queue ID in the method, it binds to the whole provider
      bindings.queues = {
        send: (body: unknown, opts?: { delay?: number }) =>
          providers.queues.send(body, opts),
        sendBatch: (bodies: unknown[]) => providers.queues.sendBatch(bodies),
      };
    }
  }

  return bindings;
}
