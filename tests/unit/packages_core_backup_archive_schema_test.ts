/**
 * Comprehensive test suite for State Backup & Disaster Recovery Archive Schema and Validation.
 *
 * Spec references:
 * - docs/adr/0002-state-backup-and-disaster-recovery-archive.md (StateBackupArchive v1 schema & restore rules)
 * - docs/contracts/platform.contract.md#PLAT-18 (Resource hierarchy: Org -> Project -> { Function, KV, Object, Queue })
 * - docs/contracts/platform.contract.md#PLAT-14 (ULID format: Crockford Base32 26 chars)
 * - docs/contracts/platform.contract.md#PLAT-12 (Error model: VALIDATION_FAILED)
 * - docs/contracts/objects.contract.md#OBJ-1 (Object durable storage for backups)
 * - docs/contracts/objects.contract.md#OBJ-4 (Content addressing: artifactId and SRI integrity)
 * - docs/contracts/queues.contract.md#Q-3 (Queue visibilityTimeoutMs, maxReceives, retentionDays)
 * - tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md (AC1 - AC6, Tests required)
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import {
  type BackupFunctionRecord,
  type BackupKvEntry,
  type BackupObjectRecord,
  type BackupQueueRecord,
  type BackupRevisionRecord,
  serializeBackupArchive,
  type StateBackupArchive,
  validateBackupArchive,
} from "../../packages/core/backup/archive-schema.ts";

/**
 * Fixture: Creates a complete, valid StateBackupArchive object for testing.
 */
function createValidArchive(
  overrides?: Partial<StateBackupArchive>,
): StateBackupArchive {
  return {
    version: 1,
    backupId: "bak_01J8Z000000000000000000000",
    createdAt: 1726358400000,
    project: {
      orgId: "org_acme",
      projectId: "proj_production",
      name: "acme-api",
    },
    functions: [
      {
        name: "api",
        activeRevisionId: "rev_01J8Z111111111111111111111",
        revisions: [
          {
            id: "rev_01J8Z111111111111111111111",
            artifactId:
              "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
            state: "Deployed",
            createdAt: 1726358400000,
            manifest: { entrypoint: "api.ts", runtime: "railfog-deno" },
          },
        ],
      },
    ],
    kv: [
      {
        namespace: "sessions",
        key: ["users", "u_123", "session"],
        value: { authenticated: true, role: "admin" },
        ttl: 3600,
        version: 1,
      },
    ],
    objects: [
      {
        store: "assets",
        key: "logo.png",
        sizeBytes: 1024,
        sha256:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
        dataBase64: "aGVsbG8gd29ybGQ=",
      },
    ],
    queues: [
      {
        name: "notifications",
        visibilityTimeoutMs: 30000,
        maxReceives: 5,
        retentionDays: 4,
        dlqQueueName: "notifications-dlq",
      },
    ],
    ...overrides,
  };
}

// ============================================================================
// AC1 & Checklist (1): Valid Archive Parsing & Structural Conformance
// ============================================================================

Deno.test("AC1 & Checklist (1): Valid StateBackupArchive passes validation with exact structural conformance", () => {
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#AC1
  // spec: docs/adr/0002-state-backup-and-disaster-recovery-archive.md#Decision
  const sample = createValidArchive();
  const validated: StateBackupArchive = validateBackupArchive(sample);

  assertEquals(validated.version, 1);
  assertEquals(validated.backupId, "bak_01J8Z000000000000000000000");
  assertEquals(validated.project.orgId, "org_acme");
  assertEquals(validated.project.projectId, "proj_production");
  assertEquals(validated.project.name, "acme-api");
  assertEquals(validated.functions.length, 1);
  assertEquals(validated.functions[0].name, "api");
  assertEquals(validated.kv.length, 1);
  assertEquals(validated.objects.length, 1);
  assertEquals(validated.queues.length, 1);
});

