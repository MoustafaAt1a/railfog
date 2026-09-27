# Local Development Guide

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [`PLAT-17 (Local/Production Parity)`](../contracts/platform.contract.md#PLAT-17)
> &nbsp;|&nbsp; **CLI Command**: `rail dev`

RailFog provides a local development runtime that mirrors cloud production
behavior without requiring Docker containers, external emulators, or cloud
connections.

---

## 1. Starting the Development Server

Start the local server from your project root:

```bash
rail dev
```

By default, the server binds to `http://localhost:8000` and displays the startup
banner:

```text
RailFog dev server running on http://localhost:8000
Dashboard on http://localhost:8000/__railfog

Local providers (PLAT-17 parity):
  KV & Queues: SQLite (.railfog/local/state.db)
  Objects:     LocalFS (.railfog/local/objects/)

Routes:
  GET /api/*  ->  functions/api.ts
```

### CLI Flags for `rail dev`

| Option            | Default     | Description                                                        |
| ----------------- | ----------- | ------------------------------------------------------------------ |
| `--port <number>` | `8000`      | Port to bind the local HTTP server                                 |
| `--host <string>` | `127.0.0.1` | Network interface to bind                                          |
| `--no-watch`      | `false`     | Disable automatic file watching and hot reload                     |
| `--dashboard`     | `false`     | Automatically open the developer dashboard in your default browser |

---

## 2. Local/Production Parity (`PLAT-17`)

Local development uses lightweight embedded adapters implementing the exact same
provider SPI interfaces used in production:

| Primitive   | Local Adapter                                | Production Backend               |
| ----------- | -------------------------------------------- | -------------------------------- |
| **KV**      | SQLite (`.railfog/local/state.db`)           | PostgreSQL, Cloudflare KV, Redis |
| **Objects** | Local Filesystem (`.railfog/local/objects/`) | Cloudflare R2, AWS S3            |
| **Queues**  | SQLite (`.railfog/local/state.db`)           | Cloudflare Queues, Redis         |
| **Compute** | Deno subprocess isolate                      | Cloud isolate sandbox            |

State persists across server restarts in the `.railfog/local/` directory. To
reset all local state:

```bash
rm -rf .railfog/local/
```

---

## 3. Developer Web Dashboard

RailFog includes a built-in local inspection dashboard served directly from the
runtime at `http://localhost:8000/__railfog`.

The dashboard provides real-time visibility into:

- **Routes & Specificity**: Active route mappings and calculated `PLAT-11`
  scores.
- **KV Inspector**: View, search, and edit keys and values stored in local
  SQLite namespaces.
- **Objects Explorer**: Inspect uploaded binary assets, content types, and
  sizes.
- **Queues Monitor**: View pending messages, in-flight deliveries, and
  dead-letter queues.
- **Live Logs**: Real-time log stream with automatic secret redaction.

---

## 4. Hot Reload & File Watching

The local server monitors changes to:

- `railfog.toml` (recompiles route trees, triggers, permissions, and limits on
  change)
- All files inside `functions/` (clears isolate module caches and pre-warms
  updated handlers)

Code changes take effect on the next incoming request without restarting the
server.

---

## Next Steps

- Learn how to write [Functions](functions.md).
- Understand [Key-Value Storage](kv.md).
- Learn about [Testing](testing.md).
