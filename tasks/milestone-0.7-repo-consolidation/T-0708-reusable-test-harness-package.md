# T-0708 — Reusable Test Harness Package

Status: Complete
Milestone: 0.7 Repo Consolidation
Depends on: T-0701, T-0702, T-0703, T-0704, T-0705, T-0706, T-0707
Blocks: T-0709, T-0710

## Spec references

`PLAT-16`, `PLAT-17`, `PLAT-19`

## Scope

**In scope**:
- `packages/testing/mocks.ts`: Standardized in-memory mock providers implementing all platform provider interfaces (`PLAT-16`, `PLAT-17`):
  - `createMockKVProvider(initial?: Map<string, unknown>): KVProvider`
  - `createMockObjectProvider(initial?: Map<string, Uint8Array>): ObjectProvider`
  - `createMockQueueProvider(): QueueProvider`
  - `createMockComputeProvider(handler?: (artifact: Artifact, limits: Limits, req?: InvocationRequest) => Promise<ExecutionResult>): ComputeProvider`
- `packages/testing/fixtures.ts`: Deterministic fixture and mock context constructors:
  - `createTestContext(overrides?: Partial<RailFogContext>): RailFogContext`
  - `createTestArtifact(overrides?: Partial<Artifact>): Artifact`
  - `createTestLimits(overrides?: Partial<Limits>): Limits`
- `packages/testing/mod.ts`: Barrel export for all mock factories and fixture builders.
- Remove redundant placeholder `packages/testing/.gitkeep`.

**Out of scope**:
- Production provider implementations (belong in `providers/`).
- Modifying test assertions in existing test files.

## Interface to implement

```typescript
import type { KVProvider } from "../../primitives/kv/kv-provider.ts";
import type { ObjectProvider } from "../../primitives/objects/object-provider.ts";
import type { QueueProvider } from "../../primitives/queues/queue-provider.ts";
import type {
  Artifact,
  ComputeProvider,
  ExecutionResult,
  InvocationRequest,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import type { RailFogContext } from "../../primitives/functions/types.ts";

export function createMockKVProvider(
  initial?: Map<string, unknown>,
): KVProvider & { storage: Map<string, unknown> };

export function createMockObjectProvider(
  initial?: Map<string, Uint8Array>,
): ObjectProvider & { objects: Map<string, Uint8Array> };

export function createMockQueueProvider(): QueueProvider & {
  messages: Array<{ id: string; body: unknown }>;
};

export function createMockComputeProvider(
  handler?: (
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ) => Promise<ExecutionResult>,
): ComputeProvider & { calls: Array<{ artifact: Artifact; limits: Limits; invocation?: InvocationRequest }> };

export function createTestContext(
  overrides?: Partial<RailFogContext>,
): RailFogContext;

export function createTestArtifact(
  overrides?: Partial<Artifact>,
): Artifact;

export function createTestLimits(
  overrides?: Partial<Limits>,
): Limits;
```

## Acceptance criteria (Given/When/Then)

1. Given in-memory mock providers created via `packages/testing/mocks.ts`, when utilized in unit and integration tests, then they strictly adhere to the contracts defined in `PLAT-16` without external dependencies.
2. Given `createTestContext`, when invoked without arguments, then it returns a fully initialized `RailFogContext` with mocked bindings and an active `timeRemaining()` calculation.
3. Given mock storage operations (KV get/set, Object put/get, Queue send/receive), when executed, then state changes remain isolated to the respective mock instance.

## Tests required

- [x] Unit — `tests/unit/packages_testing_test.ts`: Validate contract adherence of all mock providers (`KVProvider`, `ObjectProvider`, `QueueProvider`, `ComputeProvider`), state isolation, and fixture builder outputs.

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

None.
