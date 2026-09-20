import { generateUlid } from "../../packages/core/id/ulid.ts";
import type {
  KVBinding,
  ObjectBinding,
  QueueBinding,
  ResolvedBindings,
} from "../../packages/policy/permission-resolver.ts";

/**
 * Default timeout in milliseconds for HTTP invocations per functions.contract.md FN-5.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface EnvBinding {
  get(key: string): string | undefined;
}

export interface LoadedFunctionMeta {
  project: string;
  function: string;
  revision: string;
  timeout_ms?: number;
  timeoutMs?: number;
}

export interface RailFogContext {
  requestId: string;
  project: string;
  function: string;
  revision: string;
  deadline: number;
  timeRemaining(): number;
  kv: KVBinding;
  objects: ObjectBinding;
  queues: QueueBinding;
  env: EnvBinding;
}

/**
 * Spec references:
 * - FN-4: RailFogContext structure
 * - FN-5: Resource limits (timeout_ms default 30,000ms)
 * - FN-6: Isolation & warm-reuse rule (Fresh context and bindings per invocation)
 */
export function buildContext(
  fn: LoadedFunctionMeta,
  bindings: ResolvedBindings,
  env?: EnvBinding,
): RailFogContext {
  const deadline = Date.now() +
    (fn.timeout_ms ?? fn.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  return {
    requestId: generateUlid(),
    project: fn.project,
    function: fn.function,
    revision: fn.revision,
    deadline,
    timeRemaining() {
      return Math.max(0, deadline - Date.now());
    },
    kv: bindings.kv ? { ...bindings.kv } : ({} as unknown as KVBinding),
    objects: bindings.objects
      ? { ...bindings.objects }
      : ({} as unknown as ObjectBinding),
    queues: bindings.queues
      ? { ...bindings.queues }
      : ({} as unknown as QueueBinding),
    env: env ?? {
      get(_key: string): string | undefined {
        return undefined;
      },
    },
  };
}
