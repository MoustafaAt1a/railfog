// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
// spec: contracts/platform.contract.md#PLAT-17 — Local/production parity
// spec: contracts/kv.contract.md#KV-5 — Strong linearizable consistency tier backing
import type {
  KVAtomicBuilder,
  KVProvider,
} from "../../primitives/kv/kv-provider.ts";
import {
  PayloadTooLargeError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";

// spec: contracts/kv.contract.md#KV-4 — Key constraints: max 32 segments, max 512 bytes
const MAX_KEY_SEGMENTS = 32;
const MAX_KEY_BYTES = 512;

// spec: contracts/kv.contract.md#KV-1 — Payload limit 256 KB
const MAX_PAYLOAD_BYTES = 256 * 1024; // 262,144 bytes

// Deno KV single-value hard limit is 64 KiB (65,536 bytes); chunk boundary safely below that
const CHUNK_SIZE = 60_000;

// spec: contracts/kv.contract.md#KV-2 — Default list limit 100, max 1000
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Validates key according to KV-4:
 * - Array of 1 to 32 string segments.
 * - Segments must be non-empty, no null bytes, no '.', '..', '/', or '\\'.
 * - Combined UTF-8 byte length <= 512 bytes.
 */
function validateKey(key: string[]): void {
  if (!Array.isArray(key) || key.length === 0) {
    throw new ValidationFailedError("Key must be a non-empty array of strings");
  }
  if (key.length > MAX_KEY_SEGMENTS) {
    throw new ValidationFailedError(
      `Key segment count ${key.length} exceeds maximum of ${MAX_KEY_SEGMENTS}`,
    );
  }

  let totalBytes = 0;
  for (let i = 0; i < key.length; i++) {
    const seg = key[i];
    if (typeof seg !== "string") {
      throw new ValidationFailedError(
        `Key segment at index ${i} must be a string, got ${typeof seg}`,
      );
    }
    if (seg.length === 0) {
      throw new ValidationFailedError(
        `Key segment at index ${i} cannot be empty`,
      );
    }
    if (seg.includes("\0")) {
      throw new ValidationFailedError(
        `Key segment at index ${i} contains null bytes`,
      );
    }
    if (seg === "." || seg === "..") {
      throw new ValidationFailedError(
        `Key segment at index ${i} cannot be '.' or '..'`,
      );
    }
    if (seg.includes("/") || seg.includes("\\")) {
      throw new ValidationFailedError(
        `Key segment at index ${i} cannot contain '/' or '\\'`,
      );
    }
    totalBytes += TEXT_ENCODER.encode(seg).length;
  }

  if (totalBytes > MAX_KEY_BYTES) {
    throw new ValidationFailedError(
      `Total key byte length ${totalBytes} exceeds maximum of ${MAX_KEY_BYTES} bytes`,
    );
  }
}

/**
 * Measures and returns the serialized payload size and bytes.
 */
function getPayloadDetails(value: unknown): {
  size: number;
  dataType: "string" | "uint8array" | "json";
  bytes: Uint8Array;
} {
  if (typeof value === "string") {
    const bytes = TEXT_ENCODER.encode(value);
    return { size: bytes.length, dataType: "string", bytes };
  }
  if (value instanceof Uint8Array) {
    return { size: value.byteLength, dataType: "uint8array", bytes: value };
  }
  const json = JSON.stringify(value);
  const bytes = TEXT_ENCODER.encode(json ?? "null");
  return { size: bytes.length, dataType: "json", bytes };
}

/**
 * Validates payload size according to KV-1 (256 KB limit):
 * - If string: byte length.
 * - If Uint8Array: byteLength.
 * - If object/other: JSON.stringify UTF-8 byte length.
 */
function validatePayload(value: unknown): void {
  const { size } = getPayloadDetails(value);
  if (size > MAX_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(
      `Payload size ${size} bytes exceeds maximum allowed ${MAX_PAYLOAD_BYTES} bytes`,
    );
  }
}

/**
 * Validates TTL according to KV-2: must be positive number of seconds.
 */
function validateTTL(ttl: number | undefined): void {
  if (ttl !== undefined) {
    if (typeof ttl !== "number" || Number.isNaN(ttl) || ttl <= 0) {
      throw new ValidationFailedError(
        `TTL must be a positive number of seconds, received ${ttl}`,
      );
    }
  }
}

function isLargePayload(value: unknown): boolean {
  const { size } = getPayloadDetails(value);
  return size > CHUNK_SIZE;
}

function chunkPayload(value: unknown): {
  dataType: "string" | "uint8array" | "json";
  chunks: Uint8Array[];
} {
  const { dataType, bytes } = getPayloadDetails(value);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    chunks.push(
      bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length)),
    );
  }
  return { dataType, chunks };
}

