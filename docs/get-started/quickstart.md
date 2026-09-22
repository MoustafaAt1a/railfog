# 5-Minute Quickstart

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp;
> **Prerequisites**: Deno v2.0+ (or use standalone native binary) &nbsp;|&nbsp;
> **Time to Complete**: 5 minutes

This guide walks you through installing the RailFog CLI, creating a project, running the local development server with SQLite backing services, and deploying to production.

---

## Step 1: Install the RailFog CLI (`rail`)

Install the global CLI using the universal Deno installer:

```bash
deno run -A https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/scripts/install.ts
```

Verify the installation:

```bash
rail --version
```

> [!TIP]
> Alternatively, compile a standalone binary with zero dependencies:
> ```bash
> deno compile -A -o rail cli/main.ts
> ```

---

## Step 2: Initialize a New Project

Run `rail init` to scaffold a project:

```bash
rail init hello-world
cd hello-world
```

This generates the standard project structure:
```text
hello-world/
├── railfog.toml      # Declarative manifest (triggers, limits, permissions)
├── deno.json         # Toolchain configuration and SDK imports
└── functions/
    └── api.ts        # HTTP function handler
```

---

## Step 3: Inspect the Function Handler

Open `functions/api.ts`. RailFog handlers use standard Web API `Request` and `Response` objects alongside the injected `RailFogContext`:

```typescript
import { handle } from "@railfog/sdk";

export default handle(async ({ req, kv }) => {
  // Read and increment a visitor counter in KV storage
  const count = ((await kv.get<number>(["stats", "visitors"])) ?? 0) + 1;
  await kv.set(["stats", "visitors"], count);

  return {
    message: "Hello from RailFog!",
    visitors: count,
    url: req.url,
  };
});
```

---

## Step 4: Start the Local Development Server

Start the local server with hot reloading:

```bash
rail dev
```

Terminal output:
```text
RailFog dev server running on http://localhost:8000
Dashboard on http://localhost:8000/__railfog

Local providers (PLAT-17 parity):
  KV & Queues: SQLite (.railfog/local/state.db)
  Objects:     LocalFS (.railfog/local/objects/)

Routes:
  GET /api/*  ->  functions/api.ts
```

Test the endpoint:
```bash
curl http://localhost:8000/api/hello
```

---

## Step 5: Validate Configuration Statically

Before deployment, run `rail check` to statically verify your configuration and entrypoints:

```bash
rail check
```

`rail check` validates:
- `railfog.toml` schema adherence.
- Entrypoint existence and security constraints.
- Route specificity score calculations (`PLAT-11`).
- SSRF firewall egress allowlists (`PLAT-5`).

---

## Step 6: Deploy to Production

Authenticate your CLI with the Control Plane and deploy:

```bash
# 1. Log in via browser OAuth
rail login

# 2. Deploy the immutable revision
rail deploy
```

RailFog bundles your TypeScript functions, computes content-addressed SHA-256 hashes (`OBJ-4`), pre-warms runtime sandboxes, and executes an atomic traffic flip to the new revision.

---

## Next Steps

- Explore the [Project Structure Guide](project-structure.md).
- Learn about the [Declarative Manifest (`railfog.toml`)](../configuration/manifest.md).
- Dive into the [TypeScript SDK Guide](../sdk/overview.md).
