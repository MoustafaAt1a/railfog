# RailFog

RailFog is a lightweight edge compute platform built on standard Web APIs (`Request`, `Response`, `fetch`, `ReadableStream`, Web Crypto, `URLPattern`) with capability-based security, isolated execution, and native primitives for Key-Value storage, Object storage, and asynchronous Queues.

---

## Architecture & Design Principles

1. **Trigger -> Function Model (`PLAT-2`, `FN-1`, `FN-2`)**: All workloads (HTTP requests, queue messages, cron schedules, webhooks) are triggers targeting isolated TypeScript functions. There are no separate worker or cron daemon services.
2. **Control Plane / Data Plane Separation (`PLAT-1`, `PLAT-8`)**: Deployments are managed by `railfog-control`, while requests are processed by `railfog-runtime`. Data-plane nodes operate fail-static from cached, versioned configuration snapshots and continue serving traffic if the control plane is unreachable (`PLAT-8`).
3. **Capability Injection (`PLAT-6`)**: Permissions declared in `railfog.toml` resolve at deploy time into pre-scoped binding instances (`ctx.kv`, `ctx.objects`, `ctx.queues`, `ctx.env`). There are no runtime ACL checks — functions have no physical code path to address undeclared resources.
4. **Local / Production Parity (`PLAT-17`)**: The local development loop (`rail dev`) uses local SQLite and filesystem adapters that implement the exact same provider interfaces (`PLAT-16`) used in production. Development requires zero cloud credentials.
5. **Direct Storage Transfer (`OBJ-3`)**: File uploads and downloads transfer directly between client and object storage via SigV4 presigned URLs (`ctx.objects.presign`), preventing functions from becoming bandwidth proxies.

---

## Installation & Quickstart

### 1. Install the CLI (`rail`)

The RailFog command-line interface (`rail`) is available as a global Deno executable or a zero-dependency standalone binary.

#### Option A: Global Deno Install (Recommended)
```bash
deno install -g -A -n rail https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/cli/main.ts
```
Once installed, `rail` is directly accessible from your shell terminal.

#### Option B: Standalone Native Binary (Zero Prerequisites)
Compile or download a self-contained executable for Windows, macOS, or Linux:
```bash
deno compile -A -o rail cli/main.ts
```
On Windows this produces `rail.exe`; on Linux and macOS it produces `rail`.

---

### 2. Install & Import the TypeScript SDK (`@railfog/sdk`)

The `@railfog/sdk` package provides typed handlers (`FunctionHandler`, `QueueConsumerHandler`), invocation context (`RailFogContext`), capability bindings (`ctx.kv`, `ctx.objects`, `ctx.queues`, `ctx.env`), and reliability utilities (`withIdempotency`, `withRetry`).

#### Option A: Automatic Scaffolding (Recommended)
Initializing any new project via `rail init` automatically configures `deno.json` with `@railfog/sdk`:
```bash
rail init my-app
cd my-app
```

#### Option B: Manual Import Mapping
Add `@railfog/sdk` to your project's `deno.json`:
```json
{
  "imports": {
    "@railfog/sdk": "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/sdk/typescript/mod.ts"
  }
}
```

#### Option C: Direct URL Import
In your TypeScript function handlers:
```typescript
import type { FunctionHandler, RailFogContext } from "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/sdk/typescript/mod.ts";

const handler: FunctionHandler = async (req, ctx) => {
  const visitor = await ctx.kv.get(["stats", "visitors"]);
  return Response.json({ ok: true, visitor, requestId: ctx.requestId });
};

export default handler;
```

---

### 3. Quickstart Workflow

```bash
# 1. Authenticate with the RailFog control plane
rail login --control-url https://railfog-control-production.up.railway.app

# 2. Verify authenticated identity
rail whoami

# 3. Create a new project
rail init my-app
cd my-app

# 4. Start the local development server (with SQLite KV/Queues and local storage)
rail dev

# 5. Validate project configuration and entrypoints statically
rail check

# 6. Deploy to the cloud
rail deploy
```

---

## Developer Tooling & CLI Commands (Milestone 0.5)

