/**
 * Storage Provider Tenant Prefix Defense-in-Depth Guard
 *
 * Spec references:
 * - PLAT-7: Physical multi-tenancy & data isolation:
 *           physical_key = {org_id}/{project_id}/{resource_name}/{caller_key}
 * - PLAT-12: Error model: PermissionDeniedError on prefix tampering / traversal,
 *            ValidationFailedError on invalid tenant identifiers
 * - PLAT-16: Provider abstraction (pluggable engines behind identical interfaces)
 * - PLAT-17: Parity between local and production storage implementations
 * - KV-2: KV API shape (get, set, delete, list, atomic)
 * - OBJ-2: Objects API shape (put, get, delete, head, list, presign, createMultipartUpload)
 * - Q-2: Queues API shape (send, sendBatch, receive, ack)
 */

import {
  PermissionDeniedError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
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
 * Tenant context providing organization and project identity.
 * Spec-anchor: PLAT-7 (physical multi-tenancy namespacing).
 */
export interface TenantContext {
  orgId: string;
  projectId: string;
}

// ============================================================================
// Internal Validation Helpers
// ============================================================================

/**
 * Validates tenant context identifiers and returns an immutable defensive copy.
 * Rejects empty, whitespace-only, untrimmed, path traversal, slashes, or null bytes.
 * Spec-anchor: PLAT-7, PLAT-12.
 */
export function normalizeTenantContext(tenant: unknown): TenantContext {
  if (!tenant || typeof tenant !== "object") {
    throw new ValidationFailedError("Tenant context must be a non-null object");
  }

  const { orgId, projectId } = tenant as Record<string, unknown>;

  if (typeof orgId !== "string" || typeof projectId !== "string") {
    throw new ValidationFailedError(
      "Tenant orgId and projectId must both be strings",
    );
  }

  if (orgId.trim().length === 0 || projectId.trim().length === 0) {
    throw new ValidationFailedError(
      "Tenant orgId and projectId must not be empty or whitespace",
    );
  }

  if (orgId !== orgId.trim() || projectId !== projectId.trim()) {
    throw new ValidationFailedError(
      "Tenant orgId and projectId must not contain leading or trailing whitespace",
    );
  }

  const isInvalid = (id: string): boolean => {
    return (
      id === "." ||
      id === ".." ||
      id.includes("..") ||
      id.includes("/") ||
      id.includes("\\") ||
      id.includes("\0") ||
      id.toLowerCase().includes("%2e%2e")
    );
  };

  if (isInvalid(orgId) || isInvalid(projectId)) {
    throw new ValidationFailedError(
      "Tenant orgId and projectId must not contain path traversal, slashes, or null bytes",
    );
  }

  return Object.freeze({
    orgId,
    projectId,
  });
}

/**
 * Validates tenant context identifiers.
 * Rejects empty, whitespace-only, path traversal, slashes, or null bytes.
 * Spec-anchor: PLAT-7, PLAT-12.
 */
export function assertValidTenant(
  tenant: unknown,
): asserts tenant is TenantContext {
  normalizeTenantContext(tenant);
}

/**
 * Validates an individual key segment for path traversal and forbidden characters.
 * Spec-anchor: PLAT-7, PLAT-12.
 */
function assertValidSegment(segment: unknown): void {
  if (typeof segment !== "string" || segment.length === 0) {
    throw new PermissionDeniedError("Key segment must be a non-empty string");
  }
  if (
    segment === "." ||
    segment === ".." ||
    segment.includes("..") ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0") ||
    segment.toLowerCase().includes("%2e%2e")
  ) {
    throw new PermissionDeniedError(
      "Key segment contains forbidden path traversal, delimiters, or control characters",
    );
  }
}

/**
 * Sanitizes and validates a KV operation key array against tenant physical prefix.
 * Produces an immutable, frozen defensive copy of primitive string segments to eliminate
 * Time-Of-Check to Time-Of-Use (TOCTOU) getter attacks and post-validation array mutation.
 * Spec-anchor: PLAT-7, PLAT-12, KV-2.
 */
export function sanitizeKvKey(key: unknown, tenant: TenantContext): string[] {
  if (!Array.isArray(key) || key.length < 2) {
    throw new PermissionDeniedError(
      "KV key must be an array containing at least [orgId, projectId, ...]",
    );
  }

  const safeKey: string[] = new Array(key.length);
  for (let i = 0; i < key.length; i++) {
    const seg = key[i];
    if (typeof seg !== "string" || seg.length === 0) {
      throw new PermissionDeniedError("Key segment must be a non-empty string");
    }
    safeKey[i] = seg;
  }

  if (safeKey[0] !== tenant.orgId || safeKey[1] !== tenant.projectId) {
    throw new PermissionDeniedError(
      `Cross-tenant KV access denied: key does not match tenant prefix [${tenant.orgId}, ${tenant.projectId}]`,
    );
  }

  for (const seg of safeKey) {
    assertValidSegment(seg);
  }

  return Object.freeze(safeKey) as unknown as string[];
}

/**
 * Validates KV operation key array against tenant physical prefix.
 * Spec-anchor: PLAT-7, KV-2.
 */
export function assertValidKvKey(key: unknown, tenant: TenantContext): void {
  sanitizeKvKey(key, tenant);
}

/**
 * Sanitizes and validates a KV list prefix array against tenant prefix.
 * Produces an immutable, frozen defensive copy to eliminate TOCTOU getter and mutation attacks.
 * Spec-anchor: PLAT-7, PLAT-12, KV-2.
 */
export function sanitizeKvPrefix(
  prefix: unknown,
  tenant: TenantContext,
): string[] {
  if (!Array.isArray(prefix) || prefix.length < 2) {
    throw new PermissionDeniedError(
      "KV list prefix must specify at least [orgId, projectId] to prevent cross-tenant scans",
    );
  }

  const safePrefix: string[] = new Array(prefix.length);
  for (let i = 0; i < prefix.length; i++) {
    const seg = prefix[i];
    if (typeof seg !== "string" || seg.length === 0) {
      throw new PermissionDeniedError("Key segment must be a non-empty string");
    }
    safePrefix[i] = seg;
  }

  if (safePrefix[0] !== tenant.orgId || safePrefix[1] !== tenant.projectId) {
    throw new PermissionDeniedError(
      `Cross-tenant KV list denied: prefix does not match tenant prefix [${tenant.orgId}, ${tenant.projectId}]`,
    );
  }

  for (const seg of safePrefix) {
    assertValidSegment(seg);
  }

  return Object.freeze(safePrefix) as unknown as string[];
}

/**
 * Validates KV list prefix array against tenant prefix.
 * Spec-anchor: PLAT-7, KV-2.
 */
export function assertValidKvPrefix(
  prefix: unknown,
  tenant: TenantContext,
): void {
  sanitizeKvPrefix(prefix, tenant);
}

/**
 * Validates Object key string against tenant prefix `{org_id}/{project_id}/`.
 * Spec-anchor: PLAT-7, OBJ-2.
 */
function assertValidObjectKey(key: unknown, tenant: TenantContext): void {
  if (typeof key !== "string") {
    throw new PermissionDeniedError("Object key must be a string");
  }

  const expectedPrefix = `${tenant.orgId}/${tenant.projectId}/`;
  if (!key.startsWith(expectedPrefix)) {
    throw new PermissionDeniedError(
      `Cross-tenant object access denied: key must begin with ${expectedPrefix}`,
    );
  }

  if (
    key.includes("..") ||
    key.includes("\\") ||
    key.includes("\0") ||
    key.toLowerCase().includes("%2e%2e")
  ) {
    throw new PermissionDeniedError(
      "Object key contains forbidden path traversal, backslashes, or null bytes",
    );
  }

  const remainder = key.slice(expectedPrefix.length);
  if (remainder.length === 0) {
    throw new PermissionDeniedError(
      "Object key must contain a non-empty name after tenant prefix",
    );
  }

  // Validate every segment in remainder
  const segments = remainder.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === ".." || seg.length === 0) {
      throw new PermissionDeniedError(
        "Object key contains invalid or empty path segments",
      );
    }
  }
}

