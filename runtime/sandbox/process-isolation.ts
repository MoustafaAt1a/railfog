/**
 * ProcessIsolation provider with restricted Deno subprocess and stdio IPC.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-4: Isolation, defense in depth (OS sandbox & subprocess boundary)
 * - docs/contracts/platform.contract.md#PLAT-5: Network policy (mandatory egress constraint, SSRF mitigation)
 * - docs/contracts/platform.contract.md#PLAT-12: Error model (TIMEOUT, INTERNAL, VALIDATION_FAILED)
 * - docs/contracts/functions.contract.md#FN-4: RailFogContext structure
 * - docs/contracts/functions.contract.md#FN-5: Resource limits (timeout_ms, cpu_ms, memory_mb)
 * - docs/contracts/functions.contract.md#FN-6: Isolation & warm-reuse rule (reuse ONLY within same Function + Revision)
 * - docs/adr/0001-isolation-provider-invocation-protocol.md: ADR-0001 (stdio JSON-RPC IPC)
 */

import { basename, fromFileUrl } from "@std/path";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import type {
  Artifact,
  ExecutionResult,
  InvocationRequest,
  IsolationProvider,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";
import {
  InternalError,
  RailFogError,
  type RailFogErrorCode,
  TimeoutError,
  toErrorResponseBody,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import type {
  WorkerErrorResponse,
  WorkerInvokeMessage,
  WorkerSuccessResponse,
} from "./process-worker.ts";

/**
 * Options for configuring ProcessIsolationProvider.
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-4, PLAT-5.
 */
export interface ProcessIsolationOptions {
  egressProxyPort?: number;
  denoExecutablePath?: string;
  maxIdleProcesses?: number;
  orgId?: string;
}

/**
 * Builds the strict security flags passed to Deno worker subprocesses.
 *
 * Spec references:
 * - PLAT-4: Enforce deny-read, deny-write, deny-run, deny-sys, deny-env, no-prompt
 * - PLAT-5: Restrict network to egress proxy port, or deny-net if omitted
 */
export function buildDenoArgs(options?: ProcessIsolationOptions): string[] {
  // spec: contracts/platform.contract.md#PLAT-4 — strict isolation flags
  const flags = [
    "--no-prompt",
    "--deny-read",
    "--deny-write",
    "--deny-run",
    "--deny-sys",
    "--deny-env",
  ];

  // spec: contracts/platform.contract.md#PLAT-5 — network policy: constrain to local proxy port or deny
  if (options?.egressProxyPort !== undefined) {
    flags.push(`--allow-net=127.0.0.1:${options.egressProxyPort}`);
  } else {
    flags.push("--deny-net");
  }

  return flags;
}

// spec: docs/contracts/platform.contract.md#PLAT-12 — HTTP status mapping for PLAT-12 error taxonomy
function statusFromErrorCode(code: RailFogErrorCode): number {
  switch (code) {
    case "RESOURCE_NOT_FOUND":
      return 404;
    case "PERMISSION_DENIED":
      return 403;
    case "VALIDATION_FAILED":
      return 400;
    case "RATE_LIMITED":
    case "CALL_DEPTH_EXCEEDED":
      return 429;
    case "TIMEOUT":
      return 504;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "CONFLICT":
      return 409;
    case "UNAVAILABLE":
      return 503;
    case "INTERNAL":
    default:
      return 500;
  }
}

/**
 * Performs case-insensitive header lookup.
 */
function getHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return v;
    }
  }
  return undefined;
}

/**
 * Extracts executable code bytes from Artifact.
 * Spec-anchor: docs/contracts/objects.contract.md#OBJ-4.
 */
async function getArtifactCodeBytes(artifact: Artifact): Promise<Uint8Array> {
  if (artifact.code instanceof Uint8Array) {
    return artifact.code;
  }

  if (
    artifact.code &&
    typeof (artifact.code as ReadableStream<Uint8Array>).getReader ===
      "function"
  ) {
    const reader = (artifact.code as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        totalLength += value.byteLength;
      }
    }

    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }

  return new Uint8Array(0);
}

/**
 * Reads NDJSON lines asynchronously from a ReadableStream.
 */
async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) yield trimmed;
      }
    }
    const remaining = buffer.trim();
    if (remaining) yield remaining;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Managed subprocess wrapper representing an isolated warm worker.
 * Spec-anchor: docs/contracts/functions.contract.md#FN-6.
 * Spec-anchor: docs/adr/0001-isolation-provider-invocation-protocol.md.
 */
class SubprocessInstance {
  readonly child: Deno.ChildProcess;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly lineReader: AsyncGenerator<string, void, unknown>;
  private _isKilled = false;
  private _hasExited = false;
  private queue: Promise<unknown> = Promise.resolve();
  lastUsed = Date.now();

