# Project Structure

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp;
> **Specification**: [PLAT-18, PLAT-19](../contracts/platform.contract.md)

This guide documents the layout, conventions, and configuration files of a RailFog application.

---

## Standard Directory Layout

When you initialize a project using `rail init`, the following directory structure is created:

```text
my-project/
├── railfog.toml         # Primary application manifest
├── deno.json            # Deno compiler options, imports map, and tasks
├── functions/           # TypeScript function entrypoints
│   ├── api.ts           # HTTP handler
│   └── processor.ts     # Asynchronous queue consumer
└── tests/               # Unit and integration test files
    └── api_test.ts
```

---

## File Breakdown

### 1. `railfog.toml`
The single source of truth for your application's deployment configuration:
- Declares functions and their corresponding TypeScript source paths (`entry`).
- Defines triggers (`http`, `queue`, `schedule`, `webhook`).
- Injects capability-scoped permissions (`kv`, `objects`, `queues`, `network`, `secrets`).
- Configures hard resource limits (`cpu_ms`, `timeout_ms`, `memory_mb`, `concurrency`).
- Maps URL routing rules (`[[routes]]`) to target functions.

```toml
name = "my-project"

[functions.api]
entry = "functions/api.ts"

[functions.api.triggers]
http = true

[functions.api.permissions]
kv = ["main"]

[[routes]]
pattern = "/api/*"
function = "api"

[kv.main]
consistency = "strong"
```

---

### 2. `deno.json`
Manages the TypeScript toolchain and dependency imports map:

```json
{
  "imports": {
    "@railfog/sdk": "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/sdk/typescript/mod.ts"
  },
  "tasks": {
    "dev": "rail dev",
    "check": "rail check",
    "test": "deno test --allow-all"
  }
}
```

---

### 3. `functions/` Directory
Contains the executable handler modules. Each function module must export a default handler conforming to `FN-1` or `FN-2`:

```typescript
import type { FunctionHandler } from "@railfog/sdk";

const handler: FunctionHandler = async (req, ctx) => {
  return Response.json({ status: "ok", requestId: ctx.requestId });
};

export default handler;
```

> [!IMPORTANT]
> Entrypoint paths specified in `railfog.toml` must reside within the project directory. Directory traversal attempts (`../`) escaping the project boundary are rejected at deploy time (`PLAT-3`).

---

## Next Steps

- Explore the complete [`railfog.toml` Configuration Reference](../configuration/manifest.md).
- Learn about the [Functions Primitive](../primitives/functions/overview.md).
