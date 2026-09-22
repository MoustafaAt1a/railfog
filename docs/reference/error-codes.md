# Error Codes Reference (`PLAT-12`)

> [!NOTE]
> **Documentation**: [Docs Home](../README.md) &nbsp;|&nbsp;
> **Specification**: [PLAT-12 (Machine-Readable Error Codes)](../contracts/platform.contract.md#PLAT-12) &nbsp;|&nbsp;
> **Taxonomy**: Exhaustive 10-Code Set

RailFog standardizes all errors across services, APIs, and client SDKs to 10 machine-readable error codes.

---

## The 10 Machine-Readable Codes

| Code | HTTP Status | SDK Error Class | Description |
|---|---|---|---|
| `RESOURCE_NOT_FOUND` | `404` | `ResourceNotFoundError` | The requested project, function, or revision does not exist. |
| `PERMISSION_DENIED` | `403` | `PermissionDeniedError` | Access to an undeclared resource was attempted. The capability binding is absent from `ctx` (`PLAT-6`). |
| `VALIDATION_FAILED` | `400` | `ValidationFailedError` | Schema validation error in `railfog.toml` or invalid client request payload. |
| `RATE_LIMITED` | `429` | `RateLimitedError` | Concurrency or token bucket capacity exhausted (`PLAT-9`). Includes `Retry-After` header. |
| `CALL_DEPTH_EXCEEDED`| `429` | `CallDepthExceededError` | Internal recursive invocation depth exceeded threshold (`FN-7`). |
| `TIMEOUT` | `504` | `TimeoutError` | Wall-clock execution deadline exceeded (`FN-5`). |
| `PAYLOAD_TOO_LARGE` | `413` | `PayloadTooLargeError` | Request body, KV value, or queue message exceeded maximum allowed size. |
| `CONFLICT` | `409` | `ConflictError` | Check-And-Set optimistic concurrency version mismatch in `kv.atomic()` (`KV-3`). |
| `UNAVAILABLE` | `503` | `UnavailableError` | Control plane unreachable; data plane serves cached snapshot (`PLAT-8`). |
| `INTERNAL` | `500` | `InternalError` | Unclassified platform or isolate failure. |

---

## Wire Format

Error responses return standard JSON:

```json
{
  "error": "The requested resource was not found",
  "code": "RESOURCE_NOT_FOUND",
  "requestId": "01J8G5E1M2R4K7W9P0X1Y2Z3A4"
}
```

The `requestId` is a sortable ULID (`PLAT-14`) that correlates across Gateway access logs, Data Plane execution traces, and background metrics.
