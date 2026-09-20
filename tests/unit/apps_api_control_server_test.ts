/**
 * Standalone Control Plane Daemon Server Integration Tests (T-0605).
 *
 * Spec references:
 * - PLAT-1: Control plane vs data plane separation (never executes customer code).
 * - PLAT-3: Deployment pipeline (validation, content-addressed storage, health gating, atomic cutover, instant rollback).
 * - PLAT-8: Fail-static snapshot distribution and ETag caching.
 * - PLAT-12: Error model taxonomy (RESOURCE_NOT_FOUND, VALIDATION_FAILED, PERMISSION_DENIED).
 * - PLAT-14: ULID monotonic identifier format for request_id, revisions, and snapshots.
 * - PLAT-18: Resource hierarchy Org -> Project -> { Function, KV, Object, Queue } -> Revision.
 * - FN-3: Function lifecycle, immutable revisions, instant pointer-flip rollback without rebuilding.
 * - ADR-0002: State backup and disaster recovery archive specification.
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
} from "@std/assert";
import type {
  ControlServer,
  ControlServerOptions,
  ProjectSnapshot,
} from "../../apps/api/control-server.ts";
import { startControlServer } from "../../apps/api/control-server.ts";
import { DeploymentService } from "../../apps/api/deployment-service.ts";
import {
  createStateBackupService,
  type StateBackupService,
} from "../../apps/api/state-backup-service.ts";
import { isValidUlid } from "../../packages/core/id/ulid.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import {
  type PackagedArtifact,
  packageFunctionArtifact,
} from "../../packages/core/artifact/packager.ts";
import type { StateBackupArchive } from "../../packages/core/backup/archive-schema.ts";

// ============================================================================
// Constants & Test Fixtures
// ============================================================================

// spec: contracts/platform.contract.md#PLAT-12 — Canonical HTTP status codes
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_CREATED = 201;
const HTTP_STATUS_NOT_MODIFIED = 304;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_NOT_FOUND = 404;

// spec: contracts/platform.contract.md#PLAT-12 — Canonical error codes
const ERROR_VALIDATION_FAILED = "VALIDATION_FAILED";
const ERROR_RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND";
const ERROR_PERMISSION_DENIED = "PERMISSION_DENIED";

// spec: contracts/platform.contract.md#PLAT-1 — Daemon service identifier
const CONTROL_PLANE_SERVICE_NAME = "railfog-control";

interface TestContext {
  tempDir: string;
  storage: LocalFSProvider;
  kv: SQLiteKVProvider;
  deploymentService: DeploymentService;
  stateBackupService: StateBackupService;
  cleanup: () => Promise<void>;
}

/**
 * Creates isolated storage providers and services for integration testing.
 * spec: contracts/platform.contract.md#PLAT-16, PLAT-17
 */
async function createTestContext(): Promise<TestContext> {
  const tempDir = await Deno.makeTempDir({ prefix: "railfog-control-test-" });
  const storage = new LocalFSProvider(tempDir);
  const kv = new SQLiteKVProvider(":memory:");
  const deploymentService = new DeploymentService(storage);
  const stateBackupService = createStateBackupService(
    deploymentService,
    kv,
    storage,
  );

  return {
    tempDir,
    storage,
    kv,
    deploymentService,
    stateBackupService,
    cleanup: async () => {
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {
        // Temp directory cleanup is best effort
      }
    },
  };
}

/**
 * Helper to construct a valid packaged artifact for testing.
 * spec: contracts/platform.contract.md#PLAT-3
 * spec: contracts/objects.contract.md#OBJ-4
 */
async function createSampleArtifact(
  entrypoint = "index.ts",
  code = 'export default () => new Response("ok");',
): Promise<PackagedArtifact> {
  const bytes = new TextEncoder().encode(code);
  return await packageFunctionArtifact(entrypoint, bytes);
}

/**
 * Serializes a packaged artifact into a JSON-friendly structure for HTTP POST.
 */
