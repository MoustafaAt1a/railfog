# RailFog Developer Experience (DX) & Operations Guide

Welcome to RailFog — a lightweight edge application platform designed around standard Web APIs (`Request`, `Response`, `ReadableStream`, `TransformStream`), strict capability-based isolation, and four core primitives: **Functions**, **KV**, **Objects**, and **Queues**.

This manual covers the complete developer journey from initial scaffolding and local development to real-time streaming, local devtools, and production deployments.

---

## 1. Quickstart & Project Scaffolding

### Installation
Install the RailFog CLI (`rail`) via the cross-platform Deno installer or build a native executable:

```bash
# Option A: Install globally via Deno
deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts

# Option B: Clone and install locally
git clone https://github.com/MoustafaAt1a/railfog.git
cd railfog
deno task install
```

### Initializing a New Project
Run `rail init` to create a new project interactively or choose a template:

```bash
# Interactive project generator
rail init my-app

# Or scaffold a specific starter template
rail init my-app --template api
```

This creates a standard project layout:
```text
my-app/
├── railfog.toml         # Declarative configuration and capability permissions
├── functions/
│   └── api.ts           # Primary HTTP function handler
└── deno.json            # Toolchain imports and task runner configuration
```

---

## 2. Configuration & JSON Schema (`railfog.toml`)

RailFog uses a declarative `railfog.toml` configuration locked to formal specifications. To enable instant autocompletion, real-time validation, and tooltips in VS Code, IntelliJ, or Neovim, add the JSON Schema header:

```toml
#:schema https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/schemas/railfog.schema.json
name = "my-service"

[limits]
memory_mb = 128
timeout_ms = 5000

# Declare functions and their capability permissions
[functions.api]
entry = "functions/api.ts"
timeout_ms = 3000

[functions.api.permissions]
kv = ["main"]
objects = ["uploads"]
queues = ["tasks"]
secrets = ["API_KEY", "DATABASE_URL"]

# Route traffic with PLAT-11 specificity
[[routes]]
pattern = "/api/*"
function = "api"
```

### IDE Setup
- **VS Code**: Install the *Even Better TOML* extension. The `#:schema` header activates autocompletion and hover documentation automatically.
- **IntelliJ / WebStorm**: Mapped automatically via JSON Schema Store or local schema path `./schemas/railfog.schema.json`.

---

## 3. Local Development Terminal (Wrangler/Railway Parity)

Launch the zero-dependency local development server with live reload:

```bash
rail dev
```

### Startup Signal Banner
`rail dev` boots an in-memory runtime backed by SQLite and local filesystem storage (`PLAT-17`), providing full parity with production:

```text
RailFog dev server running on http://localhost:8000
Dashboard on http://localhost:8000/__railfog

Local providers (PLAT-17 parity):
  KV & Queues: SQLite
  Objects:     LocalFS

Routes:
  /api/*               -> api              (score: 1)

Ready for requests. [b] browser  [d] dashboard  [c] clear  [q] quit
```

### Interactive Keyboard Shortcuts
While `rail dev` is running, you can press single-key shortcuts directly in the terminal:
- **`[b]`**: Opens your application in your default browser (`http://localhost:8000/api/...`).
- **`[d]`**: Opens the embedded **Local Dev Dashboard** in your browser (`http://localhost:8000/__railfog`).
- **`[c]`**: Clears the console and redraws the clean status banner.
- **`[q]`**: Gracefully shuts down the dev server.

### Live Badged Request Logging
Every request is streamed live with colorized HTTP method badges, status codes, elapsed execution time, and ULID tracking:
```text
[01M307NK57T75R5V8B9G2R9VJP] GET  /api/users      200 4ms
[01M307NKRNW332C0BN7HSQXPYC] POST /api/chat/stream 200 18ms
[01M307NMDTCXC6X21AKWJK24J0] GET  /api/missing     404 1ms
```

