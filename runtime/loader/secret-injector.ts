/**
 * Dynamic secret injection and scoped EnvBinding resolution.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-15: Secrets (runtime access capability-scoped;
 *   resolved at invocation time from SecretStore; never baked into artifact; rotation without redeploy)
 * - docs/contracts/platform.contract.md#PLAT-6: Capability injection (no runtime ACL checks,
 *   absence of declaration means unaddressable resource)
 * - docs/contracts/platform.contract.md#PLAT-7: Multi-tenancy & data isolation (scoping by orgId and projectId)
 * - docs/contracts/platform.contract.md#PLAT-12: Error model (ValidationFailedError on invalid identifiers)
 * - docs/contracts/functions.contract.md#FN-4: RailFogContext (env: EnvBinding exposes only explicitly assigned secrets)
 * - docs/contracts/functions.contract.md#FN-6: Isolation & warm-reuse rule (bindings re-injected on every invocation,
 *   never trusted to persist across invocations)
 */

import { ValidationFailedError } from "../../packages/errors/mod.ts";
import type { SecretStore } from "../../packages/policy/secret-store.ts";
import type { EnvBinding } from "./context-builder.ts";

// spec: docs/contracts/platform.contract.md#PLAT-7, PLAT-12 — Forbidden characters across operating systems and namespaces
const FORBIDDEN_IDENTIFIER_CHARS = /[<>:"/\\|?*]/;

/**
 * Validates tenant and project identifiers against traversal and illegal characters.
 * spec: docs/contracts/platform.contract.md#PLAT-7
 * spec: docs/contracts/platform.contract.md#PLAT-12
 */
function assertValidIdentifier(label: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationFailedError(`${label} must be a non-empty string`);
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
 * Checks for ASCII control characters (0x00-0x1F, 0x7F) without regex control characters.
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

export interface SecretInjector {
  resolveEnvBinding(
    orgId: string,
    projectId: string,
    allowedSecrets: string[],
    secretStore: SecretStore,
  ): Promise<EnvBinding>;
}

/**
 * Dynamically resolves declared secrets from SecretStore into a scoped EnvBinding.
 * spec: docs/contracts/platform.contract.md#PLAT-15 — Dynamic invocation-time secret resolution
 * spec: docs/contracts/functions.contract.md#FN-6 — Re-resolved per invocation for warm isolate safety
 */
export class SecretInjector implements SecretInjector {
  async resolveEnvBinding(
    orgId: string,
    projectId: string,
    allowedSecrets: string[],
    secretStore: SecretStore,
  ): Promise<EnvBinding> {
    // spec: docs/contracts/platform.contract.md#PLAT-12 — Error model validation
    // spec: docs/contracts/platform.contract.md#PLAT-7 — Tenant and project validation
    assertValidIdentifier("orgId", orgId);
    assertValidIdentifier("projectId", projectId);

    if (
      !secretStore ||
      typeof secretStore !== "object" ||
      typeof secretStore.get !== "function"
    ) {
      throw new ValidationFailedError(
        "secretStore must be a valid SecretStore instance",
      );
    }

    if (!Array.isArray(allowedSecrets)) {
      throw new ValidationFailedError("allowedSecrets must be an array");
    }

    // spec: docs/contracts/platform.contract.md#PLAT-15 — Safe storage preventing prototype pollution
    const resolved = new Map<string, string>();

    // spec: docs/contracts/platform.contract.md#PLAT-6 — Resolve only explicitly declared secrets
    const uniqueSecrets = Array.from(new Set(allowedSecrets));
    const entries = await Promise.all(
      uniqueSecrets.map(async (secretName) => {
        if (typeof secretName !== "string") {
          throw new ValidationFailedError(
            "Each secret in allowedSecrets must be a string",
          );
        }
        const val = await secretStore.get(orgId, projectId, secretName);
        return [secretName, val] as const;
      }),
    );

    for (const [name, val] of entries) {
      if (val !== null && val !== undefined) {
        resolved.set(name, val);
      }
    }

    // spec: docs/contracts/functions.contract.md#FN-4 — Expose only explicitly resolved secrets
    // spec: docs/contracts/platform.contract.md#PLAT-15 — Never ambient process environment
    // spec: docs/contracts/functions.contract.md#FN-6 — Fresh instance per invocation
    return {
      get(key: string): string | undefined {
        return resolved.get(key);
      },
    };
  }
}
