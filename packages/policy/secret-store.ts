/**
 * SecretStore interface and local encrypted secret store implementation.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-15: Secrets (encryption at rest, tenant isolation, zero plaintext persistence)
 * - docs/contracts/platform.contract.md#PLAT-12: Error model (ValidationFailedError on invalid inputs or cryptographic failure)
 * - docs/contracts/platform.contract.md#PLAT-7: Multi-tenancy & data isolation (scoping by org_id and project_id)
 */

import { join } from "@std/path";
import { ValidationFailedError } from "../errors/mod.ts";

// spec: docs/contracts/platform.contract.md#PLAT-15 — Record format magic bytes "RFS1"
const RECORD_MAGIC = new Uint8Array([0x52, 0x46, 0x53, 0x31]);
const MAGIC_LENGTH = 4;

// spec: docs/contracts/platform.contract.md#PLAT-15 — Cryptographic parameters for AES-GCM and PBKDF2
const SALT_LENGTH_BYTES = 16;
const IV_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;
const TAG_LENGTH_BITS = 128;
const KEY_LENGTH_BITS = 256;
const PBKDF2_ITERATIONS = 100_000;

// spec: docs/contracts/platform.contract.md#PLAT-15 — Minimum record size: magic (4) + salt (16) + IV (12) + tag (16) = 48 bytes
const MIN_RECORD_LENGTH_BYTES = MAGIC_LENGTH + SALT_LENGTH_BYTES +
  IV_LENGTH_BYTES + TAG_LENGTH_BYTES;

const FILE_EXTENSION = ".enc";

/**
 * SecretStore defines the contract for accessing and managing encrypted secrets.
 * spec: docs/contracts/platform.contract.md#PLAT-15
 */
export interface SecretStore {
  get(orgId: string, projectId: string, name: string): Promise<string | null>;
  set(
    orgId: string,
    projectId: string,
    name: string,
    value: string,
  ): Promise<void>;
  delete(orgId: string, projectId: string, name: string): Promise<void>;
  listNames(orgId: string, projectId: string): Promise<string[]>;
}

/**
 * Options for configuring a LocalEncryptedSecretStore.
 */
export interface EncryptedSecretStoreOptions {
  masterKey: Uint8Array | string;
  storagePath?: string;
}

// spec: docs/contracts/platform.contract.md#PLAT-7, PLAT-12 — Forbidden characters across all operating systems & filesystems
const FORBIDDEN_IDENTIFIER_CHARS = /[<>:"/\\|?*]/;

/**
 * Checks for ASCII control characters (0x00-0x1F, 0x7F) without control regex.
 */
function hasControlChar(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0x00 && code <= 0x1f) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Validates tenant, project, and secret identifiers against path traversal, dot collisions, and invalid characters.
 * spec: docs/contracts/platform.contract.md#PLAT-12
 * spec: docs/contracts/platform.contract.md#PLAT-7
 */
function assertValidIdentifier(label: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationFailedError(
      `${label} must be a non-empty string`,
    );
  }
  if (
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    value.includes("..") ||
    value.endsWith(".") ||
    FORBIDDEN_IDENTIFIER_CHARS.test(value) ||
    hasControlChar(value)
  ) {
    throw new ValidationFailedError(
      `${label} contains invalid characters or path traversal sequences`,
    );
  }
}

/**
 * Local encrypted secret store using AES-GCM-256 and PBKDF2-HMAC-SHA256 key derivation.
 * Supports ephemeral in-memory storage or persistent filesystem storage.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
 * spec: docs/contracts/platform.contract.md#PLAT-7 — Multi-tenancy & data isolation
 */
export class LocalEncryptedSecretStore implements SecretStore {
  readonly #options: EncryptedSecretStoreOptions;
  #baseKeyPromise: Promise<CryptoKey> | null = null;
  readonly #memoryStore = new Map<
    string,
    Map<string, Map<string, Uint8Array>>
  >();

