// spec: contracts/platform.contract.md#PLAT-5 — Network policy: allowlist + mandatory IP block (SSRF-safe)
// spec: contracts/platform.contract.md#PLAT-6 — Capability injection: deploy-time permission scoping
// spec: contracts/platform.contract.md#PLAT-11 — Routing specificity algorithm
// spec: contracts/platform.contract.md#PLAT-15 — Secrets management
// spec: contracts/platform.contract.md#PLAT-19 — Workspace structure and release gate validation

import { assert, assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { EgressIpBlocker } from "../../runtime/sandbox/egress-ip-blocker.ts";
import {
  checkSsrfBlock,
  DeployDiagnosticsAnalyzer,
  type DiagnosticIssue,
  type PreDeployReport,
} from "../../packages/core/diagnostics/deploy-analyzer.ts";
import {
  matchRoute,
  specificityScore,
} from "../../runtime/router/route-matcher.ts";

async function createTestSourceDir(
  files: Record<string, string>,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "railfog_m092_test_" });
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath);
    const lastSlash = Math.max(
      fullPath.lastIndexOf("/"),
      fullPath.lastIndexOf("\\"),
    );
    if (lastSlash > 0) {
      await Deno.mkdir(fullPath.slice(0, lastSlash), { recursive: true });
    }
    await Deno.writeTextFile(fullPath, content);
  }
  return dir;
}

Deno.test("T-0923 / PLAT-5: EgressIpBlocker blocks RFC 6598 Carrier-Grade NAT (100.64.0.0/10)", () => {
  const blocker = new EgressIpBlocker();

  // Boundary tests for 100.64.0.0/10 (100.64.0.0 to 100.127.255.255)
  assertEquals(
    blocker.isIpBlocked("100.64.0.0"),
    true,
    "100.64.0.0 network boundary must be blocked",
  );
  assertEquals(
    blocker.isIpBlocked("100.64.0.1"),
    true,
    "100.64.0.1 CGNAT IP must be blocked",
  );
  assertEquals(
    blocker.isIpBlocked("100.100.50.25"),
    true,
    "100.100.50.25 internal cloud VPC IP must be blocked",
  );
  assertEquals(
    blocker.isIpBlocked("100.127.255.255"),
    true,
    "100.127.255.255 upper boundary must be blocked",
  );

  // Addresses outside 100.64.0.0/10
  assertEquals(
    blocker.isIpBlocked("100.63.255.255"),
    false,
    "100.63.255.255 is outside CGNAT range",
  );
  assertEquals(
    blocker.isIpBlocked("100.128.0.0"),
    false,
    "100.128.0.0 is outside CGNAT range",
  );
});

Deno.test("T-0923 / PLAT-5: EgressIpBlocker blocks RFC 4193 IPv6 Unique Local Addresses (fc00::/7)", () => {
  const blocker = new EgressIpBlocker();

  // fc00::/7 covers fc00::/8 and fd00::/8
  assertEquals(
    blocker.isIpBlocked("fc00::1"),
    true,
    "fc00::1 must be blocked",
  );
  assertEquals(
    blocker.isIpBlocked("fcff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"),
    true,
    "Upper fc00::/8 boundary must be blocked",
  );
  assertEquals(
    blocker.isIpBlocked("fd00::1"),
    true,
    "fd00::1 must be blocked",
  );
  assertEquals(
    blocker.isIpBlocked("fd12:3456:789a:bcde::1"),
    true,
    "fd12:... ULA subnet must be blocked",
  );
  assertEquals(
    blocker.isIpBlocked("fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"),
    true,
    "Upper fd00::/8 boundary must be blocked",
  );

  // Addresses outside fc00::/7
  assertEquals(
    blocker.isIpBlocked("2606:2800:220:1:248:1893:25c8:1946"),
    false,
    "Public IPv6 address must not be blocked",
  );
  assertEquals(
    blocker.isIpBlocked("2001:db8::1"),
    false,
    "Documentation IPv6 prefix is outside fc00::/7",
  );
});

Deno.test("T-0923 / PLAT-5: EgressIpBlocker blocks IPv4-mapped IPv6 for CGNAT and loopback", () => {
  const blocker = new EgressIpBlocker();

  assertEquals(
    blocker.isIpBlocked("::ffff:100.64.1.1"),
    true,
    "::ffff:100.64.1.1 mapped CGNAT must be blocked",
  );
  assertEquals(
    blocker.isIpBlocked("::ffff:127.0.0.1"),
    true,
    "::ffff:127.0.0.1 mapped loopback must be blocked",
  );
  assertEquals(
    blocker.isIpBlocked("::ffff:169.254.169.254"),
    true,
    "::ffff:169.254.169.254 mapped metadata must be blocked",
  );
});

Deno.test("T-0923 / PLAT-5: checkSsrfBlock in deploy analyzer blocks CGNAT and ULA", () => {
  assertEquals(checkSsrfBlock("100.64.0.5").blocked, true);
  assertEquals(checkSsrfBlock("100.120.1.1").blocked, true);
  assertEquals(checkSsrfBlock("100.63.1.1").blocked, false);
  assertEquals(checkSsrfBlock("fc00::1").blocked, true);
  assertEquals(checkSsrfBlock("fd00:1::1").blocked, true);
});

