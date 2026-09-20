/**
 * Tests for State Export and Disaster Recovery Service (T-0411).
 *
 * Spec references:
 * - PLAT-7: Multi-tenant physical prefixing {org_id}/{project_id}/{resource}/{key}
 * - PLAT-12: Error model (VALIDATION_FAILED, CONFLICT, RESOURCE_NOT_FOUND)
 * - PLAT-14: ULID monotonic identifier format (bak_{ULID}, rev_{ULID})
 * - PLAT-18: Resource hierarchy Org -> Project -> { Function, KV, Object, Queue }
 * - OBJ-1: Durable binary storage for backups under backups/{backup_id}.json
 * - OBJ-4: Cryptographic content addressing (sha256 hex id and SRI integrity)
 * - FN-3: Function lifecycle, immutable revisions, pointer flip rollback
 * - ADR-0002: State backup and disaster recovery archive specification
 */

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";
import { computeSha256 } from "../../packages/core/crypto/content-address.ts";
import { LocalFSProvider } from "../../providers/objects/local-fs-provider.ts";
import { SQLiteKVProvider } from "../../providers/kv/sqlite-provider.ts";
import { DeploymentService } from "../../apps/api/deployment-service.ts";
import {
  type PackagedArtifact,
  packageFunctionArtifact,
} from "../../packages/core/artifact/packager.ts";
import {
  ConflictError,
  ValidationFailedError,
} from "../../packages/errors/mod.ts";
import {
  type BackupFunctionRecord,
  type BackupKvEntry,
  type BackupObjectRecord,
  type BackupRevisionRecord,
  type StateBackupArchive,
  validateBackupArchive,
} from "../../packages/core/backup/archive-schema.ts";
import { createStateBackupService } from "../../apps/api/state-backup-service.ts";

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

/**
 * Helper to create a test environment with real SQLite KV, LocalFS Object storage,
 * and DeploymentService.
 */
async function createTestContext() {
  const tempDir = await Deno.makeTempDir();
  const objectProvider = new LocalFSProvider(tempDir);
  const kvProvider = new SQLiteKVProvider(":memory:");
  const deploymentService = new DeploymentService(objectProvider);
  const backupService = createStateBackupService(
    deploymentService,
    kvProvider,
    objectProvider,
  );

  return {
    tempDir,
    objectProvider,
    kvProvider,
    deploymentService,
    backupService,
  };
}

// ============================================================================
// Unit Tests: Export archive construction matching StateBackupArchive v1 schema
// ============================================================================

Deno.test({
  name:
    "exportProject - AC1: constructs valid StateBackupArchive v1 matching schema (ADR-0002, PLAT-14, PLAT-18)",
  fn: async () => {
    const { backupService } = await createTestContext();
    const orgId = "org_test";
    const projectId = "proj_alpha";

    const archive = await backupService.exportProject({
      orgId,
      projectId,
    });

    // Verify schema version
    assertEquals(archive.version, 1);

    // Verify backupId format: bak_{ULID} (PLAT-14)
    assertMatch(
      archive.backupId,
      /^bak_[0-9A-HJKMNP-TV-Z]{26}$/,
      "backupId must follow bak_{ULID} format",
    );

    // Verify timestamp
    assert(Number.isFinite(archive.createdAt));
    assert(archive.createdAt > 0);

    // Verify project identity (PLAT-18)
    assertEquals(archive.project.orgId, orgId);
    assertEquals(archive.project.projectId, projectId);

    // Verify required collections are present
    assert(Array.isArray(archive.functions));
    assert(Array.isArray(archive.kv));
    assert(Array.isArray(archive.objects));
    assert(Array.isArray(archive.queues));

    // Verify schema validation passes
    const validated = validateBackupArchive(archive);
    assertEquals(validated.backupId, archive.backupId);
  },
});

Deno.test({
  name:
    "exportProject - AC1: persists content-addressed archive JSON under backups/{backup_id}.json in object storage (OBJ-1)",
  fn: async () => {
    const { backupService, objectProvider } = await createTestContext();
    const orgId = "org_test";
    const projectId = "proj_alpha";

    const archive = await backupService.exportProject({
      orgId,
      projectId,
    });

    const backupKey = `backups/${archive.backupId}.json`;
    const stream = await objectProvider.get(backupKey);
    assert(stream !== null, `Expected archive to be stored at ${backupKey}`);

    const storedBytes = await streamToBytes(stream);
    const storedText = new TextDecoder().decode(storedBytes);
    const parsed = JSON.parse(storedText) as StateBackupArchive;

    assertEquals(parsed.backupId, archive.backupId);
    assertEquals(parsed.version, 1);
    assertEquals(parsed.project.projectId, projectId);
  },
});

