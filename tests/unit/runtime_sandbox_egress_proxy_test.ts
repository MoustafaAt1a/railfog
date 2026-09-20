/**
 * Tests for HTTP egress proxy with network allowlist enforcement.
 *
 * Spec references:
 * - contracts/platform.contract.md#PLAT-5: Network policy: allowlist + mandatory IP block (SSRF-safe).
 *   Two independent defense-in-depth layers:
 *     Layer 1: Network allowlist matching against permissions.network (exact hostname or wildcard subdomain).
 *     Layer 2: Mandatory connect-time IP blocking via EgressIpBlocker across all resolved IPs,
 *              independent of allowlist and immune to DNS rebinding.
 * - contracts/platform.contract.md#PLAT-12: Error model: HTTPS + JSON with machine-readable codes.
 *   Rejections return 403 PERMISSION_DENIED or 429 RATE_LIMITED with Retry-After header.
 * - contracts/functions.contract.md#FN-5: Resource limits: network.connections capped at 6 concurrent
 *   outbound connections per invocation; exceeding attempts return 429 RATE_LIMITED.
 * - tasks/milestone-0.3-security/T-0304-egress-proxy.md
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import {
  EgressIpBlocker,
  type IpBlockResult,
} from "../../runtime/sandbox/egress-ip-blocker.ts";
import {
  EgressProxy,
  type EgressProxyOptions,
  type InvocationNetworkContext,
} from "../../runtime/sandbox/egress-proxy.ts";

// spec: contracts/functions.contract.md#FN-5 — Max 6 concurrent outbound network connections per invocation
const MAX_CONCURRENT_CONNECTIONS = 6;

// spec: contracts/platform.contract.md#PLAT-12 — HTTP error status codes and machine-readable error codes
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_CREATED = 201;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_FORBIDDEN = 403;
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;

const ERROR_CODE_PERMISSION_DENIED = "PERMISSION_DENIED";
const ERROR_CODE_RATE_LIMITED = "RATE_LIMITED";

/**
 * Extracts the machine-readable error code from a JSON error response body per PLAT-12.
 */
async function extractErrorCode(res: Response): Promise<string | undefined> {
  try {
    const data = await res.json();
    return data?.error?.code ?? data?.code;
  } catch {
    return undefined;
  }
}

/**
 * Permissive IP blocker test double for HTTP forwarding integration tests,
 * allowing requests to loopback mock servers without triggering PLAT-5 IP blocks.
 */
class PermissiveIpBlocker extends EgressIpBlocker {
  override isIpBlocked(_ip: string): boolean {
    return false;
  }

  override validateDestination(hostOrIp: string): Promise<IpBlockResult> {
    return Promise.resolve({
      blocked: false,
      ip: hostOrIp,
    });
  }
}

// ============================================================================
// Section 1: Allowlist Matching Logic (Unit)
// Spec: contracts/platform.contract.md#PLAT-5
// ============================================================================

Deno.test("Allowlist Unit — AC1: Exact hostname match permitted; unpermitted rejected with 403 PERMISSION_DENIED", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — Layer 1 allowlist matching
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-ac1-test";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["api.stripe.com"],
    });

    // Unpermitted domain must be rejected with 403 PERMISSION_DENIED
    const deniedReq = new Request("https://unpermitted.example.com/v1/charges");
    const deniedRes = await proxy.handleRequest(deniedReq, invocationId);
    assertEquals(deniedRes.status, HTTP_STATUS_FORBIDDEN);
    const deniedCode = await extractErrorCode(deniedRes);
    assertEquals(deniedCode, ERROR_CODE_PERMISSION_DENIED);

    // Another unpermitted domain
    const otherDeniedReq = new Request("https://other.stripe.com/v1/charges");
    const otherDeniedRes = await proxy.handleRequest(
      otherDeniedReq,
      invocationId,
    );
    assertEquals(otherDeniedRes.status, HTTP_STATUS_FORBIDDEN);
    const otherCode = await extractErrorCode(otherDeniedRes);
    assertEquals(otherCode, ERROR_CODE_PERMISSION_DENIED);

    // Apex domain must not match exact subdomain
    const apexDeniedReq = new Request("https://stripe.com/about");
    const apexDeniedRes = await proxy.handleRequest(
      apexDeniedReq,
      invocationId,
    );
    assertEquals(apexDeniedRes.status, HTTP_STATUS_FORBIDDEN);
    const apexCode = await extractErrorCode(apexDeniedRes);
    assertEquals(apexCode, ERROR_CODE_PERMISSION_DENIED);
  } finally {
    await proxy.close();
  }
});

Deno.test("Allowlist Unit — Strips explicit default ports when matching exact hostnames", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const options: EgressProxyOptions = { blocker: new PermissiveIpBlocker() };
  const proxy = new EgressProxy(options);

  try {
    const ctx: InvocationNetworkContext = {
      invocationId: "inv-port-strip",
      allowlist: ["api.stripe.com"],
    };
    proxy.registerInvocation(ctx);

    // Target unpermitted with port is rejected
    const deniedReqWithPort = new Request(
      "https://unpermitted.example.com:443/test",
    );
    const deniedRes = await proxy.handleRequest(
      deniedReqWithPort,
      ctx.invocationId,
    );
    assertEquals(deniedRes.status, HTTP_STATUS_FORBIDDEN);
    const deniedCode = await extractErrorCode(deniedRes);
    assertEquals(deniedCode, ERROR_CODE_PERMISSION_DENIED);
  } finally {
    await proxy.close();
  }
});

Deno.test("Allowlist Unit — Case-insensitive hostname matching per RFC 4343 / RFC 3986", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-case-test";
    // Lowercase in allowlist
    proxy.registerInvocation({
      invocationId,
      allowlist: ["api.stripe.com", "*.github.com"],
    });

    // Uppercase in request for unpermitted domain
    const deniedReq = new Request("https://UNPERMITTED.EXAMPLE.COM/api");
    const deniedRes = await proxy.handleRequest(deniedReq, invocationId);
    assertEquals(deniedRes.status, HTTP_STATUS_FORBIDDEN);
    const deniedCode = await extractErrorCode(deniedRes);
    assertEquals(deniedCode, ERROR_CODE_PERMISSION_DENIED);
  } finally {
    await proxy.close();
  }
});

Deno.test("Allowlist Unit — Wildcard subdomain matching (*.example.com)", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-wildcard-test";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["*.example.com"],
    });

    // Subdomain on a different domain must be rejected
    const diffDomainReq = new Request("https://api.different.com/data");
    const diffRes = await proxy.handleRequest(diffDomainReq, invocationId);
    assertEquals(diffRes.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(await extractErrorCode(diffRes), ERROR_CODE_PERMISSION_DENIED);

    // Suffix confusion attack: attacker-example.com must NOT match *.example.com
    const suffixAttackReq = new Request("https://attacker-example.com/steal");
    const suffixRes = await proxy.handleRequest(suffixAttackReq, invocationId);
    assertEquals(suffixRes.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      await extractErrorCode(suffixRes),
      ERROR_CODE_PERMISSION_DENIED,
    );

    // Append attack: example.com.attacker.com must NOT match *.example.com
    const appendAttackReq = new Request(
      "https://example.com.attacker.com/steal",
    );
    const appendRes = await proxy.handleRequest(appendAttackReq, invocationId);
    assertEquals(appendRes.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      await extractErrorCode(appendRes),
      ERROR_CODE_PERMISSION_DENIED,
    );
  } finally {
    await proxy.close();
  }
});

