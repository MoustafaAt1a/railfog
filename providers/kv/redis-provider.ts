// spec: contracts/kv.contract.md#KV-1 — KV purpose and non-purpose
// spec: contracts/kv.contract.md#KV-2 — KV API shape (get, set, delete, list, atomic)
// spec: contracts/kv.contract.md#KV-3 — Optimistic concurrency (CAS)
// spec: contracts/kv.contract.md#KV-4 — Key model & physical prefix namespacing
// spec: contracts/kv.contract.md#KV-5 — Consistency tiers (strong single-writer / linearizable)
// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction

import type {
  KVAtomicBuilder,
  KVProvider,
} from "../../primitives/kv/kv-provider.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import { Redis } from "ioredis";

export interface RedisKVOptions {
  url?: string;
  keyPrefix?: string;
  connectionTimeoutMs?: number;
}

interface StoredPayload {
  key: string[];
  value: unknown;
  version: number;
  expiresAt?: number;
}

/**
 * Redis-backed implementation of KVProvider.
 *
 * Implements high-throughput key-value storage and caching. When `url` is provided,
 * connects to Redis via standard RESP protocol. When no URL is provided, utilizes
 * an in-memory Redis simulator for local testing and zero-dependency parity.
 */
export class RedisKVProvider implements KVProvider {
  // deno-lint-ignore no-explicit-any
  private client: any | null = null;
  private memoryStore: Map<string, StoredPayload> = new Map();
  private prefix: string;

  constructor(options?: RedisKVOptions) {
    this.prefix = options?.keyPrefix ?? "rfk:";
    if (options?.url && options.url.trim().length > 0) {
      try {
        this.client = new Redis(options.url, {
          connectTimeout: options.connectionTimeoutMs ?? 5000,
          lazyConnect: true,
          maxRetriesPerRequest: 2,
        });
      } catch {
        this.client = null;
      }
    }
  }