Deno.test("AC1: Minimal valid archive with empty resource arrays parses successfully", () => {
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#AC1
  const minimal: StateBackupArchive = {
    version: 1,
    backupId: "bak_01J8Z999999999999999999999",
    createdAt: Date.now(),
    project: {
      orgId: "org_min",
      projectId: "proj_min",
      name: "empty-project",
    },
    functions: [],
    kv: [],
    objects: [],
    queues: [],
  };

  const validated = validateBackupArchive(minimal);
  assertEquals(validated.version, 1);
  assertEquals(validated.functions.length, 0);
  assertEquals(validated.kv.length, 0);
  assertEquals(validated.objects.length, 0);
  assertEquals(validated.queues.length, 0);
});

Deno.test("AC1: Function with activeRevisionId as null is valid when no active revision set", () => {
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#Interface
  const sample = createValidArchive();
  sample.functions[0].activeRevisionId = null;

  const validated = validateBackupArchive(sample);
  assertEquals(validated.functions[0].activeRevisionId, null);
});

// ============================================================================
// AC2 & Checklist (2): Schema Rejection & Version Validation
// ============================================================================

Deno.test("AC2 & Checklist (2): Rejects non-object and null raw inputs with ValidationFailedError", () => {
  // spec: contracts/platform.contract.md#PLAT-12
  const invalidInputs: unknown[] = [
    null,
    undefined,
    "not-an-object",
    12345,
    true,
    [],
  ];

  for (const input of invalidInputs) {
    const err = assertThrows(
      () => validateBackupArchive(input),
      ValidationFailedError,
    );
    assertEquals(err.code, "VALIDATION_FAILED");
  }
});

Deno.test("AC2: Rejects version other than 1 with ValidationFailedError (PLAT-12)", () => {
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#AC2
  const sample = createValidArchive();

  const invalidVersions = [2, 0, -1, "1", 1.5, null, undefined];
  for (const v of invalidVersions) {
    const invalidRaw = { ...sample, version: v };
    const err = assertThrows(
      () => validateBackupArchive(invalidRaw),
      ValidationFailedError,
    );
    assertEquals(err.code, "VALIDATION_FAILED");
  }
});

Deno.test("AC2: Rejects missing required project fields (orgId, projectId, name)", () => {
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#Tests-required
  const sample = createValidArchive();

  // Missing project entirely
  const noProject = { ...sample, project: undefined };
  assertThrows(() => validateBackupArchive(noProject), ValidationFailedError);

  // Missing orgId
  const noOrgId = createValidArchive();
  delete (noOrgId.project as Partial<typeof noOrgId.project>).orgId;
  assertThrows(() => validateBackupArchive(noOrgId), ValidationFailedError);

  // Missing projectId
  const noProjId = createValidArchive();
  delete (noProjId.project as Partial<typeof noProjId.project>).projectId;
  assertThrows(() => validateBackupArchive(noProjId), ValidationFailedError);

  // Missing name
  const noName = createValidArchive();
  delete (noName.project as Partial<typeof noName.project>).name;
  assertThrows(() => validateBackupArchive(noName), ValidationFailedError);

  // Empty string fields
  const emptyOrgId = createValidArchive();
  emptyOrgId.project.orgId = "";
  assertThrows(() => validateBackupArchive(emptyOrgId), ValidationFailedError);
});

Deno.test("AC2: Rejects missing or non-array top-level resource sections", () => {
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#Interface
  const sample = createValidArchive();

  const sections = ["functions", "kv", "objects", "queues"] as const;
  for (const sec of sections) {
    const missing = { ...sample, [sec]: undefined };
    assertThrows(() => validateBackupArchive(missing), ValidationFailedError);

    const nonArray = { ...sample, [sec]: "not-an-array" };
    assertThrows(() => validateBackupArchive(nonArray), ValidationFailedError);
  }
});

// ============================================================================
// AC3 & Checklist (3): ULID Format Validation (PLAT-14)
// ============================================================================