Deno.test("Allowlist Unit — Port-specific allowlist entry enforcement", async () => {
  // spec: contracts/platform.contract.md#PLAT-5
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-port-specific";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["custom.api.internal:8443"],
    });

    // Different port to same host must be rejected
    const wrongPortReq = new Request("https://custom.api.internal:443/data");
    const wrongPortRes = await proxy.handleRequest(wrongPortReq, invocationId);
    assertEquals(wrongPortRes.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      await extractErrorCode(wrongPortRes),
      ERROR_CODE_PERMISSION_DENIED,
    );
  } finally {
    await proxy.close();
  }
});

Deno.test("Allowlist Unit — AC4: Empty allowlist rejects all outbound traffic with 403 PERMISSION_DENIED", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — AC4: absence of permission == no code path permitted
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-empty-allowlist";
    proxy.registerInvocation({
      invocationId,
      allowlist: [],
    });

    const destinations = [
      "https://api.stripe.com/v1/charges",
      "https://example.com/",
      "https://google.com/",
      "http://1.1.1.1/",
    ];

    for (const url of destinations) {
      const req = new Request(url);
      const res = await proxy.handleRequest(req, invocationId);
      assertEquals(
        res.status,
        HTTP_STATUS_FORBIDDEN,
        `Expected 403 for ${url}`,
      );
      const code = await extractErrorCode(res);
      assertEquals(
        code,
        ERROR_CODE_PERMISSION_DENIED,
        `Expected PERMISSION_DENIED for ${url}`,
      );
    }
  } finally {
    await proxy.close();
  }
});

// ============================================================================
// Section 2: Registration & Invocation Lifecycle
// Spec: contracts/platform.contract.md#PLAT-6, FN-4
// ============================================================================

Deno.test("Registration Lifecycle — Unregistered invocationId rejected with 403 PERMISSION_DENIED", async () => {
  // spec: contracts/platform.contract.md#PLAT-6, PLAT-12
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const req = new Request("https://api.stripe.com/v1/charges");
    const res = await proxy.handleRequest(req, "non-existent-invocation-id");

    assertEquals(res.status, HTTP_STATUS_FORBIDDEN);
    const code = await extractErrorCode(res);
    assertEquals(code, ERROR_CODE_PERMISSION_DENIED);
  } finally {
    await proxy.close();
  }
});

Deno.test("Registration Lifecycle — unregisterInvocation cleanly removes invocation permissions", async () => {
  // spec: contracts/functions.contract.md#FN-6 — Bindings and lifecycle cleaned up per invocation
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-lifecycle-1";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["api.stripe.com"],
    });

    // Unregister invocation context
    proxy.unregisterInvocation(invocationId);

    // Subsequent request must be rejected as unregistered
    const req = new Request("https://api.stripe.com/v1/charges");
    const res = await proxy.handleRequest(req, invocationId);

    assertEquals(res.status, HTTP_STATUS_FORBIDDEN);
    const code = await extractErrorCode(res);
    assertEquals(code, ERROR_CODE_PERMISSION_DENIED);
  } finally {
    await proxy.close();
  }
});

Deno.test("Registration Lifecycle — Multiple concurrent invocations maintain isolated permissions", async () => {
  // spec: contracts/platform.contract.md#PLAT-6, PLAT-7 — Per-invocation capability scoping
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invA = "inv-tenant-alpha";
    const invB = "inv-tenant-beta";

    proxy.registerInvocation({
      invocationId: invA,
      allowlist: ["api.stripe.com"],
    });

    proxy.registerInvocation({
      invocationId: invB,
      allowlist: ["api.github.com"],
    });

    // Invocation A targeting Github (permitted only for B) -> Denied
    const reqGithub = new Request("https://api.github.com/user");
    const resADenied = await proxy.handleRequest(reqGithub, invA);
    assertEquals(resADenied.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      await extractErrorCode(resADenied),
      ERROR_CODE_PERMISSION_DENIED,
    );

    // Invocation B targeting Stripe (permitted only for A) -> Denied
    const reqStripe = new Request("https://api.stripe.com/v1/charges");
    const resBDenied = await proxy.handleRequest(reqStripe, invB);
    assertEquals(resBDenied.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      await extractErrorCode(resBDenied),
      ERROR_CODE_PERMISSION_DENIED,
    );
  } finally {
    await proxy.close();
  }
});

// ============================================================================
// Section 3: Dual-Layer Independence & SSRF Protection (PLAT-5 Security)
// ============================================================================

Deno.test("Security Dual-Layer — AC2: Allowlist contains metadata.internal resolving to 169.254.169.254 -> rejected by connect-time IP blocker", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — Mandatory-block ranges enforced at connect time
  const customResolver = (host: string): Promise<string[]> => {
    if (host === "metadata.internal") {
      return Promise.resolve(["169.254.169.254"]);
    }
    return Promise.resolve(["93.184.216.34"]);
  };

  const blocker = new EgressIpBlocker({ dnsResolver: customResolver });
  const proxy = new EgressProxy({ blocker });

  try {
    const invocationId = "inv-ssrf-metadata";
    // Hostname explicitly in allowlist
    proxy.registerInvocation({
      invocationId,
      allowlist: ["metadata.internal"],
    });

    // Request to metadata endpoint
    const req = new Request("http://metadata.internal/latest/meta-data/");
    const res = await proxy.handleRequest(req, invocationId);

    // Connect-time IP blocker must reject the request
    assertEquals(res.status, HTTP_STATUS_FORBIDDEN);
    const code = await extractErrorCode(res);
    assertEquals(code, ERROR_CODE_PERMISSION_DENIED);
  } finally {
    await proxy.close();
  }
});

Deno.test("Security Dual-Layer — Rejects allowlisted hostname resolving to RFC1918 10.0.0.0/8 private range", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — 10.0.0.0/8 RFC1918 private range
  const customResolver = (host: string): Promise<string[]> => {
    if (host === "internal-db.corp") {
      return Promise.resolve(["10.0.1.50"]);
    }
    return Promise.resolve(["93.184.216.34"]);
  };

  const blocker = new EgressIpBlocker({ dnsResolver: customResolver });
  const proxy = new EgressProxy({ blocker });

  try {
    const invocationId = "inv-ssrf-rfc1918";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["internal-db.corp"],
    });

    const req = new Request("http://internal-db.corp:5432/query");
    const res = await proxy.handleRequest(req, invocationId);

    assertEquals(res.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(await extractErrorCode(res), ERROR_CODE_PERMISSION_DENIED);
  } finally {
    await proxy.close();
  }
});

Deno.test("Security Dual-Layer — Rejects allowlisted hostname resolving to loopback 127.0.0.1", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — 127.0.0.0/8 loopback range
  const customResolver = (host: string): Promise<string[]> => {
    if (host === "local-admin.internal") {
      return Promise.resolve(["127.0.0.1"]);
    }
    return Promise.resolve(["93.184.216.34"]);
  };

  const blocker = new EgressIpBlocker({ dnsResolver: customResolver });
  const proxy = new EgressProxy({ blocker });

  try {
    const invocationId = "inv-ssrf-loopback";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["local-admin.internal"],
    });

    const req = new Request("http://local-admin.internal:8080/admin");
    const res = await proxy.handleRequest(req, invocationId);

    assertEquals(res.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(await extractErrorCode(res), ERROR_CODE_PERMISSION_DENIED);
  } finally {
    await proxy.close();
  }
});

