import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { ValidationFailedError } from "../../packages/errors/mod.ts";
import {
  LocalEncryptedSecretStore,
  type SecretStore,
} from "../../packages/policy/secret-store.ts";

/**
 * Helper to recursively discover all files within a directory.
 */
async function getAllFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory) {
        files.push(...(await getAllFiles(fullPath)));
      } else if (entry.isFile) {
        files.push(fullPath);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return [];
    }
    throw err;
  }
  return files;
}

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
Deno.test("Unit: set and get returns exact plaintext secret (AC1)", async () => {
  const store: SecretStore = new LocalEncryptedSecretStore({
    masterKey: "test-master-key-0123456789abcdef",
  });
  await store.set("org-1", "proj-1", "API_KEY", "sk_live_xyz");
  const value = await store.get("org-1", "proj-1", "API_KEY");
  assertEquals(value, "sk_live_xyz");
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
Deno.test("Unit: get non-existent secret returns null (AC1)", async () => {
  const store = new LocalEncryptedSecretStore({
    masterKey: "test-master-key-0123456789abcdef",
  });
  const value = await store.get("org-1", "proj-1", "NON_EXISTENT");
  assertEquals(value, null);
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
Deno.test("Unit: overwrite secret updates stored value", async () => {
  const store = new LocalEncryptedSecretStore({
    masterKey: "test-master-key-0123456789abcdef",
  });
  await store.set("org-1", "proj-1", "API_KEY", "initial_value");
  assertEquals(await store.get("org-1", "proj-1", "API_KEY"), "initial_value");

  await store.set("org-1", "proj-1", "API_KEY", "updated_value");
  assertEquals(await store.get("org-1", "proj-1", "API_KEY"), "updated_value");
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
Deno.test("Unit: secret store accepts Uint8Array masterKey", async () => {
  const rawKey = new Uint8Array(32);
  crypto.getRandomValues(rawKey);
  const store = new LocalEncryptedSecretStore({
    masterKey: rawKey,
  });
  await store.set("org-1", "proj-1", "API_KEY", "sk_live_uint8array");
  assertEquals(
    await store.get("org-1", "proj-1", "API_KEY"),
    "sk_live_uint8array",
  );
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
Deno.test("Unit: handles empty values, unicode, and large payloads", async () => {
  const store = new LocalEncryptedSecretStore({
    masterKey: "test-master-key-0123456789abcdef",
  });

  // Empty string
  await store.set("org-1", "proj-1", "EMPTY", "");
  assertEquals(await store.get("org-1", "proj-1", "EMPTY"), "");

  // Unicode / emojis / special characters
  const unicodeVal =
    "🔐 敏感数据 • 秘密 • \u0000 \t \n special chars & symbols";
  await store.set("org-1", "proj-1", "UNICODE", unicodeVal);
  assertEquals(await store.get("org-1", "proj-1", "UNICODE"), unicodeVal);

  // Large secret (64 KB)
  const largeSecret = "a".repeat(64 * 1024);
  await store.set("org-1", "proj-1", "LARGE", largeSecret);
  assertEquals(await store.get("org-1", "proj-1", "LARGE"), largeSecret);
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets (AES-GCM random IV per record)
Deno.test("Unit: random IV per record ensures non-deterministic ciphertext", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const store = new LocalEncryptedSecretStore({
      masterKey: "test-master-key-0123456789abcdef",
      storagePath: tempDir,
    });

    const identicalPlaintext = "same-secret-value-for-both-records";
    await store.set("org-1", "proj-1", "SECRET_A", identicalPlaintext);
    await store.set("org-1", "proj-1", "SECRET_B", identicalPlaintext);

    const files = await getAllFiles(tempDir);
    assertEquals(files.length, 2);

    const contentA = await Deno.readFile(files[0]);
    const contentB = await Deno.readFile(files[1]);

    // Even with identical plaintext and master key, ciphertexts must differ due to unique IV / salt
    assertNotEquals(contentA, contentB);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets (zero plaintext leakage)
Deno.test("Security: zero plaintext leakage in persistent storage (AC2)", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const store = new LocalEncryptedSecretStore({
      masterKey: "test-master-key-0123456789abcdef",
      storagePath: tempDir,
    });

    const plaintext = "sk_live_xyz_super_secret_token_never_leak_987654";
    await store.set("org-1", "proj-1", "API_KEY", plaintext);

    const files = await getAllFiles(tempDir);
    assert(files.length > 0, "Expected stored file to exist on disk");

    const plaintextBytes = new TextEncoder().encode(plaintext);

    for (const filePath of files) {
      const fileBytes = await Deno.readFile(filePath);
      const fileText = new TextDecoder().decode(fileBytes);

      // Verify string search
      assert(
        !fileText.includes(plaintext),
        "Plaintext secret was leaked in file string contents",
      );

      // Verify byte search (raw bytes matching)
      let foundByteMatch = false;
      for (let i = 0; i <= fileBytes.length - plaintextBytes.length; i++) {
        let match = true;
        for (let j = 0; j < plaintextBytes.length; j++) {
          if (fileBytes[i + j] !== plaintextBytes[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          foundByteMatch = true;
          break;
        }
      }
      assert(!foundByteMatch, "Plaintext bytes found in binary file contents");
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
// spec: docs/contracts/platform.contract.md#PLAT-7 — Multi-tenancy & data isolation
Deno.test("Integration: multi-tenant and cross-project isolation (AC3)", async () => {
  const store = new LocalEncryptedSecretStore({
    masterKey: "test-master-key-0123456789abcdef",
  });

  await store.set("org-1", "proj-a", "STRIPE_KEY", "sk_live_proj_a");
  await store.set("org-1", "proj-b", "STRIPE_KEY", "sk_live_proj_b");
  await store.set("org-2", "proj-a", "STRIPE_KEY", "sk_live_org2_proj_a");

  assertEquals(
    await store.get("org-1", "proj-a", "STRIPE_KEY"),
    "sk_live_proj_a",
  );
  assertEquals(
    await store.get("org-1", "proj-b", "STRIPE_KEY"),
    "sk_live_proj_b",
  );
  assertEquals(
    await store.get("org-2", "proj-a", "STRIPE_KEY"),
    "sk_live_org2_proj_a",
  );
  assertEquals(await store.get("org-2", "proj-b", "STRIPE_KEY"), null);
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
Deno.test("Integration: physical tenant namespacing on disk", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const store = new LocalEncryptedSecretStore({
      masterKey: "test-master-key-0123456789abcdef",
      storagePath: tempDir,
    });

    await store.set(
      "tenant-org",
      "service-proj",
      "JWT_SECRET",
      "secret-token",
    );

    const files = await getAllFiles(tempDir);
    assert(files.length > 0, "File should exist in storage directory");

    // Verify path structure includes org and project identifiers
    const namespacedPath = files[0];
    assert(
      namespacedPath.includes("tenant-org"),
      "Storage path must namespace by org_id",
    );
    assert(
      namespacedPath.includes("service-proj"),
      "Storage path must namespace by project_id",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
Deno.test("AC4: listNames returns only secret names and never plaintext values", async () => {
  const store = new LocalEncryptedSecretStore({
    masterKey: "test-master-key-0123456789abcdef",
  });

  await store.set("org-1", "proj-1", "API_KEY", "sk_live_111");
  await store.set("org-1", "proj-1", "DB_PASS", "super_secret_db_pass");
  await store.set("org-1", "proj-1", "WEBHOOK_SIGNING_SECRET", "whsec_222");

  const names = await store.listNames("org-1", "proj-1");
  assertEquals(names.sort(), ["API_KEY", "DB_PASS", "WEBHOOK_SIGNING_SECRET"]);

  // Verify none of the secret plaintext values are present in names
  for (const name of names) {
    assert(!name.includes("sk_live_111"));
    assert(!name.includes("super_secret_db_pass"));
    assert(!name.includes("whsec_222"));
  }

  // Verify project isolation in listNames
  const otherNames = await store.listNames("org-1", "proj-other");
  assertEquals(otherNames, []);
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
Deno.test("Unit: delete cleanly removes secret", async () => {
  const store = new LocalEncryptedSecretStore({
    masterKey: "test-master-key-0123456789abcdef",
  });

  await store.set("org-1", "proj-1", "API_KEY", "sk_live_xyz");
  assertEquals(await store.get("org-1", "proj-1", "API_KEY"), "sk_live_xyz");

  await store.delete("org-1", "proj-1", "API_KEY");
  assertEquals(await store.get("org-1", "proj-1", "API_KEY"), null);

  const names = await store.listNames("org-1", "proj-1");
  assertEquals(names, []);

  // Deleting non-existent secret is safe (no-op)
  await store.delete("org-1", "proj-1", "API_KEY");
  await store.delete("org-1", "proj-1", "NON_EXISTENT");
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
Deno.test("Integration: delete removes persisted file from storage", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const store = new LocalEncryptedSecretStore({
      masterKey: "test-master-key-0123456789abcdef",
      storagePath: tempDir,
    });

    await store.set("org-1", "proj-1", "TO_BE_DELETED", "value-123");
    let files = await getAllFiles(tempDir);
    assertEquals(files.length, 1);

    await store.delete("org-1", "proj-1", "TO_BE_DELETED");
    assertEquals(await store.get("org-1", "proj-1", "TO_BE_DELETED"), null);

    files = await getAllFiles(tempDir);
    assertEquals(files.length, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
// spec: docs/contracts/platform.contract.md#PLAT-12 — Error model (ValidationFailedError)
Deno.test("Security: altering ciphertext byte throws ValidationFailedError", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const store = new LocalEncryptedSecretStore({
      masterKey: "test-master-key-0123456789abcdef",
      storagePath: tempDir,
    });

    await store.set("org-1", "proj-1", "TAMPER_KEY", "sensitive-information");

    const files = await getAllFiles(tempDir);
    assertEquals(files.length, 1);
    const filePath = files[0];

    // Read stored bytes and flip a byte in the encrypted content
    const bytes = await Deno.readFile(filePath);
    // Flip byte near the middle (ciphertext payload)
    const corruptOffset = Math.floor(bytes.length / 2);
    bytes[corruptOffset] ^= 0xff;
    await Deno.writeFile(filePath, bytes);

    await assertRejects(
      async () => {
        await store.get("org-1", "proj-1", "TAMPER_KEY");
      },
      ValidationFailedError,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
// spec: docs/contracts/platform.contract.md#PLAT-12 — Error model (ValidationFailedError)
Deno.test("Security: altering authentication tag throws ValidationFailedError", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const store = new LocalEncryptedSecretStore({
      masterKey: "test-master-key-0123456789abcdef",
      storagePath: tempDir,
    });

    await store.set("org-1", "proj-1", "TAG_KEY", "authenticated-information");

    const files = await getAllFiles(tempDir);
    assertEquals(files.length, 1);
    const filePath = files[0];

    // Corrupt the very last byte (tag area)
    const bytes = await Deno.readFile(filePath);
    bytes[bytes.length - 1] ^= 0x01;
    await Deno.writeFile(filePath, bytes);

    await assertRejects(
      async () => {
        await store.get("org-1", "proj-1", "TAG_KEY");
      },
      ValidationFailedError,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
// spec: docs/contracts/platform.contract.md#PLAT-12 — Error model (ValidationFailedError)
Deno.test("Security: truncated or malformed record throws ValidationFailedError", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const store = new LocalEncryptedSecretStore({
      masterKey: "test-master-key-0123456789abcdef",
      storagePath: tempDir,
    });

    await store.set("org-1", "proj-1", "TRUNC_KEY", "truncate-me-test");

    const files = await getAllFiles(tempDir);
    assertEquals(files.length, 1);
    const filePath = files[0];

    // Truncate to just 4 bytes
    const truncatedBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    await Deno.writeFile(filePath, truncatedBytes);

    await assertRejects(
      async () => {
        await store.get("org-1", "proj-1", "TRUNC_KEY");
      },
      ValidationFailedError,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
// spec: docs/contracts/platform.contract.md#PLAT-12 — Error model (ValidationFailedError)
Deno.test("Security: decryption with incorrect masterKey throws ValidationFailedError", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const store1 = new LocalEncryptedSecretStore({
      masterKey: "correct-master-key-0123456789abcdef",
      storagePath: tempDir,
    });

    await store1.set("org-1", "proj-1", "KEY_WRONG_PW", "super-secret");

    const store2 = new LocalEncryptedSecretStore({
      masterKey: "wrong-master-key-9876543210fedcba",
      storagePath: tempDir,
    });

    await assertRejects(
      async () => {
        await store2.get("org-1", "proj-1", "KEY_WRONG_PW");
      },
      ValidationFailedError,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
Deno.test("Integration: persistent storage retains secrets across store re-instantiations", async () => {
  const tempDir = await Deno.makeTempDir();
  const masterKey = "persistent-store-key-1234567890";
  try {
    const store1 = new LocalEncryptedSecretStore({
      masterKey,
      storagePath: tempDir,
    });

    await store1.set(
      "org-1",
      "proj-1",
      "DB_URL",
      "postgres://user:pass@host/db",
    );

    // Create a brand new instance pointing at the same storage path
    const store2 = new LocalEncryptedSecretStore({
      masterKey,
      storagePath: tempDir,
    });

    const retrieved = await store2.get("org-1", "proj-1", "DB_URL");
    assertEquals(retrieved, "postgres://user:pass@host/db");

    const names = await store2.listNames("org-1", "proj-1");
    assertEquals(names, ["DB_URL"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
// spec: docs/contracts/platform.contract.md#PLAT-12 — Error model (ValidationFailedError)
Deno.test("Security: path traversal in tenant or secret identifiers is rejected", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const store = new LocalEncryptedSecretStore({
      masterKey: "test-master-key-0123456789abcdef",
      storagePath: tempDir,
    });

    const traversalTargets = [
      { org: "../escaped", proj: "proj", name: "KEY" },
      { org: "org", proj: "../../escaped", name: "KEY" },
      { org: "org", proj: "proj", name: "../../../escaped_secret" },
      { org: "org/traversal", proj: "proj", name: "KEY" },
      { org: "org", proj: "proj/traversal", name: "KEY" },
      { org: "org", proj: "proj", name: "KEY/sub" },
    ];

    for (const { org, proj, name } of traversalTargets) {
      await assertRejects(
        async () => {
          await store.set(org, proj, name, "malicious_val");
        },
        ValidationFailedError,
      );

      await assertRejects(
        async () => {
          await store.get(org, proj, name);
        },
        ValidationFailedError,
      );
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
// spec: docs/contracts/platform.contract.md#PLAT-12 — Error model (ValidationFailedError)
Deno.test("Security: empty identifiers throw ValidationFailedError", async () => {
  const store = new LocalEncryptedSecretStore({
    masterKey: "test-master-key-0123456789abcdef",
  });

  await assertRejects(
    async () => {
      await store.set("", "proj", "KEY", "val");
    },
    ValidationFailedError,
  );

  await assertRejects(
    async () => {
      await store.set("org", "", "KEY", "val");
    },
    ValidationFailedError,
  );

  await assertRejects(
    async () => {
      await store.set("org", "proj", "", "val");
    },
    ValidationFailedError,
  );
});

// spec: docs/contracts/platform.contract.md#PLAT-7 — Multi-tenancy (Single dot path traversal & collision defense)
// spec: docs/contracts/platform.contract.md#PLAT-12 — Error model (ValidationFailedError)
Deno.test("Security Adversarial: single dot identifier path traversal and collision (PLAT-7)", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const store = new LocalEncryptedSecretStore({
      masterKey: "test-master-key-0123456789abcdef",
      storagePath: tempDir,
    });

    await assertRejects(
      async () => {
        await store.set(".", "victim", "COLLISION_KEY", "attacker_secret");
      },
      ValidationFailedError,
    );

    await assertRejects(
      async () => {
        await store.set("victim", ".", "COLLISION_KEY", "victim_secret");
      },
      ValidationFailedError,
    );

    await assertRejects(
      async () => {
        await store.set("victim", "proj", ".", "dot_secret");
      },
      ValidationFailedError,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// spec: docs/contracts/platform.contract.md#PLAT-12 — Error model (Reserved filesystem characters throw ValidationFailedError)
Deno.test("Security Adversarial: invalid filesystem characters throw ValidationFailedError (PLAT-12)", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const store = new LocalEncryptedSecretStore({
      masterKey: "test-master-key-0123456789abcdef",
      storagePath: tempDir,
    });

    for (
      const invalidId of [
        "tenant:1",
        "proj*",
        "org<1>",
        "name?",
        "pipe|",
        'quote"',
      ]
    ) {
      await assertRejects(
        async () => {
          await store.set(invalidId, "proj", "KEY", "val");
        },
        ValidationFailedError,
      );
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// spec: docs/contracts/platform.contract.md#PLAT-7 — Multi-tenancy (Silent tenant aliasing via whitespace or trailing dots)
Deno.test("Security Adversarial: identifiers with leading/trailing whitespace or trailing dots rejected (PLAT-7)", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const store = new LocalEncryptedSecretStore({
      masterKey: "test-master-key-0123456789abcdef",
      storagePath: tempDir,
    });

    for (const untrimmed of ["tenant1 ", " tenant1", "tenant1."]) {
      await assertRejects(
        async () => {
          await store.set(untrimmed, "proj", "KEY", "val");
        },
        ValidationFailedError,
      );
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// spec: docs/contracts/platform.contract.md#PLAT-12 — Error model (Invalid masterKey types rejected)
Deno.test("Security Adversarial: non-string non-Uint8Array masterKey rejected (PLAT-12)", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => new LocalEncryptedSecretStore({ masterKey: {} as any }),
    ValidationFailedError,
  );
});
