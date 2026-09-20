# RailFog — 60-Second Quickstart Guide

RailFog is a minimal application-infrastructure platform: four primitives
(**Functions**, **KV**, **Objects**, **Queues**), one runtime (**Deno**),
reduced to `Trigger → Function → {KV, Objects, Queues}`.

This quickstart guides you through installing the CLI, scaffolding a new
project, starting the local development environment with embedded dashboard,
consuming endpoints with the typed RPC client, and deploying to production.

---

## 1. Prerequisites

- **Deno** (v2.0 or later):
  ```bash
  deno --version
  ```
- No external database, cloud account, or Docker container is required for local
  development.

---

## 2. Installation

Install the `rail` CLI globally using Deno:

```bash
deno task install
```

Verify your installation:

```bash
rail --version
```

---

## 3. Scaffold a New Project

Scaffold a clean, production-ready project in seconds:

```bash
rail init my-edge-app
cd my-edge-app
```

This creates the canonical RailFog project layout:

```text
my-edge-app/
├── railfog.toml         # Declarative schema, limits, routes, and capability permissions
├── deno.json            # Import maps and TypeScript toolchain configuration
├── functions/
│   └── api.ts           # Type-safe HTTP handler starter
└── tests/
```

---

## 4. Launch Local Development with Dev Dashboard

Start the live local development server:

```bash
rail dev
```

You will see the interactive terminal banner:

```text
╔══════════════════════════════════════════════════════════════╗
║               RailFog Edge Runtime (Local)                   ║
╠══════════════════════════════════════════════════════════════╣
║  Project:    my-edge-app                                     ║
║  Status:     ● Ready (Hot Reload active)                     ║
║  Local:      http://localhost:8000                           ║
║  Dashboard:  http://localhost:8000/__railfog                 ║
║  Shortcuts:  [b] open app  [d] dashboard  [c] clear  [q] quit║
╚══════════════════════════════════════════════════════════════╝
```

### Interactive Terminal Shortcuts (Wrangler / Railway Parity)

- Press <kbd>b</kbd> to open your application in the default web browser.
- Press <kbd>d</kbd> to open the embedded **RailFog Local Dashboard**
  (`/__railfog`).
- Press <kbd>c</kbd> to clear the console and redisplay the server startup card.
- Press <kbd>q</kbd> or <kbd>Ctrl+C</kbd> to stop the dev server.

---

## 5. Authoring Handlers with `@railfog/sdk`

Edit `functions/api.ts` to implement streaming responses, Server-Sent Events, or
stateful KV storage:

```typescript
import { handle } from "@railfog/sdk";

export default handle(async (c) => {
  const url = new URL(c.req.url);

  // 1. Chunked response streaming
  if (url.pathname === "/api/stream") {
    return c.stream(async (writer) => {
      await writer.write("Hello ");
      await writer.write("from ");
      await writer.write("RailFog!");
      await writer.close();
    });
  }

  // 2. Server-Sent Events (SSE)
  if (url.pathname === "/api/sse") {
    return c.sse(async (sse) => {
      await sse.send({ event: "init", data: { status: "ready" } });
      await sse.send({ event: "metric", data: { cpu: 12, memory: 45 } });
      await sse.close();
    });
  }

  // 3. Stateful Key-Value store
  if (url.pathname === "/api/items" && c.req.method === "POST") {
    const item = await c.body<{ id: string; name: string }>();
    await c.kv.set(["items", item.id], item);
    return c.json({ ok: true, saved: item }, 201);
  }

  // Default JSON response
  return {
    service: "my-edge-app",
    requestId: c.requestId,
    timestamp: new Date().toISOString(),
  };
});
```

---

## 6. Type-Safe Client Consumption

Use RailFog's built-in RPC client in frontend or client applications:

