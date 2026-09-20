# T-0810 — Implement Ergonomic Function Handler Wrapper

Status: Complete Milestone: 0.8 Developer Experience & UX Polish Depends on:
none Blocks: T-0812

## Spec references

`FN-1`, `FN-4`, `PLAT-19`

## Scope

**In scope**:

- `sdk/typescript/wrapper.ts` — Ergonomic function handler wrappers for RailFog
  serverless workloads:
  - `handle()`: High-level wrapper function that accepts
    `(c: HandlerContext) => Promise<unknown> | unknown`, provides
    auto-destructured access to `c.kv`, `c.objects`, `c.queues`, `c.env`,
    `c.req`, `c.body()`, and auto-wraps plain returned objects/primitives into
    `Response.json(...)`.
  - `api()`: Micro-router mapping HTTP method and path patterns (e.g.
    `"GET /items"`, `"POST /items"`) to minimal handler functions.
  - Re-export `handle` and `api` from `sdk/typescript/mod.ts`.
- `tests/unit/sdk_wrapper_test.ts` — Unit tests verifying automatic JSON
  serialization, error normalization, body parsing, and route resolution.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):

- Modifying underlying `RailFogContext` interface (`sdk/typescript/types.ts` —
  stable).
- CLI installation command (`cli/add.ts` — covered in `T-0811`).
- Runtime sandbox execution (`runtime/`).

## Interface to implement

```typescript
import type { FunctionHandler, RailFogContext } from "./types.ts";

export interface HandlerContext extends RailFogContext {
  req: Request;
  body<T = unknown>(): Promise<T>;
  json(data: unknown, status?: number): Response;
  text(str: string, status?: number): Response;
}

export type HandlerResult =
  | Response
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean
  | null
  | void;

export type HandlerFn = (
  c: HandlerContext,
) => Promise<HandlerResult> | HandlerResult;

export function handle(fn: HandlerFn): FunctionHandler;

export interface ApiRouteMap {
  [routePattern: string]: HandlerFn;
}

export function api(routes: ApiRouteMap): FunctionHandler;
```

## Acceptance criteria (Given/When/Then)

1. Given a function wrapped with
   `handle(async ({ kv }) => kv.get(["users", "1"]))`, when invoked, then the
   returned value is automatically serialized as an HTTP `Response` with
   `content-type: application/json` and status `200`.
2. Given a function wrapped with `handle()` that explicitly returns a Web API
   `Response`, then the custom `Response` is passed through verbatim without
   re-serialization.
3. Given a function wrapped with `handle()` where the handler throws an
   unhandled error, then the error is normalized and converted into canonical
   platform error format (`PLAT-12`).
4. Given an `api({ "GET /users": fn1, "POST /users": fn2 })` definition, when an
   incoming request matches a declared method and path, then the corresponding
   route handler is executed; when no route matches, a `404 NOT_FOUND` JSON
   response is returned.

## Tests required

- [x] Unit — `tests/unit/sdk_wrapper_test.ts`: Verify `handle` auto-JSON
      serialization, explicit `Response` passthrough, `c.body()` parsing, and
      `api()` route pattern matching.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`FN-1`, `FN-4`,
      `PLAT-19`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Assumptions made

- Plain object returns default to HTTP status 200; explicit status codes are set
  via `c.json(data, status)` or standard `Response`.

## Verification Evidence

### `deno check`

```
Check sdk/typescript/wrapper.ts
Check sdk/typescript/mod.ts
Check tests/unit/sdk_wrapper_test.ts
```

### `deno lint`

```
Checked 3 files
```

### `deno test`