/**
 * Validates Object list prefix string against tenant prefix `{org_id}/{project_id}/`.
 * Spec-anchor: PLAT-7, OBJ-2.
 */
function assertValidObjectListPrefix(
  prefix: unknown,
  tenant: TenantContext,
): void {
  if (typeof prefix !== "string") {
    throw new PermissionDeniedError("Object list prefix must be a string");
  }

  const expectedPrefix = `${tenant.orgId}/${tenant.projectId}/`;
  if (!prefix.startsWith(expectedPrefix)) {
    throw new PermissionDeniedError(
      `Cross-tenant object list denied: prefix must begin with ${expectedPrefix}`,
    );
  }

  if (
    prefix.includes("..") ||
    prefix.includes("\\") ||
    prefix.includes("\0") ||
    prefix.toLowerCase().includes("%2e%2e")
  ) {
    throw new PermissionDeniedError(
      "Object list prefix contains forbidden path traversal, backslashes, or null bytes",
    );
  }

  // Check segments for traversal
  const segments = prefix.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      throw new PermissionDeniedError(
        "Object list prefix contains traversal segments",
      );
    }
  }
}

/**
 * Validates Queue name string against tenant prefix `{org_id}_{project_id}_`.
 * Spec-anchor: PLAT-7, Q-2.
 */
