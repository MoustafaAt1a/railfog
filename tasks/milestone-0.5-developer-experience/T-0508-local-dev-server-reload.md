# T-0508 — Local Dev Server File Watcher and Developer Ergonomics

Status: Done
Milestone: 0.5 Developer Experience
Depends on: T-0111, T-0504
Blocks: T-0511

## Spec references

`PLAT-17`, `PLAT-19`, `FN-1`, `FN-8`

## Scope

**In scope**:
- `runtime/dev-server/watcher.ts`: Implement debounced file system watcher using `Deno.watchFs` monitoring `railfog.toml` and the functions directory (`functions/**/*.ts`).
- `runtime/dev-server/local-server.ts`: Update local development server to:
  1. Hot-reload function modules and route configurations upon file change without restarting the HTTP listener or terminating long-lived connections.
  2. Emit an informative startup banner showing loaded routes, specificity scores (`PLAT-11`), active local providers (SQLite, FS per `PLAT-17`), and listening address.
  3. Format incoming request/response lines with ULID `request_id` (`PLAT-14`), HTTP method, path, response status, and duration in ms.
  4. Return structured error responses (`PLAT-12`) with actionable stack traces during local dev when unhandled exceptions occur.
- Integration with `cli/main.ts dev` with `--port` (default 8000), `--host`, and `--no-watch` flags.
- `runtime/dev-server/watcher_test.ts`: Unit tests for file event debouncing and reload triggers.

**Out of scope**:
- Browser DOM live-reload or websocket HMR scripts injected into HTML (RailFog is a backend compute runtime, not a frontend bundler).
- Production isolate execution (handled by `ProcessIsolation` / `GVisorIsolation`).

## Interface to implement

```typescript
// runtime/dev-server/watcher.ts

export interface WatchOptions {
  paths: string[];
  debounceMs?: number; // Default: 100 ms
  signal?: AbortSignal;
}

export interface WatcherCallback {
  (events: Array<{ path: string; kind: "create" | "modify" | "delete" }>): Promise<void> | void;
}

export class ProjectWatcher {
  constructor(options: WatchOptions);
  start(callback: WatcherCallback): Promise<void>;
  stop(): void;
}
```

## Acceptance criteria (Given/When/Then)

1. Given a running `rail dev` server, when an existing function file under `functions/` is modified, then the watcher detects the change, invalidates the cached isolate, reloads the handler, and logs `"Reloaded functions/api.ts"` within 200 ms.
2. Given `rail dev` started on an application, when the HTTP server binds, then stdout displays the server banner with port, routes, and local provider indicators (`PLAT-17`).
3. Given a customer Function throwing an unhandled Error during execution, when invoked via HTTP, then the server logs the error, generates a ULID `request_id`, and returns HTTP 500 JSON with error code `INTERNAL` (`PLAT-12`).
4. Given multiple rapid file write events (e.g. IDE format on save), when debounced, then the watcher triggers reload exactly once rather than thrashing.
5. Given `rail dev --no-watch`, when started, then file watching is disabled.

## Tests required

- [x] Unit — `runtime/dev-server/watcher_test.ts`: Test file modification detection, event debouncing, and shutdown signal handling.
- [x] Integration — Test that modifying a handler file causes subsequent HTTP requests to execute the updated handler logic.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-17`, `PLAT-19`, `FN-1`, `FN-8`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

## Verification Evidence

```shell
$ deno check runtime/dev-server/watcher.ts runtime/dev-server/local-server.ts runtime/dev-server/watcher_test.ts cli/main.ts
(clean output, exit code 0)

$ deno test -A runtime/dev-server/watcher_test.ts
running 12 tests from ./runtime/dev-server/watcher_test.ts
ProjectWatcher: debounces rapid consecutive file write events to fire callback once after debounceMs (AC4) ... ok (423ms)
ProjectWatcher: detects file modification and passes event array with path and kind 'modify' ... ok (343ms)
ProjectWatcher: detects file creation and passes event array with path and kind 'create' ... ok (330ms)
ProjectWatcher: detects file deletion and passes event array with path and kind 'delete' ... ok (327ms)
ProjectWatcher: handles clean shutdown via watcher.stop() and stops emitting events ... ok (446ms)
ProjectWatcher: handles shutdown via AbortSignal passed in WatchOptions ... ok (456ms)
ProjectWatcher: watches both files and directories simultaneously (e.g. railfog.toml and functions/) ... ok (453ms)
Developer ergonomics: startup banner displays listening address, routes with specificity scores (PLAT-11), and local providers (PLAT-17) ... ok (491µs)
Developer ergonomics: request line formatter emits ULID request_id (PLAT-14), HTTP method, pathname, status, and duration_ms ... ok (151µs)
Developer ergonomics: unhandled error in dev mode returns HTTP 500 JSON with code 'INTERNAL', ULID request_id in body and header, and actionable stack trace (PLAT-12, PLAT-14, AC3) ... ok (441ms)
Hot-reload integration: modifying a function handler reloads logic for subsequent HTTP requests without dropping HTTP listener (AC1, FN-1, FN-8) ... ok (653ms)
--no-watch behavior: disabling watcher prevents automatic handler reloading on file modifications (AC5) ... ok (647ms)

ok | 12 passed | 0 failed (4s)

$ deno test -A runtime/dev-server/local-server_test.ts
running 8 tests from ./runtime/dev-server/local-server_test.ts
AC1: POST /upload runs handler with real objects/queues bindings and returns uploadUrl, queue messageId, and valid ULID request_id ... ok (382ms)
AC2 (FN-6): two sequential requests to the same route receive distinct requestIds and separate context instances ... ok (330ms)
AC3 (PLAT-12): request to unmatched path returns HTTP 404 with RESOURCE_NOT_FOUND error shape and matching request_id ... ok (317ms)
Lifecycle: server.close() shuts down server and refuses subsequent connections ... ok (2s)
Error handling: handler throwing RailFogError returns mapped status and PLAT-12 body with request_id ... ok (337ms)
Error handling: handler throwing unexpected Error returns 500 INTERNAL and PLAT-12 body with request_id ... ok (339ms)
Error handling: route targeting undeclared function returns 404 RESOURCE_NOT_FOUND ... ok (310ms)
Error handling: missing function entry file returns 400 VALIDATION_FAILED with PLAT-12 body ... ok (320ms)

ok | 8 passed | 0 failed (5s)

$ deno lint runtime/dev-server/ cli/
Checked 20 files
(clean output, exit code 0)
```

## Assumptions made

None.
