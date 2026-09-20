# T-0109 — Route matching and specificity scoring

Status: Done
Milestone: 0.1 Runtime Prototype
Depends on: T-0101
Blocks: T-0111

## Spec references

`PLAT-11`

## Scope

**In scope:**
- `runtime/router/route-matcher.ts`: given a list of `{ pattern, function }`
  routes (from `railfog.toml`) and an incoming request path, return the
  winning route using `URLPattern` for matching and PLAT-11's exact scoring
  formula for tie-breaking.
- Pure function — no dependency on the loader, providers, or context. This is
  a deliberately isolated, easily-unit-tested module (and a DOD-appropriate
  one per `docs/CONSTITUTION.md` — it runs on every request).

**Out of scope:**
- Actually invoking the matched Function (T-0111).
- HTTP server wiring (T-0111).

## Interface to implement

```typescript
interface RouteConfig { pattern: string; function: string; }
function matchRoute(routes: RouteConfig[], path: string): RouteConfig | null;
function specificityScore(pattern: string): number;  // PLAT-11 formula, exposed for direct unit testing
```

## Acceptance criteria

1. Given routes `/api/*` and `/api/users` both declared, when a request for
   `/api/users` arrives, then `/api/users` wins (score 4 vs 3, PLAT-11
   worked example).
2. Given two routes with equal specificity score, when matched, then the
   first-declared route wins (PLAT-11 tie-break rule) — test declaration
   order both ways to prove it's genuinely order-based, not incidental.
3. Given no route matches, when `matchRoute` is called, then it returns
   `null` (caller maps this to `RESOURCE_NOT_FOUND`, not this module's job).

## Tests required

- [x] Unit — the two worked examples above plus at least one three-way tie
- [ ] Integration — n/a (pure function)
- [ ] Security — n/a

## Definition of Done

- [x] `specificityScore` matches PLAT-11's formula exactly:
      `literal_segments × 2 + wildcard_or_named_segments × 1`
- [x] Implemented as plain functions over data (`RouteConfig[]`), no route
      object hierarchy or visitor pattern — this is the DOD side of the
      Boundary Rule (`docs/CONSTITUTION.md`), and it runs once per request
- [x] `deno check` / `deno test` / `deno lint` clean, real output attached

## Assumptions made

None — PLAT-11 fully specifies the algorithm.

## Verification Evidence

```
$ deno task check
Task check deno check **/*.ts
Check cli/main.ts
Check packages/core/crypto/content-address.ts
Check packages/core/crypto/content-address_test.ts
Check packages/core/id/ulid.ts
Check packages/core/id/ulid_test.ts
Check packages/errors/mod.ts
Check packages/errors/mod_test.ts
Check packages/policy/permission-resolver.ts
Check packages/policy/permission-resolver_test.ts
Check primitives/kv/kv-provider.ts
Check primitives/objects/object-provider.ts
Check primitives/queues/queue-provider.ts
Check providers/kv/sqlite-provider.ts
Check providers/kv/sqlite-provider_test.ts
Check providers/objects/local-fs-provider.ts
Check providers/objects/local-fs-provider_test.ts
Check providers/queues/sqlite-queue-provider.ts
Check providers/queues/sqlite-queue-provider_test.ts
Check runtime/loader/context-builder.ts
Check runtime/loader/function-loader.ts
Check runtime/loader/function-loader_test.ts
Check runtime/router/route-matcher.ts
Check runtime/router/route-matcher_test.ts
Check tests/fixtures/functions/invalid_no_export.ts
Check tests/fixtures/functions/invalid_null_export.ts
Check tests/fixtures/functions/invalid_object_export.ts
Check tests/fixtures/functions/invalid_wrong_type.ts
Check tests/fixtures/functions/valid_function.ts
Check tests/security/loader_security_test.ts

$ deno test runtime/router
Check runtime/router/route-matcher_test.ts
running 7 tests from ./runtime/router/route-matcher_test.ts
specificityScore - calculates PLAT-11 scores for standard patterns ... ok (720µs)
specificityScore - handles edge patterns and variations ... ok (113µs)
matchRoute - AC1: higher specificity score wins over lower score regardless of order ... ok (59ms)
matchRoute - AC2: equal score ties break by declaration order (two-way tie both directions) ... ok (1ms)
matchRoute - AC2: equal score ties break by declaration order (three-way tie all directions) ... ok (3ms)
matchRoute - AC3: returns null when no route matches ... ok (2ms)
matchRoute - handles query strings, hash fragments, and full URLs ... ok (5ms)

ok | 7 passed | 0 failed (95ms)

$ deno task test
Task test deno test --allow-read --allow-write --allow-net
ok | 66 passed | 0 failed (7s)

$ deno task lint
Task lint deno lint
Checked 29 files

$ deno fmt --check
Checked 30 files
```