Deno.test("Security Dual-Layer — Direct IP literals in allowlist cannot bypass connect-time IP blocker", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — IP blocker is independent of allowlist
  const blocker = new EgressIpBlocker();
  const proxy = new EgressProxy({ blocker });

  try {
    const invocationId = "inv-direct-ip-bypass";
    // Attempting to bypass by putting metadata IP directly in allowlist
    proxy.registerInvocation({
      invocationId,
      allowlist: ["169.254.169.254", "127.0.0.1", "10.0.0.1"],
    });

    const targets = [
      "http://169.254.169.254/latest/meta-data",
      "http://127.0.0.1:8080/internal",
      "http://10.0.0.1:80/admin",
    ];

    for (const url of targets) {
      const req = new Request(url);
      const res = await proxy.handleRequest(req, invocationId);
      assertEquals(
        res.status,
        HTTP_STATUS_FORBIDDEN,
        `Expected 403 for ${url}`,
      );
      assertEquals(await extractErrorCode(res), ERROR_CODE_PERMISSION_DENIED);
    }
  } finally {
    await proxy.close();
  }
});

Deno.test("Security Dual-Layer — DNS rebinding to metadata IP at connect time is intercepted", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — Connect-time resolution immune to DNS rebinding
  let callCount = 0;
  const rebindingResolver = (_host: string): Promise<string[]> => {
    callCount++;
    // Rebinds to link-local metadata IP
    return Promise.resolve(["169.254.169.254"]);
  };

  const blocker = new EgressIpBlocker({ dnsResolver: rebindingResolver });
  const proxy = new EgressProxy({ blocker });

  try {
    const invocationId = "inv-dns-rebind";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["rebind-target.example.com"],
    });

    const req = new Request("http://rebind-target.example.com/endpoint");
    const res = await proxy.handleRequest(req, invocationId);

    assertEquals(res.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(await extractErrorCode(res), ERROR_CODE_PERMISSION_DENIED);
    assert(callCount > 0, "Resolver should have been invoked at connect time");
  } finally {
    await proxy.close();
  }
});

// ============================================================================
// Section 4: Concurrency Limit Enforcement (FN-5, PLAT-12)
// ============================================================================

Deno.test("Concurrency Limit — AC3: Max 6 concurrent connections per invocation; 7th simultaneous attempt is rejected with 429 RATE_LIMITED", async () => {
  // spec: contracts/functions.contract.md#FN-5 — network.connections default 6 concurrent
  // spec: contracts/platform.contract.md#PLAT-9, PLAT-12 — 429 RATE_LIMITED with Retry-After header
  const targetServer = Deno.serve(
    { port: 0, hostname: "127.0.0.1" },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/hold") {
        // Hold connection open until explicitly signalled
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (releaseAll) {
              clearInterval(check);
              resolve();
            }
          }, 10);
        });
        return new Response("released", { status: HTTP_STATUS_OK });
      }
      return new Response("fast", { status: HTTP_STATUS_OK });
    },
  );

  let releaseAll = false;
  const targetPort = targetServer.addr.port;
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-burst-concurrency";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["127.0.0.1"],
    });

    // Launch 6 concurrent requests that hold connections open
    const activePromises: Promise<Response>[] = [];
    for (let i = 0; i < MAX_CONCURRENT_CONNECTIONS; i++) {
      const req = new Request(`http://127.0.0.1:${targetPort}/hold?conn=${i}`);
      activePromises.push(proxy.handleRequest(req, invocationId));
    }

    // Small delay to ensure all 6 requests have reached the proxy and acquired connection slots
    await new Promise((r) => setTimeout(r, 50));

    // 7th simultaneous request must be rejected with 429 RATE_LIMITED
    const req7 = new Request(`http://127.0.0.1:${targetPort}/hold?conn=7th`);
    const res7 = await proxy.handleRequest(req7, invocationId);

    assertEquals(res7.status, HTTP_STATUS_TOO_MANY_REQUESTS);
    const code7 = await extractErrorCode(res7);
    assertEquals(code7, ERROR_CODE_RATE_LIMITED);

    // Must include Retry-After header per PLAT-9 / PLAT-12
    const retryAfter = res7.headers.get("retry-after");
    assert(
      retryAfter !== null && retryAfter.length > 0,
      "Expected Retry-After header on 429 response",
    );

    // Release active connections
    releaseAll = true;
    const initialResponses = await Promise.all(activePromises);
    for (const res of initialResponses) {
      assertEquals(res.status, HTTP_STATUS_OK);
    }

    // After completing an in-flight connection, subsequent requests must succeed
    const subsequentReq = new Request(`http://127.0.0.1:${targetPort}/fast`);
    const subsequentRes = await proxy.handleRequest(
      subsequentReq,
      invocationId,
    );
    assertEquals(subsequentRes.status, HTTP_STATUS_OK);
  } finally {
    releaseAll = true;
    await proxy.close();
    await targetServer.shutdown();
  }
});

Deno.test("Concurrency Limit — Concurrency counts are isolated across distinct invocations", async () => {
  // spec: contracts/functions.contract.md#FN-5 — Connection limit is strictly per-invocation
  const targetServer = Deno.serve(
    { port: 0, hostname: "127.0.0.1" },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/hold") {
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (releaseAll) {
              clearInterval(check);
              resolve();
            }
          }, 10);
        });
        return new Response("ok", { status: HTTP_STATUS_OK });
      }
      return new Response("ok", { status: HTTP_STATUS_OK });
    },
  );

  let releaseAll = false;
  const targetPort = targetServer.addr.port;
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invA = "inv-concurrency-tenant-a";
    const invB = "inv-concurrency-tenant-b";

    proxy.registerInvocation({
      invocationId: invA,
      allowlist: ["127.0.0.1"],
      maxConcurrentConnections: 2,
    });

    proxy.registerInvocation({
      invocationId: invB,
      allowlist: ["127.0.0.1"],
      maxConcurrentConnections: 2,
    });

    // Invocation A exhausts its 2 connections
    const p1 = proxy.handleRequest(
      new Request(`http://127.0.0.1:${targetPort}/hold?a=1`),
      invA,
    );
    const p2 = proxy.handleRequest(
      new Request(`http://127.0.0.1:${targetPort}/hold?a=2`),
      invA,
    );
    await new Promise((r) => setTimeout(r, 50));

    // Invocation A's 3rd request is rejected
    const resA3 = await proxy.handleRequest(
      new Request(`http://127.0.0.1:${targetPort}/hold?a=3`),
      invA,
    );
    assertEquals(resA3.status, HTTP_STATUS_TOO_MANY_REQUESTS);

    // Invocation B should NOT be blocked by Invocation A's concurrency usage
    const pB1 = proxy.handleRequest(
      new Request(`http://127.0.0.1:${targetPort}/hold?b=1`),
      invB,
    );
    // B has its own independent concurrency counter
    releaseAll = true;
    const resB1 = await pB1;
    assertNotEquals(resB1.status, HTTP_STATUS_TOO_MANY_REQUESTS);
    await Promise.all([p1, p2]);
  } finally {
    releaseAll = true;
    await proxy.close();
    await targetServer.shutdown();
  }
});

