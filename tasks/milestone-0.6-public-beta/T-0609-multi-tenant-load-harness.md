# T-0609 — High-Concurrency Multi-Tenant Load Harness

Status: Done
Milestone: 0.6 Public Beta
Depends on: T-0604, T-0605, T-0606
Blocks: T-0611

## Spec references

`PLAT-7`, `PLAT-9`, `PLAT-10`, `FN-5`, `FN-6`

## Scope

**In scope**:
- `tests/fixtures/load-generator.ts`: Configurable synthetic HTTP workload generator simulating concurrent multi-tenant client requests, measuring latency percentiles (p50, p95, p99), error budgets, and rate limiting behavior.
- `tests/load/multi_tenant_load_test.ts`: Automated load and stress benchmark suite validating SLO compliance (`PLAT-10`), token bucket shedding (`PLAT-9`), and zero cross-tenant state bleed under high concurrency (`PLAT-7`, `FN-6`).

**Out of scope**:
- Distributed load testing clusters (k6 cloud / distributed botnets) requiring external accounts (banned per `PLAT-20`).
- Synthetic network packet corruption or kernel-level fault injection.

## Interface to implement

```typescript
export interface TenantLoadSpec {
  orgId: string;
  projectId: string;
  apiKey: string;
  targetPath: string;
}

export interface LoadScenarioOptions {
  gatewayUrl: string;
  concurrency: number; // concurrent client workers
  durationMs: number;
  tenants: TenantLoadSpec[];
  targetRps: number;
}

export interface LoadBenchmarkResult {
  totalRequests: number;
  successfulRequests: number;
  rateLimitedRequests: number;
  errorRequests: number;
  availabilityPercent: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyP99Ms: number;
  crossTenantCollisions: number;
}

export function runLoadBenchmark(options: LoadScenarioOptions): Promise<LoadBenchmarkResult>;
```

## Acceptance criteria (Given/When/Then)

1. Given multiple concurrent tenants dispatching HTTP requests to the gateway within declared limits, when benchmarked, then data plane availability satisfies the $99.95\%$ monthly target (`PLAT-10`) with zero unhandled internal errors.
2. Given a tenant exceeding the token bucket burst threshold, when evaluated under load, then the excess requests are cleanly shed with HTTP 429 `RATE_LIMITED` and `Retry-After` headers without starving other concurrent tenants or degrading system throughput (`PLAT-9`).
3. Given concurrent requests executed across warm isolates, when responses are analyzed, then `crossTenantCollisions` is strictly 0 and all request IDs are unique ULIDs (`PLAT-7`, `FN-6`).
4. Given sustained execution over the benchmark duration, when memory usage is observed, then heap growth remains bounded without resource leakage.

## Tests required

- [x] Integration — `tests/load/multi_tenant_load_test.ts`: High-concurrency benchmark asserting latency percentiles, availability thresholds ($\ge 99.95\%$), and 429 rate shedding.
- [x] Security — Verify zero cross-tenant state bleed or data collision under high concurrency (`PLAT-7`, `FN-6`).

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-7`, `PLAT-9`, `PLAT-10`, `FN-5`, `FN-6`)
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Integration tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete if triggered
- [x] Nothing outside "In scope" touched

## Verification Transcripts

### `deno check tests/fixtures/load-generator.ts tests/load/multi_tenant_load_test.ts apps/gateway/gateway-server.ts`
```text
Check tests/fixtures/load-generator.ts
Check tests/load/multi_tenant_load_test.ts
Check apps/gateway/gateway-server.ts
Check apps/gateway/gateway-server_test.ts
```

### `deno test -A tests/load/multi_tenant_load_test.ts apps/gateway/gateway-server_test.ts`
```text
running 13 tests from ./apps/gateway/gateway-server_test.ts
PLAT-1 (AC1): forwards GET /v1/projects with query params and headers to control plane ... ok (30ms)
PLAT-1 (AC1): forwards POST /v1/deploy with streaming body and headers to control plane ... ok (8ms)
PLAT-1 (AC1): streams chunked response body from control plane back to client intact ... ok (9ms)
PLAT-1, PLAT-8 (AC2): forwards customer route GET /hello with zero control plane roundtrips ... ok (7ms)
PLAT-1, PLAT-8 (AC2): forwards customer route POST /upload/image with payload to data plane ... ok (8ms)
PLAT-1, PLAT-8 (AC2): forwards nested path GET /users/123 to data plane with zero control plane roundtrips ... ok (8ms)
PLAT-14, PLAT-12 (AC3): generates Crockford Base32 ULID and injects x-request-id and request-id when absent ... ok (7ms)
PLAT-14, PLAT-12 (AC3): preserves existing client-supplied x-request-id upstream and downstream ... ok (5ms)
PLAT-9, PLAT-12 (AC4): rejects bursts exceeding token bucket with 429 RATE_LIMITED, Retry-After, and PLAT-12 body ... ok (11ms)
PLAT-9, PLAT-18 (AC4): isolates rate limit buckets across distinct client IPs ... ok (10ms)
PLAT-12 (AC5): returns HTTP 503 UNAVAILABLE with PLAT-12 error body when upstream control plane is unreachable ... ok (2s)
PLAT-12 (AC5): returns HTTP 503 UNAVAILABLE with PLAT-12 error body when upstream data plane is unreachable ... ok (2s)
PLAT-19: allocates dynamic port, handles requests, and terminates cleanly on close() ... ok (1s)
running 5 tests from ./tests/load/multi_tenant_load_test.ts
PLAT-10 (AC1): Multi-tenant load benchmark within limits meets 99.95% SLO ... ok (590ms)
PLAT-9 (AC2): Token bucket shedding under burst load cleanly sheds excess requests with 429 without starving benign tenant ... ok (516ms)
PLAT-7, FN-6 (AC3): Zero cross-tenant data bleed under multi-tenant concurrent stress ... ok (579ms)
PLAT-10, PLAT-14: Percentile metric accuracy and ULID request ID propagation across benchmark ... ok (407ms)
FN-5 (AC4): Bounded memory consumption during sustained multi-tenant execution ... ok (636ms)

ok | 18 passed | 0 failed (8s)
```

### `deno lint tests/fixtures/load-generator.ts tests/load/multi_tenant_load_test.ts apps/gateway/gateway-server.ts`
```text
Checked 3 files
```

### Reviewer Verdict
- **Verdict**: PASS (Independent review verified interface compliance, rate-limiting, latency percentile monotonicity, and clean body drainage).

### Security Auditor Verdict
- **Verdict**: PASS (Adversarial re-audit verified synthetic client IP derivation per tenant, Anonymous/IP rate limit scoping strictly to unauthenticated traffic, noisy neighbor isolation for concurrent benign tenants, and 0 cross-tenant state bleeding).

## Assumptions made

None.
