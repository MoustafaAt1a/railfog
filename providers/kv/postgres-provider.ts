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
import postgres from "postgres";

export interface PostgresKVOptions {
  connectionString?: string;
  tableName?: string;
  maxConnections?: number;
  idleTimeout?: number;
}

interface StoredRow {
  key_path: string;
  key_json: string;
  value_json: string;
  version: number;
  expires_at: number | null;
}

/**
 * PostgreSQL implementation of KVProvider supporting ACID transactional CAS.
 *
 * Implements KV-1 through KV-5 backed by PostgreSQL (PLAT-16). When connectionString
 * is provided (or DATABASE_URL is set), uses native SQL connection pool with SSL.
 * When absent, runs with an embedded in-memory SQL simulator to preserve local/test parity.
 */
export class PostgresKVProvider implements KVProvider {
  // deno-lint-ignore no-explicit-any
  private sql: any | null = null;
  private tableName: string;
  private memoryRows: Map<string, StoredRow> = new Map();

  constructor(options?: PostgresKVOptions) {
    this.tableName = options?.tableName ?? "kv_entries";
    const connStr = options?.connectionString ?? Deno.env.get("DATABASE_URL");

    if (connStr && connStr.trim().length > 0) {
      try {
        this.sql = postgres(connStr, {
          max: options?.maxConnections ?? 10,
          idle_timeout: options?.idleTimeout ?? 20,
          connect_timeout: 5,
          ssl: "prefer",
        });
      } catch {
        this.sql = null;
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
    return key.map((seg) => encodeURIComponent(seg)).join("/") + "/";
  }

  // spec: contracts/kv.contract.md#KV-1, KV-5 — Schema initialization
  async initSchema(): Promise<void> {
    if (this.sql) {
      await this.sql`
        CREATE TABLE IF NOT EXISTS ${this.sql(this.tableName)} (
          key_path TEXT PRIMARY KEY,
          key_json JSONB NOT NULL,
          value_json JSONB NOT NULL,
          version BIGINT NOT NULL DEFAULT 1,
          expires_at TIMESTAMPTZ
        );
      `;
      await this.sql`
        CREATE INDEX IF NOT EXISTS ${
        this.sql(`idx_${this.tableName}_expires_at`)
      }
        ON ${this.sql(this.tableName)}(expires_at);
      `;
    }
  }

  private cleanMemoryExpired(now = Date.now()): void {
    for (const [k, v] of this.memoryRows.entries()) {
      if (v.expires_at !== null && v.expires_at <= now) {
        this.memoryRows.delete(k);
      }
    }
  }

  // spec: contracts/kv.contract.md#KV-2 — get(key)
  async get(key: string[]): Promise<unknown | null> {
    this.validateKey(key);
    const keyPath = this.encodeKeyPath(key);

    if (this.sql) {
      const rows = await this.sql`
        SELECT value_json, expires_at
        FROM ${this.sql(this.tableName)}
        WHERE key_path = ${keyPath}
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1;
      `;
      if (!rows || rows.length === 0) {
        return null;
      }
      const rawVal = rows[0].value_json;
      if (typeof rawVal === "string") {
        try {
          return JSON.parse(rawVal);
        } catch {
          return rawVal;
        }
      }
      return rawVal;
    }

    this.cleanMemoryExpired();
    const row = this.memoryRows.get(keyPath);
    if (!row) return null;
    return JSON.parse(row.value_json);
  }

  // spec: contracts/kv.contract.md#KV-2 — set(key, value, { ttl?: number })
  async set(
    key: string[],
    value: unknown,
    opts?: { ttl?: number },
  ): Promise<void> {
    this.validateKey(key);
    const keyPath = this.encodeKeyPath(key);
    const keyJson = JSON.stringify(key);
    const valueJson = JSON.stringify(value);

    if (this.sql) {
      if (opts?.ttl !== undefined && opts.ttl > 0) {
        await this.sql`
          INSERT INTO ${this.sql(this.tableName)}
            (key_path, key_json, value_json, version, expires_at)
          VALUES (
            ${keyPath},
            ${keyJson}::jsonb,
            ${valueJson}::jsonb,
            1,
            NOW() + (${opts.ttl} || ' seconds')::interval
          )
          ON CONFLICT (key_path) DO UPDATE SET
            value_json = EXCLUDED.value_json,
            version = ${this.sql(this.tableName)}.version + 1,
            expires_at = EXCLUDED.expires_at;
        `;
      } else {
        await this.sql`
          INSERT INTO ${this.sql(this.tableName)}
            (key_path, key_json, value_json, version, expires_at)
          VALUES (
            ${keyPath},
            ${keyJson}::jsonb,
            ${valueJson}::jsonb,
            1,
            NULL
          )
          ON CONFLICT (key_path) DO UPDATE SET
            value_json = EXCLUDED.value_json,
            version = ${this.sql(this.tableName)}.version + 1,
            expires_at = NULL;
        `;
      }
      return;
    }

    this.cleanMemoryExpired();
    const existing = this.memoryRows.get(keyPath);
    const version = (existing ? existing.version : 0) + 1;
    const expiresAt = opts?.ttl !== undefined && opts.ttl > 0
      ? Date.now() + opts.ttl * 1000
      : null;

    this.memoryRows.set(keyPath, {
      key_path: keyPath,
      key_json: keyJson,
      value_json: valueJson,
      version,
      expires_at: expiresAt,
    });
  }

  // spec: contracts/kv.contract.md#KV-2 — delete(key)
  async delete(key: string[]): Promise<void> {
    this.validateKey(key);
    const keyPath = this.encodeKeyPath(key);

    if (this.sql) {
      await this.sql`
        DELETE FROM ${this.sql(this.tableName)}
        WHERE key_path = ${keyPath};
      `;
      return;
    }

    this.memoryRows.delete(keyPath);
  }

  // spec: contracts/kv.contract.md#KV-2 — list(prefix, opts)
  async list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }> {
    const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 1000);
    const prefixPath = this.encodeKeyPath(prefix);
    const decodedCursor = opts?.cursor ? atob(opts.cursor) : "";

    if (this.sql) {
      let rows;
      if (decodedCursor) {
        rows = await this.sql`
          SELECT key_json, value_json, key_path
          FROM ${this.sql(this.tableName)}
          WHERE key_path LIKE ${prefixPath + "%"}
            AND key_path > ${decodedCursor}
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY key_path ASC
          LIMIT ${limit + 1};
        `;
      } else {
        rows = await this.sql`
          SELECT key_json, value_json, key_path
          FROM ${this.sql(this.tableName)}
          WHERE key_path LIKE ${prefixPath + "%"}
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY key_path ASC
          LIMIT ${limit + 1};
        `;
      }

      const hasMore = rows.length > limit;
      const selected = hasMore ? rows.slice(0, limit) : rows;
      const keys = selected.map((
        r: { key_json: unknown; value_json: unknown },
      ) => {
        let val = r.value_json;
        if (typeof val === "string") {
          try {
            val = JSON.parse(val);
          } catch {
            // keep raw
          }
        }
        return {
          key: (typeof r.key_json === "string"
            ? JSON.parse(r.key_json)
            : r.key_json) as string[],
          value: val,
        };
      });

      const cursor = hasMore
        ? btoa(selected[selected.length - 1].key_path)
        : undefined;

      return { keys, cursor };
    }

    // In-memory list
    this.cleanMemoryExpired();
    const matching: StoredRow[] = [];

    for (const [k, v] of this.memoryRows.entries()) {
      if (k.startsWith(prefixPath) && k > decodedCursor) {
        matching.push(v);
      }
    }

    matching.sort((a, b) => a.key_path.localeCompare(b.key_path));
    const hasMore = matching.length > limit;
    const selected = hasMore ? matching.slice(0, limit) : matching;

    const keys = selected.map((row) => ({
      key: JSON.parse(row.key_json),
      value: JSON.parse(row.value_json),
    }));

    const cursor = hasMore
      ? btoa(selected[selected.length - 1].key_path)
      : undefined;

    return { keys, cursor };
  }