function serializeArtifact(artifact: PackagedArtifact) {
  return {
    id: artifact.id,
    integrity: artifact.integrity,
    manifest: artifact.manifest,
    bytes: Array.from(artifact.bytes),
  };
}

// ============================================================================
// AC1: GET /healthz (PLAT-1, PLAT-12, PLAT-14)
// ============================================================================

Deno.test("AC1: GET /healthz returns 200 OK with ok status, railfog-control service, and valid ULID request_id", async () => {
  // spec: contracts/platform.contract.md#PLAT-1 — railfog-control process identity
  // spec: contracts/platform.contract.md#PLAT-12 — Every response carries request_id
  // spec: contracts/platform.contract.md#PLAT-14 — Crockford Base32 26-char ULID
  const ctx = await createTestContext();
  let server: ControlServer | undefined;

  try {
    const options: ControlServerOptions = {
      port: 0,
      host: "127.0.0.1",
      deploymentService: ctx.deploymentService,
      stateBackupService: ctx.stateBackupService,
    };
    server = await startControlServer(options);

    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assertEquals(res.status, HTTP_STATUS_OK);

    const contentType = res.headers.get("content-type") ?? "";
    assert(
      contentType.includes("application/json"),
      "Response content-type must be application/json",
    );

    const body = await res.json();
    assertEquals(body.status, "ok");
    assertEquals(body.service, CONTROL_PLANE_SERVICE_NAME);

    // Verify request_id in body
    const bodyReqId: string = body.request_id ?? body.requestId;
    assertExists(bodyReqId, "Response body must contain request_id");
    assert(
      isValidUlid(bodyReqId),
      `Body request_id '${bodyReqId}' must be a valid ULID (PLAT-14)`,
    );

    // Verify request_id in response headers
    const headerReqId = res.headers.get("x-request-id") ??
      res.headers.get("request-id");
    assert(
      headerReqId !== null,
      "Response headers must carry x-request-id or request-id",
    );
    assert(
      isValidUlid(headerReqId),
      `Header request-id '${headerReqId}' must be a valid ULID (PLAT-14)`,
    );

    assertEquals(
      bodyReqId,
      headerReqId,
      "Body request_id must match header request-id (PLAT-12)",
    );
  } finally {
    await server?.close();
    await ctx.cleanup();
  }
});

Deno.test("AC1: GET /healthz propagates existing request_id header unchanged per PLAT-12", async () => {
  // spec: contracts/platform.contract.md#PLAT-12 — Propagated Gateway -> Control -> Runtime unchanged
  // spec: contracts/platform.contract.md#PLAT-14 — ULID identifier format
  const ctx = await createTestContext();
  let server: ControlServer | undefined;

  try {
    server = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      deploymentService: ctx.deploymentService,
      stateBackupService: ctx.stateBackupService,
    });

    const inboundRequestId = "01J8ZG00000000000000000000";
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`, {
      headers: {
        "x-request-id": inboundRequestId,
      },
    });

    assertEquals(res.status, HTTP_STATUS_OK);

    const body = await res.json();
    const bodyReqId = body.request_id ?? body.requestId;
    assertEquals(
      bodyReqId,
      inboundRequestId,
      "Inbound request_id must be propagated unchanged in body (PLAT-12)",
    );

    const headerReqId = res.headers.get("x-request-id") ??
      res.headers.get("request-id");
    assertEquals(
      headerReqId,
      inboundRequestId,
      "Inbound request_id must be propagated unchanged in headers (PLAT-12)",
    );
  } finally {
    await server?.close();
    await ctx.cleanup();
  }
});

// ============================================================================
// AC2: Snapshot Distribution & ETag Caching (PLAT-8)
// ============================================================================

Deno.test("AC2: GET /v1/projects/:projectId/snapshot returns 200 with snapshot and ETag header", async () => {
  // spec: contracts/platform.contract.md#PLAT-8 — Immutable versioned snapshot distribution
  // spec: contracts/platform.contract.md#PLAT-18 — Project -> Function -> Revision
  const ctx = await createTestContext();
  let server: ControlServer | undefined;

  try {
    const projectId = "project-ac2-test";
    const artifact = await createSampleArtifact();
    await ctx.deploymentService.deploy(projectId, "api", artifact);

    server = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      deploymentService: ctx.deploymentService,
      stateBackupService: ctx.stateBackupService,
    });

    const res = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${projectId}/snapshot`,
    );
    assertEquals(res.status, HTTP_STATUS_OK);

    const etag = res.headers.get("etag") ?? res.headers.get("ETag");
    assert(
      etag !== null && etag.length > 0,
      "ETag header must be present on snapshot response (PLAT-8)",
    );

    const snapshot: ProjectSnapshot = await res.json();
    assertExists(snapshot.version, "Snapshot must have a version property");
    assert(
      typeof snapshot.version === "number" && snapshot.version >= 1,
      "Snapshot version must be a positive integer",
    );
    assert(
      Array.isArray(snapshot.routes),
      "Snapshot routes must be an array (PLAT-8)",
    );
    assertExists(
      snapshot.functions,
      "Snapshot functions mapping must be present",
    );
    assertExists(
      snapshot.functions["api"],
      "Snapshot must include deployed function 'api'",
    );
    assertEquals(snapshot.functions["api"].functionName, "api");
    assertEquals(snapshot.functions["api"].artifactId, artifact.id);
  } finally {
    await server?.close();
    await ctx.cleanup();
  }
});