Deno.test({
  name: "exportProject - AC1: supports custom backupStorageKey when specified",
  fn: async () => {
    const { backupService, objectProvider } = await createTestContext();
    const orgId = "org_test";
    const projectId = "proj_alpha";
    const customKey = "custom/dr-snapshots/snapshot-1.json";

    const archive = await backupService.exportProject({
      orgId,
      projectId,
      backupStorageKey: customKey,
    });

    const stream = await objectProvider.get(customKey);
    assert(stream !== null, `Expected archive to be stored at ${customKey}`);

    const storedBytes = await streamToBytes(stream);
    const parsed = JSON.parse(
      new TextDecoder().decode(storedBytes),
    ) as StateBackupArchive;
    assertEquals(parsed.backupId, archive.backupId);
  },
});

Deno.test({
  name:
    "exportProject - AC1: serializes functions, revisions, and activeRevisionId correctly (PLAT-18, FN-3, OBJ-4)",
  fn: async () => {
    const { backupService, deploymentService } = await createTestContext();
    const orgId = "org_test";
    const projectId = "proj_functions";

    // Deploy rev 1 for 'api'
    const art1 = await createSampleArtifact(
      'export default () => new Response("rev1");',
    );
    const dep1 = await deploymentService.deploy(projectId, "api", art1);

    // Deploy rev 2 for 'api'
    const art2 = await createSampleArtifact(
      'export default () => new Response("rev2");',
    );
    const dep2 = await deploymentService.deploy(projectId, "api", art2);

    // Deploy rev 1 for 'worker'
    const artWorker = await createSampleArtifact(
      'export default () => new Response("worker");',
    );
    const depWorker = await deploymentService.deploy(
      projectId,
      "worker",
      artWorker,
    );

    const archive = await backupService.exportProject({ orgId, projectId });

    assertEquals(archive.functions.length, 2);

    const apiFn = archive.functions.find((f: BackupFunctionRecord) =>
      f.name === "api"
    );
    assert(apiFn !== undefined);
    assertEquals(apiFn.activeRevisionId, dep2.revisionId);
    assertEquals(apiFn.revisions.length, 2);

    const rev1 = apiFn.revisions.find((r: BackupRevisionRecord) =>
      r.id === dep1.revisionId
    );
    assert(rev1 !== undefined);
    assertEquals(rev1.artifactId, art1.id);
    assertEquals(rev1.integrity, art1.integrity);
    assertEquals(rev1.state, "Deployed");

    const workerFn = archive.functions.find((f: BackupFunctionRecord) =>
      f.name === "worker"
    );
    assert(workerFn !== undefined);
    assertEquals(workerFn.activeRevisionId, depWorker.revisionId);
    assertEquals(workerFn.revisions.length, 1);
  },
});

Deno.test({
  name:
    "exportProject - AC1: serializes KV entries scoped to tenant project prefix (PLAT-7, ADR-0002)",
  fn: async () => {
    const { backupService, kvProvider } = await createTestContext();
    const orgId = "org_test";
    const projectId = "proj_kv";

    // Insert KV keys for proj_kv: physical_key = [orgId, projectId, namespace, ...callerKey]
    await kvProvider.set([orgId, projectId, "sessions", "sess_1"], {
      user: "alice",
    });
    await kvProvider.set([orgId, projectId, "sessions", "sess_2"], {
      user: "bob",
    });
    await kvProvider.set([orgId, projectId, "config", "theme"], "dark");

    // Insert KV keys for another project (must NOT be exported)
    await kvProvider.set(["other_org", "other_proj", "sessions", "leak"], {
      user: "intruder",
    });

    const archive = await backupService.exportProject({ orgId, projectId });

    assertEquals(archive.kv.length, 3);
    const session1 = archive.kv.find((k: BackupKvEntry) =>
      k.namespace === "sessions" && k.key.join("/") === "sess_1"
    );
    assert(session1 !== undefined);
    assertEquals(session1.value, { user: "alice" });

    const themeEntry = archive.kv.find((k: BackupKvEntry) =>
      k.namespace === "config" && k.key.join("/") === "theme"
    );
    assert(themeEntry !== undefined);
    assertEquals(themeEntry.value, "dark");

    // Ensure other tenant's data was not captured
    const leaked = archive.kv.find((k: BackupKvEntry) =>
      k.key.includes("leak")
    );
    assertEquals(leaked, undefined);
  },
});