```typescript
import { createRpcClient } from "@railfog/sdk";

const client = createRpcClient("http://localhost:8000");

// Standard GET request
const info = await client.get<{ service: string; requestId: string }>(
  "/api/hello",
);
console.log(info.service);

// POST JSON request
const created = await client.post<{ ok: boolean }>("/api/items", {
  id: "item_123",
  name: "Industrial Sensor",
});
```

---

## 7. Static Validation & Pre-Flight Checks

Before deploying, run static validation to check route specificity scores and
security policies:

```bash
rail check
```

Output:

```text
Route Specificity Summary (PLAT-11):
  SCORE  ROUTE PATTERN                  FUNCTION
  -----  -----------------------------  --------
      4  /api/hello                     api
      4  /api/stream                    api

Configuration valid. Zero errors found.
```

---

## 8. Managing Encrypted Secrets

Store capability-scoped secrets using AES-GCM-256 with PBKDF2 encryption.
Secrets are never printed in plain text:

```bash
# Set a secret
rail secrets set STRIPE_API_KEY sk_live_mock123

# List configured secret keys
rail secrets list

# Delete a secret
rail secrets delete STRIPE_API_KEY
```

---

## 9. Deploying to Production

Authenticate and deploy your project with automatic packaging,
content-addressing (`sha256`), and zero-downtime pointer cutover:

```bash
# Authenticate via browser zero-copy OAuth flow
rail login

# Deploy project
rail deploy
```

Deployment output:

```text
✔ Packaging function sources and calculating SHA-256 hashes
✔ Validating configuration and capability permissions
✔ Uploading snapshot bundle to Control Plane
✔ Verifying deployment activation and health check

Deployment complete!
  Project:   my-edge-app
  Revision:  rev_01M309K26HRB5KD2PE8235M5PB
  Duration:  128ms
  Runtime:   https://railfog-control-production.up.railway.app
```

---

## 10. Operational Monitoring & Disaster Recovery

### Stream Real-Time Logs

```bash
rail logs --follow --level info
```

### Inspect Usage and Itemized Micro-Cent Costs

```bash
rail usage
```

### Export State Backup (Disaster Recovery Archive)

```bash
rail export --out backup.json
```

### Restore State Backup

```bash
rail import --in backup.json
```

---

## Complete CLI Command Cheatsheet

| Command                          | Description                                                   | Spec Anchor          |
| -------------------------------- | ------------------------------------------------------------- | -------------------- |
| `rail init [dir]`                | Scaffold new project (`--template minimal \| worked-example`) | `PLAT-18`, `PLAT-19` |
| `rail dev`                       | Live local server with SQLite, hot-reload, embedded dashboard | `PLAT-17`, `PLAT-19` |
| `rail check`                     | Statically validate config, schema, routes, and security      | `PLAT-3`, `PLAT-11`  |
| `rail status`                    | Inspect project resources, entrypoints, and route mappings    | `PLAT-18`            |
| `rail secrets set <KEY> [VAL]`   | Encrypt and store project secret                              | `PLAT-15`            |
| `rail secrets list`              | List secret keys and update timestamps                        | `PLAT-15`            |
| `rail secrets delete <KEY>`      | Remove project secret                                         | `PLAT-15`            |
| `rail deploy`                    | Package, content-address, health-check, and deploy revision   | `PLAT-3`, `PLAT-8`   |
| `rail rollback <fn> --to <rev>`  | Instant pointer-flip rollback to previous revision            | `PLAT-3`, `FN-3`     |
| `rail logs [-f] [--level <lvl>]` | Stream structured JSON runtime logs                           | `PLAT-13`, `PLAT-14` |
| `rail usage [--format json]`     | Itemized compute, storage, and operations cost reporting      | `PLAT-10`, `PLAT-13` |
| `rail export --out <file>`       | Export state backup disaster recovery archive                 | `ADR-0002`           |
| `rail import --in <file>`        | Restore state backup disaster recovery archive                | `ADR-0002`           |
| `rail update`                    | Self-upgrade CLI in-place to latest release                   | `PLAT-19`            |
