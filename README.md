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