  // spec: contracts/kv.contract.md#KV-4 — Key model validation
  public validateKey(key: string[]): void {
    if (!Array.isArray(key) || key.length === 0) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Key must be a non-empty array of segments",
      );
    }
    if (key.length > 32) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Key exceeds 32 segments",
      );
    }
    const encoder = new TextEncoder();
    const byteLength = key.reduce(
      (sum, seg) => sum + encoder.encode(seg).length,
      0,
    );
    if (byteLength > 512) {
      throw new ValidationFailedError(
        "VALIDATION_FAILED: Key exceeds 512 bytes",
      );
    }
  }

  public encodeKeyPath(key: string[]): string {
    return this.prefix + key.map((seg) => encodeURIComponent(seg)).join("/") +
      "/";
  }

  private cleanMemoryExpired(now = Date.now()): void {
    for (const [k, v] of this.memoryStore.entries()) {
      if (v.expiresAt !== undefined && v.expiresAt <= now) {
        this.memoryStore.delete(k);
      }
    }
  }

  // spec: contracts/kv.contract.md#KV-2 — get(key)
  async get(key: string[]): Promise<unknown | null> {
    this.validateKey(key);
    const keyPath = this.encodeKeyPath(key);

    if (this.client) {
      const raw = await this.client.get(keyPath);
      if (!raw) return null;
      try {
        const payload: StoredPayload = JSON.parse(raw);
        return payload.value;
      } catch {
        return null;
      }
    }

    this.cleanMemoryExpired();
    const entry = this.memoryStore.get(keyPath);
    if (!entry) return null;
    return entry.value;
  }

  // spec: contracts/kv.contract.md#KV-2 — set(key, value, { ttl?: number })
  async set(
    key: string[],
    value: unknown,
    opts?: { ttl?: number },
  ): Promise<void> {
    this.validateKey(key);
    const keyPath = this.encodeKeyPath(key);

    let currentVersion = 0;
    if (this.client) {
      const existingRaw = await this.client.get(keyPath);
      if (existingRaw) {
        try {
          const parsed: StoredPayload = JSON.parse(existingRaw);
          currentVersion = parsed.version;
        } catch {
          // ignore corrupted payload
        }
      }
      const newPayload: StoredPayload = {
        key,
        value,
        version: currentVersion + 1,
      };
      const serialized = JSON.stringify(newPayload);
      if (opts?.ttl !== undefined && opts.ttl > 0) {
        await this.client.set(keyPath, serialized, "EX", opts.ttl);
      } else {
        await this.client.set(keyPath, serialized);
      }
      return;
    }

    this.cleanMemoryExpired();
    const existing = this.memoryStore.get(keyPath);
    if (existing) {
      currentVersion = existing.version;
    }
    const expiresAt = opts?.ttl !== undefined && opts.ttl > 0
      ? Date.now() + opts.ttl * 1000
      : undefined;

    this.memoryStore.set(keyPath, {
      key,
      value,
      version: currentVersion + 1,
      expiresAt,
    });
  }

  // spec: contracts/kv.contract.md#KV-2 — delete(key)
  async delete(key: string[]): Promise<void> {
    this.validateKey(key);
    const keyPath = this.encodeKeyPath(key);

    if (this.client) {
      await this.client.del(keyPath);
      return;
    }

    this.memoryStore.delete(keyPath);
  }

  // spec: contracts/kv.contract.md#KV-2 — list(prefix, opts)
  async list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }> {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
    const prefixPath = this.encodeKeyPath(prefix);

    if (this.client) {
      // In Redis mode, perform SCAN match
      let cursor = opts?.cursor ?? "0";
      const matchedKeys: string[] = [];

      do {
        const [nextCursor, keys] = await this.client.scan(
          cursor,
          "MATCH",
          `${prefixPath}*`,
          "COUNT",
          limit * 2,
        );
        cursor = nextCursor;
        for (const k of keys) {
          if (!matchedKeys.includes(k)) {
            matchedKeys.push(k);
          }
        }
      } while (cursor !== "0" && matchedKeys.length < limit + 1);

      matchedKeys.sort();
      const hasMore = matchedKeys.length > limit;
      const selected = hasMore ? matchedKeys.slice(0, limit) : matchedKeys;

      const keys: { key: string[]; value: unknown }[] = [];
      if (selected.length > 0) {
        const values = await this.client.mget(...selected);
        for (let i = 0; i < selected.length; i++) {
          const raw = values[i];
          if (raw) {
            try {
              const payload: StoredPayload = JSON.parse(raw);
              keys.push({ key: payload.key, value: payload.value });
            } catch {
              // ignore
            }
          }
        }
      }

      const nextCursorStr = hasMore
        ? btoa(selected[selected.length - 1])
        : undefined;

      return { keys, cursor: nextCursorStr };
    }

    // In-memory list
    this.cleanMemoryExpired();
    const decodedCursor = opts?.cursor ? atob(opts.cursor) : "";
    const allMatching: StoredPayload[] = [];

    for (const [k, v] of this.memoryStore.entries()) {
      if (k.startsWith(prefixPath) && k > decodedCursor) {
        allMatching.push(v);
      }
    }

    allMatching.sort((a, b) => {
      const pathA = this.encodeKeyPath(a.key);
      const pathB = this.encodeKeyPath(b.key);
      return pathA.localeCompare(pathB);
    });

    const hasMore = allMatching.length > limit;
    const items = hasMore ? allMatching.slice(0, limit) : allMatching;
    const keys = items.map((item) => ({ key: item.key, value: item.value }));

    const nextCursor = hasMore
      ? btoa(this.encodeKeyPath(items[items.length - 1].key))
      : undefined;

    return { keys, cursor: nextCursor };
  }

  // spec: contracts/kv.contract.md#KV-3 — atomic() optimistic concurrency
  atomic(): KVAtomicBuilder {
    return new RedisAtomicBuilder(this, this.client, this.memoryStore);
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        // ignore
      }
    }
  }
}

