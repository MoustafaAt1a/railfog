# CLI Command Reference (`rail`)

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [PLAT-19 (Developer Tooling)](../contracts/platform.contract.md#PLAT-19)

This document is the complete alphabetical reference for all commands supported
by the `rail` CLI.

---

## Command Index

| Command                           | Description                                                                |
| --------------------------------- | -------------------------------------------------------------------------- |
| [`rail add`](#rail-add)           | Injects SDK bindings or capability templates into `deno.json`.             |
| [`rail check`](#rail-check)       | Statically analyzes `railfog.toml`, entrypoints, and route specificity.    |
| [`rail dev`](#rail-dev)           | Starts the local dev server with SQLite KV/Queues and hot reload.          |
| [`rail doctor`](#rail-doctor)     | Diagnoses system dependencies, Deno version, and permissions.              |
| [`rail deploy`](#rail-deploy)     | Packages and deploys project revisions to the Control Plane.               |
| [`rail export`](#rail-export)     | Exports configuration, revision history, and KV state into backup archive. |
| [`rail import`](#rail-import)     | Restores project configuration and state from backup archive.              |
| [`rail init`](#rail-init)         | Scaffolds a new RailFog project interactively or from a template.          |
| [`rail login`](#rail-login)       | Authenticates CLI with the Control Plane via browser OAuth.                |
| [`rail logs`](#rail-logs)         | Streams and filters real-time structured JSON runtime logs.                |
| [`rail rollback`](#rail-rollback) | Atomically flips live traffic pointer to a prior verified revision.        |
| [`rail secrets`](#rail-secrets)   | Manages encrypted project secrets resolved dynamically via `ctx.env`.      |
| [`rail simulate`](#rail-simulate) | Dry-runs HTTP requests against route specificity resolution offline.       |
| [`rail status`](#rail-status)     | Displays deployed functions, active revisions, and route mappings.         |
| [`rail undeploy`](#rail-undeploy) | Deactivates live revision traffic and releases isolate resources.          |
| [`rail upgrade`](#rail-upgrade)   | In-place self-upgrade to the latest release or specific git ref.           |
| [`rail whoami`](#rail-whoami)     | Displays active identity, organization, and token status.                  |

---

## Detailed Command Specifications

### `rail add`

```bash
rail add <sdk|kv|objects|queues>
```

Injects capability imports and configuration into `deno.json`.

---

### `rail check`

```bash
rail check [path]
```

Validates `railfog.toml`, verifies that all entrypoints exist without parent
traversal (`..`), computes `PLAT-11` route specificity scores, and flags SSRF
violations (`PLAT-5`).

---

### `rail dev`

```bash
rail dev [--port <port>] [--host <host>] [--no-watch] [--dashboard]
```

Boots local development runtime with SQLite KV and queue storage and local
filesystem object storage (`PLAT-17`).

---

### `rail deploy`

```bash
rail deploy [--project <name>] [--control-url <url>] [--token <token>]
```

Bundles TypeScript source artifacts, computes SHA-256 hashes (`OBJ-4`), creates
an immutable revision (`FN-3`), pre-warms sandboxes, and executes an atomic
traffic flip.

---

### `rail rollback`

```bash
rail rollback <functionName> --to <revisionId>
```

Executes an instant atomic pointer-flip rollback to a previous revision without
rebuilding.

---

### `rail secrets`

```bash
rail secrets set <KEY> [VALUE] [--file <path>]
rail secrets list
rail secrets delete <KEY>
```

Manages encrypted project secrets. Secret values are never displayed in `list`
and are auto-redacted in runtime logs.

---

### `rail logs`

```bash
rail logs [--function <name>] [--level <debug|info|warn|error>] [--limit <n>] [-f|--follow]
```

Streams real-time structured JSON runtime logs with automated secret redaction.

---

### `rail export` & `rail import`

```bash
rail export --out backup.json
rail import --in backup.json [--overwrite-kv]
```

Disaster recovery and state migration utilities.

---

### `rail simulate`

```bash
rail simulate --path /api/v1/users/profile [--method GET]
```

Evaluates URL path resolution against `railfog.toml` offline and prints the
winning route's specificity score.
