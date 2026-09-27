# T-0923 — SSRF Defense-in-Depth Expansion for Carrier-Grade NAT & IPv6 ULA

Status: Done
Milestone: 0.9.2 Master Autonomous Engineering, Forensic Audit, Hardening & Productionization Gate
Depends on: none
Blocks: T-0928

## Spec references

`PLAT-5`

## Scope

**In scope**:
- `runtime/sandbox/egress-ip-blocker.ts`
- Expanding `MANDATORY_BLOCKED_IPV4_CIDRS` with `100.64.0.0/10` (RFC 6598 Carrier-Grade NAT / internal cloud VPCs).
- Expanding `MANDATORY_BLOCKED_IPV6_CIDRS` with `fc00::/7` (RFC 4193 Unique Local Addresses covering `fc00::/8` and `fd00::/8`).

**Out of scope**:
- Weakening or removing any existing CIDR blocks.
- Modifying proxy forwarding logic in `egress-proxy.ts`.
- Modifying public DNS resolution semantics.

## Interface to implement

```typescript
// runtime/sandbox/egress-ip-blocker.ts
// Expanded constants:
const MANDATORY_BLOCKED_IPV4_CIDRS: readonly string[];
const MANDATORY_BLOCKED_IPV6_CIDRS: readonly string[];
```

## Acceptance criteria (Given/When/Then)

1. Given an outbound request targeting an RFC 6598 Carrier-Grade NAT IPv4 address (e.g. `100.64.0.1` or `100.127.255.254`), when `isIpBlocked()` or `validateDestination()` is evaluated, then the address is blocked with `blocked: true`.
2. Given an outbound request targeting an RFC 4193 Unique Local IPv6 address (e.g. `fc00::1` or `fd12:3456:789a::1`), when evaluated, then the address is blocked with `blocked: true`.
3. Given legitimate public IPv4 or IPv6 destinations (e.g. `93.184.216.34` or `2606:2800:220:1:248:1893:25c8:1946`), when evaluated, then they are allowed with `blocked: false`.

## Tests required

- [x] Unit — `tests/unit/milestone_092_hardening_test.ts`
- [x] Security — `PLAT-5` verification for CGNAT and IPv6 ULA

## Definition of Done

- [x] Implementation matches every cited clause ID exactly (`PLAT-5`)
- [x] Spec-anchor comments present at each decision point
- [x] Unit tests written and verified passing
- [x] `deno check` run, zero errors
- [x] `deno test` run, zero failures
- [x] `deno lint` run, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Nothing outside "In scope" touched

## Assumptions made

None. RFC 4193 and RFC 6598 are standard non-routable address definitions.