Deno.test("AC3 & Checklist (3): Rejects invalid backupId that does not match ^bak_[0-9A-HJKMNP-TV-Z]{26}$", () => {
  // spec: contracts/platform.contract.md#PLAT-14 — Crockford Base32 26-char ULID
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#AC3
  const sample = createValidArchive();

  const invalidBackupIds = [
    "invalid_id",
    "bak_123", // too short
    "bak_01J8Z0000000000000000000000", // 27 chars (too long)
    "bak_01J8Z00000000000000000000I", // 'I' is invalid in Crockford Base32
    "bak_01J8Z00000000000000000000L", // 'L' is invalid in Crockford Base32
    "bak_01J8Z00000000000000000000O", // 'O' is invalid in Crockford Base32
    "bak_01J8Z00000000000000000000U", // 'U' is invalid in Crockford Base32
    "bak_01j8z000000000000000000000", // lowercase is invalid for ULID
    "rev_01J8Z000000000000000000000", // wrong prefix (rev_ instead of bak_)
    "01J8Z000000000000000000000", // missing prefix entirely
    "",
    12345,
    null,
  ];

  for (const id of invalidBackupIds) {
    const invalidRaw = { ...sample, backupId: id };
    const err = assertThrows(
      () => validateBackupArchive(invalidRaw),
      ValidationFailedError,
    );
    assertEquals(err.code, "VALIDATION_FAILED");
  }
});

Deno.test("AC3 & Checklist (3): Rejects revision with invalid revisionId that does not match ^rev_[0-9A-HJKMNP-TV-Z]{26}$", () => {
  // spec: contracts/platform.contract.md#PLAT-14
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#Tests-required
  const invalidRevIds = [
    "invalid_rev",
    "rev_short",
    "rev_01J8Z11111111111111111111I", // 'I' invalid
    "bak_01J8Z111111111111111111111", // wrong prefix
    "01J8Z111111111111111111111", // missing prefix
    "",
  ];

  for (const id of invalidRevIds) {
    const raw = createValidArchive();
    raw.functions[0].revisions[0].id = id;
    raw.functions[0].activeRevisionId = id;
    assertThrows(() => validateBackupArchive(raw), ValidationFailedError);
  }
});

// ============================================================================
// AC4, AC5 & Checklist (4): OBJ-4 Content Addressing & Integrity Validation
// ============================================================================

Deno.test("AC4 & Checklist (4): Rejects revision with invalid artifactId not matching ^sha256:[0-9a-f]{64}$", () => {
  // spec: contracts/objects.contract.md#OBJ-4 — artifact_id = "sha256:" + hex(sha256(bytes))
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#AC4
  const invalidArtifactIds = [
    "not-a-hash",
    "sha256:e3b0c44", // too short
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855aa", // too long (66 chars)
    "sha256:E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855", // uppercase rejected
    "sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // hyphen instead of colon
    "md5:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // unsupported algorithm
    "",
    null,
  ];

  for (const artId of invalidArtifactIds) {
    const raw = createValidArchive();
    (raw.functions[0].revisions[0] as unknown as Record<string, unknown>)
      .artifactId = artId;
    const err = assertThrows(
      () => validateBackupArchive(raw),
      ValidationFailedError,
    );
    assertEquals(err.code, "VALIDATION_FAILED");
  }
});

Deno.test("AC5 & Checklist (4): Rejects object record with invalid integrity string not matching ^sha256-[A-Za-z0-9+/=]+$", () => {
  // spec: contracts/objects.contract.md#OBJ-4 — Subresource Integrity format
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#AC5
  const invalidIntegrities = [
    "not-sri",
    "sha256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=", // colon instead of hyphen
    "sha512-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=", // non-sha256
    "sha256-", // empty base64 part
    "sha256-invalid base64 characters *&^%",
    "",
    null,
  ];

  for (const integ of invalidIntegrities) {
    const raw = createValidArchive();
    (raw.objects[0] as unknown as Record<string, unknown>).integrity = integ;
    const err = assertThrows(
      () => validateBackupArchive(raw),
      ValidationFailedError,
    );
    assertEquals(err.code, "VALIDATION_FAILED");
  }
});

