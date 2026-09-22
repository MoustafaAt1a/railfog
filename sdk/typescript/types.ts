// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: sdk/typescript
// spec: contracts/functions.contract.md#FN-1 — Function definition and HTTP handler
// spec: contracts/functions.contract.md#FN-4 — RailFogContext structure and scoped capability bindings
// spec: contracts/kv.contract.md#KV-2 — KV binding API and atomic transaction builder
// spec: contracts/objects.contract.md#OBJ-2 — Objects binding API and SigV4 presigning
// spec: contracts/queues.contract.md#Q-2 — Queue binding API and message structure
// spec: contracts/platform.contract.md#PLAT-12 — Error model and ValidationFailedError
// spec: contracts/platform.contract.md#PLAT-15 — Secret access via capability-scoped EnvBinding

/**
 * Options for paginated list operations across KV and Object stores.
 * @spec contracts/kv.contract.md#KV-2
 * @spec contracts/objects.contract.md#OBJ-2
 */
export interface ListOptions {
  limit?: number;
  cursor?: string;
}

/**
 * Atomic transaction builder for KV operations supporting optimistic concurrency check-and-set.
 * @spec contracts/kv.contract.md#KV-2
 */
export interface KVAtomicOperation {
  check(key: string[], expectedVersion: number): KVAtomicOperation;
  set(
    key: string[],
    value: unknown,
    options?: { ttl?: number },
  ): KVAtomicOperation;
  delete(key: string[]): KVAtomicOperation;
  commit(): Promise<{ ok: boolean; version?: number }>;
}

/**
 * Alias for KVAtomicOperation.
 * @spec contracts/kv.contract.md#KV-2
 */
export type AtomicOperation = KVAtomicOperation;

/**
 * Key-Value storage capability binding pre-scoped to the function's declared namespace.
 * @spec contracts/kv.contract.md#KV-2
 * @spec contracts/functions.contract.md#FN-4
 */
export interface KVBinding {
  get<T = unknown>(key: string[]): Promise<T | null>;
  set(
    key: string[],
    value: unknown,
    options?: { ttl?: number },
  ): Promise<void>;
  delete(key: string[]): Promise<void>;
  list<T = unknown>(
    prefix: string[],
    options?: ListOptions,
  ): Promise<{
    entries: Array<{ key: string[]; value: T; version: number }>;
    cursor?: string;
  }>;
  atomic(): KVAtomicOperation;
}

/**
 * Options for generating SigV4 presigned URLs for direct client-to-storage transfer.
 * @spec contracts/objects.contract.md#OBJ-2
 */
export interface PresignOptions {
  method: "GET" | "PUT";
  expiresIn?: number;
  maxExpiresIn?: number;
}

/**
 * Object storage capability binding pre-scoped to the function's declared bucket.
 * @spec contracts/objects.contract.md#OBJ-2
 * @spec contracts/functions.contract.md#FN-4
 */
export interface ObjectBinding {
  put(
    key: string,
    data: Uint8Array | ReadableStream<Uint8Array>,
  ): Promise<void>;
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  head(
    key: string,
  ): Promise<{ sizeBytes: number; sha256: string; integrity: string } | null>;
  list(
    prefix: string,
    options?: ListOptions,
  ): Promise<{
    keys: Array<{ key: string; sizeBytes: number; sha256: string }>;
    cursor?: string;
  }>;
  createMultipartUpload(key: string): Promise<{ uploadId: string }>;
  presign(
    key: string,
    options: PresignOptions,
  ): Promise<{ url: string; headers: Record<string, string> }>;
}

/**
 * Queue message structure delivered to queue consumer functions.
 * @spec contracts/queues.contract.md#Q-2
 */
export interface QueueMessage<T = unknown> {
  id: string;
  body: T;
  attempts: number;
  timestamp: number;
}

/**
 * Queue capability binding pre-scoped to the function's declared target queue.
 * @spec contracts/queues.contract.md#Q-2
 * @spec contracts/functions.contract.md#FN-4
 */
export interface QueueBinding {
  send<T = unknown>(
    message: T,
    options?: { delay?: number },
  ): Promise<{ id: string }>;
  sendBatch<T = unknown>(messages: T[]): Promise<Array<{ id: string }>>;
}