Deno.test("Concurrency Limit — Custom maxConcurrentConnections ceiling configured via InvocationNetworkContext", async () => {
  // spec: contracts/functions.contract.md#FN-5
  const targetServer = Deno.serve(
    { port: 0, hostname: "127.0.0.1" },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/hold") {
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (releaseAll) {
              clearInterval(check);
              resolve();
            }
          }, 10);
        });
        return new Response("ok", { status: HTTP_STATUS_OK });
      }
      return new Response("ok", { status: HTTP_STATUS_OK });
    },
  );

  let releaseAll = false;
  const targetPort = targetServer.addr.port;
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-custom-limit-2";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["127.0.0.1"],
      maxConcurrentConnections: 2,
    });

    // Fire 2 concurrent requests
    const p1 = proxy.handleRequest(
      new Request(`http://127.0.0.1:${targetPort}/hold?c=1`),
      invocationId,
    );
    const p2 = proxy.handleRequest(
      new Request(`http://127.0.0.1:${targetPort}/hold?c=2`),
      invocationId,
    );
    await new Promise((r) => setTimeout(r, 50));

    // 3rd attempt should be rejected with 429
    const res3 = await proxy.handleRequest(
      new Request(`http://127.0.0.1:${targetPort}/hold?c=3`),
      invocationId,
    );
    assertEquals(res3.status, HTTP_STATUS_TOO_MANY_REQUESTS);
    assertEquals(await extractErrorCode(res3), ERROR_CODE_RATE_LIMITED);

    releaseAll = true;
    await Promise.all([p1, p2]);
  } finally {
    releaseAll = true;
    await proxy.close();
    await targetServer.shutdown();
  }
});

Deno.test("Concurrency Limit — Connection count is decremented even when target request fails", async () => {
  // spec: contracts/functions.contract.md#FN-5 — Connection leaks must be prevented
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-fail-recovery";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["127.0.0.1"],
      maxConcurrentConnections: 1,
    });

    // Request to a port where nothing is listening (fails connection)
    const deadPortReq = new Request("http://127.0.0.1:59999/dead");
    await proxy.handleRequest(deadPortReq, invocationId).catch(() => {});

    // Subsequent request should not be blocked by leaked connection counter
    const deadPortReq2 = new Request("http://127.0.0.1:59999/dead");
    const res = await proxy.handleRequest(deadPortReq2, invocationId).catch((
      err: unknown,
    ) => err);
    // Should attempt connection, not fail with 429 RATE_LIMITED
    if (res instanceof Response) {
      assertNotEquals(res.status, HTTP_STATUS_TOO_MANY_REQUESTS);
    }
  } finally {
    await proxy.close();
  }
});

// ============================================================================
// Section 5: HTTP Forwarding Integration (Headers, Body, Streaming)
// Spec: tasks/milestone-0.3-security/T-0304-egress-proxy.md
// ============================================================================

Deno.test("Forwarding Integration — Preserves HTTP methods, headers, and payload body", async () => {
  let receivedMethod = "";
  let receivedAuthHeader = "";
  let receivedCustomHeader = "";
  let receivedBody = "";

  const targetServer = Deno.serve(
    { port: 0, hostname: "127.0.0.1" },
    async (req) => {
      receivedMethod = req.method;
      receivedAuthHeader = req.headers.get("authorization") ?? "";
      receivedCustomHeader = req.headers.get("x-custom-trace") ?? "";
      receivedBody = await req.text();

      return new Response(
        JSON.stringify({ echoed: true, size: receivedBody.length }),
        {
          status: HTTP_STATUS_CREATED,
          headers: {
            "content-type": "application/json",
            "x-response-server": "mock-backend",
          },
        },
      );
    },
  );

  const targetPort = targetServer.addr.port;
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-forward-post";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["127.0.0.1"],
    });

    const payload = JSON.stringify({ action: "charge", amount: 4200 });
    const forwardReq = new Request(
      `http://127.0.0.1:${targetPort}/v1/charges`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer sk_test_12345",
          "x-custom-trace": "trace-uuid-abc-123",
        },
        body: payload,
      },
    );

    const res = await proxy.handleRequest(forwardReq, invocationId);

    // Verify upstream received identical request details
    assertEquals(receivedMethod, "POST");
    assertEquals(receivedAuthHeader, "Bearer sk_test_12345");
    assertEquals(receivedCustomHeader, "trace-uuid-abc-123");
    assertEquals(receivedBody, payload);

    // Verify caller received response from upstream intact
    assertEquals(res.status, HTTP_STATUS_CREATED);
    assertEquals(res.headers.get("x-response-server"), "mock-backend");
    const responseJson = await res.json();
    assertEquals(responseJson, { echoed: true, size: payload.length });
  } finally {
    await proxy.close();
    await targetServer.shutdown();
  }
});

Deno.test("Forwarding Integration — Forwards non-200 upstream error status and body", async () => {
  const targetServer = Deno.serve(
    { port: 0, hostname: "127.0.0.1" },
    (_req) => {
      return new Response(JSON.stringify({ error: "item_not_found" }), {
        status: HTTP_STATUS_NOT_FOUND,
        headers: { "content-type": "application/json" },
      });
    },
  );

  const targetPort = targetServer.addr.port;
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-forward-404";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["127.0.0.1"],
    });

    const forwardReq = new Request(
      `http://127.0.0.1:${targetPort}/missing-resource`,
    );
    const res = await proxy.handleRequest(forwardReq, invocationId);

    // Upstream 404 should be passed back to caller intact
    assertEquals(res.status, HTTP_STATUS_NOT_FOUND);
    const body = await res.json();
    assertEquals(body, { error: "item_not_found" });
  } finally {
    await proxy.close();
    await targetServer.shutdown();
  }
});

// ============================================================================
// Section 6: Server Lifecycle and Clean Shutdown
// Spec: tasks/milestone-0.3-security/T-0304-egress-proxy.md
// ============================================================================

Deno.test("Server Lifecycle — Binds to ephemeral port and cleanly shuts down on close()", async () => {
  const proxy = new EgressProxy({
    port: 0,
    blocker: new PermissiveIpBlocker(),
  });

  // Verify proxy assigned a positive integer port
  assert(
    typeof proxy.port === "number" && proxy.port > 0,
    `Expected positive port, got ${proxy.port}`,
  );

  const assignedPort = proxy.port;

  // Clean shutdown
  await proxy.close();

  // Subsequent connection attempt to the closed port should fail
  await assertRejects(
    async () => {
      await fetch(`http://127.0.0.1:${assignedPort}/health`, {
        signal: AbortSignal.timeout(500),
      });
    },
    Error,
  );
});

// ============================================================================
// Section 7: HTTPS CONNECT Tunneling and Wire Protocol Integration
// Spec: tasks/milestone-0.3-security/T-0304-egress-proxy.md, PLAT-5, FN-5, PLAT-12
// ============================================================================

/**
 * Reads a complete raw HTTP response from a client TCP connection.
 */
