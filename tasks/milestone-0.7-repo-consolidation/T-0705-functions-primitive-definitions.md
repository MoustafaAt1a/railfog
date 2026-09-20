# T-0705 — Functions Primitive Definitions

Status: Complete
Milestone: 0.7 Repo Consolidation
Depends on: T-0701
Blocks: T-0707, T-0708, T-0709, T-0710

## Spec references

`FN-1`, `FN-2`, `FN-4`, `FN-8`, `PLAT-19`

## Scope

**In scope**:
- `primitives/functions/types.ts`: Unifying core primitive definitions for Functions:
  - `FunctionHandler`: Standard Web API request/response signature (`(request: Request, ctx: RailFogContext) => Promise<Response>`) per `FN-1`.
  - `TriggerDefinition`: Trigger specifications for HTTP, Queue, Schedule, and Webhook per `FN-2` (confirming no separate Worker/API/Cron service).
  - `RailFogContext`: The complete RailFog-specific injection surface per `FN-4` (`requestId`, `project`, `function`, `revision`, `deadline`, `timeRemaining()`, `kv`, `objects`, `queues`, `env`).
  - `FunctionLimits`: Standard resource limits with MVP defaults matching `FN-5`.
- `primitives/functions/mod.ts`: Barrel export for function primitive interfaces.
- Remove redundant placeholder `primitives/functions/.gitkeep`.

**Out of scope**:
- Customer isolate sandbox execution logic or IPC pipes (belongs in `runtime/`).
- Introducing a separate worker or daemon process for background triggers (banned per `FN-2`, `PLAT-2`).

## Interface to implement

```typescript
import type { KVBinding } from "@railfog/primitives/kv";
import type { ObjectBinding } from "@railfog/primitives/objects";
import type { QueueBinding } from "@railfog/primitives/queues";

export interface EnvBinding {
  get(key: string): string | undefined;
  has(key: string): boolean;
}

export interface RailFogContext {
  requestId: string; // ULID (PLAT-14)
  project: string;
  function: string;
  revision: string;
  deadline: number; // epoch ms; hard kill time (FN-4, FN-5)
  timeRemaining(): number; // ms left; size downstream AbortSignal.timeout() from this (FN-4)
  kv: KVBinding; // pre-scoped capability (PLAT-6, KV-1)
  objects: ObjectBinding; // pre-scoped capability (PLAT-6, OBJ-1)
  queues: QueueBinding; // pre-scoped capability (PLAT-6, Q-1)
  env: EnvBinding; // only secrets explicitly assigned to this Function (PLAT-15)
}

export type FunctionHandler = (
  request: Request,
  ctx: RailFogContext,
) => Promise<Response>;

export type TriggerType = "http" | "queue" | "schedule" | "webhook";

export interface HttpTriggerConfig {
  type: "http";
  route: string;
}

export interface QueueTriggerConfig {
  type: "queue";
  queueName: string;
  batchSize?: number;
}

export interface ScheduleTriggerConfig {
  type: "schedule";
  cron: string;
}

export interface WebhookTriggerConfig {
  type: "webhook";
  endpoint: string;
  secretName?: string;
}

export type TriggerDefinition =
  | HttpTriggerConfig
  | QueueTriggerConfig
  | ScheduleTriggerConfig
  | WebhookTriggerConfig;

export interface FunctionLimits {
  cpuMs: number;
  timeoutMs: number;
  memoryMb: number;
  concurrency: number;
}

export const DEFAULT_FUNCTION_LIMITS: Readonly<FunctionLimits> = {
  cpuMs: 200,
  timeoutMs: 30_000,
  memoryMb: 128,
  concurrency: 50,
};
```

## Acceptance criteria (Given/When/Then)

1. Given a customer function implementation conforming to `FunctionHandler`, when invoked with a standard `Request` and `RailFogContext`, then it returns a standard Web API `Response` (`FN-1`).
2. Given trigger configurations for HTTP, Queue, Schedule, and Webhook, when evaluated, then all trigger types map into `TriggerDefinition` targeting a unified Function without requiring separate runtime processes (`FN-2`).
3. Given an instantiated `RailFogContext`, when calling `timeRemaining()`, then it returns `Math.max(0, deadline - Date.now())` giving the remaining execution time before the hard deadline (`FN-4`).
4. Given `DEFAULT_FUNCTION_LIMITS`, when checked against `FN-5`, then `cpuMs` is 200, `timeoutMs` is 30,000, `memoryMb` is 128, and `concurrency` is 50.

## Tests required

- [x] Unit — `tests/unit/primitives_functions_test.ts`: Validate interface structures, `RailFogContext` timeRemaining computation, trigger definitions, and default limits constants.

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
