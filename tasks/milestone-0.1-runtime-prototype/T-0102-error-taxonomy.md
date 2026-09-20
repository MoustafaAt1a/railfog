# T-0102 — Core error taxonomy

Status: Done
Milestone: 0.1 Runtime Prototype
Depends on: T-0101
Blocks: T-0104, T-0105, T-0106, T-0107, T-0108

## Spec references

`PLAT-12` (error model — exhaustive code table)

## Scope

**In scope:**
- `packages/errors/`: one typed error class per PLAT-12 code
  (`RESOURCE_NOT_FOUND`, `PERMISSION_DENIED`, `VALIDATION_FAILED`,
  `RATE_LIMITED`, `CALL_DEPTH_EXCEEDED`, `TIMEOUT`, `PAYLOAD_TOO_LARGE`,
  `CONFLICT`, `UNAVAILABLE`, `INTERNAL`), all extending one `RailFogError`
  base carrying `code`, `message`, and an optional `requestId`.
- A single serialization function producing the exact JSON error shape from
  PLAT-12 (`{"error": {"code", "message", "request_id"}}`).
- `deno.json` modifications to map imports and adjust test tasks per architect's ratification.

**Out of scope:**
- Wiring these into any HTTP handler (later tasks raise/catch them).
- `Retry-After` header logic (PLAT-9 — a rate-limiting task, not this one).

## Interface to implement

```typescript
abstract class RailFogError extends Error {
  abstract readonly code:
    | "RESOURCE_NOT_FOUND" | "PERMISSION_DENIED" | "VALIDATION_FAILED"
    | "RATE_LIMITED" | "CALL_DEPTH_EXCEEDED" | "TIMEOUT"
    | "PAYLOAD_TOO_LARGE" | "CONFLICT" | "UNAVAILABLE" | "INTERNAL";
  constructor(message: string, readonly requestId?: string);
}
function toErrorResponseBody(err: RailFogError): {
  error: { code: string; message: string; request_id?: string };
};
```

## Acceptance criteria

1. Given any of the ten error classes, when constructed and passed to
   `toErrorResponseBody`, then the output shape matches PLAT-12 exactly.
2. Given a code not in PLAT-12, when attempted, then it is a compile error
   (the union type has no room for it) — this is the enforcement mechanism,
   not a runtime check.

## Tests required

- [x] Unit — one test per error code round-tripping through serialization
- [ ] Integration — n/a this task
- [ ] Security — n/a this task

## Definition of Done

- [x] Exactly ten error classes, matching PLAT-12 one-to-one, no extras
- [x] `deno check` clean, output attached
- [x] `deno test packages/errors` green, output attached
- [x] No ad hoc thrown strings anywhere in this package (`docs/ANTI-SLOP.md`)

```
$ deno check **/*.ts
EXIT:0

$ deno test packages/errors
running 3 tests from ./packages/errors/mod_test.ts
RailFogError classes extend Error and RailFogError ... ok (1ms)
Error classes initialize and serialize correctly without requestId ... ok (941µs)
Error classes initialize and serialize correctly with requestId ... ok (252µs)

ok | 3 passed | 0 failed (14ms)
EXIT:0

$ deno task test
Task test deno test --allow-read --allow-write --allow-net
running 3 tests from ./packages/errors/mod_test.ts
RailFogError classes extend Error and RailFogError ... ok (871µs)
Error classes initialize and serialize correctly without requestId ... ok (794µs)
Error classes initialize and serialize correctly with requestId ... ok (195µs)

ok | 3 passed | 0 failed (11ms)
EXIT:0

$ deno lint
Checked 3 files
EXIT:0

$ deno fmt --check
Checked 4 files
EXIT:0
```

## Assumptions made

1. The `statusCode` getter was initially added as a convenience but subsequently removed per the architect's official ruling to strictly adhere to PLAT-12 and the declared interface.
2. Adding an `imports` block for `@std/assert` to `deno.json` was ratified by the architect to resolve `no-import-prefix` and `no-unversioned-import` lint rules, and `deno.json` import configuration was formally included in the task scope.
3. Unit tests for `packages/errors/` reside solely in `packages/errors/mod_test.ts` (colocated), and `deno.json`'s `test` task was updated to `"deno test --allow-read --allow-write --allow-net"` per the architect's ruling to discover package unit tests without proxy trampolines.

