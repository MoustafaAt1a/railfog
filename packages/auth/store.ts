// spec: contracts/platform.contract.md#PLAT-6 — Capability injection & tenant scoping
// spec: contracts/platform.contract.md#PLAT-9 — Rate limiting: identity resolution
// spec: contracts/platform.contract.md#PLAT-14 — Monotonic ULID identifiers
// spec: contracts/platform.contract.md#PLAT-15 — Secrets management: zero raw secret leakage
// spec: contracts/kv.contract.md#KV-2 — KV API usage
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0753-persistent-api-key-store.md

import type { IdentityContext } from "./verifier.ts";
import { hashApiToken } from "./token.ts";
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import { generateUlid } from "../core/id/ulid.ts";

export interface StoredApiKeyRecord {
  id: string; // Monotonic ULID (PLAT-14)
  tokenHash: string; // Deterministic SHA-256 hex digest (PLAT-15)
  name: string; // Human label for key
  orgId: string;
  projectId?: string;
  createdAt: string; // ISO-8601
  revokedAt?: string; // ISO-8601 if revoked
}

export interface CreateApiKeyResult {
  id: string;
  rawToken: string; // Returned ONLY once at creation (PLAT-15)
  record: StoredApiKeyRecord;
}

export interface ApiKeyStoreOptions {
  storageProvider: KVProvider;
  cacheProvider?: KVProvider; // Fast Redis cache layer
  cacheTtlSeconds?: number; // Default: 300s (5 minutes)
}

/**
 * Persistent API key storage and verification manager.
 *
 * Implements PLAT-6, PLAT-9, and PLAT-15. Persists hashed credentials to primary storage
 * (e.g., PostgreSQL or SQLite) while leveraging fast caching (e.g., Redis) for
 * high-throughput token verification without ever storing raw tokens.
 */
export class ApiKeyStore {
  private storage: KVProvider;
  private cache?: KVProvider;
  private cacheTtl: number;

  constructor(options: ApiKeyStoreOptions) {
    this.storage = options.storageProvider;
    this.cache = options.cacheProvider;
    this.cacheTtl = options.cacheTtlSeconds ?? 300;
  }

  /**
   * Generates a cryptographically random API token, hashes it via SHA-256,
   * stores the metadata record, and returns the raw token once.
   */
  async createKey(params: {
    name: string;
    orgId: string;
    projectId?: string;
  }): Promise<CreateApiKeyResult> {
    const id = generateUlid();

    // Generate cryptographically secure random token bytes
    const randomBytes = new Uint8Array(24);
    crypto.getRandomValues(randomBytes);
    const randomHex = Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const rawToken = `rfk_${randomHex}`;

    // spec: contracts/platform.contract.md#PLAT-15 — Deterministic SHA-256 hash
    const tokenHash = await hashApiToken(rawToken);

    const record: StoredApiKeyRecord = {
      id,
      tokenHash,
      name: params.name.trim(),
      orgId: params.orgId.trim(),
      projectId: params.projectId?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };

    // Primary store indexing
    // 1. tokenHash index for fast verification
    await this.storage.set(["_auth", "tokens", tokenHash], record);
    // 2. id index for revocation
    await this.storage.set(["_auth", "keys", id], tokenHash);
    // 3. org index for listing
    await this.storage.set(["_auth", "orgs", record.orgId, id], record);

    return { id, rawToken, record };
  }

  /**
   * Verifies an incoming raw API token against the cache and primary storage.
   * Never leaks raw token in errors or logs.
   */
  async verifyRawToken(rawToken: string): Promise<IdentityContext | null> {
    if (!rawToken || typeof rawToken !== "string" || !rawToken.startsWith("rfk_")) {
      return null;
    }

    const tokenHash = await hashApiToken(rawToken);

    // Step 1: Check fast Redis cache if available
    if (this.cache) {
      try {
        const cached = await this.cache.get(["auth_cache", tokenHash]) as
          | IdentityContext
          | null;
        if (cached) {
          return cached;
        }
      } catch {
        // Cache error: fallback to primary storage
      }
    }

    // Step 2: Check primary persistent storage
    const record = await this.storage.get(["_auth", "tokens", tokenHash]) as
      | StoredApiKeyRecord
      | null;

    if (!record || record.revokedAt) {
      return null;
    }

    const identity: IdentityContext = {
      callerId: record.name,
      orgId: record.orgId,
      projectId: record.projectId,
      tokenHash,
      callerType: "token",
    };

    // Step 3: Populate cache with TTL
    if (this.cache) {
      try {
        await this.cache.set(
          ["auth_cache", tokenHash],
          identity,
          { ttl: this.cacheTtl },
        );
      } catch {
        // Non-fatal: ignore cache write failure
      }
    }

    return identity;
  }

  /**
   * Revokes an existing API key by ID and purges any active cache entry.
   */
  async revokeKey(keyId: string): Promise<boolean> {
    const tokenHash = await this.storage.get(["_auth", "keys", keyId]) as
      | string
      | null;
    if (!tokenHash) {
      return false;
    }

    const record = await this.storage.get(["_auth", "tokens", tokenHash]) as
      | StoredApiKeyRecord
      | null;
    if (!record) {
      return false;
    }

    record.revokedAt = new Date().toISOString();

    // Update primary storage
    await this.storage.set(["_auth", "tokens", tokenHash], record);
    await this.storage.set(["_auth", "orgs", record.orgId, keyId], record);

    // Evict from fast cache
    if (this.cache) {
      try {
        await this.cache.delete(["auth_cache", tokenHash]);
      } catch {
        // ignore
      }
    }

    return true;
  }

  /**
   * Lists all API key records for an organization.
   */
  async listKeys(orgId: string): Promise<StoredApiKeyRecord[]> {
    const listRes = await this.storage.list(["_auth", "orgs", orgId], {
      limit: 1000,
    });
    const records: StoredApiKeyRecord[] = [];

    for (const item of listRes.keys) {
      if (item.value && typeof item.value === "object") {
        records.push(item.value as StoredApiKeyRecord);
      }
    }

    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