function assertValidQueueName(name: unknown, tenant: TenantContext): void {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new PermissionDeniedError(
      "Queue name must be a non-empty string",
    );
  }

  const expectedPrefix = `${tenant.orgId}_${tenant.projectId}_`;
  if (!name.startsWith(expectedPrefix)) {
    throw new PermissionDeniedError(
      `Cross-tenant queue access denied: queue name must begin with ${expectedPrefix}`,
    );
  }

  if (
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.toLowerCase().includes("%2e%2e")
  ) {
    throw new PermissionDeniedError(
      "Queue name contains forbidden slashes, traversal, or control characters",
    );
  }

  const resourcePart = name.slice(expectedPrefix.length);
  if (resourcePart.length === 0) {
    throw new PermissionDeniedError(
      "Queue name must contain a resource identifier after tenant prefix",
    );
  }
}

// ============================================================================
// Guarded Provider Implementations
// ============================================================================

/**
 * Guarded atomic builder enforcing tenant key prefix on check, set, delete.
 * Spec-anchor: PLAT-7, KV-2.
 */
export class GuardedKVAtomicBuilder implements KVAtomicBuilder {
  private readonly tenant: TenantContext;

  constructor(
    private readonly underlying: KVAtomicBuilder,
    tenant: TenantContext,
  ) {
    this.tenant = normalizeTenantContext(tenant);
    Object.freeze(this);
  }

  check(key: string[], expectedVersion: number): KVAtomicBuilder {
    const safeKey = sanitizeKvKey(key, this.tenant);
    this.underlying.check(safeKey, expectedVersion);
    return this;
  }

  set(key: string[], value: unknown): KVAtomicBuilder {
    const safeKey = sanitizeKvKey(key, this.tenant);
    this.underlying.set(safeKey, value);
    return this;
  }

  delete(key: string[]): KVAtomicBuilder {
    const safeKey = sanitizeKvKey(key, this.tenant);
    this.underlying.delete(safeKey);
    return this;
  }

  commit(): Promise<{ ok: boolean; version?: number }> {
    return this.underlying.commit();
  }
}

/**
 * Guarded KVProvider intercepting every operation at the entrypoint.
 * Spec-anchor: PLAT-7, PLAT-16, KV-2.
 */
export class GuardedKVProvider implements KVProvider {
  private readonly tenant: TenantContext;

  constructor(
    private readonly underlying: KVProvider,
    tenant: TenantContext,
  ) {
    this.tenant = normalizeTenantContext(tenant);
    Object.freeze(this);
  }

  async get(key: string[]): Promise<unknown | null> {
    const safeKey = sanitizeKvKey(key, this.tenant);
    return await this.underlying.get(safeKey);
  }

  async set(
    key: string[],
    value: unknown,
    opts?: { ttl?: number },
  ): Promise<void> {
    const safeKey = sanitizeKvKey(key, this.tenant);
    return await this.underlying.set(safeKey, value, opts);
  }

  async delete(key: string[]): Promise<void> {
    const safeKey = sanitizeKvKey(key, this.tenant);
    return await this.underlying.delete(safeKey);
  }

  async list(
    prefix: string[],
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: { key: string[]; value: unknown }[]; cursor?: string }> {
    const safePrefix = sanitizeKvPrefix(prefix, this.tenant);
    return await this.underlying.list(safePrefix, opts);
  }

  atomic(): KVAtomicBuilder {
    const builder = this.underlying.atomic();
    return new GuardedKVAtomicBuilder(builder, this.tenant);
  }
}

/**
 * Guarded ObjectProvider intercepting every operation at the entrypoint.
 * Spec-anchor: PLAT-7, PLAT-16, OBJ-2.
 */
export class GuardedObjectProvider implements ObjectProvider {
  private readonly tenant: TenantContext;

  constructor(
    private readonly underlying: ObjectProvider,
    tenant: TenantContext,
  ) {
    this.tenant = normalizeTenantContext(tenant);
    Object.freeze(this);
  }

  async put(
    key: string,
    data: ArrayBuffer | ReadableStream,
  ): Promise<{ etag: string }> {
    assertValidObjectKey(key, this.tenant);
    return await this.underlying.put(key, data);
  }

  async get(key: string): Promise<ReadableStream | null> {
    assertValidObjectKey(key, this.tenant);
    return await this.underlying.get(key);
  }

  async delete(key: string): Promise<void> {
    assertValidObjectKey(key, this.tenant);
    return await this.underlying.delete(key);
  }

  async head(key: string): Promise<{ size: number; etag: string } | null> {
    assertValidObjectKey(key, this.tenant);
    return await this.underlying.head(key);
  }