// spec: contracts/kv.contract.md#KV-3 — Direct envelope to track integer versioning and expiration
interface KVDirectEnvelope<T = unknown> {
  type: "direct";
  value: T;
  version: number;
  expiresAt?: number;
}

// spec: contracts/kv.contract.md#KV-3 — Chunked envelope for payloads exceeding Deno KV entry limit
interface KVChunkedEnvelope {
  type: "chunked";
  version: number;
  expiresAt?: number;
  dataType: "string" | "uint8array" | "json";
  totalChunks: number;
}

function isDirectEnvelope(val: unknown): val is KVDirectEnvelope {
  return (
    val !== null &&
    typeof val === "object" &&
    "version" in val &&
    typeof (val as Record<string, unknown>).version === "number" &&
    ("value" in val || (val as Record<string, unknown>).type === "direct")
  );
}

function isChunkedEnvelope(val: unknown): val is KVChunkedEnvelope {
  return (
    val !== null &&
    typeof val === "object" &&
    (val as Record<string, unknown>).type === "chunked" &&
    typeof (val as Record<string, unknown>).version === "number" &&
    typeof (val as Record<string, unknown>).totalChunks === "number"
  );
}

/**
 * Resolves a stored entry value, assembling chunks or validating expiration.
 */
async function resolveValue(
  kv: Deno.Kv,
  key: string[],
  entryValue: unknown,
): Promise<{ value: unknown; version: number; expired: boolean }> {
  if (entryValue === null || entryValue === undefined) {
    return { value: null, version: 0, expired: false };
  }

  if (isChunkedEnvelope(entryValue)) {
    // spec: contracts/kv.contract.md#KV-2 — Expiration check
    if (
      entryValue.expiresAt !== undefined && entryValue.expiresAt <= Date.now()
    ) {
      return { value: null, version: 0, expired: true };
    }
    const chunkPromises: Promise<Deno.KvEntryMaybe<Uint8Array>>[] = [];
    for (let i = 0; i < entryValue.totalChunks; i++) {
      chunkPromises.push(kv.get<Uint8Array>(["\0rf_chunks", ...key, i]));
    }
    const chunkEntries = await Promise.all(chunkPromises);
    let totalLen = 0;
    for (const c of chunkEntries) {
      if (c.value) {
        totalLen += c.value.byteLength;
      }
    }
    const combined = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of chunkEntries) {
      if (c.value) {
        combined.set(c.value, pos);
        pos += c.value.byteLength;
      }
    }

    let val: unknown = null;
    if (entryValue.dataType === "string") {
      val = TEXT_DECODER.decode(combined);
    } else if (entryValue.dataType === "uint8array") {
      val = combined;
    } else if (entryValue.dataType === "json") {
      val = JSON.parse(TEXT_DECODER.decode(combined));
    }
    return { value: val, version: entryValue.version, expired: false };
  }

  if (isDirectEnvelope(entryValue)) {
    // spec: contracts/kv.contract.md#KV-2 — Expiration check
    if (
      entryValue.expiresAt !== undefined && entryValue.expiresAt <= Date.now()
    ) {
      return { value: null, version: 0, expired: true };
    }
    return {
      value: entryValue.value,
      version: entryValue.version,
      expired: false,
    };
  }

  return { value: entryValue, version: 1, expired: false };
}

export interface DenoDeployKVProviderOptions {
  url?: string;
  accessToken?: string;
  path?: string; // for local testing with Deno.openKv(path)
}

/**
 * Remote strong KV provider using Deno Deploy KV (or local SQLite KV for tests).
 * Delivers linearizable consistency per KV-5 and atomic CAS per KV-3.
 */
export class DenoDeployKVProvider implements KVProvider {
  private kvPromise: Promise<Deno.Kv> | null = null;
  private kv: Deno.Kv | null = null;

  constructor(private readonly options?: DenoDeployKVProviderOptions) {
    if (this.options?.accessToken) {
      try {
        Deno.env.set("DENO_KV_ACCESS_TOKEN", this.options.accessToken);
      } catch {
        // Environment variable manipulation may be restricted in sandbox
      }
    }
    const target = this.options?.url ?? this.options?.path;
    this.kvPromise = Deno.openKv(target).then((kv) => {
      this.kv = kv;
      return kv;
    });
  }

  async getKvInstance(): Promise<Deno.Kv> {
    if (this.kv) {
      return this.kv;
    }
    if (this.kvPromise) {
      return await this.kvPromise;
    }
    throw new ValidationFailedError("KV database is closed");
  }

