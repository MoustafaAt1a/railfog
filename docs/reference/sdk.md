# TypeScript SDK Reference (`@railfog/sdk`)

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Package**:
> `@railfog/sdk` &nbsp;|&nbsp; **Runtime**: Deno v2.0+ Native Web Standards
> &nbsp;|&nbsp; **Dependencies**: Zero External

This document is the complete API reference for the `@railfog/sdk` package.

---

## 1. Handlers & Contexts

### Execution Wrappers

- `compute(fn: HandlerFn): FunctionHandler`: Canonical conceptual execution wrapper establishing Compute as the fundamental unit of execution (`CONCEPT-2`).
- `handle(fn: HandlerFn): FunctionHandler`: Standard HTTP function handler wrapper with auto-JSON serialization and error normalization (`FN-1`).
- `api(routes: ApiRouteMap): FunctionHandler`: Micro-router matching requests by HTTP method and URLPattern with `PLAT-11` specificity scoring.
- `router(): RouterInstance`: Fluent builder instance with middleware chaining and direct callability as `FunctionHandler`.
- `consumer<T>(fn: (msg: QueueMessage<T>, ctx: ConsumerContext) => Promise<void> | void, options?: ConsumerOptions): QueueConsumerHandler<T>`: Queue message consumer wrapper with optional idempotency (`Q-4`).

### `HandlerContext`

Extends `RailFogContext` with request parsing, response helpers, and conceptual
aliases:

| Property / Method          | Return Type                           | Description                                                |
| -------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `c.req`                    | `Request`                             | Standard WHATWG incoming HTTP request                      |
| `c.url`                    | `URL`                                 | Parsed request URL                                         |
| `c.query`                  | `Record<string, string \| undefined>` | Parsed URL query parameters                                |
| `c.params`                 | `Record<string, string \| undefined>` | Matched URLPattern path parameters                         |
| `c.body<T>(validator?)`    | `Promise<T>`                          | Parse JSON body with optional schema validator             |
| `c.json(data, status?)`    | `Response`                            | Returns a JSON response (`Content-Type: application/json`) |
| `c.text(str, status?)`     | `Response`                            | Returns a plain text response                              |
| `c.html(htmlStr, status?)` | `Response`                            | Returns an HTML response                                   |
| `c.redirect(url, status?)` | `Response`                            | Returns a 302/301 redirect response                        |
| `c.notFound(message?)`     | `never`                               | Throws `ResourceNotFoundError` (`404`)                     |
| `c.badRequest(message?)`   | `never`                               | Throws `ValidationFailedError` (`400`)                     |
| `c.fail(error)`            | `never`                               | Throws normalized `RailFogError`                           |
| `c.stream(fn, options?)`   | `Response`                            | Returns a chunked streaming response                       |
| `c.sse(fn, options?)`      | `Response`                            | Returns a Server-Sent Events (SSE) stream                  |
| `c.state`                  | `StateBinding`                        | Primary State binding (`CONCEPT-2`) (implements KV)       |
| `c.data`                   | `DataBinding`                         | Primary Data binding (`CONCEPT-2`) (implements Objects)   |
| `c.signal`                 | `SignalBinding`                       | Primary Signal binding (`CONCEPT-2`) (implements Queues)  |

### `ConsumerContext`

Extends `RailFogContext` with conceptual capability bindings for queue consumer handlers:

| Property / Method | Return Type     | Description                                               |
| ----------------- | --------------- | --------------------------------------------------------- |
| `ctx.state`       | `StateBinding`  | Primary State binding (`CONCEPT-2`) (implements KV)       |
| `ctx.data`        | `DataBinding`   | Primary Data binding (`CONCEPT-2`) (implements Objects)   |
| `ctx.signal`      | `SignalBinding` | Primary Signal binding (`CONCEPT-2`) (implements Queues)  |

---

## 2. Capability Bindings

### `KVBinding` / `StateBinding`

- `get<T>(key: string[]): Promise<T | null>`
- `set<T>(key: string[], value: T, options?: { ttl?: number }): Promise<void>`
- `delete(key: string[]): Promise<void>`
- `list(prefix: string[], options?: ListOptions): Promise<{ entries: KVEntry[]; cursor?: string }>`
- `atomic(): KVAtomicOperation`

### `ObjectBinding` / `DataBinding`

- `get(key: string): Promise<ReadableStream<Uint8Array> | null>`
- `put(key: string, data: ReadableStream<Uint8Array> | Uint8Array | string, metadata?: ObjectMetadata): Promise<void>`
- `delete(key: string): Promise<void>`
- `presign(key: string, options: PresignOptions): Promise<{ url: string; headers?: Record<string, string> }>`

### `QueueBinding` / `SignalBinding`

- `send(body: unknown, options?: { delaySeconds?: number }): Promise<{ id: string }>`
- `sendBatch(messages: Array<{ body: unknown; delaySeconds?: number }>): Promise<Array<{ id: string }>>`

### `EnvBinding`

- `get(key: string): string | undefined`
- `require(key: string): string` (throws `PermissionDeniedError` if absent)

---

## 3. Reliability Helpers

- `withIdempotency<T>(kv, key, callback, options?): Promise<T>`
- `withRetry<T>(operation, options?): Promise<T>`
- `withCircuitBreaker<T>(operation, options?): Promise<T>`
- `mutate<T>(kv, key, mutator, options?): Promise<T>`

---

## 4. Testing Utilities (`@railfog/sdk/testing`)

- `createMockContext(options?: MockContextOptions): MockRailFogContext`
- `MockStorageState`: In-memory storage state for assertions
  (`ctx.storage.getKv(key)`).
