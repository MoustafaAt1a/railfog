# T-0304 — HTTP egress proxy with network allowlist enforcement

Status: Done
Milestone: 0.3 Security
Depends on: T-0102, T-0303
Blocks: T-0311, T-0313

## Spec references

`PLAT-5` `FN-5`

## Scope

**In scope:**
- `runtime/sandbox/egress-proxy.ts`: HTTP forward proxy service for sandboxed function execution.
- Enforce the two independent defense-in-depth network security layers from PLAT-5:
  1. Layer 1: Network allowlist matching against `permissions.network = [...]` declared in `railfog.toml` (exact hostname or wildcard subdomain match).
  2. Layer 2: Mandatory connect-time IP blocking using `EgressIpBlocker` (T-0303) across all resolved IPs, independent of allowlist status.
- Enforce network connection concurrency ceiling per FN-5: max 6 concurrent outbound connections per invocation; attempts exceeding the ceiling return `429 RATE_LIMITED`.
- Support HTTP and HTTPS CONNECT tunneling for outbound requests.

**Out of scope:**
- CIDR parsing and IP range validation logic (delegated to T-0303).
- Subprocess spawning and Deno permission flags configuration (T-0311).
- Direct host OS firewall or packet filtering rules.

## Interface to implement

```typescript
import type { EgressIpBlocker } from "./egress-ip-blocker.ts";

export interface EgressProxyOptions {
  port?: number;
  blocker?: EgressIpBlocker;
}

export interface InvocationNetworkContext {
  invocationId: string;
  allowlist: string[];
  maxConcurrentConnections?: number;
}

export interface EgressProxy {
  port: number;
  registerInvocation(ctx: InvocationNetworkContext): void;
  unregisterInvocation(invocationId: string): void;
  handleRequest(req: Request, invocationId: string): Promise<Response>;
  close(): Promise<void>;
}
```

## Acceptance criteria (Given/When/Then)

1. Given a function with `permissions.network = ["api.stripe.com"]`, when it attempts an outbound request to `unpermitted.example.com`, then the proxy rejects the request with `PERMISSION_DENIED`.
2. Given a function with `permissions.network = ["metadata.internal"]` that resolves to `169.254.169.254`, even though the hostname matches the allowlist, when evaluated against the connect-time IP blocker, then the connection is rejected.
3. Given an invocation attempting to establish 7 concurrent outbound connections when `network.connections` is capped at 6 (FN-5), then the 7th concurrent request is rejected with `RATE_LIMITED`.
4. Given a function with no declared network permissions (`permissions.network` omitted or empty), when any outbound connection is attempted, then all outbound traffic is rejected.

## Tests required

- [x] Unit — allowlist matching logic for exact hostnames, wildcard subdomains, and port-specific destinations
- [x] Integration — HTTP forward proxy request dispatching, header forwarding, and response streaming
- [x] Security — dual-layer independence verification: prove allowlist cannot bypass mandatory IP blocker, verify connection exhaustion protection under burst load (PLAT-5, FN-5)

## Definition of Done

- [x] Implementation matches every cited clause ID exactly
- [x] Spec-anchor comments present at each RailFog-specific decision point
- [x] Unit tests written first (red), then implementation (green)
- [x] `deno check` run, real output attached, zero errors
- [x] `deno test` run, real output attached, all required tests passing (36/36 passing)
- [x] `deno lint` run, real output attached, zero warnings
- [x] No item from `docs/ANTI-SLOP.md` violated
- [x] Reviewer pass complete; security-auditor pass complete (touches PLAT-5, FN-5)
- [x] Nothing outside "In scope" touched

## Assumptions made

- Egress proxy binds to 127.0.0.1 on an ephemeral port (or configured port), accessible only to local sandbox child processes.
- Unregistered or missing invocation ID returns 403 PERMISSION_DENIED per PLAT-6 and PLAT-12.
- Empty allowlist rejects all outbound requests with 403 PERMISSION_DENIED per PLAT-5 AC4.
- HTTPS CONNECT tunneling is supported over the same TCP listener port, validating Layer 1 allowlist and Layer 2 IP blocking before establishing upstream TCP connection and duplex piping streams.
- Upstream dispatch connects directly to the connect-time validated IP address (`blockResult.ip`) with preserved `Host` and SNI `servername` headers, preventing TOCTOU DNS rebinding attacks.
- Upstream connection failures emit HTTP 502 with structured `toErrorResponseBody(new UnavailableError(...))` error code `UNAVAILABLE` per PLAT-12.
- Internal metadata header `x-railfog-invocation-id` and hop-by-hop headers are stripped prior to upstream dispatch.
- Concurrency isolation test deadlock resolved by dispatching tenant B request concurrently before releasing mock server hold.
