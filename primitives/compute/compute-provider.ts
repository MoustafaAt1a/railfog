/**
 * Compute and Isolation Provider Interfaces
 *
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-4 (Isolation, defense in depth)
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-16 (Provider abstraction)
 * Spec-anchor: docs/contracts/functions.contract.md FN-5 (Resource limits)
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-4 (Content addressing)
 * Spec-anchor: docs/adr/0001-isolation-provider-invocation-protocol.md ADR-0001
 */

/**
 * Resource limits enforced during function execution.
 * Spec-anchor: docs/contracts/functions.contract.md FN-5 (Resource limits)
 */
export interface Limits {
  cpuMs: number;
  timeoutMs: number;
  memoryMb: number;
  concurrency?: number;
}

/**
 * Deployment artifact representation containing bundle code and content-addressed hashes.
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-3, PLAT-4
 * Spec-anchor: docs/contracts/objects.contract.md OBJ-4 (Content addressing: id "sha256:...", integrity "sha256-...")
 */
export interface Artifact {
  id: string; // sha256:... (OBJ-4)
  integrity: string; // sha256-... (OBJ-4)
  entrypoint: string;
  code: Uint8Array | ReadableStream<Uint8Array>;
}

/**
 * Invocation request representation passed into compute and isolation providers.
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-4 (Isolation, defense in depth)
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-16 (Provider abstraction)
 * Spec-anchor: docs/adr/0001-isolation-provider-invocation-protocol.md ADR-0001
 */
export interface InvocationRequest {
  requestId: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

/**
 * Isolated execution result containing response metadata and measured consumption metrics.
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-4, PLAT-16
 * Spec-anchor: docs/contracts/functions.contract.md FN-5 (Execution metrics: cpuTimeMs, wallClockMs)
 */
export interface ExecutionResult {
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
  cpuTimeMs: number;
  wallClockMs: number;
}

/**
 * Compute provider abstraction interface.
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-16 (Provider abstraction)
 * Spec-anchor: docs/adr/0001-isolation-provider-invocation-protocol.md ADR-0001
 */
export interface ComputeProvider {
  run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult>;
  prewarm?(artifact: Artifact, limits?: Limits): Promise<void>;
}

/**
 * Isolation provider abstraction interface for sandboxed runtime execution.
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-4 (Isolation, defense in depth)
 * Spec-anchor: docs/contracts/platform.contract.md PLAT-16 (Provider abstraction)
 * Spec-anchor: docs/adr/0001-isolation-provider-invocation-protocol.md ADR-0001
 */
export interface IsolationProvider {
  run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult>;
  prewarm?(artifact: Artifact, limits?: Limits): Promise<void>;
}