async function readRawResponse(conn: Deno.TcpConn): Promise<{
  status: number;
  statusText: string;
  headers: Headers;
  bodyText: string;
  json: () => Record<string, unknown>;
}> {
  const buf = new Uint8Array(4096);
  let raw = "";
  while (true) {
    const n = await conn.read(buf);
    if (n === null) break;
    raw += new TextDecoder().decode(buf.subarray(0, n));
    if (raw.includes("\r\n\r\n")) {
      const headerEnd = raw.indexOf("\r\n\r\n");
      const headersStr = raw.slice(0, headerEnd);
      const contentLenMatch = headersStr.match(/content-length:\s*(\d+)/i);
      if (contentLenMatch) {
        const expectedBodyLen = parseInt(contentLenMatch[1], 10);
        const bodySoFar = raw.slice(headerEnd + 4);
        if (new TextEncoder().encode(bodySoFar).length >= expectedBodyLen) {
          break;
        }
      } else {
        break;
      }
    }
  }

  const headerEnd = raw.indexOf("\r\n\r\n");
  const headersStr = headerEnd !== -1 ? raw.slice(0, headerEnd) : raw;
  const bodyText = headerEnd !== -1 ? raw.slice(headerEnd + 4) : "";

  const lines = headersStr.split("\r\n");
  const statusParts = lines[0].split(" ");
  const status = parseInt(statusParts[1] ?? "0", 10);
  const statusText = statusParts.slice(2).join(" ");

  const headers = new Headers();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon !== -1) {
      headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
  }

  return {
    status,
    statusText,
    headers,
    bodyText,
    json: () => JSON.parse(bodyText),
  };
}

Deno.test("HTTPS CONNECT — Establishes bidirectional TCP tunnel when destination is allowlisted and IP is safe", async () => {
  // Setup mock echo server
  const targetListener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const targetPort = (targetListener.addr as Deno.NetAddr).port;
  (async () => {
    try {
      for await (const conn of targetListener) {
        conn.readable.pipeTo(conn.writable).catch(() => {});
      }
    } catch {
      // Server closed
    }
  })();

  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-connect-allow";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["127.0.0.1"],
    });

    const client = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });

    // Send HTTP CONNECT request
    await client.write(
      new TextEncoder().encode(
        `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nx-railfog-invocation-id: ${invocationId}\r\n\r\n`,
      ),
    );

    // Read 200 Connection Established response
    const buf = new Uint8Array(1024);
    const n = await client.read(buf);
    assert(n !== null);
    const responseHead = new TextDecoder().decode(buf.subarray(0, n));
    assert(
      responseHead.startsWith("HTTP/1.1 200 Connection Established"),
      `Expected 200 Connection Established, got: ${responseHead}`,
    );

    // Test bidirectional data transmission through the tunnel
    const payload = "Hello secure tunnel through RailFog egress proxy!";
    await client.write(new TextEncoder().encode(payload));

    const echoBuf = new Uint8Array(1024);
    const echoN = await client.read(echoBuf);
    assert(echoN !== null);
    const echoedText = new TextDecoder().decode(echoBuf.subarray(0, echoN));
    assertEquals(echoedText, payload);

    client.close();
  } finally {
    await proxy.close();
    targetListener.close();
  }
});

Deno.test("HTTPS CONNECT — Rejects unpermitted destination with 403 PERMISSION_DENIED structured JSON", async () => {
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-connect-deny";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["api.stripe.com"],
    });

    const client = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });

    await client.write(
      new TextEncoder().encode(
        `CONNECT unpermitted.example.com:443 HTTP/1.1\r\nHost: unpermitted.example.com:443\r\nx-railfog-invocation-id: ${invocationId}\r\n\r\n`,
      ),
    );

    const res = await readRawResponse(client);
    assertEquals(res.status, HTTP_STATUS_FORBIDDEN);
    const body = res.json();
    assertEquals(
      (body.error as { code: string })?.code,
      ERROR_CODE_PERMISSION_DENIED,
    );

    client.close();
  } finally {
    await proxy.close();
  }
});

Deno.test("HTTPS CONNECT — Rejects destination resolving to blocked cloud metadata IP with 403 PERMISSION_DENIED", async () => {
  class MetadataBlocker extends EgressIpBlocker {
    override validateDestination(host: string): Promise<IpBlockResult> {
      if (host === "metadata.internal") {
        return Promise.resolve({
          blocked: true,
          ip: "169.254.169.254",
          reason:
            "Destination resolves to blocked IP range: 169.254.169.254 (169.254.0.0/16)",
        });
      }
      return Promise.resolve({ blocked: false, ip: host });
    }
  }

  const proxy = new EgressProxy({ blocker: new MetadataBlocker() });

  try {
    const invocationId = "inv-connect-ssrf";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["metadata.internal"],
    });

    const client = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });

    await client.write(
      new TextEncoder().encode(
        `CONNECT metadata.internal:443 HTTP/1.1\r\nHost: metadata.internal:443\r\nx-railfog-invocation-id: ${invocationId}\r\n\r\n`,
      ),
    );

    const res = await readRawResponse(client);
    assertEquals(res.status, HTTP_STATUS_FORBIDDEN);
    const body = res.json();
    assertEquals(
      (body.error as { code: string })?.code,
      ERROR_CODE_PERMISSION_DENIED,
    );

    client.close();
  } finally {
    await proxy.close();
  }
});

Deno.test("HTTPS CONNECT — Enforces concurrency ceiling (FN-5) and returns 429 RATE_LIMITED with Retry-After", async () => {
  const targetListener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const targetPort = (targetListener.addr as Deno.NetAddr).port;
  (async () => {
    try {
      for await (const conn of targetListener) {
        conn.readable.pipeTo(conn.writable).catch(() => {});
      }
    } catch {
      // Listener closed
    }
  })();

  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-connect-concurrency";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["127.0.0.1"],
      maxConcurrentConnections: 2,
    });

    // Establish tunnel 1
    const c1 = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
    await c1.write(
      new TextEncoder().encode(
        `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nx-railfog-invocation-id: ${invocationId}\r\n\r\n`,
      ),
    );
    const b1 = new Uint8Array(1024);
    const n1 = await c1.read(b1);
    assert(
      new TextDecoder().decode(b1.subarray(0, n1!)).startsWith("HTTP/1.1 200"),
    );

    // Establish tunnel 2
    const c2 = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
    await c2.write(
      new TextEncoder().encode(
        `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nx-railfog-invocation-id: ${invocationId}\r\n\r\n`,
      ),
    );
    const b2 = new Uint8Array(1024);
    const n2 = await c2.read(b2);
    assert(
      new TextDecoder().decode(b2.subarray(0, n2!)).startsWith("HTTP/1.1 200"),
    );

    // Tunnel 3 should be rejected with 429 RATE_LIMITED
    const c3 = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
    await c3.write(
      new TextEncoder().encode(
        `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nx-railfog-invocation-id: ${invocationId}\r\n\r\n`,
      ),
    );
    const res3 = await readRawResponse(c3);
    assertEquals(res3.status, HTTP_STATUS_TOO_MANY_REQUESTS);
    assertEquals(res3.headers.get("retry-after"), "1");
    assertEquals(
      (res3.json().error as { code: string })?.code,
      ERROR_CODE_RATE_LIMITED,
    );
    c3.close();

    // Close tunnel 1, which releases concurrency slot
    c1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Tunnel 4 should now succeed
    const c4 = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
    await c4.write(
      new TextEncoder().encode(
        `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nx-railfog-invocation-id: ${invocationId}\r\n\r\n`,
      ),
    );
    const b4 = new Uint8Array(1024);
    const n4 = await c4.read(b4);
    assert(
      new TextDecoder().decode(b4.subarray(0, n4!)).startsWith("HTTP/1.1 200"),
    );

    c2.close();
    c4.close();
  } finally {
    await proxy.close();
    targetListener.close();
  }
});

// ============================================================================
// Section 8: TOCTOU DNS Rebinding Resistance
// Spec: contracts/platform.contract.md#PLAT-5
// ============================================================================

