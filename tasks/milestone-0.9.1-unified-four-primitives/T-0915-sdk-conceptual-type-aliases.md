# T-0915 — Export Canonical Conceptual Type Aliases in SDK

Status: Done
Milestone: 0.9.1 Unified Four-Primitives & SDK Specification
Depends on: T-0911
Blocks: T-0916, T-0917

## Spec references

`PLAT-19`, `FN-1`, `KV-2`, `OBJ-2`, `Q-2`, `CONCEPT-1`, `CONCEPT-2`

## Scope

**In scope**:
- Modify `sdk/typescript/types.ts` to export canonical conceptual type aliases:
  ```typescript
  export type StateBinding = KVBinding;
  export type DataBinding = ObjectBinding;
  export type SignalBinding = QueueBinding;
  export type ComputeHandler = FunctionHandler;
  ```
- Re-export the new aliases in `sdk/typescript/mod.ts`.
- Perform surgical anti-slop cleanup in `sdk/typescript/types.ts`:
  - Remove dead code alias `AtomicOperation = KVAtomicOperation` (ANTI-SLOP §Completeness).
  - Normalize `CookieOptions.sameSite` to `"Strict" | "Lax" | "None"`.
- Update `tests/unit/sdk_typescript_types_test.ts` to verify type assignments and exports.

**Out of scope**:
- Breaking changes to existing `KVBinding`, `ObjectBinding`, `QueueBinding`, or `FunctionHandler`.
- Modifying `wrapper.ts` runtime ergonomics (handled in T-0916).

## Interface to implement

```typescript
/**
 * Canonical developer concept alias for KVBinding (CONCEPT-2).
 * @spec contracts/concepts.contract.md#CONCEPT-2
 * @spec contracts/kv.contract.md#KV-2
 */
export type StateBinding = KVBinding;

/**
 * Canonical developer concept alias for ObjectBinding (CONCEPT-2).
 * @spec contracts/concepts.contract.md#CONCEPT-2
 * @spec contracts/objects.contract.md#OBJ-2
 */
export type DataBinding = ObjectBinding;

/**
 * Canonical developer concept alias for QueueBinding (CONCEPT-2).
 * @spec contracts/concepts.contract.md#CONCEPT-2
 * @spec contracts/queues.contract.md#Q-2
 */
export type SignalBinding = QueueBinding;

/**
 * Canonical developer concept alias for FunctionHandler (CONCEPT-2).
 * @spec contracts/concepts.contract.md#CONCEPT-2
 * @spec contracts/functions.contract.md#FN-1
 */
export type ComputeHandler = FunctionHandler;
```

## Acceptance criteria (Given/When/Then)

1. Given a TypeScript module importing `{ StateBinding, DataBinding, SignalBinding, ComputeHandler }` from `@railfog/sdk`, when type checking runs, then the types are completely assignable to and from `KVBinding`, `ObjectBinding`, `QueueBinding`, and `FunctionHandler`.
2. Given `@railfog/sdk`, when inspected for dead code, then `AtomicOperation` is absent and `KVAtomicOperation` is used consistently.
3. Given `deno check sdk/typescript/mod.ts`, when executed, then type checking succeeds with zero errors.

## Tests required

- [x] Unit — `tests/unit/sdk_typescript_types_test.ts` verifying all 4 conceptual type aliases and checking assignability.
- [x] Integration — none.
- [x] Security — none.

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

The aliases are pure compile-time type aliases and introduce zero runtime overhead or code size increase.
