# SDK — Error Handling & Platform Taxonomy

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp; **Specification**:
> [PLAT-12 (Machine-Readable Error Codes)](../contracts/platform.contract.md#PLAT-12)
> &nbsp;|&nbsp; **Taxonomy**: 10 Exhaustive Codes

Every platform error in RailFog maps to one of the 10 exhaustive,
machine-readable error codes defined in `PLAT-12`. Clients check the error code
rather than parsing unstable human-readable error messages.

---

## 1. The 10 Machine-Readable Error Codes

| Error Code            | HTTP Status | Error Class              | Description                                                                       |
| --------------------- | ----------- | ------------------------ | --------------------------------------------------------------------------------- |
| `RESOURCE_NOT_FOUND`  | `404`       | `ResourceNotFoundError`  | Target project, function, or revision does not exist.                             |
| `PERMISSION_DENIED`   | `403`       | `PermissionDeniedError`  | Unpermitted resource access; capability missing from binding (`PLAT-6`).          |
| `VALIDATION_FAILED`   | `400`       | `ValidationFailedError`  | Configuration, schema, or payload validation error.                               |
| `RATE_LIMITED`        | `429`       | `RateLimitedError`       | Concurrency or token bucket capacity exceeded (`PLAT-9`). Includes `Retry-After`. |
| `CALL_DEPTH_EXCEEDED` | `429`       | `CallDepthExceededError` | Internal function recursion exceeded maximum call depth (`FN-7`).                 |
| `TIMEOUT`             | `504`       | `TimeoutError`           | Wall-clock execution deadline exceeded (`FN-5`).                                  |
| `PAYLOAD_TOO_LARGE`   | `413`       | `PayloadTooLargeError`   | Request body, KV value, or queue message exceeded size limit.                     |
| `CONFLICT`            | `409`       | `ConflictError`          | Check-And-Set optimistic concurrency version mismatch in `kv.atomic()` (`KV-3`).  |
| `UNAVAILABLE`         | `503`       | `UnavailableError`       | Control plane unreachable; data plane serves cached snapshot (`PLAT-8`).          |
| `INTERNAL`            | `500`       | `InternalError`          | Unclassified platform or isolate failure.                                         |

---

## 2. Catching and Normalizing Errors

```typescript
import { ConflictError, normalizeError, RailFogError } from "@railfog/sdk";
import type { FunctionHandler } from "@railfog/sdk";

const handler: FunctionHandler = async (req, ctx) => {
  try {
    const result = await ctx.kv.atomic()
      .check(["counter"], 5)
      .set(["counter"], 6)
      .commit();

    if (!result.ok) {
      throw new ConflictError(
        "Version conflict on counter update",
        ctx.requestId,
      );
    }

    return Response.json({ success: true });
  } catch (err) {
    const normalized = normalizeError(err, ctx.requestId);
    console.error(
      `Request failed with code [${normalized.code}]: ${normalized.message}`,
    );

    return Response.json(
      {
        error: normalized.message,
        code: normalized.code,
        requestId: normalized.requestId,
      },
      { status: normalized.status },
    );
  }
};

export default handler;
```

---

## Next Steps

- Explore the [CLI Command Reference](../../cli/commands.md).
- Learn about the [System Architecture](../../architecture/overview.md).