  constructor(child: Deno.ChildProcess) {
    this.child = child;
    this.writer = child.stdin.getWriter();
    this.lineReader = readLines(child.stdout);

    // Track subprocess exit state
    child.status.then(() => {
      this._hasExited = true;
    }).catch(() => {
      this._hasExited = true;
    });

    // Drain stderr in the background so pipe buffer never deadlocks child
    (async () => {
      try {
        const errReader = child.stderr.getReader();
        while (true) {
          const { done } = await errReader.read();
          if (done) break;
        }
      } catch {
        // Child exited
      }
    })();
  }

  get isDead(): boolean {
    return this._isKilled || this._hasExited;
  }

  kill(): void {
    if (this._isKilled) return;
    this._isKilled = true;
    try {
      this.writer.close().catch(() => {});
    } catch {
      // Ignore
    }
    try {
      this.child.kill();
    } catch {
      // Ignore
    }
  }

  async execute(
    msg: WorkerInvokeMessage,
    timeoutMs: number,
  ): Promise<WorkerSuccessResponse | WorkerErrorResponse> {
    const run = async () => {
      this.lastUsed = Date.now();

      // Write invocation message to child stdin
      try {
        const line = JSON.stringify(msg) + "\n";
        const bytes = new TextEncoder().encode(line);
        await this.writer.write(bytes);
      } catch {
        this.kill();
        throw new InternalError("Failed to write to worker subprocess stdin");
      }

      // Race readLine with timeout enforcement (FN-5)
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"TIMEOUT">((resolve) => {
        timerId = setTimeout(() => resolve("TIMEOUT"), timeoutMs);
      });

      try {
        const readPromise = this.readLine();
        const raceResult = await Promise.race([readPromise, timeoutPromise]);

        if (raceResult === "TIMEOUT") {
          this.kill();
          throw new TimeoutError("Invocation deadline exceeded");
        }

        if (raceResult === null) {
          this.kill();
          throw new InternalError("Subprocess terminated unexpectedly");
        }

        const parsed = JSON.parse(raceResult) as
          | WorkerSuccessResponse
          | WorkerErrorResponse;

        if (parsed.id !== msg.id) {
          this.kill();
          throw new InternalError(
            `Mismatched IPC message ID: expected ${msg.id}, got ${parsed.id}`,
          );
        }

        return parsed;
      } catch (err) {
        if (err instanceof RailFogError) {
          throw err;
        }
        this.kill();
        throw new InternalError(
          `Subprocess execution error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        if (timerId !== undefined) {
          clearTimeout(timerId);
        }
      }
    };

    // Serialize operations on this worker instance
    const current = this.queue.catch(() => {}).then(run);
    this.queue = current.catch(() => {});
    return await current;
  }

  private async readLine(): Promise<string | null> {
    try {
      const result = await this.lineReader.next();
      if (result.done) return null;
      return result.value;
    } catch {
      return null;
    }
  }
}

/**
 * Process-isolated compute provider implementation.
 *
 * Executes customer code in dedicated, restricted Deno child processes
 * using stdio JSON-RPC IPC per PLAT-4 and ADR-0001.
 */
export class ProcessIsolationProvider implements IsolationProvider {
  private readonly options?: ProcessIsolationOptions;
  private readonly pool = new Map<string, SubprocessInstance>();

  constructor(options?: ProcessIsolationOptions) {
    this.options = options;
  }

  /**
   * Extracts function identification metadata from artifact and invocation.
   * Spec-anchor: docs/contracts/functions.contract.md#FN-6.
   */
  private extractMetadata(
    artifact: Artifact,
    invocation?: InvocationRequest,
  ): {
    orgId?: string;
    project: string;
    functionName: string;
    revision: string;
  } {
    const artObj = artifact as unknown as Record<string, unknown>;
    const headers = invocation?.headers;

    const orgId = (artObj.orgId as string) ??
      (artObj.org as string) ??
      getHeader(headers, "x-railfog-org") ??
      getHeader(headers, "x-railfog-org-id") ??
      this.options?.orgId;

    const project = (artObj.project as string) ??
      (artObj.projectName as string) ??
      getHeader(headers, "x-railfog-project") ??
      "default";

    const functionName = (artObj.function as string) ??
      (artObj.functionName as string) ??
      getHeader(headers, "x-railfog-function") ??
      (artifact.entrypoint
        ? basename(artifact.entrypoint).replace(/\.[^/.]+$/, "")
        : "default");

    const revision = (artObj.revision as string) ??
      (artObj.revisionId as string) ??
      getHeader(headers, "x-railfog-revision") ??
      artifact.id ??
      "latest";

    return { orgId, project, functionName, revision };
  }

  /**
   * Spawns a new worker subprocess with strict isolation flags.
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-4, PLAT-5.
   */
  private spawnSubprocess(): SubprocessInstance {
    const denoExe = this.options?.denoExecutablePath ?? Deno.execPath();
    const workerUrl = new URL("./process-worker.ts", import.meta.url);
    const workerPath = fromFileUrl(workerUrl);
    const denoArgs = ["run", ...buildDenoArgs(this.options), workerPath];

    const cmd = new Deno.Command(denoExe, {
      args: denoArgs,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });

    const child = cmd.spawn();
    return new SubprocessInstance(child);
  }

  /**
   * Evicts the oldest instance if pool reaches maxIdleProcesses capacity.
   */
  private evictIfFull(): void {
    if (
      this.options?.maxIdleProcesses !== undefined &&
      this.pool.size >= this.options.maxIdleProcesses
    ) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;

      for (const [key, inst] of this.pool.entries()) {
        if (inst.lastUsed < oldestTime) {
          oldestTime = inst.lastUsed;
          oldestKey = key;
        }
      }

      if (oldestKey) {
        const toEvict = this.pool.get(oldestKey);
        this.pool.delete(oldestKey);
        toEvict?.kill();
      }
    }
  }

  /**
   * Runs an isolated function invocation in a sandboxed Deno child process.
   *
   * Spec references:
   * - PLAT-4: Isolation defense in depth (process boundary)
   * - PLAT-5: Egress network restriction
   * - PLAT-12: Error taxonomy mapping
   * - FN-5: Limits enforcement (timeoutMs, cpuMs)
   * - FN-6: Warm-reuse rule (strictly for same {project, function, revision})
   * - ADR-0001: Stdio JSON-RPC IPC
   */
  async run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult> {
    // spec: contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED
    if (!artifact || typeof artifact !== "object") {
      throw new ValidationFailedError("Artifact must be a non-null object");
    }
    if (!limits || typeof limits !== "object") {
      throw new ValidationFailedError("Limits must be a non-null object");
    }

    const meta = this.extractMetadata(artifact, invocation);
    // spec: contracts/functions.contract.md#FN-6, PLAT-7 — warm reuse exclusively per {orgId, project, function, revision}
    const poolKey = JSON.stringify([
      meta.orgId ?? "",
      meta.project,
      meta.functionName,
      meta.revision,
    ]);

    let instance = this.pool.get(poolKey);
    if (instance && instance.isDead) {
      this.pool.delete(poolKey);
      instance = undefined;
    }

    if (!instance) {
      this.evictIfFull();
      instance = this.spawnSubprocess();
      this.pool.set(poolKey, instance);
    }

    const codeBytes = await getArtifactCodeBytes(artifact);
    const codeBase64 = encodeBase64(codeBytes);

    const invokeMsg: WorkerInvokeMessage = {
      type: "invoke",
      id: generateUlid(),
      codeBase64,
      invocation: {
        requestId: invocation?.requestId ?? generateUlid(),
        method: invocation?.method ?? "GET",
        url: invocation?.url ?? "https://example.com/api",
        headers: invocation?.headers ?? {},
        bodyBase64: (invocation?.body && invocation.body.byteLength > 0)
          ? encodeBase64(invocation.body)
          : undefined,
      },
      limits: {
        cpuMs: limits.cpuMs,
        timeoutMs: limits.timeoutMs,
        memoryMb: limits.memoryMb,
      },
      meta: {
        orgId: meta.orgId,
        project: meta.project,
        function: meta.functionName,
        revision: meta.revision,
      },
    };

    try {
      const res = await instance.execute(invokeMsg, limits.timeoutMs);

      if ("error" in res) {
        // spec: contracts/platform.contract.md#PLAT-12 — error model
        const err = res.error.code === "TIMEOUT"
          ? new TimeoutError(res.error.message)
          : new InternalError(res.error.message);
        return this.formatErrorResult(err);
      }

      const body = res.bodyBase64
        ? decodeBase64(res.bodyBase64)
        : new Uint8Array(0);

      return {
        statusCode: res.statusCode,
        headers: res.headers ?? {},
        body,
        cpuTimeMs: res.cpuTimeMs ?? 0,
        wallClockMs: res.wallClockMs ?? 0,
      };
    } catch (err) {
      if (err instanceof RailFogError) {
        return this.formatErrorResult(err);
      }
      const internalErr = new InternalError(
        err instanceof Error ? err.message : String(err),
      );
      return this.formatErrorResult(internalErr);
    }
  }

  /**
   * Shuts down all warm worker subprocesses and cleans up process handles.
   * Spec-anchor: tasks/T-0311.
   */
  async shutdown(): Promise<void> {
    const instances = Array.from(this.pool.values());
    this.pool.clear();

    await Promise.all(
      instances.map(async (inst) => {
        inst.kill();
        try {
          await inst.child.status;
        } catch {
          // Ignore
        }
      }),
    );
  }

  /**
   * Formats a RailFogError into an ExecutionResult per PLAT-12.
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-12.
   */
  private formatErrorResult(err: RailFogError): ExecutionResult {
    const status = statusFromErrorCode(err.code);
    const bodyObj = toErrorResponseBody(err);
    const bodyBytes = new TextEncoder().encode(JSON.stringify(bodyObj));

    return {
      statusCode: status,
      headers: {
        "content-type": "application/json",
      },
      body: bodyBytes,
      cpuTimeMs: 0,
      wallClockMs: 0,
    };
  }
}