  constructor(options: EncryptedSecretStoreOptions) {
    if (
      !options ||
      !options.masterKey ||
      (typeof options.masterKey !== "string" &&
        !(options.masterKey instanceof Uint8Array)) ||
      (typeof options.masterKey === "string" &&
        options.masterKey.length === 0) ||
      (options.masterKey instanceof Uint8Array &&
        options.masterKey.length === 0)
    ) {
      // spec: docs/contracts/platform.contract.md#PLAT-12 — Error model
      throw new ValidationFailedError("masterKey must not be empty");
    }
    this.#options = {
      masterKey: typeof options.masterKey === "string"
        ? options.masterKey
        : new Uint8Array(options.masterKey),
      storagePath: options.storagePath,
    };
  }

  #getBaseKey(): Promise<CryptoKey> {
    if (!this.#baseKeyPromise) {
      const rawKey = typeof this.#options.masterKey === "string"
        ? new TextEncoder().encode(this.#options.masterKey)
        : this.#options.masterKey;
      const keyBytes = new Uint8Array(rawKey);
      this.#baseKeyPromise = crypto.subtle.importKey(
        "raw",
        keyBytes,
        "PBKDF2",
        false,
        ["deriveKey"],
      );
    }
    return this.#baseKeyPromise;
  }

  // spec: docs/contracts/platform.contract.md#PLAT-15 — AES-GCM 256-bit encryption with random IV and salt
  async #encrypt(plaintext: string): Promise<Uint8Array> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));

    const baseKey = await this.#getBaseKey();
    const derivedKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: KEY_LENGTH_BITS },
      false,
      ["encrypt"],
    );

    const plaintextBytes = new TextEncoder().encode(plaintext);
    const ciphertextBuffer = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: TAG_LENGTH_BITS,
      },
      derivedKey,
      plaintextBytes,
    );

    const ciphertextAndTag = new Uint8Array(ciphertextBuffer);
    const record = new Uint8Array(
      MAGIC_LENGTH + SALT_LENGTH_BYTES + IV_LENGTH_BYTES +
        ciphertextAndTag.byteLength,
    );
    record.set(RECORD_MAGIC, 0);
    record.set(salt, MAGIC_LENGTH);
    record.set(iv, MAGIC_LENGTH + SALT_LENGTH_BYTES);
    record.set(
      ciphertextAndTag,
      MAGIC_LENGTH + SALT_LENGTH_BYTES + IV_LENGTH_BYTES,
    );

    return record;
  }

  // spec: docs/contracts/platform.contract.md#PLAT-15 — Authenticated decryption with tamper detection
  async #decrypt(record: Uint8Array): Promise<string> {
    if (record.byteLength < MIN_RECORD_LENGTH_BYTES) {
      // spec: docs/contracts/platform.contract.md#PLAT-12 — Error model
      throw new ValidationFailedError("Invalid secret record length");
    }
    if (
      record[0] !== RECORD_MAGIC[0] ||
      record[1] !== RECORD_MAGIC[1] ||
      record[2] !== RECORD_MAGIC[2] ||
      record[3] !== RECORD_MAGIC[3]
    ) {
      // spec: docs/contracts/platform.contract.md#PLAT-12 — Error model
      throw new ValidationFailedError("Invalid secret record magic header");
    }

    const salt = record.slice(
      MAGIC_LENGTH,
      MAGIC_LENGTH + SALT_LENGTH_BYTES,
    );
    const iv = record.slice(
      MAGIC_LENGTH + SALT_LENGTH_BYTES,
      MAGIC_LENGTH + SALT_LENGTH_BYTES + IV_LENGTH_BYTES,
    );
    const ciphertextAndTag = record.slice(
      MAGIC_LENGTH + SALT_LENGTH_BYTES + IV_LENGTH_BYTES,
    );

    const baseKey = await this.#getBaseKey();
    const derivedKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: KEY_LENGTH_BITS },
      false,
      ["decrypt"],
    );

    let plaintextBuffer: ArrayBuffer;
    try {
      plaintextBuffer = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          tagLength: TAG_LENGTH_BITS,
        },
        derivedKey,
        ciphertextAndTag,
      );
    } catch (_err) {
      // spec: docs/contracts/platform.contract.md#PLAT-12 — Error model
      throw new ValidationFailedError(
        "Secret decryption failed: ciphertext corrupted, tag mismatch, or wrong key",
      );
    }

    return new TextDecoder().decode(plaintextBuffer);
  }

  #getRecordPath(orgId: string, projectId: string, name: string): string {
    // spec: docs/contracts/platform.contract.md#PLAT-7 — Namespacing by org_id/project_id
    return join(
      this.#options.storagePath!,
      orgId,
      projectId,
      `${encodeURIComponent(name)}${FILE_EXTENSION}`,
    );
  }

  #getProjectDir(orgId: string, projectId: string): string {
    return join(this.#options.storagePath!, orgId, projectId);
  }

  // spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
  async get(
    orgId: string,
    projectId: string,
    name: string,
  ): Promise<string | null> {
    assertValidIdentifier("orgId", orgId);
    assertValidIdentifier("projectId", projectId);
    assertValidIdentifier("name", name);

    let record: Uint8Array | undefined;

    if (this.#options.storagePath !== undefined) {
      const filePath = this.#getRecordPath(orgId, projectId, name);
      try {
        record = await Deno.readFile(filePath);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          return null;
        }
        throw err;
      }
    } else {
      record = this.#memoryStore.get(orgId)?.get(projectId)?.get(name);
      if (!record) {
        return null;
      }
    }

    return await this.#decrypt(record);
  }

  // spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
  async set(
    orgId: string,
    projectId: string,
    name: string,
    value: string,
  ): Promise<void> {
    assertValidIdentifier("orgId", orgId);
    assertValidIdentifier("projectId", projectId);
    assertValidIdentifier("name", name);

    if (typeof value !== "string") {
      throw new ValidationFailedError("Secret value must be a string");
    }

    const record = await this.#encrypt(value);

    if (this.#options.storagePath !== undefined) {
      const projectDir = this.#getProjectDir(orgId, projectId);
      await Deno.mkdir(projectDir, { recursive: true });
      const filePath = this.#getRecordPath(orgId, projectId, name);
      await Deno.writeFile(filePath, record);
    } else {
      let orgMap = this.#memoryStore.get(orgId);
      if (!orgMap) {
        orgMap = new Map();
        this.#memoryStore.set(orgId, orgMap);
      }
      let projMap = orgMap.get(projectId);
      if (!projMap) {
        projMap = new Map();
        orgMap.set(projectId, projMap);
      }
      projMap.set(name, record);
    }
  }

  // spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
  async delete(
    orgId: string,
    projectId: string,
    name: string,
  ): Promise<void> {
    assertValidIdentifier("orgId", orgId);
    assertValidIdentifier("projectId", projectId);
    assertValidIdentifier("name", name);

    if (this.#options.storagePath !== undefined) {
      const filePath = this.#getRecordPath(orgId, projectId, name);
      try {
        await Deno.remove(filePath);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          throw err;
        }
      }
    } else {
      const orgMap = this.#memoryStore.get(orgId);
      if (orgMap) {
        const projMap = orgMap.get(projectId);
        if (projMap) {
          projMap.delete(name);
          if (projMap.size === 0) {
            orgMap.delete(projectId);
            if (orgMap.size === 0) {
              this.#memoryStore.delete(orgId);
            }
          }
        }
      }
    }
  }

  // spec: docs/contracts/platform.contract.md#PLAT-15 — Secrets
  async listNames(orgId: string, projectId: string): Promise<string[]> {
    assertValidIdentifier("orgId", orgId);
    assertValidIdentifier("projectId", projectId);

    if (this.#options.storagePath !== undefined) {
      const projectDir = this.#getProjectDir(orgId, projectId);
      const names: string[] = [];
      try {
        for await (const entry of Deno.readDir(projectDir)) {
          if (entry.isFile && entry.name.endsWith(FILE_EXTENSION)) {
            const rawName = entry.name.slice(0, -FILE_EXTENSION.length);
            try {
              names.push(decodeURIComponent(rawName));
            } catch {
              // Ignore files with invalid URI encoding
            }
          }
        }
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          return [];
        }
        throw err;
      }
      return names;
    } else {
      const projMap = this.#memoryStore.get(orgId)?.get(projectId);
      if (!projMap) {
        return [];
      }
      return Array.from(projMap.keys());
    }
  }
}
