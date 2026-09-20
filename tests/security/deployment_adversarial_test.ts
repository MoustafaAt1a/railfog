/**
 * Adversarial Security Tests for Control Plane Revision Deployment Pipeline (T-0207).
 *
 * Spec references:
 * - PLAT-1: Control plane isolation (never executes customer code)
 * - PLAT-3: Deployment pipeline & health check gating safety
 * - PLAT-7: Multi-tenant isolation & resource hierarchy (PLAT-18)
 * - OBJ-4: Content addressing
 */

import { assertEquals, assertRejects } from "@std/assert";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import {
  type PackagedArtifact,
  packageFunctionArtifact,
} from "../../packages/core/artifact/packager.ts";
import {
  ResourceNotFoundError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import { DeploymentService } from "../../apps/api/deployment-service.ts";

async function streamToBytes(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ============================================================================
// Attack 1: PLAT-1 Customer Code Execution
// ============================================================================

Deno.test("Attack PLAT-1: Control plane never invokes eval, Function constructor, or Worker", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    // Spy on code execution vectors
    let evalCalled = false;
    let functionCtorCalled = false;
    let workerCalled = false;

    const originalEval = globalThis.eval;
    const originalFunction = globalThis.Function;
    const originalWorker =
      (globalThis as unknown as { Worker: unknown }).Worker;

    (globalThis as unknown as { eval: unknown }).eval = (
      ...args: unknown[]
    ) => {
      evalCalled = true;
      return (originalEval as (...a: unknown[]) => unknown)(...args);
    };

    const SpiedFunction = function (...args: unknown[]) {
      functionCtorCalled = true;
      return Reflect.construct(originalFunction, args);
    };
    (globalThis as unknown as { Function: unknown }).Function = SpiedFunction;

    if (originalWorker) {
      const SpiedWorker = function (...args: unknown[]) {
        workerCalled = true;
        return Reflect.construct(
          originalWorker as new (...a: unknown[]) => unknown,
          args,
        );
      };
      (globalThis as unknown as { Worker: unknown }).Worker = SpiedWorker;
    }

    try {
      // Construct payload designed to execute code if evaluated
      const maliciousCode = `
        // Exploit payload
        const x = 1 + 1;
        throw new Error("EXPLOIT EXECUTED");
      `;
      const artifact = await packageFunctionArtifact(
        "index.ts",
        new TextEncoder().encode(maliciousCode),
      );

      const result = await service.deploy(
        "sec-p",
        "sec-fn",
        artifact,
        () => Promise.resolve(true),
      );
      assertEquals(result.state, "Deployed");
      assertEquals(evalCalled, false, "eval() was called!");
      assertEquals(functionCtorCalled, false, "Function() was called!");
      assertEquals(workerCalled, false, "Worker() was called!");

      // Also verify during rollback
      await service.rollback("sec-p", "sec-fn", result.revisionId);
      assertEquals(evalCalled, false, "eval() called during rollback!");
    } finally {
      // Restore
      (globalThis as unknown as { eval: unknown }).eval = originalEval;
      (globalThis as unknown as { Function: unknown }).Function =
        originalFunction;
      if (originalWorker) {
        (globalThis as unknown as { Worker: unknown }).Worker = originalWorker;
      }
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Attack 2: PLAT-7 Tenant Boundary Violations & Cross-Tenant Rollback
// ============================================================================

Deno.test("Attack PLAT-7: Cross-tenant rollback is rejected with RESOURCE_NOT_FOUND", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const art = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode("export default 1;"),
    );
    const deployA = await service.deploy(
      "tenant-alpha",
      "fn-alpha",
      art,
      () => Promise.resolve(true),
    );

    // Tenant Beta attempts to rollback to Tenant Alpha's revision
    const err = await assertRejects(
      async () => {
        await service.rollback("tenant-beta", "fn-beta", deployA.revisionId);
      },
      ResourceNotFoundError,
    );
    assertEquals(err.code, "RESOURCE_NOT_FOUND");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Attack PLAT-7: Cross-function rollback in same project is rejected with RESOURCE_NOT_FOUND", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const art = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode("export default 1;"),
    );
    const deployFn1 = await service.deploy(
      "tenant-gamma",
      "fn-1",
      art,
      () => Promise.resolve(true),
    );

    // Same tenant, but fn-2 attempts to rollback to fn-1's revision
    const err = await assertRejects(
      async () => {
        await service.rollback("tenant-gamma", "fn-2", deployFn1.revisionId);
      },
      ResourceNotFoundError,
    );
    assertEquals(err.code, "RESOURCE_NOT_FOUND");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Attack 3: PLAT-7 Key Collision via Null Bytes (\0)
// ============================================================================

Deno.test("Attack PLAT-7: Null-byte delimiter injection in project/function names", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const art1 = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode("export default 'tenantA';"),
    );
    const art2 = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode("export default 'tenantB';"),
    );

    // Tenant 1 has project "corp", function "app\0service"
    const r1 = await service.deploy(
      "corp",
      "app\0service",
      art1,
      () => Promise.resolve(true),
    );

    // Tenant 2 has project "corp\0app", function "service"
    const r2 = await service.deploy(
      "corp\0app",
      "service",
      art2,
      () => Promise.resolve(true),
    );

    const active1 = await service.getActiveRevision("corp", "app\0service");
    const active2 = await service.getActiveRevision("corp\0app", "service");

    // Because nested maps are used instead of delimiter strings, no collision occurs
    assertEquals(active1!.id, r1.revisionId);
    assertEquals(active2!.id, r2.revisionId);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Attack 4: Storage Path Traversal / Escaping artifacts/ via artifact.id
// ============================================================================

Deno.test("Attack PLAT-7 / OBJ-4: Path traversal via artifact.id escaping artifacts/", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    // Pre-create a "victim" tenant file in storage root
    await storage.put(
      "victim/data.txt",
      new TextEncoder().encode("ORIGINAL VICTIM DATA").buffer as ArrayBuffer,
    );

    // Attacker crafts an artifact with path traversal in id
    const evilArtifact: PackagedArtifact = {
      id: "../victim/data.txt",
      integrity: "sha256-forged",
      bytes: new TextEncoder().encode("OVERWRITTEN BY ATTACKER"),
      manifest: {
        runtime: "railfog-deno",
        runtimeVersion: "1.0",
        entrypoint: "index.ts",
        integrity: "sha256-forged",
        permissions: {},
        limits: { cpu_ms: 100, timeout_ms: 1000, memory_mb: 64 },
        dependencies: {},
      },
    };

    // Deploy with path-traversing artifact.id MUST be rejected with ValidationFailedError
    const err = await assertRejects(
      async () => {
        await service.deploy(
          "attacker-proj",
          "fn",
          evilArtifact,
          () => Promise.resolve(true),
        );
      },
      ValidationFailedError,
    );
    assertEquals(err.code, "VALIDATION_FAILED");

    // Verify victim/data.txt was NOT overwritten
    const victimStream = await storage.get("victim/data.txt");
    const victimBytes = await streamToBytes(victimStream!);
    const victimText = new TextDecoder().decode(victimBytes);
    assertEquals(victimText, "ORIGINAL VICTIM DATA");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Attack 5: Artifact Poisoning / Hash Collision / Integrity Forgery
// ============================================================================

Deno.test("Attack OBJ-4: Artifact content spoofing / poisoning of another tenant's artifact", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    // Tenant A deploys a legitimate artifact
    const legitimateCode = new TextEncoder().encode(
      "export default () => 'legitimate';",
    );
    const legitArtifact = await packageFunctionArtifact(
      "index.ts",
      legitimateCode,
    );
    await service.deploy(
      "victim-proj",
      "victim-fn",
      legitArtifact,
      () => Promise.resolve(true),
    );

    // Attacker deploys with the same artifact.id as victim, but poisoned bytes
    const poisonedBytes = new TextEncoder().encode(
      "export default () => 'POISONED BACKDOOR';",
    );
    const poisonedArtifact: PackagedArtifact = {
      id: legitArtifact.id, // Target victim's artifact ID!
      integrity: legitArtifact.integrity,
      bytes: poisonedBytes, // Mismatched bytes!
      manifest: legitArtifact.manifest,
    };

    // Deploy with mismatched/poisoned bytes MUST be rejected with ValidationFailedError
    const err = await assertRejects(
      async () => {
        await service.deploy(
          "attacker-proj",
          "attacker-fn",
          poisonedArtifact,
          () => Promise.resolve(true),
        );
      },
      ValidationFailedError,
    );
    assertEquals(err.code, "VALIDATION_FAILED");

    // Read stored artifact bytes from storage and ensure they remain authentic
    const storedStream = await storage.get(`artifacts/${legitArtifact.id}`);
    const storedBytes = await streamToBytes(storedStream!);
    assertEquals(storedBytes, legitimateCode);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Attack 6: PLAT-3 Health Check Bypass via Rollback to Failed Revision
// ============================================================================

Deno.test("Attack PLAT-3: Activating a FAILED revision via rollback", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    // Deploy revision 1 (legitimate, healthy)
    const art1 = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode("export default 'v1';"),
    );
    const r1 = await service.deploy(
      "my-proj",
      "my-fn",
      art1,
      () => Promise.resolve(true),
    );
    assertEquals(r1.state, "Deployed");
    assertEquals(r1.active, true);

    // Deploy revision 2 (FAILS health check)
    const art2 = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode("export default 'broken v2';"),
    );
    const r2 = await service.deploy(
      "my-proj",
      "my-fn",
      art2,
      () => Promise.resolve(false),
    );
    assertEquals(r2.state, "Failed");
    assertEquals(r2.active, false);

    // Active pointer is still r1
    const activeBefore = await service.getActiveRevision("my-proj", "my-fn");
    assertEquals(activeBefore!.id, r1.revisionId);

    // ATTACK: Attempting to rollback to the FAILED revision r2 MUST throw ValidationFailedError
    const err = await assertRejects(
      async () => {
        await service.rollback("my-proj", "my-fn", r2.revisionId);
      },
      ValidationFailedError,
    );
    assertEquals(err.code, "VALIDATION_FAILED");

    const activeAfter = await service.getActiveRevision("my-proj", "my-fn");
    // A FAILED revision MUST NEVER become active!
    assertEquals(activeAfter?.id, r1.revisionId);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Attack 7: PLAT-3 Health Check Truthiness / Status Code Bypass
// ============================================================================

Deno.test("Attack PLAT-3: Truthy / non-boolean return values in healthCheck probe", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const art = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode("export default 1;"),
    );

    // Health probe returns HTTP 500 or error object or "false" string instead of boolean true
    const probeReturning500 = () => Promise.resolve(500 as unknown as boolean);

    const result = await service.deploy(
      "test-p",
      "test-fn",
      art,
      probeReturning500,
    );

    // Probe returning 500 must NOT be treated as healthy
    assertEquals(result.state, "Failed");
    assertEquals(result.active, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Attack 8: PLAT-3 Race Condition with Out-of-Order Deploys
// ============================================================================

Deno.test("Attack PLAT-3: Stale/lagging deploy overwriting newer active deployment", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const art1 = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode("export default 'v1';"),
    );
    const art2 = await packageFunctionArtifact(
      "index.ts",
      new TextEncoder().encode("export default 'v2';"),
    );

    // Deploy 1 is slow (simulates 50ms per probe)
    let slowResolve: () => void;
    const slowPromise = new Promise<void>((resolve) => {
      slowResolve = resolve;
    });

    let probeCount = 0;
    const slowProbe = async () => {
      probeCount++;
      if (probeCount === 1) {
        await slowPromise;
      }
      return true;
    };

    // Start Deploy 1 (slow)
    const deploy1Promise = service.deploy("race-p", "race-fn", art1, slowProbe);

    // Wait a tiny bit then start Deploy 2 (fast)
    await new Promise((r) => setTimeout(r, 10));
    const deploy2Result = await service.deploy(
      "race-p",
      "race-fn",
      art2,
      () => Promise.resolve(true),
    );
    assertEquals(deploy2Result.state, "Deployed");
    assertEquals(
      (await service.getActiveRevision("race-p", "race-fn"))!.id,
      deploy2Result.revisionId,
    );

    // Now let Deploy 1 finish
    slowResolve!();
    const deploy1Result = await deploy1Promise;
    assertEquals(deploy1Result.state, "Deployed");
    // Deploy 1 was healthy, but its activation was suppressed because it was superseded
    assertEquals(deploy1Result.active, false);

    const currentActive = await service.getActiveRevision("race-p", "race-fn");

    // Revision 2 was deployed AFTER Revision 1. Revision 1 must not overwrite Revision 2!
    assertEquals(
      currentActive!.id,
      deploy2Result.revisionId,
      "VULNERABILITY PLAT-3: Stale deploy 1 overwritten newer deploy 2 active pointer!",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
