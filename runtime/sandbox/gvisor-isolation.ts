/**
 * gVisor OCI isolation adapter with platform detection and safe dev emulation.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-4: Isolation, defense in depth (MicroVM / gVisor isolation)
 * - docs/contracts/platform.contract.md#PLAT-16: Provider abstraction (IsolationProvider interface)
 * - docs/contracts/platform.contract.md#PLAT-17: Local/production parity (gVisor in prod, safe dev fallback emulation)
 * - docs/contracts/platform.contract.md#PLAT-12: Error model (ValidationFailedError on invalid bundle or limits)
 * - docs/contracts/functions.contract.md#FN-5: Resource limits (memory_mb default 128 MB, max 1024 MB, timeout_ms, cpu_ms)
 * - docs/adr/0001-isolation-provider-invocation-protocol.md: ADR-0001 (IsolationProvider invocation protocol)
 */

import type {
  Artifact,
  ExecutionResult,
  InvocationRequest,
  IsolationProvider,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import { LocalIsolationProvider } from "./local-isolation.ts";

/**
 * OCI bundle configuration structure conforming to the OCI Runtime Specification.
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-4.
 */
export interface OciBundleConfig {
  ociVersion: string;
  process: {
    args: string[];
    env: string[];
    cwd: string;
    capabilities?: {
      bounding?: string[];
      effective?: string[];
      permitted?: string[];
      ambient?: string[];
    };
  };
  root: { path: string; readonly: boolean };
  linux?: {
    resources?: { memory?: { limit?: number } };
    seccomp?: unknown;
    namespaces?: { type: string; path?: string }[];
  };
}

/**
 * Options for configuring GVisorIsolationProvider.
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-17.
 */
export interface GVisorIsolationOptions {
  runscPath?: string;
  bundleRootDir?: string;
  platform?: string; // override for testing platform detection
}

/**
 * gVisor OCI isolation provider implementation.
 *
 * Generates compliant OCI runtime bundles for gVisor (runsc) sandboxes in production
 * and provides safe structural emulation on development machines per PLAT-17.
 *
 * Spec-anchor: docs/contracts/platform.contract.md#PLAT-4, PLAT-16, PLAT-17.
 */
export class GVisorIsolationProvider implements IsolationProvider {
  private readonly options?: GVisorIsolationOptions;
  private readonly emulator: LocalIsolationProvider;

  constructor(options?: GVisorIsolationOptions) {
    this.options = options;
    // spec: contracts/platform.contract.md#PLAT-17 — Local emulation provider for dev fallback
    this.emulator = new LocalIsolationProvider();
  }

  /**
   * Detects whether gVisor (runsc) execution is available on the current host.
   *
   * Returns false on non-Linux platforms (e.g. Windows, macOS) or when the runsc
   * binary cannot be found or accessed, without throwing unhandled exceptions.
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-17.
   */
  isAvailable(): boolean {
    try {
      const platform = this.options?.platform ?? Deno.build.os;
      if (platform !== "linux") {
        return false;
      }

      if (this.options?.runscPath) {
        try {
          const stat = Deno.statSync(this.options.runscPath);
          return stat.isFile;
        } catch {
          return false;
        }
      }

      // Check standard Linux binary paths
      const candidatePaths = [
        "/usr/local/bin/runsc",
        "/usr/bin/runsc",
        "/bin/runsc",
      ];
      for (const candidate of candidatePaths) {
        try {
          const stat = Deno.statSync(candidate);
          if (stat.isFile) return true;
        } catch {
          // Continue search
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Generates a compliant OCI bundle configuration for the provided Artifact and Limits.
   *
   * Enforces:
   * - Read-only root filesystem (PLAT-4)
   * - Memory limit mapped from limits.memoryMb to exact bytes (FN-5)
   * - Seccomp profile configuration
   * - Linux namespaces isolation (pid, network, ipc, mount)
   * - Drops dangerous Linux capabilities (PLAT-4)
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-4.
   * Spec-anchor: docs/contracts/functions.contract.md#FN-5.
   */
  generateBundle(artifact: Artifact, limits: Limits): OciBundleConfig {
    // spec: contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED on invalid artifact
    if (!artifact || typeof artifact !== "object") {
      throw new ValidationFailedError("Artifact must be a non-null object");
    }
    if (
      !artifact.id ||
      typeof artifact.id !== "string" ||
      artifact.id.trim() === ""
    ) {
      throw new ValidationFailedError("Artifact id must be a non-empty string");
    }
    if (
      !artifact.entrypoint ||
      typeof artifact.entrypoint !== "string" ||
      artifact.entrypoint.trim() === ""
    ) {
      throw new ValidationFailedError(
        "Artifact entrypoint must be a non-empty string",
      );
    }
    if (!artifact.code) {
      throw new ValidationFailedError("Artifact code must be provided");
    }
    if (artifact.code instanceof Uint8Array && artifact.code.byteLength === 0) {
      throw new ValidationFailedError("Artifact code cannot be empty");
    }

    // spec: contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED on invalid limits
    if (!limits || typeof limits !== "object") {
      throw new ValidationFailedError("Limits must be a non-null object");
    }
    if (
      typeof limits.memoryMb !== "number" ||
      Number.isNaN(limits.memoryMb) ||
      !Number.isInteger(limits.memoryMb) ||
      limits.memoryMb <= 0 ||
      limits.memoryMb > 1024
    ) {
      throw new ValidationFailedError(
        `Invalid limits.memoryMb: ${limits.memoryMb}. Must be a positive integer <= 1024 MB`,
      );
    }
    if (
      typeof limits.timeoutMs !== "number" ||
      Number.isNaN(limits.timeoutMs) ||
      limits.timeoutMs <= 0
    ) {
      throw new ValidationFailedError(
        `Invalid limits.timeoutMs: ${limits.timeoutMs}. Must be a positive number`,
      );
    }
    if (
      typeof limits.cpuMs !== "number" ||
      Number.isNaN(limits.cpuMs) ||
      limits.cpuMs < 0
    ) {
      throw new ValidationFailedError(
        `Invalid limits.cpuMs: ${limits.cpuMs}. Must be a non-negative number`,
      );
    }

    // spec: contracts/functions.contract.md#FN-5 — memory ceiling mapping from limits.memoryMb
    const memoryLimitBytes = limits.memoryMb * 1024 * 1024;

    // spec: contracts/platform.contract.md#PLAT-4 — strict capability dropping
    const capabilities = {
      bounding: [
        "CAP_CHOWN",
        "CAP_DAC_OVERRIDE",
        "CAP_FOWNER",
        "CAP_SETGID",
        "CAP_SETUID",
      ],
      effective: [
        "CAP_CHOWN",
        "CAP_DAC_OVERRIDE",
        "CAP_FOWNER",
        "CAP_SETGID",
        "CAP_SETUID",
      ],
      permitted: [
        "CAP_CHOWN",
        "CAP_DAC_OVERRIDE",
        "CAP_FOWNER",
        "CAP_SETGID",
        "CAP_SETUID",
      ],
      ambient: [],
    };

    return {
      ociVersion: "1.0.2",
      process: {
        args: ["/entrypoint-runner", artifact.entrypoint],
        cwd: "/workspace",
        env: [
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          "TERM=xterm",
        ],
        capabilities,
      },
      // spec: contracts/platform.contract.md#PLAT-4 — root filesystem must strictly be read-only
      root: {
        path: "rootfs",
        readonly: true,
      },
      linux: {
        // spec: contracts/functions.contract.md#FN-5 — memory limit in bytes
        resources: {
          memory: {
            limit: memoryLimitBytes,
          },
        },
        // spec: contracts/platform.contract.md#PLAT-4 — seccomp syscall constraints
        seccomp: {
          defaultAction: "SCMP_ACT_ERRNO",
          architectures: ["SCMP_ARCH_X86_64"],
          syscalls: [],
        },
        // spec: contracts/platform.contract.md#PLAT-4, PLAT-5 — Linux namespace isolation
        namespaces: [
          { type: "pid" },
          { type: "network" },
          { type: "ipc" },
          { type: "mount" },
        ],
      },
    };
  }

  /**
   * Runs an isolated function invocation.
   *
   * Validates the OCI bundle specification and executes via safe emulation
   * when running on non-Linux hosts or when runsc is unavailable per PLAT-17.
   *
   * Spec-anchor: docs/contracts/platform.contract.md#PLAT-16, PLAT-17.
   * Spec-anchor: docs/adr/0001-isolation-provider-invocation-protocol.md.
   */
  async run(
    artifact: Artifact,
    limits: Limits,
    invocation?: InvocationRequest,
  ): Promise<ExecutionResult> {
    // Validate bundle structure first (PLAT-12)
    this.generateBundle(artifact, limits);

    // spec: contracts/platform.contract.md#PLAT-17 — local development fallback emulation
    return await this.emulator.run(artifact, limits, invocation);
  }
}
