# T-0604 — Ingress Reverse Proxy Gateway Server

Status: Done
Milestone: 0.6 Public Beta
Depends on: T-0109, T-0602
Blocks: T-0609, T-0610, T-0611

## Spec references

`PLAT-1`, `PLAT-8`, `PLAT-9`, `PLAT-11`, `PLAT-12`, `PLAT-14`, `PLAT-19`

## Scope

**In scope**:
- `apps/gateway/gateway-server.ts`: Edge HTTP reverse proxy terminating incoming connections, enforcing token bucket rate limits per client IP / API token / project (`PLAT-9`), injecting monotonic ULID `request_id` (`PLAT-14`), and forwarding requests to control plane or data plane endpoints.
- `apps/gateway/gateway-server_test.ts`: Integration tests verifying upstream dispatch, rate limit enforcement (429 `RATE_LIMITED`), header propagation, and error formatting.

**Out of scope**:
- Service mesh or sidecar proxies (banned per `PLAT-20`).
- Distributed TLS certificate ACME automation (banned per `PLAT-20`).
- Customer isolate execution (delegated to `railfog-runtime`).

## Interface to implement

```typescript
import type { MultiTenantRateLimiter } from "./rate-limiter.ts";

export interface GatewayOptions {
  port?: number;
  host?: string;
  controlPlaneUrl: string;
  dataPlaneUrl: string;
  rateLimiter?: MultiTenantRateLimiter;
  signal?: AbortSignal;
}

export interface GatewayServer {
  port: number;
  close(): Promise<void>;
}

export function startGatewayServer(options: GatewayOptions): Promise<GatewayServer>;
```

## Acceptance criteria (Given/When/Then)

1. Given an incoming request matching management routes (`/v1/*`), when received by the gateway, then it forwards the request to `controlPlaneUrl` preserving headers, query parameters, and streaming payload bodies per `PLAT-1`.
2. Given an incoming request matching customer function routes, when received, then it forwards the request to `dataPlaneUrl` with zero control-plane roundtrips per `PLAT-1` and `PLAT-8`.
3. Given an incoming request lacking an `x-request-id` header, when processed, then the gateway generates a fresh Crockford Base32 ULID (`PLAT-14`) and attaches both `x-request-id` and `request-id` headers to upstream and downstream responses.
4. Given request bursts that exhaust the configured token bucket for an IP, API token, or Project (`PLAT-9`), when evaluated, then the gateway returns HTTP 429 with machine-readable code `RATE_LIMITED`, `Retry-After` header, and PLAT-12 error body without contacting backend servers.
5. Given a downstream server error or network connection drop, when proxied, then the gateway formats and returns HTTP 503 `UNAVAILABLE` adhering strictly to `PLAT-12`.

## Tests required

- [x] Integration — `apps/gateway/gateway-server_test.ts`: Test reverse proxy routing (control vs data plane), rate limiting rejection (429), ULID injection, and upstream fault recovery.

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-1`, `PLAT-8`, `PLAT-9`, `PLAT-11`, `PLAT-12`, `PLAT-14`, `PLAT-19`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete
- [x] Nothing outside "In scope" touched

## Verification Evidence

### 1. Type Check (`deno check apps/gateway/gateway-server.ts apps/gateway/gateway-server_test.ts`)
```
Check apps/gateway/gateway-server.ts
Check apps/gateway/gateway-server_test.ts
Exit code: 0
```

### 2. Integration Test Suite (`deno test -A apps/gateway/gateway-server_test.ts`)
```
running 13 tests from ./apps/gateway/gateway-server_test.ts
PLAT-1 (AC1): forwards GET /v1/projects with query params and headers to control plane ... ok (60ms)
PLAT-1 (AC1): forwards POST /v1/deploy with streaming body and headers to control plane ... ok (23ms)
PLAT-1 (AC1): streams chunked response body from control plane back to client intact ... ok (20ms)
PLAT-1, PLAT-8 (AC2): forwards customer route GET /hello with zero control plane roundtrips ... ok (15ms)
PLAT-1, PLAT-8 (AC2): forwards customer route POST /upload/image with payload to data plane ... ok (19ms)
PLAT-1, PLAT-8 (AC2): forwards nested path GET /users/123 to data plane with zero control plane roundtrips ... ok (14ms)
PLAT-14, PLAT-12 (AC3): generates Crockford Base32 ULID and injects x-request-id and request-id when absent ... ok (12ms)
PLAT-14, PLAT-12 (AC3): preserves existing client-supplied x-request-id upstream and downstream ... ok (16ms)
PLAT-9, PLAT-12 (AC4): rejects bursts exceeding token bucket with 429 RATE_LIMITED, Retry-After, and PLAT-12 body ... ok (17ms)
PLAT-9, PLAT-18 (AC4): isolates rate limit buckets across distinct client IPs ... ok (19ms)
PLAT-12 (AC5): returns HTTP 503 UNAVAILABLE with PLAT-12 error body when upstream control plane is unreachable ... ok (2s)
PLAT-12 (AC5): returns HTTP 503 UNAVAILABLE with PLAT-12 error body when upstream data plane is unreachable ... ok (2s)
PLAT-19: allocates dynamic port, handles requests, and terminates cleanly on close() ... ok (1s)

ok | 13 passed | 0 failed (5s)
```

### 3. Linter (`deno lint apps/gateway/gateway-server.ts apps/gateway/gateway-server_test.ts`)
```
Checked 2 files
Exit code: 0 (zero warnings)
```

### 4. Reviewer Verification
- **Verdict:** PASS
- Independent verification against `PLAT-1`, `PLAT-8`, `PLAT-9`, `PLAT-11`, `PLAT-12`, `PLAT-14`, and `PLAT-19`.
- Workspace regression check: 1,125 passed, 0 failed across the entire repository.

## Assumptions made

None.