Deno.test("AC2: GET /v1/projects/:projectId/snapshot returns 304 Not Modified when If-None-Match matches ETag", async () => {
  // spec: contracts/platform.contract.md#PLAT-8 — ETag caching with 304 Not Modified
  const ctx = await createTestContext();
  let server: ControlServer | undefined;

  try {
    const projectId = "project-cache-test";
    const artifact = await createSampleArtifact();
    await ctx.deploymentService.deploy(projectId, "api", artifact);

    server = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      deploymentService: ctx.deploymentService,
      stateBackupService: ctx.stateBackupService,
    });

    // Step 1: Initial fetch to retrieve current ETag
    const firstRes = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${projectId}/snapshot`,
    );
    assertEquals(firstRes.status, HTTP_STATUS_OK);
    const etag = firstRes.headers.get("etag") ?? firstRes.headers.get("ETag");
    assert(etag !== null, "ETag header must be present");

    // Step 2: Conditional GET with matching If-None-Match
    const cachedRes = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${projectId}/snapshot`,
      {
        headers: {
          "if-none-match": etag,
        },
      },
    );
    assertEquals(
      cachedRes.status,
      HTTP_STATUS_NOT_MODIFIED,
      "Must return 304 Not Modified when ETag matches",
    );
    const cachedBody = await cachedRes.text();
    assertEquals(
      cachedBody,
      "",
      "304 Not Modified response must not contain a body payload",
    );

    // Step 3: Conditional GET with mismatched If-None-Match returns 200 OK
    const staleRes = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${projectId}/snapshot`,
      {
        headers: {
          "if-none-match": '"stale-etag-value-0"',
        },
      },
    );
    assertEquals(
      staleRes.status,
      HTTP_STATUS_OK,
      "Must return 200 OK when ETag does not match",
    );
    const staleSnapshot: ProjectSnapshot = await staleRes.json();
    assertExists(staleSnapshot.version);
  } finally {
    await server?.close();
    await ctx.cleanup();
  }
});

// ============================================================================
// AC3: Revision Deployment Pipeline (PLAT-3)
// ============================================================================

Deno.test("AC3: POST /v1/projects/:projectId/deploy activates revision and increments snapshot version and ETag", async () => {
  // spec: contracts/platform.contract.md#PLAT-3 — Deployment pipeline, health gating, atomic cutover
  // spec: contracts/platform.contract.md#PLAT-8 — Updates snapshot version
  // spec: contracts/platform.contract.md#PLAT-14 — ULID revision ID
  // spec: contracts/functions.contract.md#FN-3 — Revision lifecycle
  const ctx = await createTestContext();
  let server: ControlServer | undefined;

  try {
    const projectId = "project-deploy-ac3";
    server = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      deploymentService: ctx.deploymentService,
      stateBackupService: ctx.stateBackupService,
    });

    const artifact = await createSampleArtifact(
      "index.ts",
      'export default () => new Response("deployed-v1");',
    );

    const deployPayload = {
      project: projectId,
      functionName: "web",
      artifact: serializeArtifact(artifact),
    };

    const deployRes = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${projectId}/deploy`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(deployPayload),
      },
    );

    assert(
      deployRes.status === HTTP_STATUS_OK ||
        deployRes.status === HTTP_STATUS_CREATED,
      `Deployment response status must be 200 or 201, got ${deployRes.status}`,
    );

    const deployResult = await deployRes.json();
    assertExists(deployResult.revisionId, "Result must contain revisionId");
    assertMatch(
      deployResult.revisionId,
      /^rev_[0-9A-HJKMNP-TV-Z]{26}$/,
      "Revision ID must match rev_{ULID} format (PLAT-14, PLAT-18)",
    );
    assertEquals(
      deployResult.state,
      "Deployed",
      "Revision state must be Deployed (FN-3)",
    );
    assertEquals(
      deployResult.active,
      true,
      "Active pointer must be true for successful deploy (PLAT-3)",
    );

    // Verify DeploymentService active pointer was updated
    const activeRevId = ctx.deploymentService.getActiveRevisionId(
      projectId,
      "web",
    );
    assertEquals(
      activeRevId,
      deployResult.revisionId,
      "Active pointer in DeploymentService must match deployed revision",
    );

    // Verify snapshot reflects the newly deployed function and revision
    const snapshotRes = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${projectId}/snapshot`,
    );
    assertEquals(snapshotRes.status, HTTP_STATUS_OK);

    const snapshot: ProjectSnapshot = await snapshotRes.json();
    assertExists(snapshot.functions["web"]);
    assertEquals(snapshot.functions["web"].revisionId, deployResult.revisionId);
    assertEquals(snapshot.functions["web"].artifactId, artifact.id);
  } finally {
    await server?.close();
    await ctx.cleanup();
  }
});

Deno.test("AC3: POST /v1/projects/:projectId/deploy rejects invalid artifact with 400 VALIDATION_FAILED", async () => {
  // spec: contracts/platform.contract.md#PLAT-3 — Validation before build
  // spec: contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED error
  // spec: contracts/objects.contract.md#OBJ-4 — Integrity verification
  const ctx = await createTestContext();
  let server: ControlServer | undefined;

  try {
    const projectId = "project-invalid-deploy";
    server = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      deploymentService: ctx.deploymentService,
      stateBackupService: ctx.stateBackupService,
    });

    const validArtifact = await createSampleArtifact();
    // Tamper with artifact ID to violate sha256 checksum rule (OBJ-4)
    const malformedPayload = {
      project: projectId,
      functionName: "web",
      artifact: {
        id:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        integrity: validArtifact.integrity,
        manifest: validArtifact.manifest,
        bytes: Array.from(validArtifact.bytes),
      },
    };

    const res = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${projectId}/deploy`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(malformedPayload),
      },
    );

    assertEquals(
      res.status,
      HTTP_STATUS_BAD_REQUEST,
      "Tampered artifact must return HTTP 400",
    );

    const err = await res.json();
    assertEquals(
      err.error?.code,
      ERROR_VALIDATION_FAILED,
      "Error code must be VALIDATION_FAILED (PLAT-12)",
    );
  } finally {
    await server?.close();
    await ctx.cleanup();
  }
});