Deno.test("Checklist (4): Rejects revision with invalid integrity string", () => {
  // spec: contracts/objects.contract.md#OBJ-4
  const raw = createValidArchive();
  raw.functions[0].revisions[0].integrity = "invalid-integrity";
  assertThrows(() => validateBackupArchive(raw), ValidationFailedError);
});

Deno.test("Checklist (4): Rejects object record with invalid sha256 field", () => {
  // spec: contracts/objects.contract.md#OBJ-4
  const raw = createValidArchive();
  raw.objects[0].sha256 = "not-64-hex";
  assertThrows(() => validateBackupArchive(raw), ValidationFailedError);
});

// ============================================================================
// Checklist (5): Detailed Entity Validation
// ============================================================================

Deno.test("Checklist (5): Revisions must have valid state ('Deployed' | 'Failed' | 'Ready')", () => {
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#Interface
  const validStates = ["Deployed", "Failed", "Ready"] as const;
  for (const s of validStates) {
    const raw = createValidArchive();
    raw.functions[0].revisions[0].state = s;
    const validated = validateBackupArchive(raw);
    assertEquals(validated.functions[0].revisions[0].state, s);
  }

  const invalidStates = ["Active", "Pending", "draft", "retired", "", "READY"];
  for (const s of invalidStates) {
    const raw = createValidArchive();
    (raw.functions[0].revisions[0] as unknown as Record<string, unknown>)
      .state = s;
    assertThrows(() => validateBackupArchive(raw), ValidationFailedError);
  }
});

Deno.test("Checklist (5): activeRevisionId must match one of the revisions in the function or be null", () => {
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#Interface
  const raw = createValidArchive();
  // Set to a valid ULID format that does NOT exist in the revisions array
  raw.functions[0].activeRevisionId = "rev_01J8Z999999999999999999999";

  const err = assertThrows(
    () => validateBackupArchive(raw),
    ValidationFailedError,
  );
  assertEquals(err.code, "VALIDATION_FAILED");
});

Deno.test("Checklist (5): KV entries key must be non-empty string[] and version non-negative integer", () => {
  // spec: contracts/kv.contract.md#KV-4
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#Interface

  // Invalid key: empty array
  const emptyKey = createValidArchive();
  emptyKey.kv[0].key = [];
  assertThrows(() => validateBackupArchive(emptyKey), ValidationFailedError);

  // Invalid key: contains non-strings
  const nonStringKey = createValidArchive();
  (nonStringKey.kv[0] as unknown as Record<string, unknown>).key = [
    "users",
    123,
  ];
  assertThrows(
    () => validateBackupArchive(nonStringKey),
    ValidationFailedError,
  );

  // Invalid key: empty segment string
  const emptySegment = createValidArchive();
  emptySegment.kv[0].key = ["users", ""];
  assertThrows(
    () => validateBackupArchive(emptySegment),
    ValidationFailedError,
  );

  // Invalid version: negative
  const negVersion = createValidArchive();
  negVersion.kv[0].version = -1;
  assertThrows(() => validateBackupArchive(negVersion), ValidationFailedError);

  // Invalid ttl: non-positive number
  const negTtl = createValidArchive();
  negTtl.kv[0].ttl = -5;
  assertThrows(() => validateBackupArchive(negTtl), ValidationFailedError);
});

