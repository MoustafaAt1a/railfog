# T-0902 — E2E Production Soak & Rate Limiter Loopback Harness Tuning

Status: Done
Milestone: 0.9 Deep System Audit & Hardening
Depends on: none
Blocks: T-0905

## Spec references

`PLAT-8`, `PLAT-9`, `PLAT-10`, `PLAT-18`

## Scope

**In scope**:
- `tests/e2e/public_beta_soak_test.ts`: Configure `launchProductionTopology()` defaults for `ipRate` and `ipBurst` to allow sufficient headroom (e.g. 100 req/s, burst 100) for loopback tests where all concurrent tenant requests share `127.0.0.1`.
- Ensure AC2 (fail-static chaos injection), AC3 (token bucket project burst limit), and AC4 (multi-tenant state bleed) tests pass deterministically without premature IP throttling.

**Out of scope**:
- Altering production IP rate limit defaults (`10 req/s`, burst `20`) defined in `platform.contract.md` PLAT-9.

## Interface to implement

```typescript
// tests/e2e/public_beta_soak_test.ts
async function launchProductionTopology(
  customLimits?: {
    projectRate?: number;
    projectBurst?: number;
    ipRate?: number;
    ipBurst?: number;
  },
): Promise<ProductionTopology>;
```

## Acceptance criteria (Given/When/Then)

1. Given AC2 driving 25 concurrent customer requests during control plane outage, when executed against the gateway, then 100% of requests return 200 OK (fail-static).
2. Given AC3 driving 35 burst requests for a project configured with burst 25, when executed, then 25 requests are permitted and remaining excess requests are shed with 429 RATE_LIMITED.
3. Given AC4 driving 50 multi-tenant concurrent requests, when executed, then all 50 requests succeed with 200 OK and unique monotonic ULIDs.

## Tests required

- [x] E2E — `tests/e2e/public_beta_soak_test.ts`

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] `deno check` run, zero errors
- [x] `deno test` run, all required tests passing
- [x] `deno lint` run, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched

## Assumptions made

None.
