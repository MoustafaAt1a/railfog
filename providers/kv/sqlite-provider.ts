import { DatabaseSync } from "node:sqlite";
import {
  KVAtomicBuilder,
  KVProvider,
} from "../../primitives/kv/kv-provider.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";

// Spec reference: PLAT-16 (Provider abstraction)
// Spec reference: PLAT-17 (Local/production parity - backing strong tier only)
export class SQLiteKVProvider implements KVProvider {
  private db: DatabaseSync;

  constructor(path: string = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv_entries (
        key_path TEXT PRIMARY KEY,
        key_json TEXT NOT NULL,
        value_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        expires_at INTEGER
      );
    `);
  }

  public encodeKeyPath(key: string[]): string {
    return key.map((seg) => encodeURIComponent(seg)).join("/") + "/";
  }

  // Spec reference: KV-4 (Key model validation)
  public validateKey(key: string[]) {
    if (key.length > 32) {
      throw new ValidationFailedError("Key exceeds 32 segments");
    }
    const encoder = new TextEncoder();
    const byteLength = key.reduce(
      (sum, seg) => sum + encoder.encode(seg).length,
      0,
    );
    if (byteLength > 512) {
      throw new ValidationFailedError("Key exceeds 512 bytes");
    }
  }

  // Spec reference: KV-2 (API shape)
  async get(key: string[]): Promise<unknown | null> {
    await Promise.resolve();
    this.validateKey(key);
    const keyPath = this.encodeKeyPath(key);
    const stmt = this.db.prepare(
      "SELECT value_json, expires_at FROM kv_entries WHERE key_path = ?",
    );
    const row = stmt.get(keyPath) as
      | { value_json: string; expires_at: number | null }
      | undefined;

    if (!row) return null;

    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      this.db.prepare(
        "DELETE FROM kv_entries WHERE key_path = ? AND expires_at <= ?",
      ).run(keyPath, Date.now());
      return null; // Expired
    }

    return JSON.parse(row.value_json);
  }

  // Spec reference: KV-2 (API shape)
  async set(
    key: string[],
    value: unknown,
    opts?: { ttl?: number },
  ): Promise<void> {
    await Promise.resolve();
    this.validateKey(key);
    const keyPath = this.encodeKeyPath(key);
    const keyJson = JSON.stringify(key);
    const valueJson = JSON.stringify(value);

    let expiresAt: number | null = null;
    if (opts?.ttl !== undefined) {
      expiresAt = Date.now() + opts.ttl * 1000;
    }

    const stmt = this.db.prepare(`
      INSERT INTO kv_entries (key_path, key_json, value_json, version, expires_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(key_path) DO UPDATE SET
        value_json = excluded.value_json,
        version = kv_entries.version + 1,
        expires_at = excluded.expires_at
    `);
    stmt.run(keyPath, keyJson, valueJson, expiresAt);
  }

  // Spec reference: KV-2 (API shape)
  async delete(key: string[]): Promise<void> {
    await Promise.resolve();
    this.validateKey(key);
    const keyPath = this.encodeKeyPath(key);
    const stmt = this.db.prepare("DELETE FROM kv_entries WHERE key_path = ?");
    stmt.run(keyPath);
  }

  // Spec reference: KV-2 (API shape - cursor pagination)
  async list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }> {
    await Promise.resolve();
    const limit = opts?.limit && opts.limit > 0
      ? Math.min(opts.limit, 1000)
      : 100;
    const prefixPath = this.encodeKeyPath(prefix);

    let query =
      "SELECT key_json, value_json, key_path FROM kv_entries WHERE key_path LIKE ? AND (expires_at IS NULL OR expires_at > ?)";
    const params: (string | number)[] = [prefixPath + "%", Date.now()];

    if (opts?.cursor) {
      const decodedCursor = atob(opts.cursor);
      query += " AND key_path > ?";
      params.push(decodedCursor);
    }

    query += " ORDER BY key_path ASC LIMIT ?";
    params.push(limit + 1);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as {
      key_json: string;
      value_json: string;
      key_path: string;
    }[];

    const hasMore = rows.length > limit;
    const results = hasMore ? rows.slice(0, limit) : rows;

    const keys = results.map((row) => ({
      key: JSON.parse(row.key_json),
      value: JSON.parse(row.value_json),
    }));

    let nextCursor: string | undefined = undefined;
    if (hasMore) {
      nextCursor = btoa(results[results.length - 1].key_path);
    }

    return { keys, cursor: nextCursor };
  }

  // Spec reference: KV-3 (Optimistic concurrency / CAS)
  atomic(): KVAtomicBuilder {
    return new SQLiteKVAtomicBuilder(this.db, this);
  }

  // Spec reference: PLAT-19 — Deterministic resource cleanup
  close(): void {
    try {
      this.db.close();
    } catch {
      // Ignored if already closed
    }
  }
}

class SQLiteKVAtomicBuilder implements KVAtomicBuilder {
  private checks: { key: string[]; expectedVersion: number }[] = [];
  private mutations: {
    type: "set" | "delete";
    key: string[];
    value?: unknown;
  }[] = [];

  constructor(private db: DatabaseSync, private provider: SQLiteKVProvider) {}

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
    await Promise.resolve();
    // Validate keys for all mutations
    for (const m of this.mutations) {
      this.provider.validateKey(m.key);
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION;");

    try {
      const now = Date.now();

      // Cleanup expired keys to ensure fresh versions on new sets
      this.db.prepare(
        "DELETE FROM kv_entries WHERE expires_at IS NOT NULL AND expires_at <= ?",
      ).run(now);

      // Perform checks
      for (const c of this.checks) {
        const keyPath = this.provider.encodeKeyPath(c.key);
        const stmt = this.db.prepare(
          "SELECT version, expires_at FROM kv_entries WHERE key_path = ?",
        );
        const row = stmt.get(keyPath) as
          | { version: number; expires_at: number | null }
          | undefined;

        let currentVersion = 0; // spec: contracts/kv.contract.md#KV-3 — Optimistic concurrency: non-existent or expired key has version 0
        if (row && (row.expires_at === null || row.expires_at > now)) {
          currentVersion = row.version;
        }

        if (currentVersion !== c.expectedVersion) {
          this.db.exec("ROLLBACK;");
          return { ok: false };
        }
      }

      let highestNewVersion = 0;

      // Apply mutations
      for (const m of this.mutations) {
        const keyPath = this.provider.encodeKeyPath(m.key);
        if (m.type === "set") {
          const keyJson = JSON.stringify(m.key);
          const valueJson = JSON.stringify(m.value);
          const stmt = this.db.prepare(`
            INSERT INTO kv_entries (key_path, key_json, value_json, version, expires_at)
            VALUES (?, ?, ?, 1, NULL)
            ON CONFLICT(key_path) DO UPDATE SET
              value_json = excluded.value_json,
              version = kv_entries.version + 1,
              expires_at = NULL
            RETURNING version
          `);
          const result = stmt.get(keyPath, keyJson, valueJson) as {
            version: number;
          };
          highestNewVersion = Math.max(highestNewVersion, result.version);
        } else if (m.type === "delete") {
          const stmt = this.db.prepare(
            "DELETE FROM kv_entries WHERE key_path = ?",
          );
          stmt.run(keyPath);
        }
      }

      this.db.exec("COMMIT;");
      return {
        ok: true,
        version: highestNewVersion > 0 ? highestNewVersion : undefined,
      };
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }
}
