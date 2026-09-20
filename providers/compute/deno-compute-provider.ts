// spec: contracts/platform.contract.md#PLAT-4 — Isolation, defense in depth
// spec: contracts/platform.contract.md#PLAT-16 — Provider abstraction
// spec: docs/adr/0001-isolation-provider-invocation-protocol.md#ADR-0001
// spec: tasks/milestone-0.7-repo-consolidation/T-0706-deno-compute-provider-adapter.md

import type {
  Artifact,
  ComputeProvider,
  ExecutionResult,
  InvocationRequest,
  IsolationProvider,
  Limits,
} from "../../primitives/compute/compute-provider.ts";

export interface DenoComputeProviderOptions {
  isolationProvider: IsolationProvider;
}

/**
 * ComputeProvider adapter for executing customer function artifacts within sandboxed isolation boundaries.
 *
 * Wraps an IsolationProvider (LocalIsolation, ProcessIsolation, or GVisorIsolation) per PLAT-4 and PLAT-16,
 * delegating live execution and synthesizing default InvocationRequests when omitted per ADR-0001.
 */
export class DenoComputeProvider implements ComputeProvider {
  readonly #isolationProvider: IsolationProvider;

  constructor(options: DenoComputeProviderOptions) {
    if (!options || !options.isolationProvider) {
      throw new Error(
        "DenoComputeProvider requires a valid isolationProvider option",
      );
    }
    this.#isolationProvider = options.isolationProvider;
  }

  get isolation(): IsolationProvider {
    return this.#isolationProvider;
  }

  async run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult> {
    const effectiveInvocation: InvocationRequest = invocation ?? {
      requestId: "00000000000000000000000000",
      method: "GET",
      url: "http://localhost/",
      headers: {},
    };

    return await this.#isolationProvider.run(
      artifact,
      limits,
      effectiveInvocation,
    );
  }
}