Deno.test({
  name:
    "exportProject - AC1: serializes Objects with inline base64 for small payloads and content references for large (OBJ-1, OBJ-4, ADR-0002)",
  fn: async () => {
    const { backupService, objectProvider } = await createTestContext();
    const orgId = "org_test";
    const projectId = "proj_obj";

    // Small object (< 256 KB)
    const smallContent = new TextEncoder().encode("hello world small object");
    const smallKey = `${orgId}/${projectId}/uploads/avatar.png`;
    await objectProvider.put(smallKey, smallContent.buffer as ArrayBuffer);

    // Large object (> 256 KB)
    const largeContent = new Uint8Array(300 * 1024); // 300 KB
    largeContent.fill(42);
    const largeKey = `${orgId}/${projectId}/datasets/large.bin`;
    await objectProvider.put(largeKey, largeContent.buffer as ArrayBuffer);

    // Other tenant object (must NOT be exported)
    await objectProvider.put(
      "other_org/other_proj/uploads/secret.png",
      smallContent.buffer as ArrayBuffer,
    );

    const archive = await backupService.exportProject({ orgId, projectId });

    assertEquals(archive.objects.length, 2);

    const smallRec = archive.objects.find((o: BackupObjectRecord) =>
      o.key.includes("avatar.png")
    );
    assert(smallRec !== undefined);
    assertEquals(smallRec.store, "uploads");
    assert(smallRec.dataBase64 !== undefined);
    assertEquals(smallRec.dataBase64, encodeBase64(smallContent));

    const largeRec = archive.objects.find((o: BackupObjectRecord) =>
      o.key.includes("large.bin")
    );
    assert(largeRec !== undefined);
    assertEquals(largeRec.store, "datasets");
    assertEquals(largeRec.sizeBytes, 300 * 1024);
    // Per ADR-0002: large objects (>256KB) reference OBJ-1 without inline dataBase64
    assertEquals(largeRec.dataBase64, undefined);

    // Ensure other tenant object is omitted
    const leakedObj = archive.objects.find((o: BackupObjectRecord) =>
      o.key.includes("secret.png")
    );
    assertEquals(leakedObj, undefined);
  },
});

// ============================================================================
// Unit Tests: Import conflict resolution (Revision mismatch & KV overwrite gating)
// ============================================================================

Deno.test({
  name:
    "importProject - AC4: rejects revision with matching ID but conflicting artifact hash with ConflictError (PLAT-12, FN-3, ADR-0002)",
  fn: async () => {
    const { backupService, deploymentService } = await createTestContext();
    const targetOrgId = "org_target";
    const targetProjectId = "proj_conflict";

    // Deploy an existing revision in the target project
    const artA = await createSampleArtifact(
      'export default () => new Response("version A");',
    );
    const depResult = await deploymentService.deploy(
      targetProjectId,
      "api",
      artA,
    );
    const existingRevId = depResult.revisionId;

    // Create an archive containing the SAME revision ID but a DIFFERENT artifact hash
    const fakeMismatchedArtifactId =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const fakeIntegrity = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

    const archive: StateBackupArchive = {
      version: 1,
      backupId: "bak_01J8Z000000000000000000000",
      createdAt: Date.now(),
      project: { orgId: "org_src", projectId: "proj_src", name: "proj_src" },
      functions: [
        {
          name: "api",
          activeRevisionId: existingRevId,
          revisions: [
            {
              id: existingRevId,
              artifactId: fakeMismatchedArtifactId, // Mismatched!
              integrity: fakeIntegrity,
              state: "Deployed",
              createdAt: Date.now(),
              manifest: artA.manifest,
            },
          ],
        },
      ],
      kv: [],
      objects: [],
      queues: [],
    };

    const err = await assertRejects(
      () =>
        backupService.importProject({
          targetOrgId,
          targetProjectId,
          archive,
        }),
      ConflictError,
    );

    assertEquals(err.code, "CONFLICT");
  },
});

Deno.test({
  name:
    "importProject - AC4: preserves matching revision when artifact hash is identical and restores active pointer (FN-3, PLAT-3)",
  fn: async () => {
    const { backupService, deploymentService } = await createTestContext();
    const targetOrgId = "org_target";
    const targetProjectId = "proj_match";

    const artA = await createSampleArtifact(
      'export default () => new Response("identical code");',
    );
    const depResult = await deploymentService.deploy(
      targetProjectId,
      "api",
      artA,
    );
    const existingRevId = depResult.revisionId;

    // Archive has the exact same revisionId, artifactId, and integrity
    const archive: StateBackupArchive = {
      version: 1,
      backupId: "bak_01J8Z000000000000000000001",
      createdAt: Date.now(),
      project: { orgId: "org_src", projectId: "proj_src", name: "proj_src" },
      functions: [
        {
          name: "api",
          activeRevisionId: existingRevId,
          revisions: [
            {
              id: existingRevId,
              artifactId: artA.id,
              integrity: artA.integrity,
              state: "Deployed",
              createdAt: Date.now(),
              manifest: artA.manifest,
            },
          ],
        },
      ],
      kv: [],
      objects: [],
      queues: [],
    };

    const result = await backupService.importProject({
      targetOrgId,
      targetProjectId,
      archive,
    });

    assertEquals(result.restoredRevisions, 1);
    const activeRev = await deploymentService.getActiveRevision(
      targetProjectId,
      "api",
    );
    assertEquals(activeRev?.id, existingRevId);
  },
});