### Smart Command Typo Suggester
If you mistype a command in the CLI, RailFog computes the Levenshtein distance and suggests the intended command:
```bash
$ rail deply
Unknown command "deply".

Did you mean "rail deploy"?

Run 'rail --help' for available commands.
```

---

## 4. Embedded Local Dev Dashboard (`/__railfog`)

During local development, visit `http://localhost:8000/__railfog` (or press `[d]` in the terminal) to access the built-in offline devtools dashboard.

### Dashboard Features
1. **Routing Overview**: Live view of registered route patterns, target function handlers, and PLAT-11 specificity scores.
2. **Interactive KV Explorer**:
   - Inspect all keys stored in the local SQLite KV store.
   - Insert new keys directly through the browser UI.
   - Delete keys and observe real-time cache updates.
   - Programmatic dev API: `GET /__railfog/api/kv`, `POST /__railfog/api/kv`, `DELETE /__railfog/api/kv`.
3. **Queue & Storage Telemetry**: Monitor local queue backlog and object storage status without external tooling.
4. **Project Metadata**: Real-time project name, active revision, and loaded module status (`GET /__railfog/api/info`).

---

## 5. TypeScript SDK (`@railfog/sdk`)

RailFog provides a minimalist, zero-dependency SDK centered on Web Standards and modern DX.

### 5.1 Ergonomic Handler (`handle`)
The `handle()` wrapper auto-serializes plain objects to JSON, passes Web API `Response` objects through verbatim, and normalizes errors:

```typescript
import { handle } from "@railfog/sdk";

export default handle(async (c) => {
  // Access typed request body
  const body = await c.body<{ name: string }>();

  // Use pre-scoped KV binding
  await c.kv.set(["users", "123"], { name: body.name });

  // Returning an object auto-serializes to status 200 JSON
  return { ok: true, user: body.name };
});
```

### 5.2 Micro-Routing (`api`)
For functions handling multiple sub-routes, `api()` provides zero-overhead pattern matching with parameter extraction:

```typescript
import { api } from "@railfog/sdk";

export default api({
  "GET /items": async (c) => {
    const list = await c.kv.list(["items"]);
    return c.json({ items: list.keys });
  },

  "GET /items/:id": async (c) => {
    const id = c.params.id;
    const item = await c.kv.get(["items", id]);
    if (!item) return c.json({ error: "Item not found" }, 404);
    return c.json(item);
  },

  "POST /items": async (c) => {
    const data = await c.body();
    const id = crypto.randomUUID();
    await c.kv.set(["items", id], data);
    return c.json({ id, data }, 201);
  },
});
```

### 5.3 Response Streaming (`c.stream`)
Stream dynamic chunked byte or text data using standard Web Streams (`TransformStream`):

```typescript
import { handle } from "@railfog/sdk";

export default handle((c) => {
  return c.stream(async (writer) => {
    await writer.write("Chunk 1\n");
    await new Promise((r) => setTimeout(r, 50));
    await writer.write("Chunk 2\n");
    await writer.close();
  });
});
```

### 5.4 Server-Sent Events (SSE) (`c.sse`)
Deliver real-time event streams (e.g. LLM token generation, live telemetry) with automatic `text/event-stream` framing:

```typescript
import { handle } from "@railfog/sdk";

export default handle((c) => {
  return c.sse(async (sse) => {
    await sse.send({ event: "start", data: { model: "gpt-4o" } });
    await sse.send({ event: "token", data: "Hello" });
    await sse.send({ event: "token", data: " world!" });
    await sse.send({ event: "done", data: {} });
    await sse.close();
  });
});
```

### 5.5 End-to-End Type-Safe RPC Client (`createRpcClient`)
Call your RailFog functions from client code, background jobs, or frontend apps with automatic JSON serialization and PLAT-12 typed error mapping:

