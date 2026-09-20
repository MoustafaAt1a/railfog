# T-0103 — ULID generator

Status: Done
Milestone: 0.1 Runtime Prototype
Depends on: T-0101
Blocks: T-0104, T-0105, T-0106, T-0108

## Spec references

`PLAT-14` (ULID algorithm)

## Scope

**In scope:**
- `packages/core/id/ulid.ts`: pure function generating a PLAT-14-compliant
  ULID (48-bit ms timestamp + 80-bit randomness, Crockford Base32, 26 chars).
- A `isValidUlid(s: string): boolean` guard.

**Out of scope:**
- Any use of ULIDs elsewhere (request IDs, revision IDs — those are later
  tasks that *consume* this module).

## Interface to implement

```typescript
function generateUlid(now?: () => number, random?: () => Uint8Array): string;
function isValidUlid(value: string): boolean;
```

(`now`/`random` are injected for deterministic unit testing — do not hardcode
`Date.now()`/`crypto.getRandomValues` inside the function body without an
injection seam, or the "sortable by creation time" property becomes
untestable.)

## Acceptance criteria

1. Given two calls one millisecond apart, when compared lexicographically,
   then the later ULID sorts after the earlier one.
2. Given a generated ULID, when checked, then it is exactly 26 characters of
   Crockford Base32 (no `I`, `L`, `O`, `U`).
3. Given a malformed string, when passed to `isValidUlid`, then it returns
   `false`.

## Tests required

- [x] Unit — sort order, length/alphabet, round-trip validity
- [ ] Integration — n/a
- [ ] Security — n/a

## Definition of Done

- [x] No dependency on UUIDv4 or any non-ULID library anywhere in this module
- [x] `deno check` / `deno test` / `deno lint` all clean, real output attached
- [x] Pure function — no I/O, no globals besides the injected seams

```
$ deno check **/*.ts
EXIT:0

$ deno test packages/core
running 5 tests from ./packages/core/id/ulid_test.ts
generateUlid - sorts lexicographically by time ... ok (682µs)
generateUlid - length and Crockford Base32 alphabet ... ok (743µs)
isValidUlid - valid ULID returns true ... ok (254µs)
isValidUlid - boundary and malformed cases ... ok (145µs)
generateUlid - default behavior uses real time and randomness ... ok (284µs)

ok | 5 passed | 0 failed (16ms)
EXIT:0

$ deno task test
Task test deno test --allow-read --allow-write --allow-net
running 5 tests from ./packages/core/id/ulid_test.ts
generateUlid - sorts lexicographically by time ... ok (878µs)
generateUlid - length and Crockford Base32 alphabet ... ok (685µs)
isValidUlid - valid ULID returns true ... ok (236µs)
isValidUlid - boundary and malformed cases ... ok (130µs)
generateUlid - default behavior uses real time and randomness ... ok (208µs)
running 3 tests from ./packages/errors/mod_test.ts
RailFogError classes extend Error and RailFogError ... ok (1ms)
Error classes initialize and serialize correctly without requestId ... ok (691µs)
Error classes initialize and serialize correctly with requestId ... ok (159µs)

ok | 8 passed | 0 failed (130ms)
EXIT:0

$ deno lint
Checked 5 files
EXIT:0

$ deno fmt --check
Checked 6 files
EXIT:0
```

## Assumptions made

- The timestamp provided by `now()` will not exceed 48 bits (valid until the year 10889), which safely fits into a 10-character Crockford Base32 string.