Deno.test({
  name:
    "importProject - AC5: rejects duplicate KV key when overwriteKv is false or omitted with ConflictError (PLAT-12, ADR-0002)",
  fn: async () => {
    const { backupService, kvProvider } = await createTestContext();
    const targetOrgId = "org_target";
    const targetProjectId = "proj_kv_target";

    // Target project already has an existing key
    await kvProvider.set(
      [targetOrgId, targetProjectId, "settings", "theme"],
      "light",
    );

    const archive: StateBackupArchive = {
      version: 1,
      backupId: "bak_01J8Z000000000000000000002",
      createdAt: Date.now(),
      project: { orgId: "org_src", projectId: "proj_src", name: "proj_src" },
      functions: [],
      kv: [
        {
          namespace: "settings",
          key: ["theme"],
          value: "dark",
          version: 1,
        },
      ],
      objects: [],
      queues: [],
    };

    // When overwriteKv is false
    const errFalse = await assertRejects(
      () =>
        backupService.importProject({
          targetOrgId,
          targetProjectId,
          archive,
          overwriteKv: false,
        }),
      ConflictError,
    );
    assertEquals(errFalse.code, "CONFLICT");

    // When overwriteKv is omitted (default is false)
    const errDefault = await assertRejects(
      () =>
        backupService.importProject({
          targetOrgId,
          targetProjectId,
          archive,
        }),
      ConflictError,
    );
    assertEquals(errDefault.code, "CONFLICT");

    // Verify existing key was NOT modified
    const currentVal = await kvProvider.get([
      targetOrgId,
      targetProjectId,
      "settings",
      "theme",
    ]);
    assertEquals(currentVal, "light");
  },
});

Deno.test({
  name:
    "importProject - AC5: overwrites existing KV key when overwriteKv is true (ADR-0002)",
  fn: async () => {
    const { backupService, kvProvider } = await createTestContext();
    const targetOrgId = "org_target";
    const targetProjectId = "proj_kv_target_overwrite";

    await kvProvider.set(
      [targetOrgId, targetProjectId, "settings", "theme"],
      "light",
    );

    const archive: StateBackupArchive = {
      version: 1,
      backupId: "bak_01J8Z000000000000000000003",
      createdAt: Date.now(),
      project: { orgId: "org_src", projectId: "proj_src", name: "proj_src" },
      functions: [],
      kv: [
        {
          namespace: "settings",
          key: ["theme"],
          value: "dark",
          version: 1,
        },
      ],
      objects: [],
      queues: [],
    };

    const result = await backupService.importProject({
      targetOrgId,
      targetProjectId,
      archive,
      overwriteKv: true,
    });

    assertEquals(result.restoredKvKeys, 1);

    // Verify key was updated to 'dark'
    const updatedVal = await kvProvider.get([
      targetOrgId,
      targetProjectId,
      "settings",
      "theme",
    ]);
    assertEquals(updatedVal, "dark");
  },
});

// ============================================================================
// Integration Tests: Full round-trip export, target project import, state verification
// ============================================================================