```
Check tests/unit/sdk_wrapper_test.ts
running 35 tests from ./tests/unit/sdk_wrapper_test.ts
T-0810 / AC1 / FN-1: handle() auto-serializes returned plain object to JSON with status 200 and Content-Type application/json ... ok (16ms)
T-0810 / AC1 / FN-1: handle() auto-serializes nested objects and empty objects ... ok (758µs)
T-0810 / AC1 / FN-1: handle() auto-serializes returned arrays to JSON with status 200 ... ok (391µs)
T-0810 / AC1 / FN-1: handle() auto-serializes returned strings to JSON with status 200 ... ok (315µs)
T-0810 / AC1 / FN-1: handle() auto-serializes returned numbers (integers, zero, negative floats) to JSON ... ok (906µs)
T-0810 / AC1 / FN-1: handle() auto-serializes boolean values and null to JSON ... ok (407µs)
T-0810 / AC1 / FN-1: handle() supports async Promise-returning handlers ... ok (31ms)
T-0810 / AC1 / FN-1: handle() handles void / undefined returns gracefully ... ok (1ms)
T-0810 / AC2 / FN-1: handle() passes explicit Web API Response instances through verbatim without re-serialization ... ok (1ms)
T-0810 / AC2 / FN-1: handle() preserves Response created with Response.json() and custom status ... ok (401µs)
T-0810 / AC2 / FN-1: handle() passes empty 204 No Content Response through verbatim ... ok (301µs)
T-0810 / AC2 / FN-1: handle() passes binary octet-stream Response without JSON corruption ... ok (705µs)
T-0810 / FN-4: handle() provides destructured access to c.req ... ok (919µs)
T-0810 / FN-1: handle() provides c.body() to parse incoming JSON request body ... ok (985µs)
T-0810 / Interface: handle() provides c.json(data, status) helper ... ok (733µs)
T-0810 / Interface: handle() provides c.text(str, status) helper ... ok (371µs)
T-0810 / AC1 / FN-4: handle() provides destructured access to c.kv with auto-JSON response ... ok (497µs)
T-0810 / FN-4 / PLAT-6: handle() provides destructured access to c.objects, c.queues, c.env ... ok (790µs)
T-0810 / FN-4: handle() preserves RailFogContext metadata (requestId, project, function, revision, deadline, timeRemaining) ... ok (556µs)
T-0810 / AC3 / PLAT-12: handle() normalizes thrown RailFogError instances with mapped status codes ... ok (2ms)
T-0810 / AC3 / PLAT-12: handle() normalizes unhandled generic Error to status 500 and INTERNAL code ... ok (2ms)
T-0810 / AC3 / PLAT-12: handle() normalizes thrown non-Error primitives (string, number) to status 500 INTERNAL ... ok (697µs)
T-0810 / AC3 / PLAT-12: handle() preserves pre-assigned requestId on error if already present ... ok (577µs)
T-0810 / AC4 / FN-1: api() executes matching handler for GET and POST route patterns ... ok (5ms)
T-0810 / AC4 / PLAT-12: api() returns 404 NOT_FOUND canonical JSON error when no route matches path ... ok (3ms)
T-0810 / AC4 / PLAT-12: api() returns 404 when path matches but method does not match declared routes ... ok (1ms)
T-0810 / AC4 / PLAT-11: api() supports parameterized route paths (e.g. GET /items/:id) ... ok (3ms)
T-0810 / AC4: api() correctly matches routes when query strings or hash fragments are present ... ok (3ms)
T-0810 / AC4: api() route handlers inherit full handle() ergonomics (explicit Response, error normalization) ... ok (4ms)
T-0810 / AC4: api() with empty route map returns 404 for any incoming request ... ok (609µs)
T-0810 / AC4: api() handles HTTP methods case-insensitively in route keys ... ok (2ms)
PLAT-15 / Security: c.env does not leak undeclared secrets ... ok (538µs)
PLAT-15 / Security: c.env.require() throws on undeclared secrets and normalizes to PLAT-12 500 error ... ok (810µs)
PLAT-12 / Security: Normalization protects error response structure from arbitrary prototype pollution ... ok (669µs)
T-0810 / Types: HandlerContext, HandlerFn, HandlerResult, ApiRouteMap, and FunctionHandler contract typing ... ok (211µs)

ok | 35 passed | 0 failed (136ms)
```