  // spec: contracts/kv.contract.md#KV-3 — atomic()
  atomic(): KVAtomicBuilder {
    return new PostgresAtomicBuilder(
      this,
      this.sql,
      this.tableName,
      this.memoryRows,
    );
  }

  async close(): Promise<void> {
    if (this.sql) {
      try {
        await this.sql.end({ timeout: 5 });
      } catch {
        // ignore
      }
    }
  }
}

class PostgresAtomicBuilder implements KVAtomicBuilder {
  private checks: { key: string[]; expectedVersion: number }[] = [];
  private mutations: {
    type: "set" | "delete";
    key: string[];
    value?: unknown;
  }[] = [];

  constructor(
    private provider: PostgresKVProvider,
    // deno-lint-ignore no-explicit-any
    private sql: any | null,
    private tableName: string,
    private memoryRows: Map<string, StoredRow>,
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

    if (this.sql) {
      // Execute within a single Postgres transaction
      // deno-lint-ignore no-explicit-any
      const txResult = await this.sql.begin(async (tx: any) => {
        // Step 1: Perform optimistic version checks with SELECT ... FOR UPDATE
        for (const c of this.checks) {
          const keyPath = this.provider.encodeKeyPath(c.key);
          const rows = await tx`
            SELECT version, expires_at
            FROM ${tx(this.tableName)}
            WHERE key_path = ${keyPath}
            FOR UPDATE;
          `;

          let currentVersion = 0;
          if (rows && rows.length > 0) {
            const row = rows[0];
            const isExpired = row.expires_at !== null &&
              new Date(row.expires_at).getTime() <= Date.now();
            if (!isExpired) {
              currentVersion = Number(row.version);
            }
          }

          if (currentVersion !== c.expectedVersion) {
            return { ok: false };
          }
        }

        // Step 2: Apply mutations
        let highestNewVersion = 0;
        for (const m of this.mutations) {
          const keyPath = this.provider.encodeKeyPath(m.key);
          if (m.type === "set") {
            const keyJson = JSON.stringify(m.key);
            const valueJson = JSON.stringify(m.value);
            const res = await tx`
              INSERT INTO ${tx(this.tableName)}
                (key_path, key_json, value_json, version, expires_at)
              VALUES (${keyPath}, ${keyJson}::jsonb, ${valueJson}::jsonb, 1, NULL)
              ON CONFLICT (key_path) DO UPDATE SET
                value_json = EXCLUDED.value_json,
                version = ${tx(this.tableName)}.version + 1,
                expires_at = NULL
              RETURNING version;
            `;
            const nextVersion = Number(res[0].version);
            highestNewVersion = Math.max(highestNewVersion, nextVersion);
          } else {
            await tx`
              DELETE FROM ${tx(this.tableName)}
              WHERE key_path = ${keyPath};
            `;
          }
        }

        return { ok: true, version: highestNewVersion };
      });

      return txResult;
    }

    // In-memory simulation
    const now = Date.now();
    for (const [k, v] of this.memoryRows.entries()) {
      if (v.expires_at !== null && v.expires_at <= now) {
        this.memoryRows.delete(k);
      }
    }

    for (const c of this.checks) {
      const path = this.provider.encodeKeyPath(c.key);
      const row = this.memoryRows.get(path);
      const currentVersion = row ? row.version : 0;
      if (currentVersion !== c.expectedVersion) {
        return { ok: false };
      }
    }

    let highestNewVersion = 0;
    for (const m of this.mutations) {
      const path = this.provider.encodeKeyPath(m.key);
      if (m.type === "set") {
        const existing = this.memoryRows.get(path);
        const nextVersion = (existing ? existing.version : 0) + 1;
        highestNewVersion = Math.max(highestNewVersion, nextVersion);
        this.memoryRows.set(path, {
          key_path: path,
          key_json: JSON.stringify(m.key),
          value_json: JSON.stringify(m.value),
          version: nextVersion,
          expires_at: null,
        });
      } else {
        this.memoryRows.delete(path);
      }
    }

    return { ok: true, version: highestNewVersion };
  }
}