Deno.test({
  name:
    "Integration - AC1, AC3: full round-trip export and target project import restores complete state",
  fn: async () => {
    const { backupService, deploymentService, kvProvider, objectProvider } =
      await createTestContext();
    const sourceOrg = "org_production";
    const sourceProj = "proj_storefront";
    const targetOrg = "org_disaster_recovery";
    const targetProj = "proj_storefront_restored";

    // 1. Populate source project
    // Functions
    const art = await createSampleArtifact(
      'export default () => new Response("storefront ready");',
    );
    const dep = await deploymentService.deploy(sourceProj, "web", art);

    // KV
    await kvProvider.set([sourceOrg, sourceProj, "products", "prod_101"], {
      name: "Widget",
      price: 9.99,
    });
    await kvProvider.set([sourceOrg, sourceProj, "products", "prod_102"], {
      name: "Gadget",
      price: 19.99,
    });

    // Objects
    const smallData = new TextEncoder().encode("receipt template content");
    await objectProvider.put(
      `${sourceOrg}/${sourceProj}/templates/receipt.html`,
      smallData.buffer as ArrayBuffer,
    );

    // 2. Export source project
    const archive = await backupService.exportProject({
      orgId: sourceOrg,
      projectId: sourceProj,
    });

    assert(archive.functions.length >= 1);
    assert(archive.kv.length >= 2);
    assert(archive.objects.length >= 1);

    // 3. Import into target project
    const result = await backupService.importProject({
      targetOrgId: targetOrg,
      targetProjectId: targetProj,
      archive,
    });

    assertEquals(result.restoredRevisions, 1);
    assertEquals(result.restoredKvKeys, 2);
    assertEquals(result.restoredObjects, 1);

    // 4. Verify target project state
    // Function revision
    const targetActiveRev = await deploymentService.getActiveRevision(
      targetProj,
      "web",
    );
    assert(targetActiveRev !== null);
    assertEquals(targetActiveRev.id, dep.revisionId);
    assertEquals(targetActiveRev.artifactId, art.id);

    // KV records under target prefix
    const prod101 = await kvProvider.get([
      targetOrg,
      targetProj,
      "products",
      "prod_101",
    ]);
    assertEquals(prod101, { name: "Widget", price: 9.99 });
    const prod102 = await kvProvider.get([
      targetOrg,
      targetProj,
      "products",
      "prod_102",
    ]);
    assertEquals(prod102, { name: "Gadget", price: 19.99 });

    // Object records under target prefix
    const targetObjStream = await objectProvider.get(
      `${targetOrg}/${targetProj}/templates/receipt.html`,
    );
    assert(targetObjStream !== null);
    const targetObjBytes = await streamToBytes(targetObjStream);
    assertEquals(
      new TextDecoder().decode(targetObjBytes),
      "receipt template content",
    );

    // 5. Verify source project remains intact
    const sourceProd101 = await kvProvider.get([
      sourceOrg,
      sourceProj,
      "products",
      "prod_101",
    ]);
    assertEquals(sourceProd101, { name: "Widget", price: 9.99 });
  },
});

// ============================================================================
// Security Tests: Re-scoping and tenant isolation (PLAT-7)
// ============================================================================

Deno.test({
  name:
    "Security - AC3: import strictly re-scopes all keys under target prefix and does not bleed into source tenant (PLAT-7)",
  fn: async () => {
    const { backupService, kvProvider, objectProvider } =
      await createTestContext();
    const sourceOrg = "victim_org";
    const sourceProj = "victim_proj";
    const targetOrg = "attacker_org";
    const targetProj = "attacker_proj";

    // Setup victim project state
    await kvProvider.set(
      [sourceOrg, sourceProj, "secrets", "api_key"],
      "victim-secret-123",
    );
    const victimPayload = new TextEncoder().encode(
      "victim confidential document",
    );
    await objectProvider.put(
      `${sourceOrg}/${sourceProj}/docs/confidential.txt`,
      victimPayload.buffer as ArrayBuffer,
    );

    // Create archive purporting to be from victim
    const archive: StateBackupArchive = {
      version: 1,
      backupId: "bak_01J8Z000000000000000000004",
      createdAt: Date.now(),
      project: { orgId: sourceOrg, projectId: sourceProj, name: sourceProj },
      functions: [],
      kv: [
        {
          namespace: "secrets",
          key: ["api_key"],
          value: "injected-secret",
          version: 1,
        },
      ],
      objects: [
        {
          store: "docs",
          key: "confidential.txt",
          sizeBytes: 25,
          sha256:
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
          integrity: "sha256-uU0nuZNNPgilLlLX2n2r+sSE7+N6U4DukIj3rOLvzek=",
          dataBase64: encodeBase64(
            new TextEncoder().encode("attacker modified document"),
          ),
        },
      ],
      queues: [],
    };

    // Import into attacker's project
    await backupService.importProject({
      targetOrgId: targetOrg,
      targetProjectId: targetProj,
      archive,
    });

    // Verify victim's KV data was NOT overwritten
    const victimKey = await kvProvider.get([
      sourceOrg,
      sourceProj,
      "secrets",
      "api_key",
    ]);
    assertEquals(victimKey, "victim-secret-123");

    // Verify victim's object was NOT overwritten
    const victimStream = await objectProvider.get(
      `${sourceOrg}/${sourceProj}/docs/confidential.txt`,
    );
    assert(victimStream !== null);
    const victimBytes = await streamToBytes(victimStream);
    assertEquals(
      new TextDecoder().decode(victimBytes),
      "victim confidential document",
    );

    // Verify attacker's target project received the data cleanly re-scoped
    const attackerKey = await kvProvider.get([
      targetOrg,
      targetProj,
      "secrets",
      "api_key",
    ]);
    assertEquals(attackerKey, "injected-secret");

    const attackerStream = await objectProvider.get(
      `${targetOrg}/${targetProj}/docs/confidential.txt`,
    );
    assert(attackerStream !== null);
    const attackerBytes = await streamToBytes(attackerStream);
    assertEquals(
      new TextDecoder().decode(attackerBytes),
      "attacker modified document",
    );
  },
});