  // spec: contracts/kv.contract.md#KV-2 — API shape: get
  async get(key: string[]): Promise<unknown | null> {
    validateKey(key);
    const kv = await this.getKvInstance();
    const entry = await kv.get(key);
    const resolved = await resolveValue(kv, key, entry.value);
    return resolved.value;
  }

  // spec: contracts/kv.contract.md#KV-2 — API shape: set with TTL in seconds
  // spec: contracts/kv.contract.md#KV-3 — Monotonic version increment per write
  async set(
    key: string[],
    value: unknown,
    opts?: { ttl?: number },
  ): Promise<void> {
    validateKey(key);
    validatePayload(value);
    validateTTL(opts?.ttl);

    const kv = await this.getKvInstance();
    const expireIn = opts?.ttl !== undefined ? opts.ttl * 1000 : undefined;
    const expiresAt = opts?.ttl !== undefined
      ? Date.now() + opts.ttl * 1000
      : undefined;

    while (true) {
      const entry = await kv.get(key);
      let currentVersion = 0;
      let prevTotalChunks = 0;

      if (entry.value !== null && typeof entry.value === "object") {
        if (isChunkedEnvelope(entry.value)) {
          currentVersion = entry.value.version;
          prevTotalChunks = entry.value.totalChunks;
        } else if (isDirectEnvelope(entry.value)) {
          currentVersion = entry.value.version;
        }
      }

      const nextVersion = currentVersion + 1;
      const atomic = kv.atomic().check(entry);

      // Clean up previous chunks if key was previously chunked
      for (let i = 0; i < prevTotalChunks; i++) {
        atomic.delete(["\0rf_chunks", ...key, i]);
      }

      if (isLargePayload(value)) {
        const { dataType, chunks } = chunkPayload(value);
        for (let i = 0; i < chunks.length; i++) {
          atomic.set(
            ["\0rf_chunks", ...key, i],
            chunks[i],
            expireIn !== undefined ? { expireIn } : undefined,
          );
        }
        const envelope: KVChunkedEnvelope = {
          type: "chunked",
          version: nextVersion,
          expiresAt,
          dataType,
          totalChunks: chunks.length,
        };
        atomic.set(
          key,
          envelope,
          expireIn !== undefined ? { expireIn } : undefined,
        );
      } else {
        const envelope: KVDirectEnvelope = {
          type: "direct",
          value,
          version: nextVersion,
          expiresAt,
        };
        atomic.set(
          key,
          envelope,
          expireIn !== undefined ? { expireIn } : undefined,
        );
      }

      const res = await atomic.commit();
      if (res.ok) {
        return;
      }
    }
  }

  // spec: contracts/kv.contract.md#KV-2 — API shape: delete
  async delete(key: string[]): Promise<void> {
    validateKey(key);
    const kv = await this.getKvInstance();
    const entry = await kv.get(key);
    if (isChunkedEnvelope(entry.value)) {
      const atomic = kv.atomic();
      for (let i = 0; i < entry.value.totalChunks; i++) {
        atomic.delete(["\0rf_chunks", ...key, i]);
      }
      atomic.delete(key);
      await atomic.commit();
    } else {
      await kv.delete(key);
    }
  }

  // spec: contracts/kv.contract.md#KV-2 — API shape: list with cursor pagination
  async list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }> {
    validateKey(prefix);
    const limit = opts?.limit && opts.limit > 0
      ? Math.min(opts.limit, MAX_LIST_LIMIT)
      : DEFAULT_LIST_LIMIT;

    const kv = await this.getKvInstance();
    const iter = kv.list(
      { prefix },
      opts?.cursor ? { cursor: opts.cursor } : {},
    );

    const keys: { key: string[]; value: unknown }[] = [];
    let lastCursor: string | undefined = undefined;

    for await (const entry of iter) {
      const resolved = await resolveValue(
        kv,
        entry.key as string[],
        entry.value,
      );
      if (resolved.expired) {
        continue;
      }
      if (keys.length < limit) {
        keys.push({
          key: entry.key as string[],
          value: resolved.value,
        });
        lastCursor = iter.cursor;
      } else {
        return { keys, cursor: lastCursor };
      }
    }

    return { keys, cursor: undefined };
  }

  // spec: contracts/kv.contract.md#KV-3 — Optimistic concurrency / CAS builder
  atomic(): KVAtomicBuilder {
    return new DenoDeployKVAtomicBuilder(this);
  }

  async close(): Promise<void> {
    if (this.kvPromise) {
      const kv = await this.kvPromise;
      this.kv = null;
      this.kvPromise = null;
      kv.close();
    }
  }
}

