// spec: contracts/functions.contract.md#FN-1 — Definition & handler signature
// spec: contracts/functions.contract.md#FN-2 — Unified triggers (no fifth primitive)
// spec: contracts/functions.contract.md#FN-4 — RailFogContext injection surface
// spec: contracts/functions.contract.md#FN-5 — Resource limits MVP defaults
// spec: contracts/platform.contract.md#PLAT-14 — ULID format for requestId
// spec: contracts/platform.contract.md#PLAT-15 — Capability-scoped environment secrets
// spec: contracts/platform.contract.md#PLAT-19 — Repository structure: primitives/functions
// spec: tasks/milestone-0.7-repo-consolidation/T-0705-functions-primitive-definitions.md

import type { KVBinding } from "../../sdk/typescript/types.ts";
import type { ObjectBinding } from "../../sdk/typescript/types.ts";
import type { QueueBinding } from "../../sdk/typescript/types.ts";

export type { KVBinding, ObjectBinding, QueueBinding };

/**
 * Environment secrets binding exposing capability-scoped secrets per PLAT-15.
 */
export interface EnvBinding {
  get(key: string): string | undefined;
  has(key: string): boolean;
}

/**
 * Complete RailFog invocation context per FN-4.
 */
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

/**
 * Standard Web API request/response function entrypoint signature per FN-1.
 */
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

/**
 * Unified trigger definition mapping all triggers to a Function per FN-2.
 */
export type TriggerDefinition =
  | HttpTriggerConfig
  | QueueTriggerConfig
  | ScheduleTriggerConfig
  | WebhookTriggerConfig;

/**
 * Resource limits per FN-5.
 */
export interface FunctionLimits {
  cpuMs: number;
  timeoutMs: number;
  memoryMb: number;
  concurrency: number;
}

/**
 * MVP default limits per FN-5 (hard kills, not warnings).
 */
export const DEFAULT_FUNCTION_LIMITS: Readonly<FunctionLimits> = Object.freeze({
  cpuMs: 200,
  timeoutMs: 30_000,
  memoryMb: 128,
  concurrency: 50,
});

/**
 * Computes remaining execution time in milliseconds before deadline per FN-4.
 */
export function calculateTimeRemaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}