The `rail` CLI manages the full local development, validation, deployment, and operational lifecycle (`PLAT-19`).

### Project Scaffolding & Inspection

#### `rail init`
Initializes a new RailFog project in the target directory:
```bash
rail init [directory] [--template <minimal|worked-example>] [--name <project-name>] [--force]
```
- Creates `railfog.toml`, starter function handlers, and TypeScript configuration.
- Supports the `minimal` template or the canonical `worked-example` template (`docs/contracts/worked-example.md`).

#### `rail status`
Inspects the project configuration in the current directory:
```bash
rail status
```
- Displays project name, declared functions, entrypoint paths, and configured route mappings.

#### `rail check`
Statically validates project configuration and source entrypoints (`PLAT-3`):
```bash
rail check [path]
```
- Verifies TOML syntax and schema compliance.
- Ensures all entrypoint files exist and do not escape project root.
- Evaluates route patterns and calculates route specificity scores (`PLAT-11`).
- Identifies duplicate or shadowed route patterns.
- Validates consistency tiers (`KV-5`) and rejects unsafe SSRF network permissions (`PLAT-5`).

---

### Local Development

#### `rail dev`
Starts the local development server with hot reload (`PLAT-17`):
```bash
rail dev [--port <port>] [--host <host>] [--no-watch]
```
- Binds HTTP listener (default port: `8000`).
- Boots local SQLite-backed KV, filesystem Object storage, and SQLite-backed message queues.
- Watches project source files and hot-reloads functions without restarting the server.

---

### Secrets Management

#### `rail secrets`
Manages capability-scoped encrypted secrets for the project (`PLAT-15`):
```bash
rail secrets set <KEY> [VALUE] [--file <path>]
rail secrets list
rail secrets delete <KEY>
```
- Secret names must be valid C-style identifiers (`PLAT-15`).
- Secrets are resolved dynamically at invocation time via `ctx.env` and auto-redacted from structured runtime logs.

---

### Deployment & Operations

#### `rail deploy`
Packages, validates, and deploys the project to the Control Plane (`PLAT-3`):
```bash
rail deploy [--control-url <url>] [--project <name>]
```
- Packages source artifacts, computes SHA-256 content-addressed hashes (`OBJ-4`), and creates an immutable deployment revision (`FN-3`).
- Performs health-check validation before switching live traffic pointer to the new revision.

#### `rail rollback`
Executes an atomic pointer-flip rollback to a previous revision (`PLAT-3`, `FN-3`):
```bash
rail rollback <functionName> --to <revisionId> [--control-url <url>]
```
- Instantly activates a prior verified revision without rebuilding.

#### `rail logs`
Streams and filters structured JSON runtime logs (`PLAT-13`):
```bash
rail logs [--function <name>] [--level <debug|info|warn|error>] [--limit <n>] [-f|--follow]
```
- Tails runtime logs in real-time (`-f`) or inspects recent invocation records.
- Logs include ULID request identifiers (`PLAT-14`) and duration metrics.

---

### Disaster Recovery & State Migration

#### `rail export`
Exports project configuration, revisions, and state into a disaster recovery archive:
```bash
rail export [--out <backup.json>] [--project <name>] [--org <id>]
```

#### `rail import`
Restores project configuration and state from a backup archive:
```bash
rail import --in <backup.json> [--project <name>] [--overwrite-kv]
```

---

## Documentation Links

- [Architecture & Modular Monolith Guide](ARCHITECTURE.md) — Comprehensive guide to layers, dependency directions, and process topology.
- [Configuration Reference (`railfog.toml`)](docs/configuration-reference.md) — Comprehensive guide to functions, triggers, limits, permissions, and routes.
- [SDK Developer Guide](docs/sdk-guide.md) — Guide to developing with `@railfog/sdk`, storage primitives, and reliability helpers.
- [TypeScript SDK Package](sdk/typescript/README.md) — Package documentation, typed handler signatures, and error codes (`PLAT-12`).
- [Platform Contracts](docs/contracts/) — Formal platform specification and invariant definitions.
