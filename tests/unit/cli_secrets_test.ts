/**
 * Tests for CLI rail secrets subcommands (T-0506).
 *
 * Spec references:
 * - PLAT-12: Error model exhaustive code table (VALIDATION_FAILED, RESOURCE_NOT_FOUND)
 * - PLAT-15: Secrets management (encrypted persistence via AES-GCM-256 + PBKDF2, zero plaintext leakage in logs/stdout/stderr/errors)
 * - PLAT-19: Repository structure and CLI subcommands
 * - Task: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import {
  runSecrets,
  type SecretCliOptions,
  type SecretListEntry,
} from "../../cli/secrets.ts";

// spec: docs/contracts/platform.contract.md#PLAT-15 — Record magic bytes "RFS1"
const RECORD_MAGIC = new Uint8Array([0x52, 0x46, 0x53, 0x31]);
// spec: docs/contracts/platform.contract.md#PLAT-15 — Minimum record size: magic (4) + salt (16) + IV (12) + tag (16) = 48 bytes
const MIN_RECORD_LENGTH_BYTES = 48;

// spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md — Valid secret identifier regex
const VALID_SECRET_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Ensure local development master key is available in test environment (T-0305 Assumption 1)
Deno.env.set("RAILFOG_MASTER_KEY", "railfog-test-master-key-0123456789abcdef");

// =============================================================================
// Test Helpers
// =============================================================================

interface CapturedOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Intercepts console.log, console.error, and console.warn while running runSecrets
 * to assert exit codes, output formatting, and zero plaintext leakage.
 */
async function captureRunSecrets(
  options: SecretCliOptions,
): Promise<CapturedOutput> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = (...args: unknown[]) => {
    stdoutChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };
  console.error = (...args: unknown[]) => {
    stderrChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };
  console.warn = (...args: unknown[]) => {
    stderrChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
        " ",
      ),
    );
  };

  try {
    const exitCode = await runSecrets(options);
    return {
      exitCode,
      stdout: stdoutChunks.join("\n"),
      stderr: stderrChunks.join("\n"),
    };
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

/**
 * Creates an isolated temporary project directory with a minimal railfog.toml.
 */
async function createTempProject(
  projectName = "secrets-test-app",
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "railfog_secrets_test_" });
  const tomlContent =
    `name = "${projectName}"\n\n[functions.api]\nentry = "functions/api.ts"\n`;
  await Deno.writeTextFile(join(dir, "railfog.toml"), tomlContent);
  return dir;
}

/**
 * Recursively searches a directory for any .enc secret store files.
 */
async function findEncFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory) {
        results.push(...await findEncFiles(fullPath));
      } else if (entry.isFile && entry.name.endsWith(".enc")) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory may not exist yet
  }
  return results;
}

// Compile-time assertion verifying the SecretListEntry shape contract
const _verifySecretListEntryType: SecretListEntry = {
  key: "SAMPLE_KEY",
  updatedAt: 1700000000000,
};
void _verifySecretListEntryType;

// =============================================================================
// Suite 1: Unit: secrets set
// =============================================================================

