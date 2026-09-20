# T-0305 — SecretStore interface and local encrypted store

Status: Done
Milestone: 0.3 Security
Depends on: T-0102
Blocks: T-0306, T-0313

## Spec references

`PLAT-15`

## Scope

**In scope:**
- `packages/policy/secret-store.ts`: define `SecretStore` interface (`get`, `set`, `delete`, `listNames`).
- Implement `LocalEncryptedSecretStore` using standard Web Crypto API (`AES-GCM` with 256-bit keys and PBKDF2 key derivation).
- Physical tenant namespacing by `{org_id}/{project_id}/{secret_name}`.
- Authenticated encryption: verify integrity using AES-GCM authentication tags; throw `ValidationFailedError` on tampering or corruption.
- Plaintext guarantees: secrets are never stored in plaintext on disk or memory dumps.

**Out of scope:**
- Cloud KMS or HashiCorp Vault remote integrations (Milestone 0.4/0.6).
- Invocation-time injection into `RailFogContext.env` (T-0306).
- Structured log auto-redaction (T-0306).

## Interface to implement

```typescript
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

export interface EncryptedSecretStoreOptions {
  masterKey: Uint8Array | string;
  storagePath?: string;
}

export class LocalEncryptedSecretStore implements SecretStore {
  constructor(options: EncryptedSecretStoreOptions);
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
```

## Acceptance criteria (Given/When/Then)

1. Given a secret stored via `set(orgId, projectId, "API_KEY", "sk_live_xyz")`, when retrieved via `get(orgId, projectId, "API_KEY")`, then it returns `"sk_live_xyz"`.
2. Given persisted ciphertext in storage or memory, when inspected, then the plaintext `"sk_live_xyz"` does not appear anywhere in storage.
3. Given two distinct projects storing secrets with the same name `"STRIPE_KEY"`, when read, then project A reads only project A's value and project B reads only project B's value.
4. Given a call to `listNames(orgId, projectId)`, when executed, then only secret identifier names are returned, never their plaintext values.

## Tests required

- [x] Unit — AES-GCM 256-bit encryption/decryption roundtrip, PBKDF2 key derivation with random salt, and unique initialization vectors per record
- [x] Integration — project-level physical isolation and persistent storage validation
- [x] Security — ciphertext examination confirming zero plaintext leakage, tamper detection rejecting altered ciphertext or tags, and cross-project access rejection (PLAT-15)

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches PLAT-15)
- [x] Nothing outside "In scope" touched

## Verification

```shell
$ deno check packages/policy/secret-store.ts packages/policy/secret-store_test.ts
Check packages/policy/secret-store.ts
Check packages/policy/secret-store_test.ts

$ deno test -A packages/policy/secret-store_test.ts
running 23 tests from ./packages/policy/secret-store_test.ts
Unit: set and get returns exact plaintext secret (AC1) ... ok (85ms)
Unit: get non-existent secret returns null (AC1) ... ok (112µs)
Unit: overwrite secret updates stored value ... ok (157ms)
Unit: secret store accepts Uint8Array masterKey ... ok (84ms)
Unit: handles empty values, unicode, and large payloads ... ok (233ms)
Unit: random IV per record ensures non-deterministic ciphertext ... ok (101ms)
Security: zero plaintext leakage in persistent storage (AC2) ... ok (50ms)
Integration: multi-tenant and cross-project isolation (AC3) ... ok (245ms)
Integration: physical tenant namespacing on disk ... ok (43ms)
AC4: listNames returns only secret names and never plaintext values ... ok (126ms)
Unit: delete cleanly removes secret ... ok (79ms)
Integration: delete removes persisted file from storage ... ok (50ms)
Security: altering ciphertext byte throws ValidationFailedError ... ok (92ms)
Security: altering authentication tag throws ValidationFailedError ... ok (103ms)
Security: truncated or malformed record throws ValidationFailedError ... ok (47ms)
Security: decryption with incorrect masterKey throws ValidationFailedError ... ok (89ms)
Integration: persistent storage retains secrets across store re-instantiations ... ok (88ms)
Security: path traversal in tenant or secret identifiers is rejected ... ok (1ms)
Security: empty identifiers throw ValidationFailedError ... ok (571µs)
Security Adversarial: single dot identifier path traversal and collision (PLAT-7) ... ok (2ms)
Security Adversarial: invalid filesystem characters throw ValidationFailedError (PLAT-12) ... ok (1ms)
Security Adversarial: identifiers with leading/trailing whitespace or trailing dots rejected (PLAT-7) ... ok (1ms)
Security Adversarial: non-string non-Uint8Array masterKey rejected (PLAT-12) ... ok (411µs)

ok | 23 passed | 0 failed (1s)

$ deno lint packages/policy/secret-store.ts packages/policy/secret-store_test.ts
Checked 2 files

$ deno fmt --check packages/policy/secret-store.ts packages/policy/secret-store_test.ts
Checked 2 files

$ deno test -A
ok | 406 passed | 0 failed (55s)
```

## Assumptions made

1. In local development, master encryption key can be supplied via environment variable `RAILFOG_MASTER_KEY` or generated ephemerally in-memory.
2. PBKDF2 iteration count is set to 100,000 with HMAC-SHA-256 and 16-byte random salt per encryption, conforming to OWASP recommended guidelines for symmetric key derivation.
3. In-memory ephemeral storage is modeled as nested Maps (`orgId -> projectId -> name -> Uint8Array`) to guarantee isolation and prevent any key collision or plaintext retention.
4. Persistent disk storage structures paths as `{storagePath}/{orgId}/{projectId}/{encodeURIComponent(name)}.enc` to ensure physical tenant isolation (PLAT-7) and safe filename encoding.
5. Identifiers (`orgId`, `projectId`, `name`) must be non-empty and cannot contain path traversal sequences (`..`), single dots (`.`), trailing dots, untrimmed whitespace, filesystem reserved characters (`:`, `*`, `?`, `<`, `>`, `|`, `"`), separators (`/`, `\`), null bytes, or ASCII control characters (0x00-0x1F, 0x7F); violation raises `ValidationFailedError` (PLAT-12). Master key must strictly be a non-empty string or Uint8Array. Plaintext secret values may be empty strings.