Deno.test({
  name:
    "Security - AC3: import rejects path traversal in KV key segments (PLAT-7, PLAT-12)",
  fn: async () => {
    const { backupService, kvProvider } = await createTestContext();
    const targetOrgId = "target_org";
    const targetProjectId = "target_proj";

    const maliciousArchive: StateBackupArchive = {
      version: 1,
      backupId: "bak_01J8Z000000000000000000005",
      createdAt: Date.now(),
      project: { orgId: "src_org", projectId: "src_proj", name: "src_proj" },
      functions: [],
      kv: [
        {
          namespace: "data",
          key: ["..", "other_tenant", "stolen"],
          value: "evil",
          version: 1,
        },
      ],
      objects: [],
      queues: [],
    };

    await assertRejects(
      () =>
        backupService.importProject({
          targetOrgId,
          targetProjectId,
          archive: maliciousArchive,
        }),
    );

    // Verify no keys written outside prefix
    const stolenVal = await kvProvider.get(["other_tenant", "stolen"]);
    assertEquals(stolenVal, null);
  },
});

Deno.test({
  name:
    "Security - AC3: import rejects path traversal in Object keys (PLAT-7, PLAT-12)",
  fn: async () => {
    const { backupService, objectProvider } = await createTestContext();
    const targetOrgId = "target_org";
    const targetProjectId = "target_proj";

    const maliciousArchive: StateBackupArchive = {
      version: 1,
      backupId: "bak_01J8Z000000000000000000006",
      createdAt: Date.now(),
      project: { orgId: "src_org", projectId: "src_proj", name: "src_proj" },
      functions: [],
      kv: [],
      objects: [
        {
          store: "uploads",
          key: "../../victim_org/passwords.txt",
          sizeBytes: 4,
          sha256:
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          integrity: "sha256-LPJNul+woy4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
          dataBase64: encodeBase64(new TextEncoder().encode("evil")),
        },
      ],
      queues: [],
    };

    await assertRejects(
      () =>
        backupService.importProject({
          targetOrgId,
          targetProjectId,
          archive: maliciousArchive,
        }),
    );

    const victimStream = await objectProvider.get("victim_org/passwords.txt");
    assertEquals(victimStream, null);
  },
});

Deno.test({
  name:
    "Security - AC2: tampered or malformed archive throws ValidationFailedError with zero partial state applied (PLAT-12, ADR-0002)",
  fn: async () => {
    const { backupService, kvProvider } = await createTestContext();
    const targetOrgId = "target_org";
    const targetProjectId = "target_proj";

    // Tampered payload: malformed backupId, invalid revision state
    const malformedPayload = {
      version: 1,
      backupId: "invalid_backup_id_not_ulid",
      createdAt: Date.now(),
      project: { orgId: "src_org", projectId: "src_proj", name: "src_proj" },
      functions: [],
      kv: [
        {
          namespace: "users",
          key: ["user_1"],
          value: "should_not_be_written",
          version: 1,
        },
      ],
      objects: [],
      queues: [],
    };

    const err = await assertRejects(
      () =>
        backupService.importProject({
          targetOrgId,
          targetProjectId,
          archive: malformedPayload as unknown as StateBackupArchive,
        }),
      ValidationFailedError,
    );

    assertEquals(err.code, "VALIDATION_FAILED");

    // Verify zero state applied (atomicity fail-safe)
    const writtenKv = await kvProvider.get([
      targetOrgId,
      targetProjectId,
      "users",
      "user_1",
    ]);
    assertEquals(writtenKv, null);
  },
});

