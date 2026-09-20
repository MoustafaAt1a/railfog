/**
 * Tests for Control Plane Revision Deployment Pipeline (T-0207).
 *
 * Spec references:
 * - PLAT-1: Control plane vs data plane (never executes customer code)
 * - PLAT-3: Deployment pipeline (validation, content-addressed storage, health check gating, atomic cutover, instant rollback)
 * - PLAT-12: Error model (RESOURCE_NOT_FOUND)
 * - PLAT-14: ULID identifier format
 * - PLAT-18: Resource hierarchy (Project -> Function -> Revision)
 * - FN-3: Function lifecycle (Created -> Building -> Ready -> Deployed / Failed, pointer flip rollback)
 * - OBJ-4: Content addressing (artifacts/{artifact_id}, sha256 hex id, SRI integrity)
 */

import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import {
  type PackagedArtifact,
  packageFunctionArtifact,
} from "../../packages/core/artifact/packager.ts";
import { ResourceNotFoundError } from "../../packages/errors/mod.ts";
import { computeIntegrity } from "../../packages/core/crypto/content-address.ts";
import {
  type DeploymentResult,
  DeploymentService,
  type RevisionRecord,
} from "../../apps/api/deployment-service.ts";

/**
 * Helper to drain a ReadableStream into a Uint8Array.
 */
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

/**
 * Helper to build a sample packaged artifact for tests.
 */
async function createSampleArtifact(
  code: string = 'export default () => new Response("ok");',
): Promise<PackagedArtifact> {
  const bytes = new TextEncoder().encode(code);
  return await packageFunctionArtifact("index.ts", bytes);
}

// ============================================================================
// Unit Tests: AC1 - Content-addressed storage & ULID revision generation
// ============================================================================