```typescript
import { createRpcClient } from "@railfog/sdk";

const client = createRpcClient("http://localhost:8000");

// Type-safe GET
const items = await client.get<{ items: string[] }>("/api/items");

// Type-safe POST
const created = await client.post<{ id: string }>("/api/items", { title: "New Item" });

// Automatically catches non-2xx responses and throws typed RailFogError subclasses:
try {
  await client.get("/api/items/unknown");
} catch (err) {
  // err is an instance of ResourceNotFoundError with err.requestId attached!
  console.error(err.code, err.message, err.requestId);
}
```

---

## 6. Real-World Architectural Patterns

### 6.1 Idempotent Queue Consumer with Dead-Letter Handling
Process asynchronous queue jobs with guaranteed once-and-only-once execution via mandatory TTL deduplication (`Q-4`, `KV-2`):

```typescript
import { withIdempotency, withRetry } from "@railfog/sdk";
import type { QueueConsumerHandler } from "@railfog/sdk";

export const handler: QueueConsumerHandler = async (msg, ctx) => {
  const { eventId, orderId, amount } = msg.payload as {
    eventId: string;
    orderId: string;
    amount: number;
  };

  // Prevent duplicate execution under at-least-once queue delivery
  const res = await withIdempotency(ctx.kv, ["orders", orderId, "charge"], async () => {
    // Retry transient network failures with exponential backoff and decorrelated jitter
    return await withRetry(async () => {
      return await chargePaymentGateway(orderId, amount);
    }, { maxAttempts: 5, baseMs: 100, capMs: 5000 });
  });

  if (!res.processed) {
    console.log(`Skipped duplicate charge for order ${orderId}`);
  }
};
```

### 6.2 Direct Storage Transfer (Presigned URLs)
Transfer large assets (up to 100 MB per `OBJ-1`) directly between client and S3-compatible storage without proxying bytes through the function compute worker (`OBJ-3`):

```typescript
import { handle } from "@railfog/sdk";

export default handle(async (c) => {
  const { filename } = await c.body<{ filename: string }>();
  const objectKey = `uploads/${crypto.randomUUID()}-${filename}`;

  // Generate short-lived (15 min) PUT URL directly to storage bucket
  const presigned = await c.objects.presign(objectKey, {
    method: "PUT",
    expiresIn: 900,
  });

  return {
    uploadUrl: presigned.url,
    headers: presigned.headers,
    key: objectKey,
  };
});
```

---

## 7. Cloud Deployment & Production Operations

RailFog applications can be packaged into zero-dependency minimal container images and deployed to Railway, Fly.io, or standard Kubernetes clusters.

### 7.1 Deploying to Railway
The repository includes pre-wired configurations for zero-config Railway deployments:
- **`railway.json`**: Points directly to `infra/Dockerfile.runtime` with health checks on `/healthz`.
- **Command**:
  ```bash
  # Deploy cwd to Railway (auto-authenticates and provisions resources)
  railway up
  ```

### 7.2 Deploying to Fly.io
Fly.io provides distributed edge runtime deployment using the included `fly.toml`:
```bash
fly deploy
```

### 7.3 Secrets Management (`PLAT-15`)
Manage encrypted environment secrets without leaking values to build artifacts, git repositories, or logs:

```bash
# Set production secrets
rail secrets set API_KEY="sk_live_123456"
rail secrets set DATABASE_URL="postgres://user:pass@ep-db.cloud:5432/main"

# List configured secret keys (values are securely masked)
rail secrets list
```

### 7.4 Instant Atomic Rollbacks (`PLAT-3`, `FN-3`)
If a deployment fails verification or introduces a regression, flip the traffic pointer instantaneously to the last-known-good revision without rebuilding code:

```bash
rail rollback
```

---

## 8. Verification & Diagnostics

RailFog adheres to strict mechanical verification. Every command can be audited and tested locally:

```bash
# Type-check all modules
deno task check

# Lint the codebase
deno task lint

# Format code
deno task fmt:check

# Run full test suite (1,500+ unit, contract, security, and e2e tests)
deno task test
```
