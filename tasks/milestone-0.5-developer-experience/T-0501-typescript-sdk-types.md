# T-0501 — TypeScript SDK Types and Handler Interfaces

Status: Done
Milestone: 0.5 Developer Experience
Depends on: T-0102, T-0108
Blocks: T-0502, T-0503, T-0510, T-0511

## Spec references

`FN-1`, `FN-4`, `KV-2`, `OBJ-2`, `Q-2`, `PLAT-12`, `PLAT-19`

## Scope

**In scope**:
- `sdk/typescript/types.ts`: Define core types and interfaces for the TypeScript SDK (`RailFogContext`, `KVBinding`, `ObjectBinding`, `QueueBinding`, `EnvBinding`, `QueueMessage`, `FunctionHandler`, `AtomicOperation`, `PresignOptions`, `ListOptions`).
- `sdk/typescript/mod.ts`: Public module exports for consumer applications.
- Unit tests in `sdk/typescript/types_test.ts` verifying type shapes, assignability, and function handler definitions.

**Out of scope**:
- Concrete runtime injection mechanics (already implemented in `runtime/loader/context-builder.ts` under T-0108).
- Implementation of client adapter wrappers (deferred to T-0502).
- CLI scaffolding or commands (T-0503, T-0504).

## Interface to implement

```typescript
// sdk/typescript/types.ts

export interface KVAtomicOperation {
  check(key: string[], expectedVersion: number): KVAtomicOperation;
  set(key: string[], value: unknown, options?: { ttl?: number }): KVAtomicOperation;
  delete(key: string[]): KVAtomicOperation;
  commit(): Promise<{ ok: boolean; version?: number }>;
}

export interface KVBinding {
  get<T = unknown>(key: string[]): Promise<T | null>;
  set(key: string[], value: unknown, options?: { ttl?: number }): Promise<void>;
  delete(key: string[]): Promise<void>;
  list<T = unknown>(prefix: string[], options?: { limit?: number; cursor?: string }): Promise<{
    entries: Array<{ key: string[]; value: T; version: number }>;
    cursor?: string;
  }>;
  atomic(): KVAtomicOperation;
}

export interface ObjectBinding {
  put(key: string, data: Uint8Array | ReadableStream<Uint8Array>): Promise<void>;
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<{ sizeBytes: number; sha256: string; integrity: string } | null>;
  list(prefix: string, options?: { limit?: number; cursor?: string }): Promise<{
    keys: Array<{ key: string; sizeBytes: number; sha256: string }>;
    cursor?: string;
  }>;
  createMultipartUpload(key: string): Promise<{ uploadId: string }>;
  presign(key: string, options: { method: "GET" | "PUT"; expiresIn?: number; maxExpiresIn?: number }): Promise<{ url: string; headers: Record<string, string> }>;
}

export interface QueueMessage<T = unknown> {
  id: string;
  body: T;
  attempts: number;
  timestamp: number;
}

export interface QueueBinding {
  send<T = unknown>(message: T, options?: { delay?: number }): Promise<{ id: string }>;
  sendBatch<T = unknown>(messages: T[]): Promise<Array<{ id: string }>>;
}

export interface EnvBinding {
  get(key: string): string | undefined;
  require(key: string): string;
}

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

export type FunctionHandler = (
  request: Request,
  ctx: RailFogContext,
) => Promise<Response> | Response;

export type QueueConsumerHandler<T = unknown> = (
  message: QueueMessage<T>,
  ctx: RailFogContext,
) => Promise<void> | void;
```

## Acceptance criteria (Given/When/Then)

1. Given a user defining an HTTP Function handler conforming to `FN-1`, when imported from `sdk/typescript/mod.ts`, then the function signature accepts `(req: Request, ctx: RailFogContext)` and returns `Promise<Response>`.
2. Given a user defining a queue consumer function conforming to `FN-2` and `Q-2`, when typed with `QueueConsumerHandler`, then the function accepts `(message: QueueMessage, ctx: RailFogContext)` and returns `Promise<void>`.
3. Given `KVBinding` per `KV-2`, when invoking `atomic()`, then the returned chain exposes `.check()`, `.set()`, `.delete()`, and `.commit()`.
4. Given `ObjectBinding` per `OBJ-2`, when invoking `presign()`, then `method` accepts only `"GET" | "PUT"` and options accept `expiresIn` and `maxExpiresIn`.
5. Given `EnvBinding` per `FN-4` and `PLAT-15`, when calling `ctx.env.get("KEY")`, then it returns `string | undefined`, and `ctx.env.require("KEY")` returns `string` or throws `ValidationError`.

## Tests required

- [x] Unit — `sdk/typescript/types_test.ts`: Compile-time and runtime type assertion tests validating that `FunctionHandler`, `QueueConsumerHandler`, and binding shapes strictly conform to `FN-1`, `FN-4`, `KV-2`, `OBJ-2`, `Q-2`.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`FN-1`, `FN-4`, `KV-2`, `OBJ-2`, `Q-2`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

## Assumptions made

None.