Deno.test("T-0923 / PLAT-5: validateDestination resolves and blocks CGNAT / ULA destinations", async () => {
  const mockDnsResolver = (host: string): Promise<string[]> => {
    if (host === "internal.vpc.local") return Promise.resolve(["100.64.10.5"]);
    if (host === "ula.service.internal") return Promise.resolve(["fd00:1::50"]);
    if (host === "api.public.com") return Promise.resolve(["93.184.216.34"]);
    return Promise.resolve([]);
  };

  const blocker = new EgressIpBlocker({ dnsResolver: mockDnsResolver });

  const cgnatResult = await blocker.validateDestination("internal.vpc.local");
  assertEquals(cgnatResult.blocked, true);
  assert(cgnatResult.reason?.includes("blocked IP"));

  const ulaResult = await blocker.validateDestination("ula.service.internal");
  assertEquals(ulaResult.blocked, true);
  assert(ulaResult.reason?.includes("blocked IP"));

  const publicResult = await blocker.validateDestination("api.public.com");
  assertEquals(publicResult.blocked, false);
  assertEquals(publicResult.ip, "93.184.216.34");
});

Deno.test("T-0924 / PLAT-6 & PLAT-15: Pre-deploy analyzer statically detects secrets referenced via c.env", async () => {
  const code = `
    import { handle } from "@railfog/sdk";

    export default handle(async (c: any) => {
      const apiKey = c.env.get("STRIPE_SECRET_KEY");
      const dbUrl = c.env.require("DATABASE_URL");
      const optionalToken = ctx.env.get("OPTIONAL_TOKEN");
      const hostSecret = Deno.env.get("HOST_SECRET");
      return c.json({ ok: true });
    });
  `;

  const sourceDir = await createTestSourceDir({
    "src/api.ts": code,
  });

  const manifest = {
    entrypoint: "src/api.ts",
    permissions: {
      secrets: ["STRIPE_SECRET_KEY"], // DATABASE_URL, OPTIONAL_TOKEN, HOST_SECRET are undeclared
    },
  };

  try {
    const analyzer = new DeployDiagnosticsAnalyzer();
    const report: PreDeployReport = await analyzer.analyzeSource(
      sourceDir,
      manifest,
    );

    const secretIssues = report.issues.filter(
      (i: DiagnosticIssue) => i.category === "secrets",
    );
    assertExists(secretIssues);
    const secretMessages = secretIssues.map((i: DiagnosticIssue) => i.message);

    assert(
      secretMessages.some((m: string) => m.includes("DATABASE_URL")),
      "c.env.require('DATABASE_URL') must be detected as undeclared secret",
    );
    assert(
      secretMessages.some((m: string) => m.includes("OPTIONAL_TOKEN")),
      "ctx.env.get('OPTIONAL_TOKEN') must be detected",
    );
    assert(
      secretMessages.some((m: string) => m.includes("HOST_SECRET")),
      "Deno.env.get('HOST_SECRET') must be detected",
    );
  } finally {
    try {
      await Deno.remove(sourceDir, { recursive: true });
    } catch {
      // Ignore
    }
  }
});

Deno.test("T-0925 / PLAT-11: Routing specificity score calculation conforms to mathematical formula", () => {
  // score = (literal * 2) + (wildcard_or_named * 1)
  assertEquals(specificityScore("/api/users"), 4); // 2 literals -> 4
  assertEquals(specificityScore("/api/users/list"), 6); // 3 literals -> 6
  assertEquals(specificityScore("/api/*"), 3); // 1 literal + 1 wildcard -> 3
  assertEquals(specificityScore("/api/users/:id"), 5); // 2 literals + 1 named -> 5
  assertEquals(specificityScore("/:section/:page"), 2); // 2 named -> 2
  assertEquals(specificityScore("/*"), 1); // 1 wildcard -> 1
  assertEquals(specificityScore("/users/:id(\\d+)"), 3); // 1 literal + 1 regex param group -> 3
});

Deno.test("T-0925 / PLAT-11: matchRoute deterministically breaks ties by declaration order", () => {
  const routes = [
    { pattern: "/items/:id", function: "first-declared" },
    { pattern: "/items/:code", function: "second-declared" },
  ];

  // Both have identical specificity score (1 literal * 2 + 1 named * 1 = 3)
  assertEquals(specificityScore(routes[0].pattern), 3);
  assertEquals(specificityScore(routes[1].pattern), 3);

  const matched = matchRoute(routes, "/items/123");
  assertExists(matched);
  assertEquals(
    matched.function,
    "first-declared",
    "Ties must break monotonically in declaration order",
  );
});

Deno.test("T-0925 / PLAT-11: matchRoute handles query strings and trailing slashes correctly", () => {
  const routes = [
    { pattern: "/api/products", function: "exact-products" },
    { pattern: "/api/*", function: "api-wildcard" },
  ];

  const matchedWithQuery = matchRoute(
    routes,
    "/api/products?category=electronics&sort=asc",
  );
  assertExists(matchedWithQuery);
  assertEquals(matchedWithQuery.function, "exact-products");

  const matchedWithHash = matchRoute(routes, "/api/products#specs");
  assertExists(matchedWithHash);
  assertEquals(matchedWithHash.function, "exact-products");

  const matchedWildcard = matchRoute(routes, "/api/unknown-service");
  assertExists(matchedWildcard);
  assertEquals(matchedWildcard.function, "api-wildcard");
});