Deno.test({
  name:
    "Security - AC3: import strictly prevents cross-tenant object exfiltration via forged archive.project or omitted payload (PLAT-7, OBJ-4)",
  fn: async () => {
    const { backupService, objectProvider } = await createTestContext();
    const victimOrg = "victim_org";
    const victimProj = "victim_proj";
    const attackerOrg = "attacker_org";
    const attackerProj = "attacker_proj";

    // 1. Setup victim confidential data
    const victimSecret = new TextEncoder().encode("SUPER_SECRET_KEY_12345");
    await objectProvider.put(
      `${victimOrg}/${victimProj}/secrets/master_key.txt`,
      victimSecret.buffer as ArrayBuffer,
    );

    // 2. Attacker crafts archive naming victim as source project with large object (no inline dataBase64)
    const forgedArchive: StateBackupArchive = {
      version: 1,
      backupId: "bak_01J8Z000000000000000000099",
      createdAt: Date.now(),
      project: { orgId: victimOrg, projectId: victimProj, name: victimProj },
      functions: [],
      kv: [],
      objects: [
        {
          store: "secrets",
          key: "master_key.txt",
          sizeBytes: 300 * 1024,
          sha256:
            "0000000000000000000000000000000000000000000000000000000000000000",
          integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          // dataBase64 omitted
        },
      ],
      queues: [],
    };

    // 3. Import into attacker project must fail — never pulling from victim prefix
    await assertRejects(
      () =>
        backupService.importProject({
          targetOrgId: attackerOrg,
          targetProjectId: attackerProj,
          archive: forgedArchive,
        }),
      ValidationFailedError,
    );

    // 4. Verify attacker did not receive victim's secret
    const stolenStream = await objectProvider.get(
      `${attackerOrg}/${attackerProj}/secrets/master_key.txt`,
    );
    assertEquals(stolenStream, null);

    // 5. Verify victim's original secret remains intact
    const victimStream = await objectProvider.get(
      `${victimOrg}/${victimProj}/secrets/master_key.txt`,
    );
    assert(victimStream !== null);
    const victimBytes = await streamToBytes(victimStream);
    assertEquals(
      new TextDecoder().decode(victimBytes),
      "SUPER_SECRET_KEY_12345",
    );
  },
});

Deno.test({
  name:
    "Security - AC3: import rejects path traversal and slashes in targetOrgId and targetProjectId (PLAT-7, PLAT-12)",
  fn: async () => {
    const { backupService } = await createTestContext();
    const validArchive: StateBackupArchive = {
      version: 1,
      backupId: "bak_01J8Z000000000000000000070",
      createdAt: Date.now(),
      project: { orgId: "org_src", projectId: "proj_src", name: "proj_src" },
      functions: [],
      kv: [],
      objects: [],
      queues: [],
    };

    const maliciousTargets = [
      "../escaped",
      "..\\escaped",
      "/leading_slash",
      "trailing_slash/",
      "nested/subdir",
      "null\0byte",
      "%2e%2e%2fescape",
    ];

    for (const mal of maliciousTargets) {
      // Test invalid targetOrgId
      await assertRejects(
        () =>
          backupService.importProject({
            targetOrgId: mal,
            targetProjectId: "valid_proj",
            archive: validArchive,
          }),
        ValidationFailedError,
      );

      // Test invalid targetProjectId
      await assertRejects(
        () =>
          backupService.importProject({
            targetOrgId: "valid_org",
            targetProjectId: mal,
            archive: validArchive,
          }),
        ValidationFailedError,
      );
    }
  },
});

Deno.test({
  name:
    "Security - AC3: import rejects path traversal in source archive.project identifiers (PLAT-7, PLAT-12)",
  fn: async () => {
    const { backupService } = await createTestContext();

    const maliciousSourceArchives = [
      { orgId: "../evil_org", projectId: "proj" },
      { orgId: "evil_org", projectId: "../evil_proj" },
      { orgId: "evil/subdir", projectId: "proj" },
      { orgId: "evil_org", projectId: "proj\\sub" },
      { orgId: "evil%2e%2eorg", projectId: "proj" },
    ];

    for (const src of maliciousSourceArchives) {
      const badArchive: StateBackupArchive = {
        version: 1,
        backupId: "bak_01J8Z000000000000000000071",
        createdAt: Date.now(),
        project: { orgId: src.orgId, projectId: src.projectId, name: "test" },
        functions: [],
        kv: [],
        objects: [],
        queues: [],
      };

      await assertRejects(
        () =>
          backupService.importProject({
            targetOrgId: "valid_org",
            targetProjectId: "valid_proj",
            archive: badArchive,
          }),
        ValidationFailedError,
      );
    }
  },
});