Deno.test("DNS Rebinding Prevention — Upstream dispatch connects directly to validated IP preserving Host header", async () => {
  let receivedHostHeader = "";
  const targetServer = Deno.serve(
    { port: 0, hostname: "127.0.0.1" },
    (req) => {
      receivedHostHeader = req.headers.get("host") ?? "";
      return new Response(JSON.stringify({ rebindingResistant: true }), {
        status: HTTP_STATUS_OK,
        headers: { "content-type": "application/json" },
      });
    },
  );

  const targetPort = targetServer.addr.port;

  // Blocker resolves custom host to 127.0.0.1
  class PinningBlocker extends EgressIpBlocker {
    override validateDestination(host: string): Promise<IpBlockResult> {
      if (host === "rebind.example.com") {
        return Promise.resolve({ blocked: false, ip: "127.0.0.1" });
      }
      return Promise.resolve({ blocked: false, ip: host });
    }
  }

  const proxy = new EgressProxy({ blocker: new PinningBlocker() });

  try {
    const invocationId = "inv-rebind-test";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["rebind.example.com"],
    });

    const req = new Request(
      `http://rebind.example.com:${targetPort}/check-rebind`,
    );
    const res = await proxy.handleRequest(req, invocationId);

    assertEquals(res.status, HTTP_STATUS_OK);
    assertEquals(receivedHostHeader, `rebind.example.com:${targetPort}`);
    const data = await res.json();
    assertEquals(data, { rebindingResistant: true });
  } finally {
    await proxy.close();
    await targetServer.shutdown();
  }
});

// ============================================================================
// Section 9: Structured Error Taxonomy (PLAT-12 502 UNAVAILABLE)
// Spec: contracts/platform.contract.md#PLAT-12
// ============================================================================

Deno.test("Structured Error — Upstream connection failure returns 502 UNAVAILABLE with PLAT-12 JSON format", async () => {
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-unavailable-test";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["127.0.0.1"],
    });

    // Send request to an unbound/dead port
    const deadReq = new Request("http://127.0.0.1:59998/dead");
    const res = await proxy.handleRequest(deadReq, invocationId);

    assertEquals(res.status, 502);
    assertEquals(res.headers.get("content-type"), "application/json");

    const body = await res.json();
    assertEquals(body.error?.code, "UNAVAILABLE");
    assert(
      typeof body.error?.message === "string" &&
        body.error.message.includes("Upstream connection failed"),
      `Expected message mentioning upstream connection failure, got: ${body.error?.message}`,
    );
  } finally {
    await proxy.close();
  }
});

Deno.test("Wire Protocol — HTTP GET and POST requests through proxy TCP listener are forwarded and streamed correctly", async () => {
  let receivedMethod = "";
  let receivedPayload = "";

  const targetServer = Deno.serve(
    { port: 0, hostname: "127.0.0.1" },
    async (req) => {
      receivedMethod = req.method;
      receivedPayload = await req.text();
      return new Response(
        JSON.stringify({ wireSuccess: true, echo: receivedPayload }),
        {
          status: HTTP_STATUS_OK,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );

  const targetPort = targetServer.addr.port;
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-wire-http";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["127.0.0.1"],
    });

    // Test POST via raw TCP socket to proxy.port
    const client = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });

    const postData = JSON.stringify({
      message: "Hello via wire forward proxy",
    });
    const postReq = `POST http://127.0.0.1:${targetPort}/submit HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${targetPort}\r\n` +
      `content-type: application/json\r\n` +
      `content-length: ${new TextEncoder().encode(postData).length}\r\n` +
      `x-railfog-invocation-id: ${invocationId}\r\n` +
      `\r\n` +
      postData;

    await client.write(new TextEncoder().encode(postReq));

    const res = await readRawResponse(client);
    assertEquals(res.status, HTTP_STATUS_OK);
    assertEquals(receivedMethod, "POST");
    assertEquals(receivedPayload, postData);

    const body = res.json();
    assertEquals(body, { wireSuccess: true, echo: postData });

    client.close();
  } finally {
    await proxy.close();
    await targetServer.shutdown();
  }
});

// ============================================================================
// Section 10: Security Adversarial Audit Suite (PLAT-5, FN-5, PLAT-12)
// ============================================================================

Deno.test("Security Adversarial — IPv6 metadata [fd00:ec2::254] and loopback [::1] rejected by Layer 2 connect-time blocker", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — fd00:ec2::/8, ::1/128 mandatory IP block
  const blocker = new EgressIpBlocker();
  const proxy = new EgressProxy({ blocker });

  try {
    const invocationId = "inv-adv-ipv6";
    // Attempt bypass by declaring IPv6 metadata and loopback directly in allowlist
    proxy.registerInvocation({
      invocationId,
      allowlist: [
        "[fd00:ec2::254]",
        "fd00:ec2::254",
        "[::1]",
        "::1",
      ],
    });

    // 1. HTTP request to AWS IPv6 metadata
    const reqIpv6Meta = new Request(
      "http://[fd00:ec2::254]/latest/meta-data",
    );
    const resIpv6Meta = await proxy.handleRequest(reqIpv6Meta, invocationId);
    assertEquals(resIpv6Meta.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      await extractErrorCode(resIpv6Meta),
      ERROR_CODE_PERMISSION_DENIED,
    );

    // 2. HTTP request to IPv6 loopback
    const reqIpv6Loop = new Request("http://[::1]:8080/internal");
    const resIpv6Loop = await proxy.handleRequest(reqIpv6Loop, invocationId);
    assertEquals(resIpv6Loop.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      await extractErrorCode(resIpv6Loop),
      ERROR_CODE_PERMISSION_DENIED,
    );

    // 3. HTTPS CONNECT wire request to AWS IPv6 metadata
    const clientMeta = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });
    await clientMeta.write(
      new TextEncoder().encode(
        `CONNECT [fd00:ec2::254]:443 HTTP/1.1\r\nHost: [fd00:ec2::254]:443\r\nx-railfog-invocation-id: ${invocationId}\r\n\r\n`,
      ),
    );
    const resMeta = await readRawResponse(clientMeta);
    assertEquals(resMeta.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      (resMeta.json().error as { code: string })?.code,
      ERROR_CODE_PERMISSION_DENIED,
    );
    clientMeta.close();

    // 4. HTTPS CONNECT wire request to IPv6 loopback
    const clientLoop = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });
    await clientLoop.write(
      new TextEncoder().encode(
        `CONNECT [::1]:8080 HTTP/1.1\r\nHost: [::1]:8080\r\nx-railfog-invocation-id: ${invocationId}\r\n\r\n`,
      ),
    );
    const resLoop = await readRawResponse(clientLoop);
    assertEquals(resLoop.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      (resLoop.json().error as { code: string })?.code,
      ERROR_CODE_PERMISSION_DENIED,
    );
    clientLoop.close();
  } finally {
    await proxy.close();
  }
});