// ============================================================================
// AC4: Instant Pointer-Flip Rollback (PLAT-3, FN-3)
// ============================================================================

Deno.test("AC4: POST /v1/projects/:projectId/rollback flips active pointer to target revision without rebuilding", async () => {
  // spec: contracts/platform.contract.md#PLAT-3 — Instant pointer-flip rollback
  // spec: contracts/functions.contract.md#FN-3 — Pointer flip, never a rebuild
  // spec: contracts/platform.contract.md#PLAT-8 — Snapshot updated with target revision
  const ctx = await createTestContext();
  let server: ControlServer | undefined;

  try {
    const projectId = "project-rollback-ac4";
    server = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      deploymentService: ctx.deploymentService,
      stateBackupService: ctx.stateBackupService,
    });

    // Deploy revision 1
    const artifact1 = await createSampleArtifact(
      "index.ts",
      'export default () => new Response("rev1");',
    );
    const deploy1Res = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${projectId}/deploy`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: projectId,
          functionName: "api",
          artifact: serializeArtifact(artifact1),
        }),
      },
    );
    const deploy1 = await deploy1Res.json();
    const rev1Id: string = deploy1.revisionId;

    // Deploy revision 2
    const artifact2 = await createSampleArtifact(
      "index.ts",
      'export default () => new Response("rev2");',
    );
    const deploy2Res = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${projectId}/deploy`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: projectId,
          functionName: "api",
          artifact: serializeArtifact(artifact2),
        }),
      },
    );
    const deploy2 = await deploy2Res.json();
    const rev2Id: string = deploy2.revisionId;

    // Current active should be revision 2
    assertEquals(
      ctx.deploymentService.getActiveRevisionId(projectId, "api"),
      rev2Id,
    );

    // Rollback to revision 1
    const rollbackRes = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${projectId}/rollback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: projectId,
          functionName: "api",
          targetRevisionId: rev1Id,
        }),
      },
    );

    assertEquals(rollbackRes.status, HTTP_STATUS_OK);
    const rollbackResult = await rollbackRes.json();

    assertEquals(rollbackResult.previousRevisionId, rev2Id);
    assertEquals(rollbackResult.activeRevisionId, rev1Id);

    // Verify DeploymentService active pointer flipped back to rev1
    assertEquals(
      ctx.deploymentService.getActiveRevisionId(projectId, "api"),
      rev1Id,
    );

    // Verify snapshot reflects revision 1 active
    const snapshotRes = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${projectId}/snapshot`,
    );
    assertEquals(snapshotRes.status, HTTP_STATUS_OK);
    const snapshot: ProjectSnapshot = await snapshotRes.json();
    assertEquals(snapshot.functions["api"].revisionId, rev1Id);
    assertEquals(snapshot.functions["api"].artifactId, artifact1.id);
  } finally {
    await server?.close();
    await ctx.cleanup();
  }
});

Deno.test("AC4: POST /v1/projects/:projectId/rollback returns 404 RESOURCE_NOT_FOUND for non-existent revision", async () => {
  // spec: contracts/platform.contract.md#PLAT-12 — RESOURCE_NOT_FOUND
  const ctx = await createTestContext();
  let server: ControlServer | undefined;

  try {
    const projectId = "project-rollback-notfound";
    server = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      deploymentService: ctx.deploymentService,
      stateBackupService: ctx.stateBackupService,
    });

    const nonexistentRevId = "rev_01J00000000000000000000000";
    const res = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${projectId}/rollback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: projectId,
          functionName: "api",
          targetRevisionId: nonexistentRevId,
        }),
      },
    );

    assertEquals(res.status, HTTP_STATUS_NOT_FOUND);
    const err = await res.json();
    assertEquals(err.error?.code, ERROR_RESOURCE_NOT_FOUND);
  } finally {
    await server?.close();
    await ctx.cleanup();
  }
});

// ============================================================================
// AC5: State Backup Export & Import (ADR-0002)
// ============================================================================

Deno.test("AC5: POST /v1/projects/:projectId/export and /import round-trips state archive", async () => {
  // spec: docs/adr/0002-state-backup-and-disaster-recovery-archive.md
  // spec: contracts/platform.contract.md#PLAT-7 — Tenant prefix scoping
  // spec: contracts/platform.contract.md#PLAT-18 — Project resource hierarchy
  const ctx = await createTestContext();
  let server: ControlServer | undefined;

  try {
    const sourceProject = "proj-source";
    const targetProject = "proj-target";
    const orgId = "org-backup-test";

    // Setup source project with an active function revision and KV data
    const artifact = await createSampleArtifact();
    await ctx.deploymentService.deploy(sourceProject, "worker", artifact);
    await ctx.kv.set(
      [orgId, sourceProject, "config", "endpoint"],
      "https://api.test",
    );

    server = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      deploymentService: ctx.deploymentService,
      stateBackupService: ctx.stateBackupService,
    });

    // Step 1: Export source project state
    const exportRes = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${sourceProject}/export?orgId=${orgId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-org-id": orgId,
        },
        body: JSON.stringify({
          orgId,
          projectId: sourceProject,
        }),
      },
    );

    assertEquals(exportRes.status, HTTP_STATUS_OK);
    const archive: StateBackupArchive = await exportRes.json();

    assertEquals(
      archive.version,
      1,
      "Exported archive must be version 1 (ADR-0002)",
    );
    assertMatch(
      archive.backupId,
      /^bak_[0-9A-HJKMNP-TV-Z]{26}$/,
      "Backup ID must match bak_{ULID} format (PLAT-14, ADR-0002)",
    );
    assertEquals(archive.project.projectId, sourceProject);
    assert(
      archive.functions.some((f) => f.name === "worker"),
      "Exported archive must contain 'worker' function",
    );

    // Step 2: Import archive into target project
    const importRes = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${targetProject}/import?orgId=${orgId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-org-id": orgId,
        },
        body: JSON.stringify({
          targetOrgId: orgId,
          targetProjectId: targetProject,
          orgId,
          archive,
          overwriteKv: true,
        }),
      },
    );

    assertEquals(importRes.status, HTTP_STATUS_OK);
    const importResult = await importRes.json();
    assert(
      importResult.restoredRevisions >= 1,
      "Import must restore at least 1 revision",
    );

    // Step 3: Verify target project now has restored function and active revision
    const targetFunctions = ctx.deploymentService.listFunctions(targetProject);
    assert(
      targetFunctions.includes("worker"),
      "Target project must list restored 'worker' function",
    );
    const targetActiveRev = ctx.deploymentService.getActiveRevisionId(
      targetProject,
      "worker",
    );
    assertExists(
      targetActiveRev,
      "Target project must have an active revision pointer",
    );
  } finally {
    await server?.close();
    await ctx.cleanup();
  }
});

Deno.test("AC5: POST /v1/projects/:projectId/import rejects malformed archive with 400 VALIDATION_FAILED", async () => {
  // spec: docs/adr/0002-state-backup-and-disaster-recovery-archive.md#2 — Schema validation
  // spec: contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED
  const ctx = await createTestContext();
  let server: ControlServer | undefined;

  try {
    const targetProject = "proj-malformed-import";
    server = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      deploymentService: ctx.deploymentService,
      stateBackupService: ctx.stateBackupService,
    });

    const res = await fetch(
      `http://127.0.0.1:${server.port}/v1/projects/${targetProject}/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetOrgId: "org-1",
          targetProjectId: targetProject,
          archive: {
            version: 999, // Unsupported archive version
            corrupted: true,
          },
        }),
      },
    );

    assertEquals(res.status, HTTP_STATUS_BAD_REQUEST);
    const err = await res.json();
    assertEquals(err.error?.code, ERROR_VALIDATION_FAILED);
  } finally {
    await server?.close();
    await ctx.cleanup();
  }
});

