# T-0303 — Egress IP connect-time CIDR blocker

Status: Done
Milestone: 0.3 Security
Depends on: T-0102
Blocks: T-0304, T-0313

## Spec references

`PLAT-5`

## Scope

**In scope:**
- `runtime/sandbox/egress-ip-blocker.ts`: connect-time IP address and CIDR validation for all outbound network connections.
- Mandatory blocked ranges enforced per PLAT-5:
  - Cloud metadata / link-local: `169.254.0.0/16`, `fd00:ec2::/8`
  - RFC1918 private IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
  - Loopback: `127.0.0.0/8`, `::1/128`
  - Unspecified / broadcast / multicast: `0.0.0.0/8`, `224.0.0.0/4`, `240.0.0.0/4`
  - Configurable internal RailFog service addresses
- Connect-time DNS resolution: resolve destination hostname to IP at connection time and validate every resolved IP against mandatory blocked CIDRs before socket initiation to prevent DNS rebinding.
- Normalize and reject non-canonical IP formats (e.g. octal strings, integer representations, IPv4-mapped IPv6).

**Out of scope:**
- HTTP forward proxy request parsing and header handling (T-0304).
- Domain allowlist matching from `permissions.network` (T-0304).
- Host OS iptables or firewall configuration.

## Interface to implement

```typescript
export interface IpBlockResult {
  blocked: boolean;
  ip: string;
  reason?: string;
}

export interface EgressIpBlocker {
  isIpBlocked(ip: string): boolean;
  validateDestination(hostOrIp: string): Promise<IpBlockResult>;
}
```

## Acceptance criteria (Given/When/Then)

1. Given an outbound request targeting cloud metadata `169.254.169.254` or `[fd00:ec2::254]`, when `validateDestination` is called, then it returns `blocked: true` and prevents connection initiation.
2. Given an outbound request targeting RFC1918 addresses (`10.0.0.1`, `172.16.0.5`, `192.168.1.1`) or loopback (`127.0.0.1`, `::1`), when evaluated, then it returns `blocked: true`.
3. Given a DNS domain configured to return a public IP on initial check and `169.254.169.254` at connect time (DNS rebinding attempt), when resolved at connect time, then the blocked IP is intercepted and rejected.
4. Given a valid public Internet IP (e.g. `93.184.216.34`), when validated, then it returns `blocked: false`.

## Tests required

- [x] Unit — CIDR matching for IPv4 and IPv6 across all mandatory ranges specified in PLAT-5
- [x] Integration — connect-time DNS resolution with mocked and real records to confirm IP extraction and blocking
- [x] Security — verify resistance to DNS rebinding, zero-prefixed octals (e.g. `0177.0.0.1`), decimal encodings (e.g. `2130706433`), IPv4-mapped IPv6 (e.g. `::ffff:127.0.0.1`), and link-local cloud metadata endpoints (PLAT-5)

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches PLAT-5)
- [x] Nothing outside "In scope" touched

