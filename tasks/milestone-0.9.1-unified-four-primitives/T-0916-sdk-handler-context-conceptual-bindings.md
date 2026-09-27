# T-0916 — Expose Conceptual Bindings on SDK Handler Context

Status: Done
Milestone: 0.9.1 Unified Four-Primitives & SDK Specification
Depends on: T-0911, T-0915
Blocks: T-0917

## Spec references

`FN-4`, `CONCEPT-2`, `CONCEPT-6`

## Scope

**In scope**:
- Modify `sdk/typescript/wrapper.ts`:
  - Extend `HandlerContext` interface with conceptual properties:
    - `state: StateBinding;` (getter alias to `kv`)
    - `data: DataBinding;` (getter alias to `objects`)
    - `signal: SignalBinding;` (getter alias to `queues`)
  - Ensure `c.req.signal` (standard WHATWG `AbortSignal` for request cancellation) remains untouched and clearly distinguished from `c.signal` (`SignalBinding`).
  - Wire getters into the context object returned in `handle()` and `api()` runners.
- Update `tests/unit/sdk_wrapper_test.ts` to test handler ergonomics using `c.state`, `c.data`, and `c.signal`.

**Out of scope**:
- Modifying `RailFogContext` in `primitives/functions/types.ts` (the low-level runtime injected context retains `kv`, `objects`, `queues` for compatibility).
- Altering the routing or middleware execution engine.

## Interface to implement

```typescript
export interface HandlerContext extends RailFogContext {
  // Existing fields...
  kv: KVBinding;
  objects: ObjectBinding;
  queues: QueueBinding;

  /**
   * Conceptual alias for kv (CONCEPT-2).
   * @spec contracts/concepts.contract.md#CONCEPT-2
   */
  readonly state: StateBinding;

  /**
   * Conceptual alias for objects (CONCEPT-2).
   * @spec contracts/concepts.contract.md#CONCEPT-2
   */
  readonly data: DataBinding;

  /**
   * Conceptual alias for queues (CONCEPT-2).
   * Note: This is asynchronous messaging. For request cancellation, use req.signal.
   * @spec contracts/concepts.contract.md#CONCEPT-2
   */
  readonly signal: SignalBinding;
}
```

## Acceptance criteria (Given/When/Then)

1. Given a handler `handle(async ({ state, data, signal }) => { ... })`, when invoked, then `state.get` interacts identically with `kv.get`, `data.put` interacts with `objects.put`, and `signal.send` interacts with `queues.send`.
2. Given a handler accessing `req.signal`, when checked, then `req.signal` is an instance of `AbortSignal` for request cancellation and is not affected by `c.signal`.
3. Given an existing handler using `({ kv, objects, queues })`, when invoked, then it behaves identically with zero regression.

## Tests required

- [x] Unit — `tests/unit/sdk_wrapper_test.ts` asserting that `c.state === c.kv`, `c.data === c.objects`, and `c.signal === c.queues`, and verifying `req.signal` is an `AbortSignal`.
- [ ] Integration — none.
- [x] Security — Adversarial check ensuring request cancellation via `req.signal` (`AbortSignal`) is completely decoupled and not shadowed, intercepted, or corrupted by `c.signal` (`SignalBinding`) during concurrent or long-running executions (FN-5).

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Assumptions made

Getters on `HandlerContext` are zero-cost references pointing to the existing pre-scoped bindings.
