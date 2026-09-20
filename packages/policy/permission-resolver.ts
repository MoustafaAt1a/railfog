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
 */

export interface KVBinding {
  get(key: string[]): Promise<unknown>;
  set(key: string[], value: unknown, opts?: { ttl?: number }): Promise<void>;
  delete(key: string[]): Promise<void>;
  list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }>;
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
  receive(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null>;
  ack(id: string): Promise<void>;
}

export interface ResolvedBindings {
  kv?: KVBinding;
  objects?: ObjectBinding;
  queues?: QueueBinding;
}

export function resolvePermissions(
  declared: { kv?: string[]; objects?: string[]; queues?: string[] },
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

  const bindings: ResolvedBindings = {};

  const validateResourceName = (resName: string, type: string) => {
    if (!resName || resName.trim() === "") {
      throw new ValidationFailedError(
        `Invalid empty resource name for ${type}`,
      );
    }
  };

  if (declared.kv) {
    if (declared.kv.length > 1) {
      throw new ValidationFailedError(
        "Ambiguous scope: Multiple KV namespaces requested",
      );
    }
    if (declared.kv.length === 1) {
      const resName = declared.kv[0];
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
          return {
            ...res,
            keys: res.keys.map((item) => ({
              ...item,
              key: item.key.slice(prefix.length),
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

  if (declared.objects) {
    if (declared.objects.length > 1) {
      throw new ValidationFailedError(
        "Ambiguous scope: Multiple Object buckets requested",
      );
    }
    if (declared.objects.length === 1) {
      const resName = declared.objects[0];
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
          const res = await providers.objects.list(
            prefix + queryPrefix,
            opts,
          );
          return {
            ...res,
            keys: res.keys
              .filter((k) => k.startsWith(prefix))
              .map((k) => k.slice(prefix.length)),
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

  if (declared.queues) {
    if (declared.queues.length > 1) {
      throw new ValidationFailedError(
        "Ambiguous scope: Multiple Queues requested",
      );
    }
    if (declared.queues.length === 1) {
      const resName = declared.queues[0];
      validateResourceName(resName, "queues");
      // Queue provider does not accept a queue ID in the method, it binds to the whole provider
      bindings.queues = {
        send: (body: unknown, opts?: { delay?: number }) =>
          providers.queues.send(body, opts),
        sendBatch: (bodies: unknown[]) => providers.queues.sendBatch(bodies),
        receive: (opts?: { visibilityTimeoutMs?: number }) =>
          providers.queues.receive(opts),
        ack: (msgId: string) => providers.queues.ack(msgId),
      };
    }
  }

  return bindings;
}
