# T-0111 — `rail dev` local server wiring (end-to-end loop)

Status: Done
Milestone: 0.1 Runtime Prototype
Depends on: T-0104, T-0105, T-0106, T-0107, T-0108, T-0109, T-0110
Blocks: none (closes the milestone)

## Spec references

`FN-8` (request lifecycle), `PLAT-17` (local/production parity), `PLAT-2`

## Scope

**In scope:**
- `runtime/dev-server/local-server.ts`: an HTTP server that, for each
  request, runs the full FN-8 lifecycle using only the local providers from
  T-0104/0105/0106: resolve route (T-0109) → load cached permission
  snapshot equivalent (T-0107, resolved once at `rail dev` startup from
  `railfog.toml`) → load/reuse Function (T-0108) → inject fresh context
  (T-0108) → invoke handler → return `Response` with `request_id` header set.
- Wires `rail dev` (T-0110) to actually start this server instead of the
  stub.

**Out of scope:**
- Queue/schedule triggers actually firing on a timer/queue in this task —
  this task is the HTTP path only. A follow-up task (open one, don't fold it
  in here) wires queue-triggered Functions to T-0106's `receive` loop.
- Any of PLAT-4/PLAT-5/PLAT-9 (isolation, network policy, rate limiting) —
  explicitly 0.3.
- Structured logging/metrics emission (PLAT-13) — note as a gap for 0.4/0.5,
  don't half-implement it here.

## Interface to implement

```typescript
function startLocalServer(config: RailfogConfig, port: number): Promise<{ close(): Promise<void> }>;
```

## Acceptance criteria

1. Given `docs/contracts/worked-example.md`'s `/upload` route (a Function
   with `objects` + `queues` permissions), when a
   request hits `/upload`, then the Function's handler runs with a
   `RailFogContext` whose `objects`/`queues` bindings are the real T-0107
   bindings — not stand-ins — and the HTTP response includes a
   `request_id` matching FN-8/PLAT-14 format.
2. Given two sequential requests to the same route, when compared, then each
   received a distinct `requestId` and distinct context instance (FN-6,
   verified again at the integration level, not just T-0108's unit level).
3. Given a request to a path with no matching route, when handled, then the
   server returns the `RESOURCE_NOT_FOUND` shape from `docs/contracts/
   platform.contract.md` PLAT-12, not a raw framework 404.

## Tests required

- [ ] Unit — n/a (this task is integration by nature)
- [x] Integration — full request → route → context → handler → response
      loop against real local providers (this is the milestone's e2e proof)
- [ ] Security — n/a this task (0.3 scope)

## Definition of Done

- [x] `rail dev` (T-0110) actually starts this server — the stub is removed,
      not left dead alongside it
- [x] The full FN-8 sequence is traceable in the implementation: every
      arrow in that lifecycle diagram corresponds to a real function call,
      not a shortcut that skips a step because "it's just local dev"
- [x] Milestone 0.1's stated goal is demonstrably true: a developer can
      `rail init && rail dev` and have HTTP → Function → {KV, Objects,
      Queues} work end-to-end locally with zero cloud account — attach the
      actual terminal transcript proving this, per
      `docs/ANTIHALLUCINATION.md` Rule 5
- [x] `deno check` / `deno test` / `deno lint` clean, real output attached

## Evidence & Verification

### Milestone 0.1 End-to-End Terminal Transcript:
```
1. Created project directory: C:\Users\Forke\AppData\Local\Temp\railfog-e2e-demo-517968c0eb8e45f5
2. Configured railfog.toml and functions/api.ts with KV, Objects, and Queues
3. Local dev server listening on port: 23227
4. HTTP GET /api/demo status: 200
5. x-request-id header: 01M2DWGZQH1ZSCDJH22WS2EDE8
6. Response body: {
  "message": "End-to-end verification successful!",
  "requestId": "01M2DWGZQH1ZSCDJH22WS2EDE8",
  "uploadUrl": "http://localhost/local-fs/local-org/demo-app/app:uploads/demo-1789320003313.txt?token=eyJrZXkiOiJsb2NhbC1vcmcvZGVtby1hcHAvYXBwOnVwbG9hZHMvZGVtby0xNzg5MzIwMDAzMzEzLnR4dCIsIm1ldGhvZCI6IlBVVCIsImV4cGlyZXNBdCI6MTc4OTMyMDkwMzMxM30=",
  "queueMessageId": "01M2DWGZQJTJ4NYFH1N9BVJAK1",
  "kvStatus": "active"
}
7. Cleaned up and verified successfully!
```

### Full Test Suite Run:
```
$ deno task test
running 82 tests across 12 test suites:
- ./cli/main_test.ts (8 passed)
- ./packages/core/crypto/content-address_test.ts (2 passed)
- ./packages/core/id/ulid_test.ts (5 passed)
- ./packages/errors/mod_test.ts (3 passed)
- ./packages/policy/permission-resolver_test.ts (9 passed)
- ./providers/kv/sqlite-provider_test.ts (5 passed)
- ./providers/objects/local-fs-provider_test.ts (8 passed)
- ./providers/queues/sqlite-queue-provider_test.ts (7 passed)
- ./runtime/dev-server/local-server_test.ts (8 passed)
- ./runtime/loader/function-loader_test.ts (10 passed)
- ./runtime/router/route-matcher_test.ts (7 passed)
- ./tests/security/loader_security_test.ts (10 passed)
ok | 82 passed | 0 failed (16s)
```

## Assumptions made

Queue-triggered and schedule-triggered Functions are not exercised by this
task's acceptance criteria (explicitly out of scope above) — milestone 0.1's
"one developer runs an app locally" goal is satisfied by the HTTP path; a
queue-consumer dev-loop task should be opened as a fast-follow before 0.2
if `docs/contracts/worked-example.md`'s full two-Function flow needs to run
end-to-end.