Deno.test({
  name:
    "Security - AC3: import rejects invalid characters or slashes in Object store and key (PLAT-7, PLAT-12)",
  fn: async () => {
    const { backupService } = await createTestContext();

    const testCases = [
      { store: "store/sub", key: "file.txt" },
      { store: "store\\sub", key: "file.txt" },
      { store: "store", key: "/leading_slash.txt" },
      { store: "store", key: "\\leading_backslash.txt" },
      { store: "store", key: "folder/../../escaped.txt" },
      { store: "store", key: "folder/%2e%2e/escaped.txt" },
    ];

    for (const tc of testCases) {
      const badArchive: StateBackupArchive = {
        version: 1,
        backupId: "bak_01J8Z000000000000000000072",
        createdAt: Date.now(),
        project: { orgId: "src_org", projectId: "src_proj", name: "test" },
        functions: [],
        kv: [],
        objects: [
          {
            store: tc.store,
            key: tc.key,
            sizeBytes: 4,
            sha256:
              "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            integrity: "sha256-LPJNul+woy4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
            dataBase64: encodeBase64(new TextEncoder().encode("evil")),
          },
        ],
        queues: [],
      };

      await assertRejects(
        () =>
          backupService.importProject({
            targetOrgId: "valid_org",
            targetProjectId: "valid_proj",
            archive: badArchive,
          }),
        ValidationFailedError,
      );
    }
  },
});

Deno.test({
  name:
    "Security - AC5: import rejects duplicate self-colliding KV keys within archive when overwriteKv is false (PLAT-12, ADR-0002)",
  fn: async () => {
    const { backupService } = await createTestContext();

    const archiveWithDuplicateKeys: StateBackupArchive = {
      version: 1,
      backupId: "bak_01J8Z000000000000000000073",
      createdAt: Date.now(),
      project: { orgId: "src_org", projectId: "src_proj", name: "test" },
      functions: [],
      kv: [
        {
          namespace: "config",
          key: ["setting"],
          value: "first_value",
          version: 1,
        },
        {
          namespace: "config",
          key: ["setting"],
          value: "second_value",
          version: 1,
        },
      ],
      objects: [],
      queues: [],
    };

    const err = await assertRejects(
      () =>
        backupService.importProject({
          targetOrgId: "target_org",
          targetProjectId: "target_proj",
          archive: archiveWithDuplicateKeys,
          overwriteKv: false,
        }),
      ConflictError,
    );

    assertEquals(err.code, "CONFLICT");
  },
});

Deno.test({
  name:
    "Security - AC1, AC3: round-trip large object export and import via content-addressed storage verifies hash integrity (OBJ-1, OBJ-4, PLAT-7)",
  fn: async () => {
    const { backupService, objectProvider } = await createTestContext();
    const sourceOrg = "org_producer";
    const sourceProj = "proj_producer";
    const targetOrg = "org_consumer";
    const targetProj = "proj_consumer";

    // Create a 300KB large object (>256KB)
    const largeData = new Uint8Array(300 * 1024);
    for (let i = 0; i < largeData.length; i++) {
      largeData[i] = i % 256;
    }
    const largeKey = `${sourceOrg}/${sourceProj}/datasets/model_weights.bin`;
    await objectProvider.put(largeKey, largeData.buffer as ArrayBuffer);

    // Export: must persist to artifacts/{sha256}
    const archive = await backupService.exportProject({
      orgId: sourceOrg,
      projectId: sourceProj,
    });

    const exportedObj = archive.objects.find((o) =>
      o.key === "model_weights.bin"
    );
    assert(exportedObj !== undefined);
    assertEquals(exportedObj.dataBase64, undefined); // omitted because >256KB
    assertEquals(exportedObj.sizeBytes, 300 * 1024);

    // Verify payload is stored in CAS
    const casStream = await objectProvider.get(
      `artifacts/${exportedObj.sha256}`,
    );
    assert(casStream !== null);

    // Import into target project
    const result = await backupService.importProject({
      targetOrgId: targetOrg,
      targetProjectId: targetProj,
      archive,
    });

    assertEquals(result.restoredObjects, 1);

    // Verify restored object in target project prefix
    const targetKey = `${targetOrg}/${targetProj}/datasets/model_weights.bin`;
    const targetStream = await objectProvider.get(targetKey);
    assert(targetStream !== null);
    const targetBytes = await streamToBytes(targetStream);
    assertEquals(targetBytes.byteLength, 300 * 1024);
    const targetHash = encodeHex(await computeSha256(targetBytes));
    assertEquals(targetHash, exportedObj.sha256);

    // Test tamper resistance: if CAS payload hash does not match, import rejects
    const tamperedArchive: StateBackupArchive = {
      ...archive,
      backupId: "bak_01J8Z000000000000000000074",
      objects: [
        {
          ...exportedObj,
          sha256:
            "1111111111111111111111111111111111111111111111111111111111111111",
          integrity: "sha256-ERERERERERERERERERERERERERERERERERERERERERE=",
        },
      ],
    };

    await assertRejects(
      () =>
        backupService.importProject({
          targetOrgId: "other_org",
          targetProjectId: "other_proj",
          archive: tamperedArchive,
        }),
      ValidationFailedError,
    );
  },
});