Deno.test("Unit: AC1 - deploy creates revision with valid ULID and stores artifact under artifacts/{artifact_id}", async () => {
  // spec: contracts/platform.contract.md#PLAT-14 — Crockford Base32 26-char ULID
  // spec: contracts/platform.contract.md#PLAT-18 — Resource hierarchy Function -> Revision
  // spec: contracts/objects.contract.md#OBJ-4 — Content addressing
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const artifact = await createSampleArtifact();
    const result: DeploymentResult = await service.deploy(
      "proj-test",
      "fn-hello",
      artifact,
      () => Promise.resolve(true),
    );

    // Verify ULID format: rev_{26 Crockford Base32 characters}
    assertMatch(
      result.revisionId,
      /^rev_[0-9A-HJKMNP-TV-Z]{26}$/,
      `Revision ID ${result.revisionId} does not match rev_{ULID} format`,
    );

    // Verify artifact is stored in storage at artifacts/{artifact_id} per OBJ-4
    const storedStream = await storage.get(`artifacts/${artifact.id}`);
    assertNotEquals(storedStream, null, "Artifact bytes not found in storage");
    const storedBytes = await streamToBytes(storedStream!);
    assertEquals(storedBytes, artifact.bytes);

    // Verify revision record metadata
    const record: RevisionRecord | null = await service.getRevision(
      "proj-test",
      "fn-hello",
      result.revisionId,
    );
    assertNotEquals(record, null);
    assertEquals(record!.id, result.revisionId);
    assertEquals(record!.project, "proj-test");
    assertEquals(record!.functionName, "fn-hello");
    assertEquals(record!.artifactId, artifact.id);
    assertEquals(record!.integrity, artifact.integrity);
    assertEquals(record!.manifest, artifact.manifest);
    assertEquals(typeof record!.createdAt, "number");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Unit: AC1 - multiple deployments generate unique, monotonically sortable ULID revision IDs", async () => {
  // spec: contracts/platform.contract.md#PLAT-14 — sort order = creation order
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const artifact = await createSampleArtifact();
    const r1 = await service.deploy(
      "proj-1",
      "fn-1",
      artifact,
      () => Promise.resolve(true),
    );
    const r2 = await service.deploy(
      "proj-1",
      "fn-1",
      artifact,
      () => Promise.resolve(true),
    );

    assertNotEquals(r1.revisionId, r2.revisionId);
    // ULID string comparison reflects creation order
    assertEquals(
      r1.revisionId < r2.revisionId,
      true,
      `Expected ${r1.revisionId} < ${r2.revisionId}`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Unit Tests: AC2 - Health check gating (passing checks)
// ============================================================================

Deno.test("Unit: AC2 - passing health check (3 consecutive successes) activates revision and transitions to Deployed", async () => {
  // spec: contracts/platform.contract.md#PLAT-3 — Health check (3 consecutive 200s) -> Activate
  // spec: contracts/functions.contract.md#FN-3 — Ready -> Deployed -> Active
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    let probeCalls = 0;
    const healthProbe = () => {
      probeCalls++;
      return Promise.resolve(true);
    };

    const artifact = await createSampleArtifact();
    const result: DeploymentResult = await service.deploy(
      "proj-alpha",
      "fn-api",
      artifact,
      healthProbe,
    );

    // Must probe 3 consecutive times per PLAT-3
    assertEquals(
      probeCalls,
      3,
      "Health check must be probed exactly 3 consecutive times",
    );
    assertEquals(result.state, "Deployed");
    assertEquals(result.active, true);

    // Verify revision record reflects Deployed state
    const revRecord = await service.getRevision(
      "proj-alpha",
      "fn-api",
      result.revisionId,
    );
    assertNotEquals(revRecord, null);
    assertEquals(revRecord!.state, "Deployed");

    // Verify active pointer was flipped to this revision
    const activeRecord = await service.getActiveRevision(
      "proj-alpha",
      "fn-api",
    );
    assertNotEquals(activeRecord, null);
    assertEquals(activeRecord!.id, result.revisionId);
    assertEquals(activeRecord!.state, "Deployed");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Unit: AC2 - deploy without explicit healthCheck probe defaults to passing", async () => {
  // spec: contracts/platform.contract.md#PLAT-3
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const artifact = await createSampleArtifact();
    const result = await service.deploy("proj-alpha", "fn-api", artifact);

    assertEquals(result.state, "Deployed");
    assertEquals(result.active, true);

    const activeRecord = await service.getActiveRevision(
      "proj-alpha",
      "fn-api",
    );
    assertNotEquals(activeRecord, null);
    assertEquals(activeRecord!.id, result.revisionId);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Unit Tests: AC3 - Health check gating (failing checks)
// ============================================================================

Deno.test("Unit: AC3 - health check failing on attempt 1 transitions to Failed and is not activated", async () => {
  // spec: contracts/platform.contract.md#PLAT-3 — fail: revision stays inactive, previous revision keeps serving
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    let probeCalls = 0;
    const healthProbe = () => {
      probeCalls++;
      return Promise.resolve(false); // fails immediately on attempt 1
    };

    const artifact = await createSampleArtifact();
    const result: DeploymentResult = await service.deploy(
      "proj-beta",
      "fn-svc",
      artifact,
      healthProbe,
    );

    assertEquals(result.state, "Failed");
    assertEquals(result.active, false);
    assertEquals(probeCalls, 1, "Should halt health check on first failure");

    // Revision record is saved with Failed state
    const revRecord = await service.getRevision(
      "proj-beta",
      "fn-svc",
      result.revisionId,
    );
    assertNotEquals(revRecord, null);
    assertEquals(revRecord!.state, "Failed");

    // No active revision exists
    const activeRecord = await service.getActiveRevision("proj-beta", "fn-svc");
    assertEquals(activeRecord, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Unit: AC3 - health check failing on attempt 2 transitions to Failed and is not activated", async () => {
  // spec: contracts/platform.contract.md#PLAT-3
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    let probeCalls = 0;
    const healthProbe = () => {
      probeCalls++;
      if (probeCalls === 1) return Promise.resolve(true);
      return Promise.resolve(false); // fails on attempt 2
    };

    const artifact = await createSampleArtifact();
    const result = await service.deploy(
      "proj-beta",
      "fn-svc",
      artifact,
      healthProbe,
    );

    assertEquals(result.state, "Failed");
    assertEquals(result.active, false);
    assertEquals(probeCalls, 2);

    const activeRecord = await service.getActiveRevision("proj-beta", "fn-svc");
    assertEquals(activeRecord, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Unit: AC3 - health check failing on attempt 3 transitions to Failed and is not activated", async () => {
  // spec: contracts/platform.contract.md#PLAT-3
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    let probeCalls = 0;
    const healthProbe = () => {
      probeCalls++;
      if (probeCalls < 3) return Promise.resolve(true);
      return Promise.resolve(false); // fails on attempt 3
    };

    const artifact = await createSampleArtifact();
    const result = await service.deploy(
      "proj-beta",
      "fn-svc",
      artifact,
      healthProbe,
    );

    assertEquals(result.state, "Failed");
    assertEquals(result.active, false);
    assertEquals(probeCalls, 3);

    const activeRecord = await service.getActiveRevision("proj-beta", "fn-svc");
    assertEquals(activeRecord, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Unit: AC3 - health check throwing an error transitions to Failed and does not crash service", async () => {
  // spec: contracts/platform.contract.md#PLAT-3
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const throwingProbe = () => {
      return Promise.reject(new Error("Connection refused on health endpoint"));
    };

    const artifact = await createSampleArtifact();
    const result = await service.deploy(
      "proj-beta",
      "fn-svc",
      artifact,
      throwingProbe,
    );

    assertEquals(result.state, "Failed");
    assertEquals(result.active, false);

    const revRecord = await service.getRevision(
      "proj-beta",
      "fn-svc",
      result.revisionId,
    );
    assertNotEquals(revRecord, null);
    assertEquals(revRecord!.state, "Failed");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Unit: AC3 - failing deployment preserves existing active revision", async () => {
  // spec: contracts/platform.contract.md#PLAT-3 — previous revision keeps serving
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    // 1. Successful first deploy
    const artifact1 = await createSampleArtifact(
      'export default () => new Response("v1");',
    );
    const result1 = await service.deploy(
      "proj-stable",
      "fn-web",
      artifact1,
      () => Promise.resolve(true),
    );
    assertEquals(result1.state, "Deployed");
    assertEquals(result1.active, true);

    // 2. Failing second deploy
    const artifact2 = await createSampleArtifact(
      'export default () => new Response("v2");',
    );
    const result2 = await service.deploy(
      "proj-stable",
      "fn-web",
      artifact2,
      () => Promise.resolve(false),
    );
    assertEquals(result2.state, "Failed");
    assertEquals(result2.active, false);

    // Active pointer must remain result1
    const active = await service.getActiveRevision("proj-stable", "fn-web");
    assertNotEquals(active, null);
    assertEquals(active!.id, result1.revisionId);
    assertEquals(active!.state, "Deployed");

    // Both revisions must be queryable
    const rec1 = await service.getRevision(
      "proj-stable",
      "fn-web",
      result1.revisionId,
    );
    assertEquals(rec1!.state, "Deployed");
    const rec2 = await service.getRevision(
      "proj-stable",
      "fn-web",
      result2.revisionId,
    );
    assertEquals(rec2!.state, "Failed");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Unit Tests: AC4 - Instant rollback pointer flip
// ============================================================================

Deno.test("Unit: AC4 - rollback flips active pointer to target revision without rebuilding", async () => {
  // spec: contracts/functions.contract.md#FN-3 — rollback is a pointer flip, never a rebuild
  // spec: contracts/platform.contract.md#PLAT-3 — instant pointer-flip rollback
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const artifact1 = await createSampleArtifact(
      'export default () => new Response("rev1");',
    );
    const r1 = await service.deploy(
      "proj-rb",
      "fn-main",
      artifact1,
      () => Promise.resolve(true),
    );

    const artifact2 = await createSampleArtifact(
      'export default () => new Response("rev2");',
    );
    const r2 = await service.deploy(
      "proj-rb",
      "fn-main",
      artifact2,
      () => Promise.resolve(true),
    );

    // Prior to rollback, active is r2
    const activeBefore = await service.getActiveRevision("proj-rb", "fn-main");
    assertEquals(activeBefore!.id, r2.revisionId);

    // Rollback to r1
    await service.rollback("proj-rb", "fn-main", r1.revisionId);

    // Active is now r1
    const activeAfter = await service.getActiveRevision("proj-rb", "fn-main");
    assertNotEquals(activeAfter, null);
    assertEquals(activeAfter!.id, r1.revisionId);
    assertEquals(activeAfter!.state, "Deployed");

    // Both revision records are preserved with untouched metadata
    const rec1 = await service.getRevision("proj-rb", "fn-main", r1.revisionId);
    assertEquals(rec1!.artifactId, artifact1.id);
    const rec2 = await service.getRevision("proj-rb", "fn-main", r2.revisionId);
    assertEquals(rec2!.artifactId, artifact2.id);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Unit Tests: AC5 - Error handling on rollback (RESOURCE_NOT_FOUND)
// ============================================================================

Deno.test("Unit: AC5 - rollback to non-existent revision throws ResourceNotFoundError with code RESOURCE_NOT_FOUND", async () => {
  // spec: contracts/platform.contract.md#PLAT-12 — RESOURCE_NOT_FOUND: No such project / function / revision
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const artifact = await createSampleArtifact();
    await service.deploy(
      "proj-err",
      "fn-x",
      artifact,
      () => Promise.resolve(true),
    );

    const missingRevId = "rev_01J8Z000000000000000000000";

    const err = await assertRejects(
      async () => {
        await service.rollback("proj-err", "fn-x", missingRevId);
      },
      ResourceNotFoundError,
    );

    assertEquals(err.code, "RESOURCE_NOT_FOUND");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Unit: AC5 - rollback on non-existent project or function throws ResourceNotFoundError", async () => {
  // spec: contracts/platform.contract.md#PLAT-12
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const err1 = await assertRejects(
      async () => {
        await service.rollback(
          "non-existent-proj",
          "fn-any",
          "rev_01J8Z000000000000000000000",
        );
      },
      ResourceNotFoundError,
    );
    assertEquals(err1.code, "RESOURCE_NOT_FOUND");

    const artifact = await createSampleArtifact();
    const res = await service.deploy(
      "proj-exists",
      "fn-exists",
      artifact,
      () => Promise.resolve(true),
    );

    const err2 = await assertRejects(
      async () => {
        await service.rollback("proj-exists", "fn-other", res.revisionId);
      },
      ResourceNotFoundError,
    );
    assertEquals(err2.code, "RESOURCE_NOT_FOUND");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Unit: AC5 - rollback cannot target revision of another project or function", async () => {
  // spec: contracts/platform.contract.md#PLAT-18 — Resource hierarchy isolation
  // spec: contracts/platform.contract.md#PLAT-12 — RESOURCE_NOT_FOUND
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const artifact = await createSampleArtifact();
    const resProjA = await service.deploy(
      "proj-A",
      "fn-common",
      artifact,
      () => Promise.resolve(true),
    );
    await service.deploy(
      "proj-B",
      "fn-common",
      artifact,
      () => Promise.resolve(true),
    );

    // Attempting to rollback proj-B using proj-A's revision ID must fail
    const err = await assertRejects(
      async () => {
        await service.rollback("proj-B", "fn-common", resProjA.revisionId);
      },
      ResourceNotFoundError,
    );
    assertEquals(err.code, "RESOURCE_NOT_FOUND");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Unit Tests: Query methods & Multi-tenancy isolation
// ============================================================================

Deno.test("Unit: Query methods return null when revision or active revision does not exist", async () => {
  // spec: contracts/platform.contract.md#PLAT-18
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    assertEquals(
      await service.getActiveRevision("unseen-proj", "unseen-fn"),
      null,
    );
    assertEquals(
      await service.getRevision(
        "unseen-proj",
        "unseen-fn",
        "rev_01J8Z000000000000000000000",
      ),
      null,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Unit: Multi-tenancy isolation - revisions and active pointers are strictly scoped by project and function", async () => {
  // spec: contracts/platform.contract.md#PLAT-7 — Multi-tenancy & data isolation
  // spec: contracts/platform.contract.md#PLAT-18 — Resource hierarchy Organization -> Project -> Function -> Revision
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const art1 = await createSampleArtifact(
      'export default () => new Response("p1 f1");',
    );
    const art2 = await createSampleArtifact(
      'export default () => new Response("p1 f2");',
    );
    const art3 = await createSampleArtifact(
      'export default () => new Response("p2 f1");',
    );

    const r1 = await service.deploy(
      "p1",
      "f1",
      art1,
      () => Promise.resolve(true),
    );
    const r2 = await service.deploy(
      "p1",
      "f2",
      art2,
      () => Promise.resolve(true),
    );
    const r3 = await service.deploy(
      "p2",
      "f1",
      art3,
      () => Promise.resolve(true),
    );

    const activeP1F1 = await service.getActiveRevision("p1", "f1");
    const activeP1F2 = await service.getActiveRevision("p1", "f2");
    const activeP2F1 = await service.getActiveRevision("p2", "f1");

    assertEquals(activeP1F1!.id, r1.revisionId);
    assertEquals(activeP1F2!.id, r2.revisionId);
    assertEquals(activeP2F1!.id, r3.revisionId);

    // Cross-querying returns null
    assertEquals(await service.getRevision("p1", "f2", r1.revisionId), null);
    assertEquals(await service.getRevision("p2", "f1", r1.revisionId), null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Integration Tests: Real ObjectProvider verification
// ============================================================================

Deno.test("Integration: deploy artifact to real ObjectProvider and verify stored bytes match sha256 integrity", async () => {
  // spec: contracts/objects.contract.md#OBJ-4 — Content addressing
  // spec: contracts/platform.contract.md#PLAT-3 — Store content-addressed, generate manifest
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const fixtureBytes = new TextEncoder().encode(`
      export default function(ctx) {
        return new Response("Hello from integration test: " + ctx.requestId);
      }
    `);
    const artifact = await packageFunctionArtifact("index.ts", fixtureBytes, {
      permissions: { kv: ["app:sessions"] },
      limits: { cpu_ms: 150, timeout_ms: 25000, memory_mb: 256 },
    });

    const result = await service.deploy(
      "real-proj",
      "real-fn",
      artifact,
      () => Promise.resolve(true),
    );

    assertEquals(result.state, "Deployed");
    assertEquals(result.active, true);

    // Verify stored object in LocalFSProvider
    const storedStream = await storage.get(`artifacts/${artifact.id}`);
    assertNotEquals(storedStream, null);
    const storedBytes = await streamToBytes(storedStream!);

    assertEquals(storedBytes, fixtureBytes);

    // Verify integrity matches computed SRI hash of stored bytes
    const computedIntegrity = await computeIntegrity(storedBytes);
    assertEquals(computedIntegrity, artifact.integrity);

    // Check HEAD object size
    const headInfo = await storage.head(`artifacts/${artifact.id}`);
    assertNotEquals(headInfo, null);
    assertEquals(headInfo!.size, fixtureBytes.byteLength);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Integration: Sequential deployments and rollback on real ObjectProvider preserve all artifacts", async () => {
  // spec: contracts/platform.contract.md#PLAT-3
  // spec: contracts/functions.contract.md#FN-3
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const art1 = await createSampleArtifact('export default () => "v1";');
    const art2 = await createSampleArtifact('export default () => "v2";');
    const art3 = await createSampleArtifact('export default () => "v3";');

    const r1 = await service.deploy(
      "prod-project",
      "main-fn",
      art1,
      () => Promise.resolve(true),
    );
    const r2 = await service.deploy(
      "prod-project",
      "main-fn",
      art2,
      () => Promise.resolve(true),
    );
    const r3 = await service.deploy(
      "prod-project",
      "main-fn",
      art3,
      () => Promise.resolve(true),
    );

    assertEquals(
      (await service.getActiveRevision("prod-project", "main-fn"))!.id,
      r3.revisionId,
    );

    // Rollback to r1
    await service.rollback("prod-project", "main-fn", r1.revisionId);
    assertEquals(
      (await service.getActiveRevision("prod-project", "main-fn"))!.id,
      r1.revisionId,
    );

    // Rollback forward to r2
    await service.rollback("prod-project", "main-fn", r2.revisionId);
    assertEquals(
      (await service.getActiveRevision("prod-project", "main-fn"))!.id,
      r2.revisionId,
    );

    // Verify all 3 artifact blobs still exist intact in ObjectProvider
    assertNotEquals(await storage.get(`artifacts/${art1.id}`), null);
    assertNotEquals(await storage.get(`artifacts/${art2.id}`), null);
    assertNotEquals(await storage.get(`artifacts/${art3.id}`), null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Security Tests: PLAT-1 Isolation (CP never imports, evals, or executes customer code)
// ============================================================================

Deno.test("Security: PLAT-1 - Control plane deploy never evaluates, imports, or executes customer code bytes", async () => {
  // spec: contracts/platform.contract.md#PLAT-1 — Control plane executes customer code: Never
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    // Malicious code payload that sets a sentinel on globalThis or throws if executed
    const sentinelKey = "__RAILFOG_MALICIOUS_EXEC_FLAG__";
    (globalThis as Record<string, unknown>)[sentinelKey] = false;

    const maliciousCode = `
      // Malicious payload that would execute if imported or eval'd by control plane
      (globalThis as any)["${sentinelKey}"] = true;
      throw new Error("EXPLOIT: Customer code executed in control plane!");
    `;

    const maliciousArtifact = await createSampleArtifact(maliciousCode);

    // Deploy must succeed without triggering execution or error
    const result = await service.deploy(
      "sec-proj",
      "sec-fn",
      maliciousArtifact,
      () => Promise.resolve(true),
    );

    assertEquals(result.state, "Deployed");
    assertEquals(
      (globalThis as Record<string, unknown>)[sentinelKey],
      false,
      "PLAT-1 VIOLATION: Customer code was evaluated or imported by control plane process during deploy",
    );

    delete (globalThis as Record<string, unknown>)[sentinelKey];
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Security: PLAT-1 - Control plane deploy accepts non-JS/corrupt bytes without parse or eval attempt", async () => {
  // spec: contracts/platform.contract.md#PLAT-1 — Control plane treats artifact as passive opaque bytes
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    // Malformed syntax that cannot be parsed by JS engine
    const invalidSyntaxBytes = new TextEncoder().encode(
      "const { invalid syntax !#@%^&*() } = ;;;",
    );
    const artifact = await packageFunctionArtifact(
      "index.ts",
      invalidSyntaxBytes,
    );

    // Control plane must store it without attempting to parse or load it
    const result = await service.deploy(
      "sec-proj-2",
      "sec-fn-2",
      artifact,
      () => Promise.resolve(true),
    );

    assertEquals(result.state, "Deployed");
    const active = await service.getActiveRevision("sec-proj-2", "sec-fn-2");
    assertNotEquals(active, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Security: PLAT-1 - Control plane rollback never evaluates customer code", async () => {
  // spec: contracts/platform.contract.md#PLAT-1 — Pointer flip must not invoke customer code
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const sentinelKey = "__RAILFOG_RB_SENTINEL__";
    (globalThis as Record<string, unknown>)[sentinelKey] = false;

    const payload = `(globalThis as any)["${sentinelKey}"] = true;`;
    const art1 = await createSampleArtifact(payload);
    const art2 = await createSampleArtifact('export default () => "safe";');

    const r1 = await service.deploy(
      "sec-proj-3",
      "sec-fn-3",
      art1,
      () => Promise.resolve(true),
    );
    await service.deploy(
      "sec-proj-3",
      "sec-fn-3",
      art2,
      () => Promise.resolve(true),
    );

    // Rollback to r1
    await service.rollback("sec-proj-3", "sec-fn-3", r1.revisionId);

    assertEquals(
      (globalThis as Record<string, unknown>)[sentinelKey],
      false,
      "PLAT-1 VIOLATION: Customer code was evaluated during rollback",
    );

    delete (globalThis as Record<string, unknown>)[sentinelKey];
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// ============================================================================
// Integration Tests: T-0405 Deployment Health Check Gating
// ============================================================================

Deno.test("Integration: AC4 - Failing health check with HealthProbeOptions transitions revision to Failed, active: false and preserves prior revision", async () => {
  // spec: contracts/platform.contract.md#PLAT-3 — fail: revision stays inactive, previous revision keeps serving
  // spec: contracts/functions.contract.md#FN-3 — Ready -> Failed
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const artifact1 = await createSampleArtifact(
      'export default () => new Response("v1");',
    );
    const r1 = await service.deploy(
      "proj-fail",
      "fn-fail",
      artifact1,
      () => Promise.resolve(true),
    );
    assertEquals(r1.state, "Deployed");
    assertEquals(r1.active, true);

    const artifact2 = await createSampleArtifact(
      'export default () => new Response("v2");',
    );
    const options:
      import("../../apps/api/health-checker.ts").HealthProbeOptions = {
        probeUrl: "http://localhost:8080/health",
        fetchFn: () => Promise.resolve(new Response(null, { status: 500 })),
        probeIntervalMs: 10,
        totalTimeoutMs: 100,
        consecutiveSuccessesRequired: 3,
      };

    const result = await service.deploy(
      "proj-fail",
      "fn-fail",
      artifact2,
      options,
    );

    assertEquals(result.state, "Failed");
    assertEquals(result.active, false);

    // Existing active revision pointer remains unchanged (r1 continues serving)
    const activeRecord = await service.getActiveRevision(
      "proj-fail",
      "fn-fail",
    );
    assertNotEquals(activeRecord, null);
    assertEquals(activeRecord!.id, r1.revisionId);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Integration: AC5 - Passing health check with HealthProbeOptions transitions revision to Deployed, active: true", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const storage = new LocalFSProvider(tempDir);
    const service = new DeploymentService(storage);

    const artifact = await createSampleArtifact();
    const options:
      import("../../apps/api/health-checker.ts").HealthProbeOptions = {
        probeUrl: "http://localhost:8080/health",
        fetchFn: () => Promise.resolve(new Response(null, { status: 200 })),
        probeIntervalMs: 10,
        consecutiveSuccessesRequired: 3,
      };

    const result = await service.deploy(
      "proj-pass",
      "fn-pass",
      artifact,
      options,
    );

    assertEquals(result.state, "Deployed");
    assertEquals(result.active, true);

    const activeRecord = await service.getActiveRevision(
      "proj-pass",
      "fn-pass",
    );
    assertNotEquals(activeRecord, null);
    assertEquals(activeRecord!.id, result.revisionId);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
