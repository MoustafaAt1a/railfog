/**
 * CLI secrets management subcommand implementation (T-0506).
 *
 * Spec references:
 * - PLAT-12: Error model (exhaustive code table: VALIDATION_FAILED, RESOURCE_NOT_FOUND)
 * - PLAT-15: Secrets management (encrypted persistence via AES-GCM-256 + PBKDF2, zero plaintext leakage in logs/stdout/stderr/errors)
 * - PLAT-19: Repository structure and CLI subcommands
 * - Task: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md
 */

import { join, resolve } from "@std/path";
import { parse } from "@std/toml";
import { LocalEncryptedSecretStore } from "../packages/policy/secret-store.ts";
import { SecretRedactor } from "../packages/logging/secret-redactor.ts";
import { renderModernTable, renderStatusBar } from "./ui.ts";

// spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md — Valid secret identifier regex
export const VALID_SECRET_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

// spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md — SecretCliOptions interface
export interface SecretCliOptions {
  projectDir?: string;
  projectId?: string;
  project?: string;
  subcommand: "set" | "list" | "delete";
  key?: string;
  value?: string;
  filePath?: string;
}

// spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md — SecretListEntry interface
export interface SecretListEntry {
  key: string;
  updatedAt: number;
}

// spec: docs/contracts/platform.contract.md#PLAT-15 — Master key derivation or reading from .railfog/secrets.key
async function resolveMasterKey(projectDir: string): Promise<string> {
  const envKey = Deno.env.get("RAILFOG_MASTER_KEY");
  if (envKey && envKey.trim().length > 0) {
    return envKey.trim();
  }

  const railfogDir = join(projectDir, ".railfog");
  const keyPath = join(railfogDir, "secrets.key");

  try {
    const existing = await Deno.readTextFile(keyPath);
    if (existing.trim().length > 0) {
      return existing.trim();
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }

  // Generate 32 bytes hex
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const hexKey = Array.from(keyBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  await Deno.mkdir(railfogDir, { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(keyPath, hexKey, { mode: 0o600 });
  return hexKey;
}

// spec: docs/contracts/platform.contract.md#PLAT-18 — Project name resolution from railfog.toml
async function resolveProjectId(projectDir: string): Promise<string> {
  const tomlPath = join(projectDir, "railfog.toml");
  try {
    const content = await Deno.readTextFile(tomlPath);
    const parsed = parse(content) as Record<string, unknown>;
    if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
      return parsed.name.trim();
    }
  } catch {
    // If railfog.toml not found or malformed, fallback to "default"
  }
  return "default";
}

/**
 * Runs the rail secrets subcommands: set, list, delete.
 *
 * spec: docs/contracts/platform.contract.md#PLAT-15 — Zero secret leakage in stdout, stderr, or errors
 * spec: docs/contracts/platform.contract.md#PLAT-12 — Machine readable error codes
 * spec: docs/contracts/platform.contract.md#PLAT-19 — CLI subcommands
 */
export async function runSecrets(options: SecretCliOptions): Promise<number> {
  const redactor = new SecretRedactor();
  const secretCandidates: string[] = [];

  if (typeof options?.value === "string" && options.value.length > 0) {
    secretCandidates.push(options.value);
  }

  const safeError = (msg: string): void => {
    console.error(redactor.redact(msg, secretCandidates));
  };

  try {
    if (!options || typeof options !== "object") {
      safeError("Error: VALIDATION_FAILED: Invalid options object.");
      return 1;
    }

    if (
      options.subcommand !== "set" &&
      options.subcommand !== "list" &&
      options.subcommand !== "delete"
    ) {
      // spec: docs/contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED on invalid subcommand
      safeError(
        `Error: VALIDATION_FAILED: Unknown subcommand '${
          String(options.subcommand)
        }'. Available: set, list, delete`,
      );
      return 1;
    }

    // Key validation for set and delete
    if (options.subcommand === "set" || options.subcommand === "delete") {
      if (
        !options.key || typeof options.key !== "string" ||
        !VALID_SECRET_KEY_REGEX.test(options.key)
      ) {
        // spec: docs/contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED on invalid secret key
        safeError(
          "Error: VALIDATION_FAILED: Secret key is required and must match ^[A-Za-z_][A-Za-z0-9_]*$",
        );
        return 1;
      }
    }

    // Value resolution for set
    let secretValueToSet: string | undefined;
    if (options.subcommand === "set") {
      if (options.filePath !== undefined) {
        try {
          secretValueToSet = await Deno.readTextFile(options.filePath);
          if (secretValueToSet.length > 0) {
            secretCandidates.push(secretValueToSet);
          }
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) {
            // spec: docs/contracts/platform.contract.md#PLAT-12 — RESOURCE_NOT_FOUND without path leakage
            safeError("Error: RESOURCE_NOT_FOUND: Secret file not found.");
            return 1;
          }
          // spec: docs/contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED
          const msg = err instanceof Error ? err.message : String(err);
          safeError(
            `Error: VALIDATION_FAILED: Failed to read secret file: ${msg}`,
          );
          return 1;
        }
      } else if (typeof options.value === "string") {
        secretValueToSet = options.value;
      } else {
        // spec: docs/contracts/platform.contract.md#PLAT-12 — VALIDATION_FAILED when neither value nor filePath is provided
        safeError(
          "Error: VALIDATION_FAILED: Either value or filePath must be provided for setting a secret.",
        );
        return 1;
      }
    }

    const projectDir = resolve(options.projectDir ?? Deno.cwd());
    const masterKey = await resolveMasterKey(projectDir);
    const storagePath = join(projectDir, ".railfog", "secrets");
    const projectId = options.projectId ?? options.project ?? await resolveProjectId(projectDir);
    const orgId = "default";

    // spec: docs/contracts/platform.contract.md#PLAT-15 — LocalEncryptedSecretStore initialization
    const store = new LocalEncryptedSecretStore({ masterKey, storagePath });

    switch (options.subcommand) {
      case "set": {
        // spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md#Acceptance criteria AC1
        // spec: docs/contracts/platform.contract.md#PLAT-15 — Persist encrypted secret at rest
        await store.set(orgId, projectId, options.key!, secretValueToSet!);
        // spec: docs/contracts/platform.contract.md#PLAT-15 — Confirmation without leaking secret value
        console.log(`Secret ${options.key!} updated`);
        console.log();
        console.log(
          renderStatusBar([
            { label: "Secret", value: options.key! },
            { label: "Project", value: projectId },
            { label: "Status", value: "Saved" },
          ]),
        );
        return 0;
      }

      case "list": {
        // spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md#Acceptance criteria AC2
        // spec: docs/contracts/platform.contract.md#PLAT-15 — Never output secret values in list
        const names = await store.listNames(orgId, projectId);
        if (names.length === 0) {
          console.log("No secrets found.");
          console.log();
          console.log(
            renderStatusBar([
              { label: "Project", value: projectId },
              { label: "Secrets", value: "0" },
              { label: "Status", value: "Empty" },
            ]),
          );
          return 0;
        }

        names.sort();
        const entries: SecretListEntry[] = [];
        for (const name of names) {
          const encFilePath = join(
            storagePath,
            orgId,
            projectId,
            `${encodeURIComponent(name)}.enc`,
          );
          let updatedAt = Date.now();
          try {
            const stat = await Deno.stat(encFilePath);
            updatedAt = stat.mtime?.getTime() ?? Date.now();
          } catch {
            // Fallback to current timestamp if stat unavailable
          }
          entries.push({ key: name, updatedAt });
        }

        const headers = ["KEY", "ENCRYPTION", "UPDATED"];
        const rows = entries.map((entry) => {
          const dateStr = new Date(entry.updatedAt)
            .toISOString()
            .replace("T", " ")
            .replace(/\.\d{3}Z$/, " UTC");
          return [entry.key, "[AES-GCM]", dateStr];
        });

        console.log(
          renderModernTable(headers, rows, {
            alignments: ["left", "center", "left"],
            style: "unicode",
          }),
        );
        console.log();
        console.log(
          renderStatusBar([
            { label: "Project", value: projectId },
            { label: "Total Secrets", value: String(entries.length) },
            { label: "Encryption", value: "AES-256-GCM" },
          ]),
        );
        return 0;
      }

      case "delete": {
        // spec: tasks/milestone-0.5-developer-experience/T-0506-cli-secrets-management.md#Acceptance criteria AC3
        // spec: docs/contracts/platform.contract.md#PLAT-12 — RESOURCE_NOT_FOUND if secret does not exist
        const existing = await store.get(orgId, projectId, options.key!);
        if (existing === null) {
          safeError(
            `Error: RESOURCE_NOT_FOUND: Secret '${options.key!}' not found.`,
          );
          return 1;
        }
        if (existing.length > 0) {
          secretCandidates.push(existing);
        }

        await store.delete(orgId, projectId, options.key!);
        console.log(`Secret ${options.key!} deleted`);
        console.log();
        console.log(
          renderStatusBar([
            { label: "Secret", value: options.key! },
            { label: "Project", value: projectId },
            { label: "Status", value: "Deleted" },
          ]),
        );
        return 0;
      }
    }
  } catch (err) {
    // spec: docs/contracts/platform.contract.md#PLAT-15 — Zero plaintext secret leakage in errors or stack traces
    const rawMessage = err instanceof Error
      ? (err.stack ?? err.message)
      : String(err);
    const sanitized = redactor.redact(rawMessage, secretCandidates);
    console.error(`Error: ${sanitized}`);
    return 1;
  }
}

export async function secretsCommand(
  options: SecretCliOptions,
): Promise<number> {
  return await runSecrets(options);
}

export function printSecretsHelp(): void {
  console.log(`RailFog CLI - Secrets management

Usage:
  rail secrets <subcommand> [arguments] [options]

Subcommands:
  set <KEY> [VALUE] [--file <path>]   Set or update an encrypted secret
  list                                List stored secret keys
  delete <KEY>                        Delete an encrypted secret

Options:
  --file <path>                       Read secret value from file (for multiline secrets)
  -C, --dir <path>                    Target project directory (alias: --project-dir, --cwd, default: current directory)
  -p, --project <name>                Project name override (alias: -n, --name)
  -h, --help                          Show help for secrets command`);
}