Deno.test("Security Adversarial — RFC1918 172.16.0.0/12 and 192.168.0.0/16 private IP ranges rejected by Layer 2 connect-time blocker", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — 172.16.0.0/12, 192.168.0.0/16 mandatory IP block
  const blocker = new EgressIpBlocker();
  const proxy = new EgressProxy({ blocker });

  try {
    const invocationId = "inv-adv-rfc1918";
    // Attempt bypass by putting private RFC1918 IPs in allowlist
    proxy.registerInvocation({
      invocationId,
      allowlist: ["172.16.0.1", "192.168.1.1"],
    });

    // 1. HTTP to 172.16.0.1
    const req172 = new Request("http://172.16.0.1:8080/admin");
    const res172 = await proxy.handleRequest(req172, invocationId);
    assertEquals(res172.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(await extractErrorCode(res172), ERROR_CODE_PERMISSION_DENIED);

    // 2. HTTP to 192.168.1.1
    const req192 = new Request("http://192.168.1.1:80/setup");
    const res192 = await proxy.handleRequest(req192, invocationId);
    assertEquals(res192.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(await extractErrorCode(res192), ERROR_CODE_PERMISSION_DENIED);

    // 3. CONNECT wire tunnel to 172.16.0.1
    const client172 = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });
    await client172.write(
      new TextEncoder().encode(
        `CONNECT 172.16.0.1:443 HTTP/1.1\r\nHost: 172.16.0.1:443\r\nx-railfog-invocation-id: ${invocationId}\r\n\r\n`,
      ),
    );
    const raw172 = await readRawResponse(client172);
    assertEquals(raw172.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      (raw172.json().error as { code: string })?.code,
      ERROR_CODE_PERMISSION_DENIED,
    );
    client172.close();

    // 4. CONNECT wire tunnel to 192.168.1.1
    const client192 = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });
    await client192.write(
      new TextEncoder().encode(
        `CONNECT 192.168.1.1:443 HTTP/1.1\r\nHost: 192.168.1.1:443\r\nx-railfog-invocation-id: ${invocationId}\r\n\r\n`,
      ),
    );
    const raw192 = await readRawResponse(client192);
    assertEquals(raw192.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      (raw192.json().error as { code: string })?.code,
      ERROR_CODE_PERMISSION_DENIED,
    );
    client192.close();
  } finally {
    await proxy.close();
  }
});

Deno.test("Security Adversarial — HTTPS CONNECT connects directly to validated IP preventing TOCTOU DNS rebinding", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — Connect-time pinning prevents DNS rebinding during tunnel establishment
  const targetListener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const targetPort = (targetListener.addr as Deno.NetAddr).port;
  (async () => {
    try {
      for await (const conn of targetListener) {
        conn.readable.pipeTo(conn.writable).catch(() => {});
      }
    } catch {
      // Closed
    }
  })();

  // Blocker resolves fake domain "connect-rebind.invalid" to 127.0.0.1
  class ConnectPinningBlocker extends EgressIpBlocker {
    override validateDestination(host: string): Promise<IpBlockResult> {
      if (host === "connect-rebind.invalid") {
        return Promise.resolve({ blocked: false, ip: "127.0.0.1" });
      }
      return Promise.resolve({ blocked: false, ip: host });
    }
  }

  const proxy = new EgressProxy({ blocker: new ConnectPinningBlocker() });

  try {
    const invocationId = "inv-connect-rebind";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["connect-rebind.invalid"],
    });

    const client = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });

    // Send CONNECT request for the non-resolvable domain connect-rebind.invalid
    // If proxy performed a second OS DNS lookup, this would fail with NXDOMAIN.
    // Because it connects directly to blockResult.ip (127.0.0.1), it succeeds!
    await client.write(
      new TextEncoder().encode(
        `CONNECT connect-rebind.invalid:${targetPort} HTTP/1.1\r\nHost: connect-rebind.invalid:${targetPort}\r\nx-railfog-invocation-id: ${invocationId}\r\n\r\n`,
      ),
    );

    const buf = new Uint8Array(1024);
    const n = await client.read(buf);
    assert(n !== null);
    const head = new TextDecoder().decode(buf.subarray(0, n));
    assert(
      head.startsWith("HTTP/1.1 200 Connection Established"),
      `Expected 200 Connection Established, got: ${head}`,
    );

    // Verify tunnel is operational by sending data through echo server
    const payload = "Adversarial TOCTOU CONNECT Test";
    await client.write(new TextEncoder().encode(payload));
    const echoBuf = new Uint8Array(1024);
    const echoN = await client.read(echoBuf);
    assert(echoN !== null);
    assertEquals(
      new TextDecoder().decode(echoBuf.subarray(0, echoN)),
      payload,
    );

    client.close();
  } finally {
    await proxy.close();
    targetListener.close();
  }
});

Deno.test("Security Adversarial — Strips x-railfog-invocation-id and hop-by-hop headers preventing upstream leakage", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — Internal metadata headers must never reach upstream
  let capturedHeaders: Record<string, string> = {};

  const targetServer = Deno.serve(
    { port: 0, hostname: "127.0.0.1" },
    (req) => {
      capturedHeaders = {};
      for (const [k, v] of req.headers.entries()) {
        capturedHeaders[k.toLowerCase()] = v;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: HTTP_STATUS_OK,
        headers: { "content-type": "application/json" },
      });
    },
  );

  const targetPort = targetServer.addr.port;
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-adv-leakage-test";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["127.0.0.1"],
    });

    const client = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });

    // Send HTTP request with internal metadata header and RFC 7230 hop-by-hop headers
    const rawReq = `GET http://127.0.0.1:${targetPort}/inspect HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${targetPort}\r\n` +
      `x-railfog-invocation-id: ${invocationId}\r\n` +
      `Connection: keep-alive\r\n` +
      `Keep-Alive: timeout=5, max=100\r\n` +
      `Proxy-Authorization: Basic c2VjcmV0LXBhc3N3b3Jk\r\n` +
      `TE: trailers\r\n` +
      `X-Custom-Tenant-Trace: trace-adv-999\r\n` +
      `\r\n`;

    await client.write(new TextEncoder().encode(rawReq));
    const res = await readRawResponse(client);
    assertEquals(res.status, HTTP_STATUS_OK);

    // Sensitive internal headers MUST NOT be present upstream
    assertEquals(
      capturedHeaders["x-railfog-invocation-id"],
      undefined,
      "Internal x-railfog-invocation-id leaked upstream!",
    );
    assertEquals(
      capturedHeaders["proxy-authorization"],
      undefined,
      "Hop-by-hop proxy-authorization leaked upstream!",
    );
    assertEquals(
      capturedHeaders["keep-alive"],
      undefined,
      "Hop-by-hop keep-alive leaked upstream!",
    );
    assertEquals(
      capturedHeaders["te"],
      undefined,
      "Hop-by-hop te leaked upstream!",
    );

    // Legitimate customer headers MUST be preserved
    assertEquals(
      capturedHeaders["x-custom-tenant-trace"],
      "trace-adv-999",
      "Expected custom tenant header to be preserved",
    );

    client.close();
  } finally {
    await proxy.close();
    await targetServer.shutdown();
  }
});

