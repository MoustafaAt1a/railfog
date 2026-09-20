/**
 * Tests for gVisor OCI isolation adapter with platform detection.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-4: Isolation, defense in depth (MicroVM / gVisor isolation)
 * - docs/contracts/platform.contract.md#PLAT-16: Provider abstraction (IsolationProvider interface)
 * - docs/contracts/platform.contract.md#PLAT-17: Local/production parity (gVisor in prod, safe dev fallback emulation)
 * - docs/contracts/platform.contract.md#PLAT-12: Error model (ValidationFailedError on invalid bundle or limits)
 * - docs/contracts/functions.contract.md#FN-5: Resource limits (default 128 MB memory limit, max 1024 MB, timeout_ms, cpu_ms)
 * - docs/adr/0001-isolation-provider-invocation-protocol.md: ADR-0001 (IsolationProvider invocation protocol)
 * - tasks/milestone-0.3-security/T-0312-gvisor-isolation-adapter.md: Acceptance criteria AC1 - AC3
 * - .agents/skills/security-adversarial-review/SKILL.md: Adversarial review checklist
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertInstanceOf,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import type {
  Artifact,
  ExecutionResult,
  InvocationRequest,
  Limits,
} from "../../primitives/compute/compute-provider.ts";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import { generateUlid } from "../../packages/core/id/ulid.ts";

import {
  type GVisorIsolationOptions,
  GVisorIsolationProvider,
  type OciBundleConfig,
} from "../../runtime/sandbox/gvisor-isolation.ts";

// ============================================================================
// Spec-anchored Constants
// ============================================================================

// spec: contracts/functions.contract.md#FN-5 — Default memory ceiling: 128 MB (max 1024 MB)
const DEFAULT_MEMORY_MB = 128;
const DEFAULT_MEMORY_BYTES = DEFAULT_MEMORY_MB * 1024 * 1024; // 134,217,728 bytes

const CUSTOM_MEMORY_MB = 256;
const CUSTOM_MEMORY_BYTES = CUSTOM_MEMORY_MB * 1024 * 1024; // 268,435,456 bytes

// spec: contracts/functions.contract.md#FN-5 — timeout_ms: 30,000 (HTTP)
const DEFAULT_TIMEOUT_MS = 30_000;

// spec: contracts/functions.contract.md#FN-5 — cpu_ms: 200
const DEFAULT_CPU_MS = 200;

const DEFAULT_LIMITS: Limits = {
  cpuMs: DEFAULT_CPU_MS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  memoryMb: DEFAULT_MEMORY_MB,
};

// ============================================================================
// Fixture Helpers
// ============================================================================

function createTestArtifact(params?: {
  entrypoint?: string;
  code?: string | Uint8Array;
  id?: string;
  integrity?: string;
}): Artifact {
  const codeBytes = typeof params?.code === "string"
    ? new TextEncoder().encode(params.code)
    : (params?.code ?? new Uint8Array([1, 2, 3]));

  return {
    id: params?.id ?? "sha256:gvisor-test-0123456789abcdef0123456789abcdef",
    integrity: params?.integrity ??
      "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    entrypoint: params?.entrypoint ?? "index.ts",
    code: codeBytes,
  };
}

function createTestInvocation(params?: {
  requestId?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}): InvocationRequest {
  return {
    requestId: params?.requestId ?? generateUlid(),
    method: params?.method ?? "GET",
    url: params?.url ?? "https://example.com/api",
    headers: params?.headers ?? {},
    body: params?.body ?? new Uint8Array(0),
  };
}

// ============================================================================
// AC1: OCI Bundle Generation (PLAT-4, PLAT-16, FN-5)
// ============================================================================

Deno.test("AC1 (Unit): generateBundle produces valid OCI specification with readonly rootfs and default 128 MB memory limit", () => {
  // spec: contracts/platform.contract.md#PLAT-4 — MicroVM / gVisor OCI isolation
  // spec: contracts/functions.contract.md#FN-5 — memory_mb default 128 MB (134217728 bytes)
  // AC1: Given an Artifact and Limits with memoryMb: 128, when generateBundle is called,
  // then the generated OCI bundle specifies a read-only root filesystem, memory limit of 134217728 bytes, and seccomp constraints.
  const provider = new GVisorIsolationProvider();
  const artifact = createTestArtifact();

  const bundle: OciBundleConfig = provider.generateBundle(
    artifact,
    DEFAULT_LIMITS,
  );

  // OCI Version compliance
  assert(
    typeof bundle.ociVersion === "string" && bundle.ociVersion.length > 0,
    "OCI version must be defined",
  );

  // Read-only root filesystem enforcement
  assert(bundle.root !== undefined, "root configuration must be present");
  assertEquals(
    bundle.root.readonly,
    true,
    "root filesystem must strictly be read-only (PLAT-4)",
  );
  assertEquals(typeof bundle.root.path, "string");
  assert(bundle.root.path.length > 0, "root path must be a non-empty string");

  // Memory ceiling byte calculation (128 MB -> 134,217,728 bytes)
  assert(
    bundle.linux?.resources?.memory !== undefined,
    "linux.resources.memory must be present",
  );
  assertEquals(bundle.linux.resources.memory.limit, DEFAULT_MEMORY_BYTES);

  // Seccomp syscall filtering constraints
  assert(
    bundle.linux?.seccomp !== undefined,
    "seccomp syscall filtering profile must be configured",
  );

  // Linux namespaces: pid, network, ipc, mount
  assert(
    Array.isArray(bundle.linux?.namespaces),
    "namespaces array must be present",
  );
  const namespaceTypes = bundle.linux.namespaces.map((ns: { type: string }) =>
    ns.type
  );
  assert(namespaceTypes.includes("pid"), "pid namespace must be isolated");
  assert(
    namespaceTypes.includes("network"),
    "network namespace must be isolated (PLAT-5)",
  );
  assert(namespaceTypes.includes("ipc"), "ipc namespace must be isolated");
  assert(namespaceTypes.includes("mount"), "mount namespace must be isolated");

  // Process configuration
  assert(Array.isArray(bundle.process.args), "process.args must be an array");
  assert(
    bundle.process.args.length > 0,
    "process.args must contain entrypoint execution command",
  );
  assertEquals(typeof bundle.process.cwd, "string");
  assert(Array.isArray(bundle.process.env), "process.env must be an array");
});

Deno.test("AC1 (Unit): generateBundle scales memory limit bytes with custom limits.memoryMb", () => {
  // spec: contracts/functions.contract.md#FN-5 — memory ceiling mapping from limits.memoryMb
  const provider = new GVisorIsolationProvider();
  const artifact = createTestArtifact();

  const customLimits: Limits = {
    cpuMs: DEFAULT_CPU_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    memoryMb: CUSTOM_MEMORY_MB, // 256 MB
  };

  const bundle = provider.generateBundle(artifact, customLimits);
  assertEquals(bundle.linux?.resources?.memory?.limit, CUSTOM_MEMORY_BYTES);

  // Test 64 MB
  const smallLimits: Limits = {
    cpuMs: DEFAULT_CPU_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    memoryMb: 64,
  };
  const smallBundle = provider.generateBundle(artifact, smallLimits);
  assertEquals(smallBundle.linux?.resources?.memory?.limit, 64 * 1024 * 1024);
});

Deno.test("AC1: generateBundle drops sensitive Linux capabilities in process spec", () => {
  // spec: contracts/platform.contract.md#PLAT-4 — container capability drop
  const provider = new GVisorIsolationProvider();
  const artifact = createTestArtifact();

  const bundle = provider.generateBundle(artifact, DEFAULT_LIMITS);

  // If capabilities are explicitly specified in process, ensure dangerous caps are omitted
  const proc = bundle.process as {
    capabilities?: {
      bounding?: string[];
      effective?: string[];
      permitted?: string[];
      ambient?: string[];
    };
  };

  if (proc.capabilities) {
    const dangerousCaps = [
      "CAP_SYS_ADMIN",
      "CAP_NET_ADMIN",
      "CAP_SYS_RAWIO",
      "CAP_SYS_PTRACE",
    ];
    for (const cap of dangerousCaps) {
      assertFalse(
        proc.capabilities.bounding?.includes(cap),
        `Bounding capabilities must not contain ${cap}`,
      );
      assertFalse(
        proc.capabilities.effective?.includes(cap),
        `Effective capabilities must not contain ${cap}`,
      );
    }
  }
});

// ============================================================================
// AC2: Platform Detection (PLAT-17)
// ============================================================================

Deno.test("AC2 (Parity): isAvailable returns boolean cleanly without throwing unhandled exceptions", () => {
  // spec: contracts/platform.contract.md#PLAT-17 — Local/production parity
  // AC2: Given a host environment without runsc, when isAvailable() is called,
  // then it returns false cleanly without throwing an unhandled exception.
  const provider = new GVisorIsolationProvider();

  let available: boolean;
  try {
    available = provider.isAvailable();
  } catch (err) {
    throw new Error(`isAvailable() threw an unexpected exception: ${err}`);
  }

  assertEquals(typeof available, "boolean");

  // On non-Linux platforms (e.g. Windows, macOS), isAvailable must be false
  if (Deno.build.os !== "linux") {
    assertEquals(
      available,
      false,
      "gVisor (runsc) is only available on Linux hosts",
    );
  }
});

Deno.test("AC2: isAvailable returns false when configured with nonexistent runsc path", () => {
  const provider = new GVisorIsolationProvider({
    runscPath: "/nonexistent/binary/path/runsc",
  });

  assertEquals(provider.isAvailable(), false);
});

Deno.test("AC2: isAvailable returns false when simulated platform is non-linux", () => {
  // Supports platform simulation via options for cross-platform deterministic testing
  const providerWindows = new GVisorIsolationProvider(
    {
      platform: "windows",
    } as GVisorIsolationOptions & { platform?: string },
  );

  assertEquals(providerWindows.isAvailable(), false);

  const providerDarwin = new GVisorIsolationProvider(
    {
      platform: "darwin",
    } as GVisorIsolationOptions & { platform?: string },
  );

  assertEquals(providerDarwin.isAvailable(), false);
});

// ============================================================================
// AC3: Safe Development Emulation Fallback (PLAT-17)
// ============================================================================

Deno.test("AC3 (Integration): run executes via safe emulation when runsc is unavailable and returns ExecutionResult", async () => {
  // spec: contracts/platform.contract.md#PLAT-17 — Safe development emulation fallback
  // AC3: Given runsc unavailable on the host, when run(artifact, limits) is called,
  // then it validates the bundle structure and executes via safe emulation, returning a valid ExecutionResult.
  const provider = new GVisorIsolationProvider({
    runscPath: "/nonexistent/path/runsc", // Force emulation fallback
  });

  const code = `
    export default async function handler(req, ctx) {
      const url = new URL(req.url);
      const name = url.searchParams.get("name") || "guest";
      return new Response(JSON.stringify({
        message: "hello " + name,
        requestId: ctx.requestId,
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-isolation-mode": "emulated",
        },
      });
    }
  `;

  const artifact = createTestArtifact({ code });
  const invocation = createTestInvocation({
    url: "https://example.com/api?name=railfog",
  });

  const startTime = Date.now();
  const result: ExecutionResult = await provider.run(
    artifact,
    DEFAULT_LIMITS,
    invocation,
  );
  const elapsed = Date.now() - startTime;

  assertEquals(result.statusCode, 200);
  assertEquals(result.headers["content-type"], "application/json");
  assertInstanceOf(result.body, Uint8Array);

  const parsed = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(parsed.message, "hello railfog");
  assertEquals(parsed.requestId, invocation.requestId);

  // Metrics validation per FN-5
  assert(result.cpuTimeMs >= 0, "cpuTimeMs must be non-negative");
  assert(result.wallClockMs >= 0, "wallClockMs must be non-negative");
  assert(result.wallClockMs <= elapsed + 100);
});

Deno.test("AC3 (Integration): run defaults safely when invocation is omitted per ADR-0001", async () => {
  // spec: docs/adr/0001-isolation-provider-invocation-protocol.md — optional invocation defaults to empty GET
  const provider = new GVisorIsolationProvider();

  const code = `
    export default async function handler(req) {
      return new Response(req.method, { status: 200 });
    }
  `;

  const artifact = createTestArtifact({ code });
  const result = await provider.run(artifact, DEFAULT_LIMITS);

  assertEquals(result.statusCode, 200);
  assertEquals(new TextDecoder().decode(result.body), "GET");
});

Deno.test("AC3 (Validation): run and generateBundle reject invalid limits with ValidationFailedError", async () => {
  // spec: contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED error taxonomy
  const provider = new GVisorIsolationProvider();
  const artifact = createTestArtifact();

  // Negative memoryMb
  const negativeMemoryLimits: Limits = {
    cpuMs: 200,
    timeoutMs: 30000,
    memoryMb: -128,
  };
  assertThrows(
    () => provider.generateBundle(artifact, negativeMemoryLimits),
    ValidationFailedError,
  );
  await assertRejects(
    () => provider.run(artifact, negativeMemoryLimits),
    ValidationFailedError,
  );

  // Zero timeoutMs
  const zeroTimeoutLimits: Limits = {
    cpuMs: 200,
    timeoutMs: 0,
    memoryMb: 128,
  };
  assertThrows(
    () => provider.generateBundle(artifact, zeroTimeoutLimits),
    ValidationFailedError,
  );
  await assertRejects(
    () => provider.run(artifact, zeroTimeoutLimits),
    ValidationFailedError,
  );

  // Negative cpuMs
  const negativeCpuLimits: Limits = {
    cpuMs: -10,
    timeoutMs: 30000,
    memoryMb: 128,
  };
  assertThrows(
    () => provider.generateBundle(artifact, negativeCpuLimits),
    ValidationFailedError,
  );
  await assertRejects(
    () => provider.run(artifact, negativeCpuLimits),
    ValidationFailedError,
  );
});

Deno.test("AC3 (Validation): generateBundle rejects null/invalid artifact with ValidationFailedError", () => {
  // spec: contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED
  const provider = new GVisorIsolationProvider();

  const invalidArtifact = {
    id: "",
    integrity: "invalid",
    entrypoint: "",
    code: new Uint8Array(),
  };

  assertThrows(
    () => provider.generateBundle(invalidArtifact, DEFAULT_LIMITS),
    ValidationFailedError,
  );
});

// ============================================================================
// Security & Adversarial Review (PLAT-4, PLAT-16, PLAT-17, SKILL.md)
// ============================================================================

Deno.test("Security Adversarial (PLAT-4): OCI rootfs readonly flag can never be false", () => {
  // spec: contracts/platform.contract.md#PLAT-4 — Untrusted code cannot write to container rootfs
  const provider = new GVisorIsolationProvider();
  const artifact = createTestArtifact();

  const bundle = provider.generateBundle(artifact, DEFAULT_LIMITS);
  assertEquals(bundle.root.readonly, true);
  assertNotEquals(bundle.root.readonly, false);
});

Deno.test("Security Adversarial (PLAT-5): Network namespace is isolated from host network", () => {
  // spec: contracts/platform.contract.md#PLAT-5 — Network policy & container isolation
  const provider = new GVisorIsolationProvider();
  const artifact = createTestArtifact();

  const bundle = provider.generateBundle(artifact, DEFAULT_LIMITS);
  const netNamespace = bundle.linux?.namespaces?.find((ns: { type: string }) =>
    ns.type === "network"
  );

  assert(
    netNamespace !== undefined,
    "network namespace must be explicitly configured",
  );
  assertEquals(netNamespace.type, "network");
  // Ensure host network is not leaked (path must not point to /proc/1/ns/net or host namespace)
  const nsWithPath = netNamespace as { type: string; path?: string };
  if (nsWithPath.path) {
    assertFalse(
      nsWithPath.path.includes("host"),
      "Network namespace must not link to host namespace",
    );
  }
});

Deno.test("Security Adversarial (FN-5): Memory limit is an integer byte boundary and strictly enforced", () => {
  // spec: contracts/functions.contract.md#FN-5 — cgroup / isolate memory ceiling
  const provider = new GVisorIsolationProvider();
  const artifact = createTestArtifact();

  // Default limit
  const bundle = provider.generateBundle(artifact, DEFAULT_LIMITS);
  const memLimit = bundle.linux?.resources?.memory?.limit;
  assert(memLimit !== undefined);
  assertEquals(Number.isInteger(memLimit), true);
  assert(memLimit > 0);
  assertEquals(memLimit, 134217728);

  // Maximum allowed memory 1024 MB
  const maxMemoryLimits: Limits = {
    cpuMs: 200,
    timeoutMs: 30000,
    memoryMb: 1024,
  };
  const maxBundle = provider.generateBundle(artifact, maxMemoryLimits);
  assertEquals(maxBundle.linux?.resources?.memory?.limit, 1024 * 1024 * 1024);
});