class RedisAtomicBuilder implements KVAtomicBuilder {
  private checks: { key: string[]; expectedVersion: number }[] = [];
  private mutations: {
    type: "set" | "delete";
    key: string[];
    value?: unknown;
  }[] = [];

  constructor(
    private provider: RedisKVProvider,
    // deno-lint-ignore no-explicit-any
    private client: any | null,
    private memoryStore: Map<string, StoredPayload>,
  ) {}

  check(key: string[], expectedVersion: number): KVAtomicBuilder {
    this.checks.push({ key, expectedVersion });
    return this;
  }

  set(key: string[], value: unknown): KVAtomicBuilder {
    this.mutations.push({ type: "set", key, value });
    return this;
  }

  delete(key: string[]): KVAtomicBuilder {
    this.mutations.push({ type: "delete", key });
    return this;
  }

  async commit(): Promise<{ ok: boolean; version?: number }> {
    for (const m of this.mutations) {
      this.provider.validateKey(m.key);
    }
    for (const c of this.checks) {
      this.provider.validateKey(c.key);
    }

    if (this.client) {
      const watchedPaths = [
        ...this.checks.map((c) => this.provider.encodeKeyPath(c.key)),
        ...this.mutations.map((m) => this.provider.encodeKeyPath(m.key)),
      ];

      await this.client.watch(...watchedPaths);

      // Verify versions
      for (const c of this.checks) {
        const path = this.provider.encodeKeyPath(c.key);
        const raw = await this.client.get(path);
        let version = 0;
        if (raw) {
          try {
            const payload: StoredPayload = JSON.parse(raw);
            version = payload.version;
          } catch {
            version = 0;
          }
        }
        if (version !== c.expectedVersion) {
          await this.client.unwatch();
          return { ok: false };
        }
      }

      let highestNewVersion = 0;
      const multi = this.client.multi();

      for (const m of this.mutations) {
        const path = this.provider.encodeKeyPath(m.key);
        if (m.type === "set") {
          const existingRaw = await this.client.get(path);
          let currentVersion = 0;
          if (existingRaw) {
            try {
              currentVersion = JSON.parse(existingRaw).version;
            } catch {
              // ignore
            }
          }
          const nextVersion = currentVersion + 1;
          highestNewVersion = Math.max(highestNewVersion, nextVersion);
          const payload: StoredPayload = {
            key: m.key,
            value: m.value,
            version: nextVersion,
          };
          multi.set(path, JSON.stringify(payload));
        } else {
          multi.del(path);
        }
      }

      const results = await multi.exec();
      if (!results) {
        return { ok: false };
      }
      return { ok: true, version: highestNewVersion };
    }

    // In-memory atomic CAS
    const now = Date.now();
    for (const [k, v] of this.memoryStore.entries()) {
      if (v.expiresAt !== undefined && v.expiresAt <= now) {
        this.memoryStore.delete(k);
      }
    }

    for (const c of this.checks) {
      const path = this.provider.encodeKeyPath(c.key);
      const existing = this.memoryStore.get(path);
      const currentVersion = existing ? existing.version : 0;
      if (currentVersion !== c.expectedVersion) {
        return { ok: false };
      }
    }

    let highestNewVersion = 0;
    for (const m of this.mutations) {
      const path = this.provider.encodeKeyPath(m.key);
      if (m.type === "set") {
        const existing = this.memoryStore.get(path);
        const nextVersion = (existing ? existing.version : 0) + 1;
        highestNewVersion = Math.max(highestNewVersion, nextVersion);
        this.memoryStore.set(path, {
          key: m.key,
          value: m.value,
          version: nextVersion,
        });
      } else {
        this.memoryStore.delete(path);
      }
    }

    return { ok: true, version: highestNewVersion };
  }
}