Deno.test("Checklist (5): Object record requires store, key, non-negative sizeBytes, and validates dataBase64 if present", () => {
  // spec: contracts/objects.contract.md#OBJ-1
  // spec: docs/adr/0002-state-backup-and-disaster-recovery-archive.md#Decision

  // Missing store
  const noStore = createValidArchive();
  noStore.objects[0].store = "";
  assertThrows(() => validateBackupArchive(noStore), ValidationFailedError);

  // Missing key
  const noKey = createValidArchive();
  noKey.objects[0].key = "";
  assertThrows(() => validateBackupArchive(noKey), ValidationFailedError);

  // Negative sizeBytes
  const negSize = createValidArchive();
  negSize.objects[0].sizeBytes = -1;
  assertThrows(() => validateBackupArchive(negSize), ValidationFailedError);

  // Invalid dataBase64 (non-base64 characters)
  const invalidBase64 = createValidArchive();
  invalidBase64.objects[0].dataBase64 = "not-valid-base64-!!!";
  assertThrows(
    () => validateBackupArchive(invalidBase64),
    ValidationFailedError,
  );
});

Deno.test("Checklist (5): Queue record requires name, positive visibilityTimeoutMs, maxReceives, retentionDays", () => {
  // spec: contracts/queues.contract.md#Q-3
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#Interface

  // Empty queue name
  const emptyName = createValidArchive();
  emptyName.queues[0].name = "";
  assertThrows(() => validateBackupArchive(emptyName), ValidationFailedError);

  // Invalid visibilityTimeoutMs (non-positive)
  const invalidTimeout = createValidArchive();
  invalidTimeout.queues[0].visibilityTimeoutMs = 0;
  assertThrows(
    () => validateBackupArchive(invalidTimeout),
    ValidationFailedError,
  );

  // Invalid maxReceives (non-positive)
  const invalidMaxReceives = createValidArchive();
  invalidMaxReceives.queues[0].maxReceives = 0;
  assertThrows(
    () => validateBackupArchive(invalidMaxReceives),
    ValidationFailedError,
  );

  // Invalid retentionDays (> 14 per Q-3)
  const excessiveRetention = createValidArchive();
  excessiveRetention.queues[0].retentionDays = 15;
  assertThrows(
    () => validateBackupArchive(excessiveRetention),
    ValidationFailedError,
  );
});

// ============================================================================
// AC6 & Checklist (6): Round-trip Serialization & Deserialization
// ============================================================================

Deno.test("AC6 & Checklist (6): serializeBackupArchive returns JSON that validates back to identical archive", () => {
  // spec: tasks/milestone-0.4-reliability/T-0404-state-backup-archive-schema.md#AC6
  const original = createValidArchive();

  // Add multiple functions, KV entries, objects, and queues to ensure complex serialization
  const secondRevision: BackupRevisionRecord = {
    id: "rev_01J8Z222222222222222222222",
    artifactId:
      "sha256:01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b",
    integrity: "sha256-Abp3GciLb+kRsJGnwFFktk7uzpZOCsBY74+YBdrKVGs=",
    state: "Ready",
    createdAt: 1726358410000,
    manifest: { entrypoint: "worker.ts" },
  };

  const secondFunction: BackupFunctionRecord = {
    name: "worker",
    activeRevisionId: null,
    revisions: [secondRevision],
  };
  original.functions.push(secondFunction);

  const secondKv: BackupKvEntry = {
    namespace: "config",
    key: ["features", "dark_mode"],
    value: true,
    version: 3,
  };
  original.kv.push(secondKv);

  const secondObject: BackupObjectRecord = {
    store: "backups",
    key: "db-snapshot.bin",
    sizeBytes: 2048,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    integrity: "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  };
  original.objects.push(secondObject);

  const secondQueue: BackupQueueRecord = {
    name: "audit_logs",
    visibilityTimeoutMs: 15000,
    maxReceives: 3,
    retentionDays: 7,
  };
  original.queues.push(secondQueue);

  // Serialize to JSON string
  const jsonStr: string = serializeBackupArchive(original);
  assert(typeof jsonStr === "string");
  assert(jsonStr.length > 0);

  // Parse and validate
  const parsedRaw: unknown = JSON.parse(jsonStr);
  const validated: StateBackupArchive = validateBackupArchive(parsedRaw);

  // Deep structural equality
  assertEquals(validated, original);
});