/**
 * Implements KVAtomicBuilder for Deno Deploy KV supporting CAS checks and mutations.
 */
export class DenoDeployKVAtomicBuilder implements KVAtomicBuilder {
  private checks: { key: string[]; expectedVersion: number }[] = [];
  private mutations: (
    | { type: "set"; key: string[]; value: unknown }
    | { type: "delete"; key: string[] }
  )[] = [];

  constructor(private readonly provider: DenoDeployKVProvider) {}

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

  // spec: contracts/kv.contract.md#KV-3 — Atomic CAS commit
  async commit(): Promise<{ ok: boolean; version?: number }> {
    for (const c of this.checks) {
      validateKey(c.key);
    }
    for (const m of this.mutations) {
      validateKey(m.key);
      if (m.type === "set") {
        validatePayload(m.value);
      }
    }

    const kv = await this.provider.getKvInstance();

    // Collect distinct keys
    const keyMap = new Map<string, string[]>();
    for (const c of this.checks) {
      keyMap.set(JSON.stringify(c.key), c.key);
    }
    for (const m of this.mutations) {
      keyMap.set(JSON.stringify(m.key), m.key);
    }

    // Fetch existing entries for all distinct keys
    const entries = new Map<string, Deno.KvEntryMaybe<unknown>>();
    for (const [keyStr, key] of keyMap) {
      const entry = await kv.get(key);
      entries.set(keyStr, entry);
    }

    // Verify expected versions
    for (const c of this.checks) {
      const keyStr = JSON.stringify(c.key);
      const entry = entries.get(keyStr)!;
      let currentVersion = 0;
      if (entry.value !== null && typeof entry.value === "object") {
        if (isChunkedEnvelope(entry.value)) {
          if (
            entry.value.expiresAt === undefined ||
            entry.value.expiresAt > Date.now()
          ) {
            currentVersion = entry.value.version;
          }
        } else if (isDirectEnvelope(entry.value)) {
          if (
            entry.value.expiresAt === undefined ||
            entry.value.expiresAt > Date.now()
          ) {
            currentVersion = entry.value.version;
          }
        }
      }

      if (currentVersion !== c.expectedVersion) {
        return { ok: false };
      }
    }

    // Build native atomic operation with linearizable versionstamp check
    const atomic = kv.atomic();
    for (const entry of entries.values()) {
      atomic.check(entry);
    }

    const currentVersions = new Map<string, number>();
    for (const [keyStr, entry] of entries) {
      let v = 0;
      if (entry.value !== null && typeof entry.value === "object") {
        if (isChunkedEnvelope(entry.value)) {
          if (
            entry.value.expiresAt === undefined ||
            entry.value.expiresAt > Date.now()
          ) {
            v = entry.value.version;
          }
        } else if (isDirectEnvelope(entry.value)) {
          if (
            entry.value.expiresAt === undefined ||
            entry.value.expiresAt > Date.now()
          ) {
            v = entry.value.version;
          }
        }
      }
      currentVersions.set(keyStr, v);
    }

    let highestNewVersion = 0;

    for (const m of this.mutations) {
      const keyStr = JSON.stringify(m.key);
      const entry = entries.get(keyStr)!;

      // Clean up previous chunks if previously chunked
      if (isChunkedEnvelope(entry.value)) {
        for (let i = 0; i < entry.value.totalChunks; i++) {
          atomic.delete(["\0rf_chunks", ...m.key, i]);
        }
      }

      if (m.type === "set") {
        const cur = currentVersions.get(keyStr) ?? 0;
        const newVersion = cur + 1;
        currentVersions.set(keyStr, newVersion);

        if (isLargePayload(m.value)) {
          const { dataType, chunks } = chunkPayload(m.value);
          for (let i = 0; i < chunks.length; i++) {
            atomic.set(["\0rf_chunks", ...m.key, i], chunks[i]);
          }
          const envelope: KVChunkedEnvelope = {
            type: "chunked",
            version: newVersion,
            dataType,
            totalChunks: chunks.length,
          };
          atomic.set(m.key, envelope);
        } else {
          const envelope: KVDirectEnvelope = {
            type: "direct",
            value: m.value,
            version: newVersion,
          };
          atomic.set(m.key, envelope);
        }

        highestNewVersion = Math.max(highestNewVersion, newVersion);
      } else if (m.type === "delete") {
        currentVersions.set(keyStr, 0);
        atomic.delete(m.key);
      }
    }

    const commitRes = await atomic.commit();
    if (!commitRes.ok) {
      return { ok: false };
    }

    return {
      ok: true,
      version: highestNewVersion > 0 ? highestNewVersion : undefined,
    };
  }
}