  async list(
    prefix: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ keys: string[]; cursor?: string }> {
    assertValidObjectListPrefix(prefix, this.tenant);
    return await this.underlying.list(prefix, opts);
  }

  async presign(
    key: string,
    opts: { method: "GET" | "PUT"; expiresIn?: number; maxExpiresIn?: number },
  ): Promise<{ url: string; expiresAt: number }> {
    assertValidObjectKey(key, this.tenant);
    return await this.underlying.presign(key, opts);
  }

  async createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    assertValidObjectKey(key, this.tenant);
    return await this.underlying.createMultipartUpload(key);
  }
}

/**
 * Guarded QueueProvider intercepting queue operations and dynamic tampering.
 * Spec-anchor: PLAT-7, PLAT-16, Q-2.
 */
export class GuardedQueueProvider implements QueueProvider {
  private readonly tenant: TenantContext;

  constructor(
    private readonly underlying: QueueProvider,
    tenant: TenantContext,
    private readonly boundQueueName?: string,
  ) {
    this.tenant = normalizeTenantContext(tenant);
    if (this.boundQueueName !== undefined) {
      assertValidQueueName(this.boundQueueName, this.tenant);
    }
    Object.freeze(this);
  }

  /**
   * Dynamically verifies the active queue name on every operation call.
   * Spec-anchor: PLAT-7 defense-in-depth against underlying mutation.
   */
  private assertCurrentQueueName(): void {
    if (this.boundQueueName !== undefined) {
      assertValidQueueName(this.boundQueueName, this.tenant);
    }
    const underlyingObj = this.underlying as {
      queueName?: unknown;
      queueId?: unknown;
    };
    const underlyingName = underlyingObj.queueName ?? underlyingObj.queueId;
    if (underlyingName !== undefined) {
      assertValidQueueName(underlyingName, this.tenant);
    }
    if (this.boundQueueName === undefined && underlyingName === undefined) {
      throw new PermissionDeniedError(
        "No queue name configured for guarded queue provider",
      );
    }
  }

  async send(
    body: unknown,
    opts?: { delay?: number },
  ): Promise<{ id: string }> {
    this.assertCurrentQueueName();
    return await this.underlying.send(body, opts);
  }

  async sendBatch(bodies: unknown[]): Promise<{ id: string }[]> {
    this.assertCurrentQueueName();
    return await this.underlying.sendBatch(bodies);
  }

  async receive(
    opts?: { visibilityTimeoutMs?: number },
  ): Promise<QueueMessage | null> {
    this.assertCurrentQueueName();
    return await this.underlying.receive(opts);
  }

  async ack(id: string): Promise<void> {
    this.assertCurrentQueueName();
    return await this.underlying.ack(id);
  }

  get deadLetter(): QueueProvider | undefined {
    const dlq = (this.underlying as { deadLetter?: QueueProvider }).deadLetter;
    if (!dlq) return undefined;
    return new GuardedQueueProvider(dlq, this.tenant, this.boundQueueName);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Wraps a KVProvider with defense-in-depth tenant boundary verification.
 * Spec-anchor: PLAT-7, PLAT-16.
 */
export function createGuardedKVProvider(
  provider: KVProvider,
  tenant: TenantContext,
): KVProvider {
  const safeTenant = normalizeTenantContext(tenant);
  if (!provider || typeof provider !== "object") {
    throw new ValidationFailedError(
      "Underlying KVProvider must be a valid object",
    );
  }
  return new GuardedKVProvider(provider, safeTenant);
}

/**
 * Wraps an ObjectProvider with defense-in-depth tenant boundary verification.
 * Spec-anchor: PLAT-7, PLAT-16.
 */
export function createGuardedObjectProvider(
  provider: ObjectProvider,
  tenant: TenantContext,
): ObjectProvider {
  const safeTenant = normalizeTenantContext(tenant);
  if (!provider || typeof provider !== "object") {
    throw new ValidationFailedError(
      "Underlying ObjectProvider must be a valid object",
    );
  }
  return new GuardedObjectProvider(provider, safeTenant);
}

/**
 * Wraps a QueueProvider with defense-in-depth tenant boundary verification.
 * Spec-anchor: PLAT-7, PLAT-16.
 */
export function createGuardedQueueProvider(
  provider: QueueProvider,
  tenant: TenantContext,
  queueName?: string,
): QueueProvider {
  const safeTenant = normalizeTenantContext(tenant);
  if (!provider || typeof provider !== "object") {
    throw new ValidationFailedError(
      "Underlying QueueProvider must be a valid object",
    );
  }
  if (queueName !== undefined) {
    assertValidQueueName(queueName, safeTenant);
  }
  return new GuardedQueueProvider(provider, safeTenant, queueName);
}
