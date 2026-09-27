# Secrets Management & Isolation Guide

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-6`](../contracts/platform.contract.md#PLAT-6),
> [`PLAT-15`](../contracts/platform.contract.md#PLAT-15) &nbsp;|&nbsp;
> **Security Model**: Zero Ambient Authority

RailFog enforces strict, capability-based secrets isolation. Functions possess
zero ambient access to host environment variables (`Deno.env` is restricted).
Secrets must be explicitly declared in `railfog.toml` and are injected
dynamically at invocation time.

---

## 1. Declaring Secrets in `railfog.toml`

Secrets required by a function must be declared under its `permissions.secrets`
list:

```toml
[functions.api]
entry = "functions/api.ts"

[functions.api.permissions]
secrets = ["STRIPE_SECRET_KEY", "JWT_SIGNING_KEY"]
```

### Identifier Rules (`PLAT-15`)

Secret names must conform to valid C-style identifiers:

- Regex: `^[A-Za-z_][A-Za-z0-9_]*$`
- Case-sensitive (uppercase by convention)
- Must not contain hyphens, spaces, or special characters

---

## 2. Managing Secrets with the CLI (`rail secrets`)

Manage encrypted secrets using the `rail secrets` command:

### Set a Secret

```bash
# Prompt securely for value
rail secrets set STRIPE_SECRET_KEY

# Pass value directly
rail secrets set STRIPE_SECRET_KEY sk_live_51AbCdEf...

# Read from a file (e.g. private keys or service accounts)
rail secrets set JWT_SIGNING_KEY --file ./keys/private.pem
```

### List Configured Secrets

```bash
rail secrets list
```

Displays key names and last updated timestamps. Secret values are never shown in
plaintext.

### Delete a Secret

```bash
rail secrets delete STRIPE_SECRET_KEY
```

---

## 3. Accessing Secrets in Function Handlers

Access declared secrets through `c.env`:

```typescript
import { handle, type HandlerContext } from "@railfog/sdk";

export default handle(async (c: HandlerContext) => {
  // 1. Get optional secret (returns string | undefined)
  const webhookSecret = c.env.get("WEBHOOK_SECRET");

  // 2. Require mandatory secret (throws PermissionDeniedError if unset)
  const stripeKey = c.env.require("STRIPE_SECRET_KEY");

  return c.json({ configured: Boolean(stripeKey) });
});
```

---

## 4. Security Invariants (`PLAT-15`, `PLAT-8`)

1. **Undeclared Access is Denied**: Attempting to read a secret that was not
   declared in `permissions.secrets` throws `PermissionDeniedError` (`403`).
2. **Zero Reflection**: Secret enumeration (`keys()`, `entries()`, `for...in`)
   is prohibited to prevent credential dumps.
3. **Automatic Log Redaction (`PLAT-8`)**: All stdout/stderr output and
   structured runtime logs pass through a high-entropy secret redactor. Secret
   values matching encrypted vault entries are automatically masked with
   `[REDACTED]`.

---

## Next Steps

- Learn about [Testing Functions](testing.md).
- Learn how to [Deploy Projects](deployment.md).
