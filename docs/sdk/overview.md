# TypeScript SDK Overview (`@railfog/sdk`)

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp;
> **Package**: `@railfog/sdk` &nbsp;|&nbsp;
> **Runtime**: Deno v2.0+ &nbsp;|&nbsp;
> **Dependencies**: Zero External (Native Web Standards)

`@railfog/sdk` is the official TypeScript SDK for building functions, consumers, and services on the RailFog edge platform.

---

## 1. Installation

Install into your RailFog project using the CLI:

```bash
rail add sdk
```

This injects `@railfog/sdk` into your `deno.json` import map:

```json
{
  "imports": {
    "@railfog/sdk": "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/sdk/typescript/mod.ts"
  }
}
```

---

## 2. Core Exports

The SDK exposes typed interfaces, capability wrappers, and reliability helpers:

```typescript
// Type imports
import type {
  EnvBinding,
  FunctionHandler,
  KVBinding,
  ObjectBinding,
  QueueBinding,
  QueueConsumerHandler,
  QueueMessage,
  RailFogContext,
} from "@railfog/sdk";

// Value & utility imports
import {
  api,
  handle,
  normalizeError,
  RailFogError,
  withIdempotency,
  withRetry,
} from "@railfog/sdk";
```

---

## 3. Ergonomic Handlers (`handle` and `api`)

### 3.1 Minimal HTTP Handler (`handle`)
Eliminates repetitive boilerplate. Automatically destructures context and serializes return values into JSON with HTTP status 200:

```typescript
import { handle } from "@railfog/sdk";

export default handle(async ({ kv }) => {
  const visitors = ((await kv.get<number>(["counter"])) ?? 0) + 1;
  await kv.set(["counter"], visitors);
  return { visitors };
});
```

### 3.2 Micro-Router (`api`)
Handles multiple HTTP methods and paths in a single function file:

```typescript
import { api } from "@railfog/sdk";

export default api({
  "GET /items": async ({ kv }) => {
    return (await kv.get(["items"])) ?? [];
  },
  "POST /items": async ({ body, kv }) => {
    const item = await body<{ id: string }>();
    await kv.set(["items", item.id], item);
    return { ok: true, item };
  },
});
```

---

## Next Steps

- Learn about the [RailFogContext & Injected Capabilities](context.md).
- Read about [Reliability Helpers](reliability.md).
- Explore the [Platform Error Taxonomy](errors.md).