```
$ deno check runtime/sandbox/egress-ip-blocker.ts runtime/sandbox/egress-ip-blocker_test.ts
Check runtime/sandbox/egress-ip-blocker.ts
Check runtime/sandbox/egress-ip-blocker_test.ts
EXIT:0

$ deno test runtime/sandbox/egress-ip-blocker_test.ts
Check runtime/sandbox/egress-ip-blocker_test.ts
running 27 tests from ./runtime/sandbox/egress-ip-blocker_test.ts
AC1 — Blocks AWS/GCP/Azure IPv4 cloud metadata (169.254.169.254) ... ok (1ms)
AC1 — Blocks AWS IPv6 cloud metadata ([fd00:ec2::254] and fd00:ec2::/8) ... ok (474µs)
AC1 — Blocks cloud metadata with explicit ports ... ok (253µs)
AC1 — Blocks entire link-local range (169.254.0.0/16) ... ok (221µs)
AC2 — Blocks RFC1918 10.0.0.0/8 private network ... ok (197µs)
AC2 — Blocks RFC1918 172.16.0.0/12 private network ... ok (185µs)
AC2 — Blocks RFC1918 192.168.0.0/16 private network ... ok (212µs)
AC2 — Blocks loopback IPv4 127.0.0.0/8 and IPv6 ::1/128 ... ok (215µs)
Unit — Blocks 0.0.0.0/8, multicast 224.0.0.0/4, reserved 240.0.0.0/4 ... ok (221µs)
Unit — Blocks IPv6 link-local fe80::/10, multicast ff00::/8, unspecified :: ... ok (211µs)
Unit — Supports configurable additional blocked ranges for internal services ... ok (247µs)
AC4 — Allows valid public IPv4 addresses ... ok (325µs)
AC4 — Allows valid public IPv6 addresses ... ok (262µs)
AC4 — Accurately permits addresses at strict CIDR boundaries ... ok (194µs)
AC3 — Intercepts DNS rebinding targeting cloud metadata at connect time ... ok (253µs)
AC3 — Intercepts DNS rebinding targeting loopback (127.0.0.1) ... ok (195µs)
AC3 — Blocks destination when DNS returns mixed public and blocked IPs (dual-homed evasion) ... ok (155µs)
AC3 — Blocks destination when DNS returns mixed public and RFC1918 IPs ... ok (192µs)
Integration — Resolves public hostname via custom resolver successfully ... ok (192µs)
Integration — Handles DNS resolution failure safely without bypass ... ok (810µs)
Integration — Rejects destination when DNS resolves to zero IP addresses ... ok (269µs)
Security — Blocks non-canonical IPv4 octal string encodings (0177.0.0.1) ... ok (361µs)
Security — Blocks integer/decimal IPv4 encodings (2130706433) ... ok (154µs)
Security — Blocks hexadecimal IPv4 encodings (0x7f.0.0.1, 0x7f000001) ... ok (207µs)
Security — Blocks IPv4-mapped IPv6 addresses (::ffff:127.0.0.1, ::ffff:169.254.169.254) ... ok (820µs)
Security — Correctly permits public IPv4 addresses presented as IPv4-mapped IPv6 ... ok (233µs)
Security — Blocks deprecated IPv4-compatible IPv6 addresses (::127.0.0.1, ::169.254.169.254) ... ok (204µs)

ok | 27 passed | 0 failed (21ms)
EXIT:0

$ deno task test
...
ok | 347 passed | 0 failed (46s)
EXIT:0

$ deno task check
Task check deno check **/*.ts
...
Checked 66 files
EXIT:0

$ deno lint
Checked 65 files
EXIT:0

$ deno fmt --check
Checked 66 files
EXIT:0
```

## Assumptions made

- DNS resolution uses `Deno.resolveDns` for `A` and `AAAA` records, queried concurrently via `Promise.allSettled` to accommodate domains with only A or only AAAA records without failing prematurely. If both queries reject, the lookup failure is rethrown fail-closed.
- IP parsing for IPv4 uses POSIX `inet_aton` semantics supporting decimal, octal (0-prefixed), hexadecimal (0x-prefixed), and 1-4 part encodings (including single 32-bit integers/hex), ensuring obfuscated evasion attempts evaluate against blocked CIDRs.
- IPv4-mapped IPv6 (`::ffff:0:0/96`) and deprecated IPv4-compatible IPv6 (`::0:0/96`, excluding `::` and `::1`) unpack the underlying 32-bit IPv4 address to evaluate against IPv4 blocked ranges.
- Input destinations containing port suffixes or bracket notation (e.g. `[::1]:80`, `1.2.3.4:443`) are normalized by stripping brackets and ports prior to IP parsing and DNS resolution.
- All CIDR matching is performed using 32-bit unsigned BigInts for IPv4 and 128-bit BigInts for IPv6 bitmask operations (`bigint & mask === network`).
- Configurable internal RailFog service addresses can be provided via `additionalBlockedRanges` in `EgressIpBlockerOptions` for both IPv4 and IPv6 CIDR formats.
