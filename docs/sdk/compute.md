# SDK: Compute

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Package**: `@railfog/sdk` &nbsp;|&nbsp; **Conceptual Layer**: Compute &nbsp;|&nbsp; **Specification**: [`CONCEPT-1`](../contracts/concepts.contract.md#CONCEPT-1), [`FN-1`](../contracts/functions.contract.md#FN-1)

Compute represents the execution boundary in `@railfog/sdk`.

---

## 1. Handlers & Wrappers

The SDK provides several ergonomic wrappers to express Compute:

### `compute()` & `handle()`
Wrap a single asynchronous function handler with automatic JSON serialization, error normalization, and context injection:

```typescript
import { compute } from "@railfog/sdk";

export default compute(async ({ json }) => {
  return json({ status: "healthy", timestamp: Date.now() });
});
```

### `api()`
Define multiple URLPattern route patterns with deterministic specificity matching (`PLAT-11`):

```typescript
import { api } from "@railfog/sdk";

export default api({
  "GET /items": async ({ state }) => {
    return (await state.get(["items"])) ?? [];
  },
  "GET /items/:id": async ({ params, notFound }) => {
    if (!params?.id) notFound("Missing id");
    return { id: params?.id };
  },
});
```

### `router()`
Fluent builder supporting route registration, chaining, and middleware:

```typescript
import { router } from "@railfog/sdk";

const app = router()
  .use(async (c, next) => {
    c.log.info("Incoming request", { url: c.req.url });
    return await next();
  })
  .get("/health", ({ text }) => text("OK"));

export default app;
```

---

## 2. Response Helpers on `HandlerContext`

Compute handlers receive an enriched `HandlerContext` with built-in response constructors:

- `c.json(data, status?)`: Returns a JSON response with status 200 (or custom status).
- `c.text(string, status?)`: Returns a plain text response.
- `c.html(htmlString, status?)`: Returns an HTML response with `text/html; charset=utf-8`.
- `c.redirect(url, status?)`: Returns a 302 (or 301) redirect Response.
- `c.stream(writer => ...)`: Returns a chunked streaming Response (`ReadableStream`).
- `c.sse(writer => ...)`: Emits Server-Sent Events with `text/event-stream`.
- `c.notFound(message?)`: Throws canonical `404 RESOURCE_NOT_FOUND` error (`PLAT-12`).
- `c.badRequest(message?)`: Throws canonical `400 VALIDATION_FAILED` error (`PLAT-12`).
- `c.fail(error)`: Normalizes unknown errors to canonical `RailFogError` subclasses.
