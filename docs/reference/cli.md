# CLI Reference Manual (`rail`)

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-19`](../contracts/platform.contract.md#PLAT-19) &nbsp;|&nbsp; **CLI
> Version**: `0.9.0`

This is the comprehensive reference for all commands, options, environment
variables, and exit codes supported by the RailFog command-line interface
(`rail`).

---

## Command Summary Table

| Category                     | Command            | Aliases           | Description                                                             |
| ---------------------------- | ------------------ | ----------------- | ----------------------------------------------------------------------- |
| **Project & Build**          | `rail init`        | —                 | Scaffolds a new RailFog project in the target directory                 |
|                              | `rail dev`         | —                 | Starts the local development server with hot-reload                     |
|                              | `rail check`       | —                 | Statically validates `railfog.toml`, entrypoints, and route specificity |
|                              | `rail deploy`      | —                 | Packages and deploys project revisions to the Control Plane             |
|                              | `rail undeploy`    | —                 | Safely deactivates live revision traffic and releases resources         |
|                              | `rail status`      | —                 | Displays active revisions, deployed functions, and route mappings       |
|                              | `rail simulate`    | `sim`             | Simulates edge route dispatch and specificity score resolution offline  |
|                              | `rail doctor`      | —                 | Diagnoses environment health, dependencies, and V8 isolate speed        |
|                              | `rail compare`     | —                 | Displays architectural comparison vs AWS Lambda & Cloudflare Workers    |
|                              | `rail add`         | —                 | Injects SDK bindings or capability templates into `deno.json`           |
| **Security & Identity**      | `rail login`       | —                 | Authenticates CLI session via browser OAuth or API token                |
|                              | `rail logout`      | —                 | Logs out and removes local cached credentials                           |
|                              | `rail whoami`      | —                 | Displays currently authenticated organization and user identity         |
|                              | `rail secrets`     | —                 | Manages encrypted project secrets (set, list, delete)                   |
| **Services & Observability** | `rail logs`        | —                 | Streams and filters real-time structured JSON runtime logs              |
|                              | `rail rollback`    | —                 | Executes an instant atomic pointer-flip rollback to a prior revision    |
|                              | `rail usage`       | `cost`            | Displays resource consumption and itemized cost breakdown               |
|                              | `rail export`      | —                 | Exports configuration, revisions, and KV state to backup archive        |
|                              | `rail import`      | —                 | Restores project state from a disaster recovery backup archive          |
| **System & Maintenance**     | `rail upgrade`     | `update`, `sync`  | Upgrades the RailFog CLI in-place to the latest release                 |
|                              | `rail uninstall`   | —                 | Removes the RailFog CLI binary and local metadata                       |
|                              | `rail version`     | `-v`, `--version` | Shows CLI version and engine telemetry (`--detailed`, `--json`)         |
|                              | `rail completions` | `completion`      | Generates shell auto-completion scripts (`pwsh`, `bash`, `zsh`, `fish`) |

---

## Detailed Command Specifications

### 1. `rail init`

Scaffolds a new project directory with `railfog.toml`, `deno.json`, and starter
function handlers.

```bash
rail init [directory] [options]
```

**Options**:

- `--name <string>`: Override project identifier (must conform to `PLAT-18`
  naming regex `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`).
- `--template <minimal|worked-example>`: Select starter template (default:
  `minimal`).
- `--force`: Overwrite existing files in target directory.

---

### 2. `rail dev`

Boots the local development server with SQLite backing services (`PLAT-17`).

```bash
rail dev [options]
```

**Options**:

- `--port <number>`: Port to bind (default: `8000`).
- `--host <string>`: Host interface (default: `127.0.0.1`).
- `--no-watch`: Disable file watching and automatic hot-reload.
- `--dashboard`: Open the developer dashboard (`/__railfog`) in default browser.

---

### 3. `rail check`

Performs static analysis on `railfog.toml`, entrypoint files, and capability
declarations.

```bash
rail check [path]
```

**Exit Codes**:

- `0`: All checks passed.
- `1`: Validation errors found (missing entrypoint, path traversal, undeclared
  secret, or invalid route specificity).

---

### 4. `rail deploy`

Packages TypeScript sources into content-addressed immutable artifacts
(`OBJ-4`), creates a revision record (`FN-3`), pre-warms runtime sandboxes, and
activates live traffic.

```bash
rail deploy [options]
```

**Options**:

- `--project <string>`: Target project identifier override.
- `--control-url <url>`: Control plane API URL.
- `--token <string>`: Explicit authentication API token.
- `--json`: Output machine-readable JSON summary for CI/CD automation.

---

### 5. `rail rollback`

Atomically flips the live revision pointer to a prior verified deployment
without rebuilding.

```bash
rail rollback <functionName> --to <revisionId>
```

---

### 6. `rail secrets`

Manages capability-scoped encrypted secrets.

```bash
# Set a secret
rail secrets set <KEY> [VALUE] [--file <path>]

# List secret names and timestamps
rail secrets list

# Delete a secret
rail secrets delete <KEY>
```

---

### 7. `rail logs`

Streams structured JSON execution logs with automatic high-entropy secret
redaction (`PLAT-13`).

```bash
rail logs [options]
```

**Options**:

- `--follow`, `-f`: Keep connection open and stream logs in real time.
- `--level <debug|info|warn|error>`: Filter minimum log level.
- `--function <string>`: Filter by specific function name.
- `--limit <number>`: Number of recent log entries to retrieve (default: 50).

---

### 8. `rail usage` (alias: `cost`)

Calculates compute CPU milliseconds, storage gigabytes, and network egress costs
based on verified usage records.

```bash
rail usage [--project <string>] [--json]
```

---

### 9. `rail export` & `rail import`

Disaster recovery archiving and restoration per ADR-0002.

```bash
# Export state to archive
rail export --output backup.rfz

# Restore state from archive
rail import --input backup.rfz
```

---

### 10. `rail doctor`

Inspects Deno version, file read/write permissions, network connectivity, and
isolate cold-start latency.

```bash
rail doctor
```

---

## Global Options

| Flag              | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `-h`, `--help`    | Display general help or command-specific documentation |
| `-v`, `--version` | Display current CLI version                            |
| `--verbose`       | Enable debug-level operational logging                 |
| `--no-color`      | Disable ANSI terminal color codes                      |