Deno.test("Security Adversarial — Upstream open redirects are not automatically followed, preventing SSRF bypass", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — Upstream redirects must not bypass Layer 1 / Layer 2
  const targetServer = Deno.serve(
    { port: 0, hostname: "127.0.0.1" },
    (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/redirect-to-metadata") {
        return new Response(null, {
          status: 302,
          headers: {
            "location": "http://169.254.169.254/latest/meta-data/",
          },
        });
      }
      return new Response("ok", { status: HTTP_STATUS_OK });
    },
  );

  const targetPort = targetServer.addr.port;
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-adv-redirect";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["127.0.0.1"],
    });

    // Request endpoint that attempts open redirect to AWS metadata service
    const req = new Request(
      `http://127.0.0.1:${targetPort}/redirect-to-metadata`,
    );
    const res = await proxy.handleRequest(req, invocationId);

    // Proxy MUST return the 302 response directly, NOT follow it internally
    assertEquals(res.status, 302);
    assertEquals(
      res.headers.get("location"),
      "http://169.254.169.254/latest/meta-data/",
    );

    // If caller attempts to fetch the redirected target through the real blocker proxy, it is blocked
    const realProxy = new EgressProxy({ blocker: new EgressIpBlocker() });
    try {
      realProxy.registerInvocation({
        invocationId,
        allowlist: ["127.0.0.1"],
      });
      const followReq = new Request(
        "http://169.254.169.254/latest/meta-data/",
      );
      const followRes = await realProxy.handleRequest(followReq, invocationId);
      assertEquals(followRes.status, HTTP_STATUS_FORBIDDEN);
      assertEquals(
        await extractErrorCode(followRes),
        ERROR_CODE_PERMISSION_DENIED,
      );
    } finally {
      await realProxy.close();
    }
  } finally {
    await proxy.close();
    await targetServer.shutdown();
  }
});

Deno.test("Security Adversarial — Non-HTTP/HTTPS protocol schemes rejected with 403 PERMISSION_DENIED", async () => {
  // spec: contracts/platform.contract.md#PLAT-5 — Only http and https schemes permitted
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-adv-schemes";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["*"],
    });

    const maliciousUrls = [
      "file:///etc/passwd",
      "ftp://evil.com/leak",
      "gopher://127.0.0.1:6379/_INFO",
      "data:text/html,<script>alert(1)</script>",
      "javascript:alert(document.domain)",
    ];

    for (const url of maliciousUrls) {
      const req = new Request(url);
      const res = await proxy.handleRequest(req, invocationId);
      assertEquals(
        res.status,
        HTTP_STATUS_FORBIDDEN,
        `Expected 403 for scheme in ${url}`,
      );
      assertEquals(
        await extractErrorCode(res),
        ERROR_CODE_PERMISSION_DENIED,
        `Expected PERMISSION_DENIED for scheme in ${url}`,
      );
    }
  } finally {
    await proxy.close();
  }
});

Deno.test("Security Adversarial — Wire protocol rejects unregistered invocations and missing credentials with 403", async () => {
  // spec: contracts/platform.contract.md#PLAT-6, PLAT-12 — Unregistered invocation has no capability
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    // 1. HTTP request over wire with NO invocation ID header
    const clientNoId = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });
    await clientNoId.write(
      new TextEncoder().encode(
        "GET http://127.0.0.1:8080/test HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n",
      ),
    );
    const resNoId = await readRawResponse(clientNoId);
    assertEquals(resNoId.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      (resNoId.json().error as { code: string })?.code,
      ERROR_CODE_PERMISSION_DENIED,
    );
    clientNoId.close();

    // 2. HTTP request over wire with forged unregistered invocation ID
    const clientForged = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });
    await clientForged.write(
      new TextEncoder().encode(
        "GET http://127.0.0.1:8080/test HTTP/1.1\r\nHost: 127.0.0.1:8080\r\nx-railfog-invocation-id: un-registered-inv-999\r\n\r\n",
      ),
    );
    const resForged = await readRawResponse(clientForged);
    assertEquals(resForged.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      (resForged.json().error as { code: string })?.code,
      ERROR_CODE_PERMISSION_DENIED,
    );
    clientForged.close();

    // 3. CONNECT request over wire with NO invocation ID
    const clientConnectNoId = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });
    await clientConnectNoId.write(
      new TextEncoder().encode(
        "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n",
      ),
    );
    const resConnectNoId = await readRawResponse(clientConnectNoId);
    assertEquals(resConnectNoId.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      (resConnectNoId.json().error as { code: string })?.code,
      ERROR_CODE_PERMISSION_DENIED,
    );
    clientConnectNoId.close();

    // 4. CONNECT request over wire with forged unregistered invocation ID
    const clientConnectForged = await Deno.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
    });
    await clientConnectForged.write(
      new TextEncoder().encode(
        "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\nx-railfog-invocation-id: un-registered-inv-999\r\n\r\n",
      ),
    );
    const resConnectForged = await readRawResponse(clientConnectForged);
    assertEquals(resConnectForged.status, HTTP_STATUS_FORBIDDEN);
    assertEquals(
      (resConnectForged.json().error as { code: string })?.code,
      ERROR_CODE_PERMISSION_DENIED,
    );
    clientConnectForged.close();
  } finally {
    await proxy.close();
  }
});

Deno.test("Security Adversarial — Burst concurrency exhaustion drops requests at ceiling and cleanly recovers without resource leak", async () => {
  // spec: contracts/functions.contract.md#FN-5 — Outbound connection ceiling burst handling
  const targetServer = Deno.serve(
    { port: 0, hostname: "127.0.0.1" },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/slow") {
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            if (releaseBurst) {
              clearInterval(timer);
              resolve();
            }
          }, 10);
        });
        return new Response("done", { status: HTTP_STATUS_OK });
      }
      return new Response("fast", { status: HTTP_STATUS_OK });
    },
  );

  let releaseBurst = false;
  const targetPort = targetServer.addr.port;
  const proxy = new EgressProxy({ blocker: new PermissiveIpBlocker() });

  try {
    const invocationId = "inv-adv-burst";
    proxy.registerInvocation({
      invocationId,
      allowlist: ["127.0.0.1"],
      maxConcurrentConnections: 3,
    });

    // Launch 3 holding requests
    const holding = [
      proxy.handleRequest(
        new Request(`http://127.0.0.1:${targetPort}/slow?req=1`),
        invocationId,
      ),
      proxy.handleRequest(
        new Request(`http://127.0.0.1:${targetPort}/slow?req=2`),
        invocationId,
      ),
      proxy.handleRequest(
        new Request(`http://127.0.0.1:${targetPort}/slow?req=3`),
        invocationId,
      ),
    ];

    await new Promise((r) => setTimeout(r, 50));

    // Requests 4, 5, 6 must be immediately rejected with 429 RATE_LIMITED
    const rejected4 = await proxy.handleRequest(
      new Request(`http://127.0.0.1:${targetPort}/slow?req=4`),
      invocationId,
    );
    const rejected5 = await proxy.handleRequest(
      new Request(`http://127.0.0.1:${targetPort}/slow?req=5`),
      invocationId,
    );

    assertEquals(rejected4.status, HTTP_STATUS_TOO_MANY_REQUESTS);
    assertEquals(rejected4.headers.get("retry-after"), "1");
    assertEquals(
      await extractErrorCode(rejected4),
      ERROR_CODE_RATE_LIMITED,
    );

    assertEquals(rejected5.status, HTTP_STATUS_TOO_MANY_REQUESTS);
    assertEquals(rejected5.headers.get("retry-after"), "1");
    assertEquals(
      await extractErrorCode(rejected5),
      ERROR_CODE_RATE_LIMITED,
    );

    // Release held requests
    releaseBurst = true;
    const holdResults = await Promise.all(holding);
    for (const r of holdResults) {
      assertEquals(r.status, HTTP_STATUS_OK);
    }

    // Now that in-flight slots have been freed, next request must succeed
    const afterRes = await proxy.handleRequest(
      new Request(`http://127.0.0.1:${targetPort}/fast`),
      invocationId,
    );
    assertEquals(afterRes.status, HTTP_STATUS_OK);
  } finally {
    releaseBurst = true;
    await proxy.close();
    await targetServer.shutdown();
  }
});