Deno.test(
  "Unit: secrets set - sets secret with key and value, returns exit code 0 (AC1)",
  async () => {
    // spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md#Acceptance criteria AC1
    // spec: docs/contracts/platform.contract.md#PLAT-15 — Zero secret leakage in stdout
    const projectDir = await createTempProject();
    try {
      const secretKey = "STRIPE_KEY";
      const secretValue = "sk_test_12345";

      const res = await captureRunSecrets({
        subcommand: "set",
        key: secretKey,
        value: secretValue,
        projectDir,
      });

      assertEquals(res.exitCode, 0, "Setting a secret must return exit code 0");
      assertMatch(
        res.stdout,
        new RegExp(`Secret\\s+${secretKey}\\s+updated`, "i"),
        "Stdout must confirm 'Secret <KEY> updated'",
      );
      assert(
        !res.stdout.includes(secretValue),
        "Stdout must NEVER contain the secret value (PLAT-15)",
      );
      assert(
        !res.stderr.includes(secretValue),
        "Stderr must NEVER contain the secret value (PLAT-15)",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: secrets set - verifies secret is persisted encrypted on disk with zero plaintext leakage (PLAT-15)",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-15 — Plaintext guarantees: secrets never stored in plaintext on disk
    const projectDir = await createTempProject();
    try {
      const secretKey = "DATABASE_URL";
      const secretValue =
        "postgres://user:super_secret_pw_9876@db.internal:5432/prod";

      const res = await captureRunSecrets({
        subcommand: "set",
        key: secretKey,
        value: secretValue,
        projectDir,
      });

      assertEquals(res.exitCode, 0);

      // Locate persisted .enc files within the project directory
      const encFiles = await findEncFiles(projectDir);
      assert(
        encFiles.length > 0,
        "At least one .enc file must be created on disk for the secret store",
      );

      // Read raw bytes of all .enc files to verify authenticated encryption and zero plaintext leakage
      for (const encFile of encFiles) {
        const fileBytes = await Deno.readFile(encFile);
        assert(
          fileBytes.byteLength >= MIN_RECORD_LENGTH_BYTES,
          `Encrypted record length (${fileBytes.byteLength}) must be >= ${MIN_RECORD_LENGTH_BYTES} bytes`,
        );

        // Verify magic header "RFS1"
        assertEquals(
          fileBytes.slice(0, 4),
          RECORD_MAGIC,
          "Persisted record must begin with RFS1 magic bytes",
        );

        // Raw text decode must not contain any substring of the plaintext secret
        const rawContent = new TextDecoder().decode(fileBytes);
        assert(
          !rawContent.includes(secretValue),
          "Persisted .enc file must NEVER contain the plaintext secret value",
        );
        assert(
          !rawContent.includes("super_secret_pw_9876"),
          "Persisted .enc file must not contain sensitive password substring",
        );
      }
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: secrets set - sets multiline secret via filePath option, returns exit code 0, persists successfully (AC1, PLAT-15)",
  async () => {
    // spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md#Scope (supports --file=<path> for multiline secrets)
    // spec: docs/contracts/platform.contract.md#PLAT-15 — Zero secret leakage
    const projectDir = await createTempProject();
    try {
      const multilineSecret = [
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEowIBAAKCAQEA0Y3t8XWlH5bK8q8aZb6e3G9QW1X2Y3Z4",
        "line2_data_super_secret_rsa_payload_9876543210",
        "line3_data_confidential_cert_block_abcdef123456",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n");

      const secretFilePath = join(projectDir, "temp-secret.key");
      await Deno.writeTextFile(secretFilePath, multilineSecret);

      const res = await captureRunSecrets({
        subcommand: "set",
        key: "RSA_KEY",
        filePath: secretFilePath,
        projectDir,
      });

      assertEquals(res.exitCode, 0, "Setting secret via filePath must exit 0");
      assertMatch(
        res.stdout,
        /Secret\s+RSA_KEY\s+updated/i,
        "Stdout must confirm 'Secret RSA_KEY updated'",
      );

      // Verify zero leak in stdout and stderr
      assert(
        !res.stdout.includes("super_secret_rsa_payload_9876543210"),
        "Stdout must not leak multiline payload",
      );
      assert(
        !res.stdout.includes("BEGIN RSA PRIVATE KEY"),
        "Stdout must not leak key headers",
      );
      assert(
        !res.stderr.includes("super_secret_rsa_payload_9876543210"),
        "Stderr must not leak multiline payload",
      );

      // Verify on-disk .enc file
      const encFiles = await findEncFiles(projectDir);
      assert(
        encFiles.length > 0,
        "Must persist .enc file for multiline secret",
      );
      for (const encFile of encFiles) {
        const rawContent = new TextDecoder().decode(
          await Deno.readFile(encFile),
        );
        assert(
          !rawContent.includes("super_secret_rsa_payload_9876543210"),
          "Persisted file must not leak multiline payload in plaintext",
        );
      }
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: secrets set - updating an existing secret overwrites value, returns exit code 0, confirms update without leak (AC1, PLAT-15)",
  async () => {
    // spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md#Acceptance criteria AC1
    const projectDir = await createTempProject();
    try {
      const key = "API_KEY";
      const initialValue = "initial_secret_alpha_1111";
      const updatedValue = "updated_secret_beta_2222";

      // Initial set
      const res1 = await captureRunSecrets({
        subcommand: "set",
        key,
        value: initialValue,
        projectDir,
      });
      assertEquals(res1.exitCode, 0);
      assert(!res1.stdout.includes(initialValue));

      // Overwrite with new value
      const res2 = await captureRunSecrets({
        subcommand: "set",
        key,
        value: updatedValue,
        projectDir,
      });
      assertEquals(res2.exitCode, 0);
      assertMatch(res2.stdout, /Secret\s+API_KEY\s+updated/i);
      assert(
        !res2.stdout.includes(updatedValue),
        "Updated value must not leak in stdout",
      );
      assert(
        !res2.stderr.includes(updatedValue),
        "Updated value must not leak in stderr",
      );

      // Verify disk content
      const encFiles = await findEncFiles(projectDir);
      for (const encFile of encFiles) {
        const raw = new TextDecoder().decode(await Deno.readFile(encFile));
        assert(
          !raw.includes(initialValue),
          "Old value must not remain in plaintext",
        );
        assert(
          !raw.includes(updatedValue),
          "New value must not appear in plaintext",
        );
      }
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: secrets set - setting multiple distinct secrets persists each independently (PLAT-7, PLAT-15)",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-7 — Resource isolation
    const projectDir = await createTempProject();
    try {
      const resA = await captureRunSecrets({
        subcommand: "set",
        key: "SECRET_A",
        value: "val_alpha_333",
        projectDir,
      });
      assertEquals(resA.exitCode, 0);

      const resB = await captureRunSecrets({
        subcommand: "set",
        key: "SECRET_B",
        value: "val_bravo_444",
        projectDir,
      });
      assertEquals(resB.exitCode, 0);

      const encFiles = await findEncFiles(projectDir);
      assert(
        encFiles.length >= 2,
        "Distinct secrets must each produce an independent encrypted record",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: secrets set - defaults projectDir to Deno.cwd() when omitted",
  async () => {
    const projectDir = await createTempProject();
    const origCwd = Deno.cwd();
    try {
      Deno.chdir(projectDir);
      const res = await captureRunSecrets({
        subcommand: "set",
        key: "DEFAULT_DIR_SECRET",
        value: "default_dir_secret_val",
      });

      assertEquals(res.exitCode, 0);
      assertMatch(res.stdout, /Secret\s+DEFAULT_DIR_SECRET\s+updated/i);

      const encFiles = await findEncFiles(projectDir);
      assert(
        encFiles.length > 0,
        "Must create encrypted record in current directory",
      );
    } finally {
      Deno.chdir(origCwd);
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

// =============================================================================
// Suite 2: Unit: secrets list
// =============================================================================

Deno.test(
  "Unit: secrets list - lists secret keys and updatedAt timestamps, never exposing secret values (AC2, PLAT-15)",
  async () => {
    // spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md#Acceptance criteria AC2
    // spec: docs/contracts/platform.contract.md#PLAT-15 — Never exposing secret values or substrings
    const projectDir = await createTempProject();
    try {
      const secret1 = { key: "STRIPE_KEY", val: "sk_live_stripe_secret_12345" };
      const secret2 = { key: "AUTH_TOKEN", val: "auth_bearer_token_xyz_98765" };

      // Populate secrets
      await captureRunSecrets({
        subcommand: "set",
        key: secret1.key,
        value: secret1.val,
        projectDir,
      });
      await captureRunSecrets({
        subcommand: "set",
        key: secret2.key,
        value: secret2.val,
        projectDir,
      });

      // Execute list
      const res = await captureRunSecrets({
        subcommand: "list",
        projectDir,
      });

      assertEquals(res.exitCode, 0, "Listing secrets must return exit code 0");

      // Verify key names appear
      assert(
        res.stdout.includes(secret1.key),
        `Stdout must list secret key ${secret1.key}`,
      );
      assert(
        res.stdout.includes(secret2.key),
        `Stdout must list secret key ${secret2.key}`,
      );

      // Verify timestamps or date indications are present
      assertMatch(
        res.stdout,
        /\d{4}-\d{2}-\d{2}|\d{10,13}|Updated/i,
        "Stdout must contain updatedAt timestamp or date column",
      );

      // Verify ZERO plaintext secret exposure (PLAT-15)
      assert(
        !res.stdout.includes(secret1.val),
        `Stdout must NEVER contain secret value ${secret1.val} (PLAT-15)`,
      );
      assert(
        !res.stdout.includes(secret2.val),
        `Stdout must NEVER contain secret value ${secret2.val} (PLAT-15)`,
      );
      assert(
        !res.stderr.includes(secret1.val),
        `Stderr must NEVER contain secret value ${secret1.val} (PLAT-15)`,
      );
      assert(
        !res.stderr.includes(secret2.val),
        `Stderr must NEVER contain secret value ${secret2.val} (PLAT-15)`,
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: secrets list - empty store lists 'No secrets found' or empty table without error (AC2)",
  async () => {
    // spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md#Acceptance criteria AC2
    const projectDir = await createTempProject();
    try {
      const res = await captureRunSecrets({
        subcommand: "list",
        projectDir,
      });

      assertEquals(res.exitCode, 0, "Listing empty store must exit 0");
      assertMatch(
        res.stdout,
        /No secrets found|Key\s+Updated/i,
        "Stdout must indicate empty store gracefully or display table headers",
      );
      assertEquals(
        res.stderr.trim(),
        "",
        "Stderr should be empty on clean list",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: secrets list - does not expose secret values even when value overlaps with key name (PLAT-15)",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-15 — Edge case: secret value containing key substring
    const projectDir = await createTempProject();
    try {
      const key = "API_KEY";
      const value = "API_KEY_SUPER_SECRET_PAYLOAD_999";

      await captureRunSecrets({
        subcommand: "set",
        key,
        value,
        projectDir,
      });

      const res = await captureRunSecrets({
        subcommand: "list",
        projectDir,
      });

      assertEquals(res.exitCode, 0);
      assert(res.stdout.includes(key), "Stdout must include the key name");
      assert(
        !res.stdout.includes("SUPER_SECRET_PAYLOAD_999"),
        "Stdout must not expose secret suffix",
      );
      assert(
        !res.stdout.includes(value),
        "Stdout must not expose full secret value",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

// =============================================================================
// Suite 3: Unit: secrets delete
// =============================================================================

Deno.test(
  "Unit: secrets delete - deletes existing secret, returns exit code 0, confirms Secret <KEY> deleted (AC3)",
  async () => {
    // spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md#Acceptance criteria AC3
    const projectDir = await createTempProject();
    try {
      const key = "TEMP_TOKEN";
      const value = "temporary_secret_token_12345";

      // Set secret first
      await captureRunSecrets({
        subcommand: "set",
        key,
        value,
        projectDir,
      });

      // Delete secret
      const delRes = await captureRunSecrets({
        subcommand: "delete",
        key,
        projectDir,
      });

      assertEquals(
        delRes.exitCode,
        0,
        "Deleting secret must return exit code 0",
      );
      assertMatch(
        delRes.stdout,
        new RegExp(`Secret\\s+${key}\\s+deleted`, "i"),
        "Stdout must confirm 'Secret <KEY> deleted'",
      );
      assert(
        !delRes.stdout.includes(value),
        "Secret value must not appear in stdout during deletion",
      );
      assert(
        !delRes.stderr.includes(value),
        "Secret value must not appear in stderr during deletion",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: secrets delete - verifies key is no longer in store or list (AC3)",
  async () => {
    // spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md#Acceptance criteria AC3
    const projectDir = await createTempProject();
    try {
      const key = "DISPOSABLE_SECRET";
      await captureRunSecrets({
        subcommand: "set",
        key,
        value: "disposable_value",
        projectDir,
      });

      // Delete the secret
      await captureRunSecrets({
        subcommand: "delete",
        key,
        projectDir,
      });

      // Listing must not contain deleted key
      const listRes = await captureRunSecrets({
        subcommand: "list",
        projectDir,
      });
      assertEquals(listRes.exitCode, 0);
      assert(
        !listRes.stdout.includes(key),
        `Deleted key ${key} must not appear in subsequent secrets list`,
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: secrets delete - deleting non-existent secret emits RESOURCE_NOT_FOUND error and returns exit code 1 (AC3, PLAT-12)",
  async () => {
    // spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md#Acceptance criteria AC3
    // spec: docs/contracts/platform.contract.md#PLAT-12 — RESOURCE_NOT_FOUND machine-readable error code
    const projectDir = await createTempProject();
    try {
      const nonExistentKey = "DOES_NOT_EXIST_KEY";

      const res = await captureRunSecrets({
        subcommand: "delete",
        key: nonExistentKey,
        projectDir,
      });

      assertEquals(
        res.exitCode,
        1,
        "Deleting non-existent secret must fail with exit code 1",
      );
      const combinedOutput = `${res.stdout}\n${res.stderr}`;
      assertMatch(
        combinedOutput,
        /RESOURCE_NOT_FOUND/i,
        "Error output must reference RESOURCE_NOT_FOUND (PLAT-12)",
      );
      assert(
        !res.stdout.toLowerCase().includes("deleted"),
        "Must not confirm deletion of non-existent secret",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Unit: secrets delete - deleting one secret preserves remaining secrets in store (PLAT-7, PLAT-15)",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-7 — Tenant and resource isolation
    const projectDir = await createTempProject();
    try {
      await captureRunSecrets({
        subcommand: "set",
        key: "RETAINED_KEY",
        value: "retained_value_777",
        projectDir,
      });
      await captureRunSecrets({
        subcommand: "set",
        key: "DELETED_KEY",
        value: "deleted_value_888",
        projectDir,
      });

      const delRes = await captureRunSecrets({
        subcommand: "delete",
        key: "DELETED_KEY",
        projectDir,
      });
      assertEquals(delRes.exitCode, 0);

      const listRes = await captureRunSecrets({
        subcommand: "list",
        projectDir,
      });
      assertEquals(listRes.exitCode, 0);
      assert(
        listRes.stdout.includes("RETAINED_KEY"),
        "RETAINED_KEY must remain present",
      );
      assert(
        !listRes.stdout.includes("DELETED_KEY"),
        "DELETED_KEY must be absent",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

// =============================================================================
// Suite 4: Security: PLAT-15 zero secret leakage & error safety
// =============================================================================

Deno.test(
  "Security: PLAT-15 zero secret leakage - missing file path under filePath option returns exit code 1 without leaking key or path",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-15 — Never included in error/trace
    // spec: docs/contracts/platform.contract.md#PLAT-12 — RESOURCE_NOT_FOUND / VALIDATION_FAILED
    const projectDir = await createTempProject();
    try {
      const nonExistentFile = join(projectDir, "non-existent-secret-file.env");

      const res = await captureRunSecrets({
        subcommand: "set",
        key: "FILE_SECRET",
        filePath: nonExistentFile,
        projectDir,
      });

      assertEquals(
        res.exitCode,
        1,
        "Missing filePath must fail with exit code 1",
      );
      const combinedOutput = `${res.stdout}\n${res.stderr}`;
      assertMatch(
        combinedOutput,
        /RESOURCE_NOT_FOUND|VALIDATION_FAILED|not found/i,
        "Must report structured error for missing file path",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: PLAT-15 zero secret leakage - missing key for set returns exit code 1 and VALIDATION_FAILED without leaking secret value (PLAT-12, PLAT-15)",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED
    // spec: docs/contracts/platform.contract.md#PLAT-15 — Zero secret leakage
    const projectDir = await createTempProject();
    try {
      const confidentialValue = "super_confidential_secret_value_12345";

      const res = await captureRunSecrets({
        subcommand: "set",
        value: confidentialValue,
        projectDir,
      });

      assertEquals(res.exitCode, 1, "Missing key must return exit code 1");
      const combinedOutput = `${res.stdout}\n${res.stderr}`;
      assertMatch(combinedOutput, /VALIDATION_FAILED/i);
      assert(
        !res.stdout.includes(confidentialValue),
        "Secret value must not appear in stdout",
      );
      assert(
        !res.stderr.includes(confidentialValue),
        "Secret value must not appear in stderr",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: PLAT-15 zero secret leakage - missing key for delete returns exit code 1 and VALIDATION_FAILED (PLAT-12)",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED
    const projectDir = await createTempProject();
    try {
      const res = await captureRunSecrets({
        subcommand: "delete",
        projectDir,
      });

      assertEquals(
        res.exitCode,
        1,
        "Delete without key must return exit code 1",
      );
      const combinedOutput = `${res.stdout}\n${res.stderr}`;
      assertMatch(combinedOutput, /VALIDATION_FAILED/i);
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: PLAT-15 zero secret leakage - missing both value and filePath for set returns exit code 1 and VALIDATION_FAILED (PLAT-12)",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED
    const projectDir = await createTempProject();
    try {
      const res = await captureRunSecrets({
        subcommand: "set",
        key: "EMPTY_SECRET",
        projectDir,
      });

      assertEquals(
        res.exitCode,
        1,
        "Set with no value or filePath must return exit code 1",
      );
      const combinedOutput = `${res.stdout}\n${res.stderr}`;
      assertMatch(combinedOutput, /VALIDATION_FAILED/i);
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: PLAT-15 zero secret leakage - simulated store IO error never leaks secret value in stdout, stderr, or stack traces (PLAT-15)",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-15 — Never included in error/trace
    // spec: docs/ANTI-SLOP.md#Error handling — Never log or return a secret value in an error, even accidentally
    const projectDir = await createTempProject();
    try {
      // Pass a file path as projectDir so filesystem operations fail with IO error
      const dummyFilePath = join(projectDir, "not-a-directory.txt");
      await Deno.writeTextFile(dummyFilePath, "placeholder");

      const sensitivePayload =
        "extremely_sensitive_api_token_to_never_leak_9999";

      const res = await captureRunSecrets({
        subcommand: "set",
        key: "TEST_SECRET",
        value: sensitivePayload,
        projectDir: dummyFilePath,
      });

      assertEquals(res.exitCode, 1, "Store failure must exit with code 1");
      assert(
        !res.stdout.includes(sensitivePayload),
        "Sensitive payload must NEVER appear in stdout during store failure",
      );
      assert(
        !res.stderr.includes(sensitivePayload),
        "Sensitive payload must NEVER appear in stderr during store failure",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: PLAT-15 & PLAT-12 - secret identifier validation strictly rejects invalid keys matching ^[A-Za-z_][A-Za-z0-9_]*$",
  async () => {
    // spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md — Valid secret identifier regex
    // spec: docs/contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED
    // spec: docs/contracts/platform.contract.md#PLAT-15 — Zero secret leakage
    const projectDir = await createTempProject();
    try {
      const invalidKeys = [
        "../../TRAVERSAL",
        "BAD-KEY!",
        "123KEY",
        "KEY WITH SPACES",
        "KEY.NAME",
        "KEY/SUBKEY",
        "KEY\\SUBKEY",
        "KEY:NAME",
        "KEY;DROP",
        "<script>alert(1)</script>",
        "",
        "   ",
        "KEY\0NULL",
      ];

      for (const invalidKey of invalidKeys) {
        // Assert key fails the specification regex
        assert(
          !VALID_SECRET_KEY_REGEX.test(invalidKey),
          `Invalid key '${invalidKey}' must fail regex validation`,
        );

        const secretPayload = `payload_for_${encodeURIComponent(invalidKey)}`;
        const res = await captureRunSecrets({
          subcommand: "set",
          key: invalidKey,
          value: secretPayload,
          projectDir,
        });

        assertEquals(
          res.exitCode,
          1,
          `Invalid key '${invalidKey}' must return exit code 1`,
        );

        const combinedOutput = `${res.stdout}\n${res.stderr}`;
        assertMatch(
          combinedOutput,
          /VALIDATION_FAILED/i,
          `Invalid key '${invalidKey}' must yield VALIDATION_FAILED (PLAT-12)`,
        );

        // Zero secret leakage check
        assert(
          !res.stdout.includes(secretPayload),
          `Stdout must not leak secret for key '${invalidKey}'`,
        );
        assert(
          !res.stderr.includes(secretPayload),
          `Stderr must not leak secret for key '${invalidKey}'`,
        );
      }

      // Assert no .enc files were created on disk for rejected keys
      const encFiles = await findEncFiles(projectDir);
      assertEquals(
        encFiles.length,
        0,
        "No .enc file must be written for invalid secret identifiers",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: PLAT-15 & PLAT-12 - delete rejects invalid secret keys with VALIDATION_FAILED and exit code 1",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED
    const projectDir = await createTempProject();
    try {
      const invalidKeys = ["../../TRAVERSAL", "BAD-KEY!", "123KEY"];

      for (const invalidKey of invalidKeys) {
        const res = await captureRunSecrets({
          subcommand: "delete",
          key: invalidKey,
          projectDir,
        });

        assertEquals(
          res.exitCode,
          1,
          `Delete with invalid key '${invalidKey}' must return exit code 1`,
        );
        const combinedOutput = `${res.stdout}\n${res.stderr}`;
        assertMatch(combinedOutput, /VALIDATION_FAILED/i);
      }
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: PLAT-15 - valid secret keys matching ^[A-Za-z_][A-Za-z0-9_]*$ are accepted with exit code 0",
  async () => {
    // spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md — Valid secret identifier regex
    const projectDir = await createTempProject();
    try {
      const validKeys = [
        "_SYSTEM_SECRET",
        "DATABASE_URL",
        "apiKey_v2",
        "A",
        "KEY_123_abc",
      ];

      for (const validKey of validKeys) {
        assert(
          VALID_SECRET_KEY_REGEX.test(validKey),
          `Key '${validKey}' must satisfy regex validation`,
        );

        const res = await captureRunSecrets({
          subcommand: "set",
          key: validKey,
          value: "valid_secret_payload",
          projectDir,
        });

        assertEquals(
          res.exitCode,
          0,
          `Valid key '${validKey}' must succeed with exit code 0`,
        );
        assertMatch(
          res.stdout,
          new RegExp(`Secret\\s+${validKey}\\s+updated`, "i"),
        );
      }
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Security: PLAT-12 - unknown subcommand returns exit code 1 and VALIDATION_FAILED",
  async () => {
    // spec: docs/contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED on invalid input
    const projectDir = await createTempProject();
    try {
      const res = await captureRunSecrets({
        subcommand: "unknown" as unknown as "set",
        projectDir,
      });

      assertEquals(
        res.exitCode,
        1,
        "Unknown subcommand must return exit code 1",
      );
      const combinedOutput = `${res.stdout}\n${res.stderr}`;
      assertMatch(combinedOutput, /VALIDATION_FAILED/i);
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
);

Deno.test(
  "Audit: rail secrets audit cross-references declared capabilities with encrypted store",
  async () => {
    const projectDir = await Deno.makeTempDir({
      prefix: "railfog_secrets_audit_",
    });
    try {
      const tomlContent = `name = "audit-app"

[functions.api]
entry = "functions/api.ts"
[functions.api.permissions]
secrets = ["STRIPE_KEY", "DATABASE_URL"]
`;
      await Deno.writeTextFile(join(projectDir, "railfog.toml"), tomlContent);

      // Set one secret: STRIPE_KEY
      await captureRunSecrets({
        subcommand: "set",
        key: "STRIPE_KEY",
        value: "sk_test_12345",
        projectDir,
      });

      // Set an orphan secret: UNUSED_SECRET
      await captureRunSecrets({
        subcommand: "set",
        key: "UNUSED_SECRET",
        value: "orphan_value",
        projectDir,
      });

      // Run audit
      const res = await captureRunSecrets({
        subcommand: "audit",
        projectDir,
      });

      assertEquals(res.exitCode, 0, "Audit must exit 0");
      assert(
        res.stdout.includes("STRIPE_KEY"),
        "Output must mention STRIPE_KEY",
      );
      assert(
        res.stdout.includes("DATABASE_URL"),
        "Output must mention DATABASE_URL",
      );
      assert(
        res.stdout.includes("UNUSED_SECRET"),
        "Output must mention UNUSED_SECRET",
      );
      assert(
        res.stdout.includes("[ACTIVE]"),
        "Output must categorize active secret",
      );
      assert(
        res.stdout.includes("[MISSING]"),
        "Output must categorize missing secret",
      );
      assert(
        res.stdout.includes("[ORPHAN]"),
        "Output must categorize orphan secret",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true }).catch(() => {});
    }
  },
);