/**
 * Environment secrets binding exposing capability-scoped secrets assigned to this function.
 * @spec contracts/platform.contract.md#PLAT-15
 * @spec contracts/platform.contract.md#PLAT-12
 * @spec contracts/functions.contract.md#FN-4
 */
export interface EnvBinding {
  get(key: string): string | undefined;
  require(key: string): string;
}

/**
 * Invocation context providing capability-scoped bindings and invocation metadata.
 * @spec contracts/functions.contract.md#FN-4
 */
export interface RailFogContext {
  requestId: string;
  project: string;
  function: string;
  revision: string;
  deadline: number;
  timeRemaining(): number;
  kv: KVBinding;
  objects: ObjectBinding;
  queues: QueueBinding;
  env: EnvBinding;
}

/**
 * Entrypoint handler signature for HTTP-triggered functions.
 * @spec contracts/functions.contract.md#FN-1
 */
export type FunctionHandler = (
  req: Request,
  ctx: RailFogContext,
) => Promise<Response> | Response;

/**
 * Entrypoint handler signature for Queue-triggered consumer functions.
 * @spec contracts/functions.contract.md#FN-2
 * @spec contracts/queues.contract.md#Q-2
 */
export type QueueConsumerHandler<T = unknown> = (
  message: QueueMessage<T>,
  ctx: RailFogContext,
) => Promise<void> | void;

/**
 * Scheduled cron trigger payload delivered to scheduled functions.
 * @spec contracts/functions.contract.md#FN-2
 */
export interface ScheduleEvent {
  cron: string;
  timestamp: number;
}

/**
 * Entrypoint handler signature for Schedule-triggered functions.
 * @spec contracts/functions.contract.md#FN-2
 */
export type ScheduleHandler = (
  event: ScheduleEvent,
  ctx: RailFogContext,
) => Promise<void> | void;

/**
 * Standard Issue format per the Standard Schema specification (https://standardschema.dev).
 */
export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

export interface StandardSuccessResult<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}

export interface StandardFailureResult {
  readonly issues: ReadonlyArray<StandardIssue>;
}

export type StandardResult<Output> =
  | StandardSuccessResult<Output>
  | StandardFailureResult;

/**
 * Standard Schema V1 interface supported natively by Zod, Valibot, ArkType, etc.
 * @see https://standardschema.dev
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardResult<Output> | Promise<StandardResult<Output>>;
  };
}

/**
 * Universal schema validator accepted by c.body(schema).
 * Supports Standard Schema V1, safeParse/safeParseAsync (Zod/Valibot duck-typing),
 * or pure synchronous/asynchronous predicate functions.
 */
export type SchemaValidator<T> =
  | StandardSchemaV1<unknown, T>
  | {
    safeParse(
      data: unknown,
    ): { success: true; data: T } | { success: false; error: unknown };
  }
  | {
    safeParseAsync(
      data: unknown,
    ): Promise<{ success: true; data: T } | { success: false; error: unknown }>;
  }
  | ((data: unknown) => T | Promise<T>);

/**
 * Structured contextual logger correlating log messages with PLAT-14 request IDs.
 * @spec contracts/platform.contract.md#PLAT-14
 */
export interface ContextLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/**
 * Configuration options for the consumer() queue handler wrapper.
 * @spec contracts/queues.contract.md#Q-4
 */
export interface ConsumerOptions {
  /**
   * Automatically deduplicate messages using withIdempotency() over ctx.kv.
   * Defaults to false.
   */
  idempotent?: boolean;
  /**
   * Retention TTL in seconds for idempotency deduplication keys.
   * Defaults to 14 days (1,209,600s) per Q-4.
   */
  ttlSeconds?: number;
  /**
   * Custom key generator for deduplication. Defaults to ["railfog_dedupe", message.id].
   */
  dedupeKey?: (message: QueueMessage) => string[];
}

/**
 * Options for formatting Set-Cookie response headers per RFC 6265.
 */
export interface CookieOptions {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: "Strict" | "Lax" | "None" | "strict" | "lax" | "none";
  secure?: boolean;
}
