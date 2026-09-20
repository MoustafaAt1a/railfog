# T-0810 — Implement Minimalist SDK Helpers

Status: Not started
Milestone: 0.8 Developer Experience & UX Polish
Depends on: none
Blocks: T-0812

## Spec references

`FN-1`, `PLAT-6`, `PLAT-19`

## Scope

**In scope**:
- `sdk/typescript/minimal.ts` — Ultra-concise, ergonomic helpers for RailFog function handlers:
  - `handle()`: High-level wrapper function that accepts `(c: MinimalContext) => Promise<unknown> | unknown`, provides auto-destructured access to `c.kv`, `c.objects`, `c.queues`, `c.env`, `c.req`, `c.body()`, and auto-wraps plain returned objects/primitives into `Response.json(...)`.
  - `api()`: Micro-router mapping HTTP method and path patterns (e.g. `"GET /items"`, `"POST /items"`) to minimal handler functions.
  - Re-export `handle` and `api` from `sdk/typescript/mod.ts`.
- `tests/unit/sdk_minimal_test.ts` — Unit tests verifying automatic JSON serialization, error handling, body parsing, and route resolution.

**Out of scope** (binding — see `docs/ANTIHALLUCINATION.md` Rule 6):
- Modifying underlying `RailFogContext` interface (`sdk/typescript/types.ts` — stable).
- CLI installation command (`cli/add.ts` — covered in `T-0811`).
- Runtime sandbox execution (`runtime/`).

## Interface to implement

```typescript
import type { FunctionHandler, RailFogContext } from "./types.ts";

export interface MinimalContext extends RailFogContext {
  req: Request;
  body<T = unknown>(): Promise<T>;
  json(data: unknown, status?: number): Response;
  text(str: string, status?: number): Response;
}

export type MinimalHandlerResult = Response | Record<string, unknown> | unknown[] | string | number | boolean | null | void;

export type MinimalHandlerFn = (
  c: MinimalContext,
) => Promise<MinimalHandlerResult> | MinimalHandlerResult;

export function handle(fn: MinimalHandlerFn): FunctionHandler;

export interface ApiRouteMap {
  [routePattern: string]: MinimalHandlerFn;
}

export function api(routes: ApiRouteMap): FunctionHandler;
```

## Acceptance criteria (Given/When/Then)

1. Given a function wrapped with `handle(async ({ kv }) => kv.get(["users", "1"]))`, when invoked, then the returned value is automatically serialized as an HTTP `Response` with `content-type: application/json` and status `200`.
2. Given a function wrapped with `handle()` that explicitly returns a Web API `Response`, then the custom `Response` is passed through verbatim without re-serialization.
3. Given a function wrapped with `handle()` where the handler throws an unhandled error, then the error is normalized and converted into canonical platform error format (`PLAT-12`).
4. Given an `api({ "GET /users": fn1, "POST /users": fn2 })` definition, when an incoming request matches a declared method and path, then the corresponding route handler is executed; when no route matches, a `404 NOT_FOUND` JSON response is returned.

## Tests required

- [ ] Unit — `tests/unit/sdk_minimal_test.ts`: Verify `handle` auto-JSON serialization, explicit `Response` passthrough, `c.body()` parsing, and `api()` route pattern matching.

## Definition of Done

- [ ] Implementation matches every cited clause ID exactly (`FN-1`, `PLAT-6`, `PLAT-19`)
- [ ] Spec-anchor comments present at each RailFog-specific decision point
- [ ] Unit tests written first (red), then implementation (green)
- [ ] `deno check` run, real output attached, zero errors
- [ ] `deno test` run, real output attached, all required tests passing
- [ ] `deno lint` run, real output attached, zero warnings
- [ ] No item from `docs/ANTI-SLOP.md` violated
- [ ] Reviewer pass complete; security-auditor pass complete if triggered
- [ ] Nothing outside "In scope" touched

## Assumptions made

- Plain object returns default to HTTP status 200; explicit status codes are set via `c.json(data, status)` or standard `Response`.