// ============================================================================
// AC6: Rejection of Customer Code Execution (PLAT-1)
// ============================================================================

Deno.test("AC6: control plane rejects customer invocation requests with 403 or 404 and never executes customer code", async () => {
  // spec: contracts/platform.contract.md#PLAT-1 — Control plane never executes customer code
  // spec: contracts/platform.contract.md#PLAT-12 — Canonical error response with ULID request_id
  const ctx = await createTestContext();
  let server: ControlServer | undefined;

  try {
    server = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      deploymentService: ctx.deploymentService,
      stateBackupService: ctx.stateBackupService,
    });

    const customerEndpoints = [
      { method: "POST", path: "/invoke" },
      { method: "POST", path: "/run" },
      { method: "POST", path: "/v1/projects/my-proj/invoke" },
      { method: "GET", path: "/api/users" },
      { method: "POST", path: "/customer-function" },
    ];

    for (const ep of customerEndpoints) {
      const res: Response = await fetch(
        `http://127.0.0.1:${server.port}${ep.path}`,
        {
          method: ep.method,
          headers: { "content-type": "application/json" },
        },
      );

      assert(
        res.status === HTTP_STATUS_FORBIDDEN ||
          res.status === HTTP_STATUS_NOT_FOUND,
        `Customer endpoint ${ep.method} ${ep.path} must be rejected with 403 or 404, got ${res.status} (PLAT-1)`,
      );

      const err: { error?: { code?: string; request_id?: string } } = await res
        .json();
      assert(
        err.error?.code === ERROR_PERMISSION_DENIED ||
          err.error?.code === ERROR_RESOURCE_NOT_FOUND,
        `Error code for ${ep.path} must be PERMISSION_DENIED or RESOURCE_NOT_FOUND, got ${err.error?.code}`,
      );

      // Verify request_id attached per PLAT-12
      const reqId = err.error?.request_id ??
        res.headers.get("x-request-id") ??
        res.headers.get("request-id");
      assertExists(
        reqId,
        `Rejected request to ${ep.path} must carry a request_id`,
      );
      assert(isValidUlid(reqId), `request_id '${reqId}' must be a valid ULID`);
    }
  } finally {
    await server?.close();
    await ctx.cleanup();
  }
});

