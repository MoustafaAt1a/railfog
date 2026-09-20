/**
 * Structured log auto-redaction for secrets and serialized error traces.
 *
 * Spec references:
 * - docs/contracts/platform.contract.md#PLAT-15: Secrets (Structured logging must auto-redact
 *   any value matching a bound secret before it leaves the isolate; never included in error/trace)
 * - docs/contracts/platform.contract.md#PLAT-13: Observability (Structured logs are JSON, secrets
 *   auto-redacted per PLAT-15)
 * - docs/ANTI-SLOP.md: Error handling (Never log or return a secret value in an error, even accidentally)
 */

// spec: docs/contracts/platform.contract.md#PLAT-15 — Standard replacement marker
export const REDACTED_MARKER = "[REDACTED]";

// spec: tasks/milestone-0.3-security/T-0306-dynamic-secret-injection.md#Assumptions made
// Avoids false-positive over-redaction of trivial substrings (< 4 characters)
export const MIN_SECRET_REDACTION_LENGTH = 4;

export interface SecretRedactor {
  redact(text: string, secretValues: string[]): string;
  redactJson(obj: unknown, secretValues: string[]): unknown;
}

/**
 * Scans log messages, serialized errors, and structured JSON payloads to sanitize secret values.
 * spec: docs/contracts/platform.contract.md#PLAT-15
 * spec: docs/contracts/platform.contract.md#PLAT-13
 */
export class SecretRedactor implements SecretRedactor {
  /**
   * Filters and deduplicates secret values, sorting descending by length to prevent
   * partial substring leaks when secrets overlap.
   */
  #filterAndSortSecrets(secretValues: string[]): string[] {
    if (!Array.isArray(secretValues) || secretValues.length === 0) {
      return [];
    }

    const uniqueValidSecrets = new Set<string>();
    for (const secret of secretValues) {
      if (
        typeof secret === "string" &&
        secret.length >= MIN_SECRET_REDACTION_LENGTH
      ) {
        uniqueValidSecrets.add(secret);
      }
    }

    if (uniqueValidSecrets.size === 0) {
      return [];
    }

    // spec: docs/contracts/platform.contract.md#PLAT-15 — Clean redaction prioritizing longest matches
    return Array.from(uniqueValidSecrets).sort((a, b) => b.length - a.length);
  }

  /**
   * Performs literal string replacement using candidate secret values.
   */
  #redactWithCandidates(text: string, candidates: string[]): string {
    if (
      typeof text !== "string" ||
      text.length === 0 ||
      candidates.length === 0
    ) {
      return text;
    }

    let result = text;
    for (const secret of candidates) {
      // Literal replacement without regex metacharacter interference
      result = result.replaceAll(secret, REDACTED_MARKER);
    }
    return result;
  }

  /**
   * Redacts secret values from a text string.
   * spec: docs/contracts/platform.contract.md#PLAT-15
   */
  redact(text: string, secretValues: string[]): string {
    if (typeof text !== "string" || text.length === 0) {
      return text;
    }
    const candidates = this.#filterAndSortSecrets(secretValues);
    return this.#redactWithCandidates(text, candidates);
  }

  /**
   * Internal recursive deep-redaction traversal for arbitrary JSON-compatible values.
   * spec: docs/contracts/platform.contract.md#PLAT-13 — JSON structured log sanitization
   */
  #redactJsonInternal(
    obj: unknown,
    candidates: string[],
    visited: WeakMap<object, unknown>,
  ): unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === "string") {
      return this.#redactWithCandidates(obj, candidates);
    }

    if (typeof obj !== "object" && typeof obj !== "function") {
      return obj;
    }

    // Circular reference protection
    if (visited.has(obj as object)) {
      return visited.get(obj as object);
    }

    if (obj instanceof Date) {
      const copy = new Date(obj.getTime());
      visited.set(obj, copy);
      return copy;
    }

    if (obj instanceof RegExp) {
      const copy = new RegExp(obj.source, obj.flags);
      visited.set(obj, copy);
      return copy;
    }

    if (obj instanceof Error) {
      // spec: docs/contracts/platform.contract.md#PLAT-15 — Never included in error/trace
      // spec: docs/ANTI-SLOP.md#Error handling — Never log or return a secret value in an error
      const sanitizedMessage = typeof obj.message === "string"
        ? this.#redactWithCandidates(obj.message, candidates)
        : "";
      let errorCopy: Error;
      try {
        errorCopy = new (obj.constructor as new (msg?: string) => Error)(
          sanitizedMessage,
        );
      } catch {
        errorCopy = new Error(sanitizedMessage);
      }
      visited.set(obj, errorCopy);

      errorCopy.name = this.#redactWithCandidates(obj.name, candidates);
      if (typeof obj.stack === "string") {
        errorCopy.stack = this.#redactWithCandidates(obj.stack, candidates);
      }

      for (const key of Object.getOwnPropertyNames(obj)) {
        if (key === "name" || key === "message" || key === "stack") {
          continue;
        }
        const redactedKey = this.#redactWithCandidates(key, candidates);
        const val = (obj as unknown as Record<string, unknown>)[key];
        (errorCopy as unknown as Record<string, unknown>)[redactedKey] = this
          .#redactJsonInternal(val, candidates, visited);
      }
      return errorCopy;
    }

    if (Array.isArray(obj)) {
      const copy: unknown[] = [];
      visited.set(obj, copy);
      for (let i = 0; i < obj.length; i++) {
        copy.push(this.#redactJsonInternal(obj[i], candidates, visited));
      }
      return copy;
    }

    // Plain object deep copy with key and value redaction
    const copy: Record<string, unknown> = {};
    visited.set(obj as object, copy);

    for (const [key, val] of Object.entries(obj)) {
      const redactedKey = this.#redactWithCandidates(key, candidates);
      copy[redactedKey] = this.#redactJsonInternal(val, candidates, visited);
    }

    return copy;
  }

  /**
   * Deeply redacts secret values across keys and string properties in objects and arrays.
   * spec: docs/contracts/platform.contract.md#PLAT-13
   * spec: docs/contracts/platform.contract.md#PLAT-15
   */
  redactJson(obj: unknown, secretValues: string[]): unknown {
    const candidates = this.#filterAndSortSecrets(secretValues);
    const visited = new WeakMap<object, unknown>();
    return this.#redactJsonInternal(obj, candidates, visited);
  }
}