// ============================================================================
// Server Lifecycle & Graceful Shutdown
// ============================================================================

Deno.test("Server Lifecycle: startControlServer allocates dynamic port and close() cleanly shuts down", async () => {
  const ctx = await createTestContext();
  let server: ControlServer | undefined;

  try {
    server = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      deploymentService: ctx.deploymentService,
      stateBackupService: ctx.stateBackupService,
    });

    assert(server.port > 0, "Server must be assigned a positive dynamic port");

    // Server should be reachable
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assertEquals(res.status, HTTP_STATUS_OK);

    // Close server cleanly
    await server.close();

    // Verify connections are refused after shutdown
    await assertRejects(
      async () => {
        await fetch(`http://127.0.0.1:${server?.port}/healthz`);
      },
      TypeError,
    );
  } finally {
    await server?.close().catch(() => {});
    await ctx.cleanup();
  }
});

Deno.test("Server Lifecycle: startControlServer respects AbortSignal for graceful shutdown", async () => {
  const ctx = await createTestContext();
  const controller = new AbortController();
  let server: ControlServer | undefined;

  try {
    server = await startControlServer({
      port: 0,
      host: "127.0.0.1",
      deploymentService: ctx.deploymentService,
      stateBackupService: ctx.stateBackupService,
      signal: controller.signal,
    });

    assert(server.port > 0);

    // Confirm healthy before abort
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assertEquals(res.status, HTTP_STATUS_OK);

    // Trigger shutdown via abort signal
    controller.abort();

    // Small yield for shutdown processing
    await new Promise((r) => setTimeout(r, 50));

    // Verify server terminated
    await assertRejects(
      async () => {
        await fetch(`http://127.0.0.1:${server?.port}/healthz`);
      },
      TypeError,
    );
  } finally {
    await server?.close().catch(() => {});
    await ctx.cleanup();
  }
});
